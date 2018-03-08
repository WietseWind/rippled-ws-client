const RippledWsClient = require('../')
const RippleKeypairs = require('ripple-keypairs')
const RippleBinaryCodec = require('ripple-binary-codec')
const RippleHashes = require('ripple-hashes')

/**
 * Note, you may need to run:
 *   npm install ripple-keypairs ripple-binary-codec ripple-hashes
 * ... for this to work, since the requirements for the signing
 * are in these libs.
 */

/**
 * Let's check if the Secret (Seed, sXXXXX) is entered on the 
 * comandline after `node submit-tx.js`
 */
if (process.argv.length < 3) {
  console.log('Append your wallet secret (seed) after the command on the commandline.')
  process.exit(1)
}
let Seed = process.argv[2].replace(/[^a-zA-Z0-9]/g, '')
if (!Seed.match(/^s[a-zA-Z0-9]{15,}/)) {
  console.log('Invalid secret (seed), shoud look like: sXXXXXXX... Got:', Seed)
  process.exit(1)  
}

/**
 * Our helper function to sign a JSON transaction
 */
const signJsonTransaction = (Transaction, Secret) => {
  let Keypair
  let TxBlob
  let TxId

  if (typeof Secret === 'string' && Secret.match()) {
    Keypair = RippleKeypairs.deriveKeypair(Secret)
  } else if (typeof Secret === 'object' && typeof Secret.privateKey !== 'undefined'  && typeof Secret.publicKey !== 'undefined') {
    Keypair = Secret
  }
  if (typeof Keypair !== 'undefined' && typeof Transaction === 'object') {
    Transaction.SigningPubKey = Keypair.publicKey    
    Transaction.TxnSignature = RippleKeypairs.sign(RippleBinaryCodec.encodeForSigning(Transaction), Keypair.privateKey)

    TxBlob = RippleBinaryCodec.encode(Transaction)
    TxId = RippleHashes.computeBinaryTransactionHash(TxBlob)
  }

  return  {
    tx_blob: TxBlob,
    tx_id: TxId
  }
}

/**
 * Let's connect.
 */
new RippledWsClient('wss://s1.ripple.com').then((Connection) => {
  console.log('Connected')

  // First let's generate a wallet
  let Keypair = RippleKeypairs.deriveKeypair(Seed)
  let Address = RippleKeypairs.deriveAddress(Keypair.publicKey)

  console.log('Account (TX Sender)', Address)
  console.log(' -- Get account_info for the account sequence number')

  /**
   * Let's get the account info to fetch the
   * sequence number. For every TX the sequence number
   * will increase with 1. We need to send the current
   * sequence number with the transaction.
   */
  Connection.send({
    command: 'account_info',
    account: Address
  }).then((info) => {
    if (typeof info.account_data !== 'undefined') {
      let Sequence = info.account_data.Sequence
      
      let Transaction = {
        TransactionType: 'Payment',
        Account: Address,
        Fee: Connection.getState().fee.avg + '', // append '' to convert to string
        Destination: 'rQHYSEyxX3GKK3F6sXRvdd2NHhUqaxtC6F',
        DestinationTag: 1337,
        Amount: (1.337 * 1000000) + '', // in drops, so * 1000000 and append '' to convert to string
        LastLedgerSequence: Connection.getState().ledger.last + 5, // wait max. 5 ledgers for the tx to expire
        Sequence: Sequence
      }
      
      /**
       * Now let's start watching the destination wallet,
       * so we can check if the transaction arrives before
       * our LastLedgerSequence (e.g. times out)
       */
      
      Connection.send({
        command: 'subscribe',
        accounts: [ Transaction.Destination ]
      }).then(() => {
        console.log(' -- Watching account', Transaction.Destination)

        /**
         * Now sign the transaction using the helper function at line 20.
         */
        let Signed = signJsonTransaction(Transaction, Keypair)
        console.log('Signed TxId', Signed.tx_id)

        Connection.send({
          command: 'submit',
          tx_blob: Signed.tx_blob
        }).then((submit) => {
          /**
           * The transaction is sent, but we can't be 100%
           * sure the transaction will make it to a closed
           * ledger. The state is tentative.
           */
          console.log('TX submit TENTATIVE success', submit)

          /**
           * We create a new promise. Within the promise
           * we will watch for whatever comes first:
           *  - A ledger closes > the LastLedgerSequence
           *    for our TX. The TX didn't make it into
           *    a ledger. It timed out. We reject.
           *  - We see our own transaction in the 
           *    transaction stream of our destination
           *    wallet. The ledger is closed, so 
           *    the transaction is definitely OK.
           *    We resolve.
           */
          new Promise((resolve, reject) => {
            Connection.on('ledger', (ledgerInfo) => {
              if (ledgerInfo.ledger_index > Transaction.LastLedgerSequence) {
                reject('Timeout, ledger_index > tx LastLedgerSequence')
              }
            })
            Connection.on('transaction', (transaction) => {
              if (transaction.engine_result === 'tesSUCCESS' && transaction.type === 'transaction') {
                if (typeof transaction.transaction === 'object' && typeof transaction.transaction.hash !== 'undefined') {
                  if (transaction.transaction.hash === Signed.tx_id) {
                    if (transaction.status === 'closed' && transaction.validated === true) {
                      resolve(transaction.transaction)
                    }
                  }
                }
              }
            })
          }).then((TransactionOk) => {
            console.log('TransactionOk', TransactionOk)
            Connection.close()
          }).catch((TransactionError) => {
            console.log('TransactionError', TransactionError)
            Connection.close()
          })
        }).catch((error) => {
          console.log('TX submit error', error)
        })  
      }).catch((error) => {
        console.log('Error watching', error)
      })
    } else {
      console.log('account_info unexpected results', info)
    }
  }).catch((error) => {
    console.log('account_info error', error)
  })

  /**
   * Watch events...
   */
  Connection.on('ledger', (ledgerInfo) => {
    // console.log('EVENT=ledger: ledgerInfo:', ledgerInfo.ledger_index)
    // console.log('EVENT=ledger')
  })
  Connection.on('error', (error) => {
    console.error('EVENT=error: Error', error)
  })
  Connection.on('state', (stateEvent) => {
    console.info('EVENT=state: State is now', stateEvent)
  })
  Connection.on('retry', (retryEvent) => {
    console.log('EVENT=retry: << Retry connect >>', retryEvent)
  })
  Connection.on('reconnect', (reconnectEvent) => {
    console.log('EVENT=reconnect: << Reconnected >>', reconnectEvent)
  })
  Connection.on('close', (closeEvent) => {
    // console.log('EVENT=close: Connection closed', closeEvent)
  })
  Connection.on('transaction', (transaction) => {
    // console.log('EVENT=transaction: transaction:', transaction)
    // console.log('EVENT=transaction')
  })
  Connection.on('validation', (validation) => {
    console.log('EVENT=validation: validation', validation)
  })
}).catch((r) => {
  // E.g.: when WebSocket URI is faulty
  console.log('Couldn\'t connect', r)
})
