const RippledWsClient = require('../')

new RippledWsClient('wss://xrpl.ws', 'protocol://host/url').then((Connection) => {
  console.log('<< Connected, now in "then" >>')

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
    console.log('EVENT=close: Connection closed', closeEvent)
  })
  Connection.on('ledger', (ledgerInfo) => {
    console.log('EVENT=ledger: ledgerInfo:', ledgerInfo)
  })
  Connection.on('transaction', (transaction) => {
    console.log('EVENT=transaction: transaction:', transaction)
  })
  Connection.on('validation', (validation) => {
    console.log('EVENT=validation: validation', validation)
  })

  let getStateInterval = setInterval(() => {
    // Get the client state with some stats every 5 seconds
    console.log('-- state --', Connection.getState())
  }, 5 * 1000)

  setTimeout(() => {
    Connection.send({
      command: 'server_info'
    }).then((r) => {
      console.log('server_info Response', r)
    }).catch((e) => {
      console.log('server_info Catch', e)
    })
  }, 10 * 1000)

  Connection.send({
    command: 'subscribe',
    accounts: [ 'rDsbeomae4FXwgQTJp9Rs64Qg9vDiTCdBv', 'rUZwBRmxtK9PwoJqAsgJg5P5was3Bd7wjA', 'rUZwBRmxtK9PwoJqAsgJg5P5was3Bd7wjA' ]
  }).then((r) => {
    console.log('subscribe Response', r)
  }).catch((e) => {
    console.log('subscribe Catch', e)
  })

  setTimeout(() => {
    clearTimeout(getStateInterval)
    Connection.close().then((CloseState) => {
      // console.log('<< Closed socket after 15 seconds >>', CloseState)
      console.log('<< Closed socket after 15 seconds >>')
    }).catch(CloseError => {
      console.log('<< Closed socket ERROR after 15 seconds >>', CloseError)
    })
  }, 15 * 1000)
}).catch((r) => {
  // E.g.: when WebSocket URI is faulty
  console.log('Couldn\'t connect', r)
})
