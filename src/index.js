'use strict'

const EventEmitter = require('events')

class RippledWsClient extends EventEmitter {
  constructor (Endpoint) {
    super()

    let Connection = {
      HasBeenOnline: false,
      Online: false,
      Timeout: {
        ConnectSeconds: 15,
        RequestSeconds: 10,
        PingTimeoutSeconds: 4,
        $: null
      },
      MomentLastResponse: null,
      Ping: {
        Latency: {
          Last: null,
          Moment: null,
          Avg: null,
          Recent: []
        },
        Hiccups: 0,
        $: null
      },
      TryCount: -1,
      Promise: null,
      WebSocket: null,
      ClosedIntentionally: false,
      Subscriptions: [],
      Server: {
        Version: null,
        Uptime: null,
        PublicKey: '',
        Endpoint: Endpoint,
        Ledgers: '',
        LastLedger: null,
        Fee: {
          Last: null,
          Moment: null,
          Avg: null,
          Recent: []
        }
      },
      RetryTimeout: null
    }

    let RequestId = 0
    let OpenRequests = []
    let SetIsOnline = (State) => {
      clearInterval(Connection.Ping.$)
      clearTimeout(Connection.Timeout.$)
      if (State !== Connection.Online) {
        if (State) {
          Connection.HasBeenOnline = true
        }
        Connection.Online = State
        Connection.Ping.Hiccups = 0
        this.emit('state', State)
        if (!Connection.Online) {
          // We are now offline
        } else {
          // We are now online
          clearTimeout(Connection.RetryTimeout)
          this.send({
            command: 'subscribe',
            streams: [ 'ledger' ]
          }).then(() => {}).catch((e) => {
            console.log('subscribe error', e)
          })
          Connection.Ping.$ = setInterval(() => {
            WebSocketRequest({
              command: 'ping'
            }, Connection.Timeout.PingTimeoutSeconds).then(ProcessPong).catch(ProcessPong)
          }, 3 * 1000)
        }
      }
    }
    let ProcessPong = (Pong) => {
      if (Pong && typeof Pong === 'object' && typeof Pong.__replyMs !== 'undefined') {
        Connection.Ping.Hiccups = 0
        Connection.Ping.Latency.Last = Pong.__replyMs
        Connection.Ping.Latency.Recent.unshift(Pong.__replyMs)
        Connection.Ping.Latency.Recent.slice(0, 30)
        Connection.Ping.Latency.Moment = new Date()
        Connection.Ping.Latency.Avg = Connection.Ping.Latency.Recent.reduce((a, b) => {
          return a + b
        }, 0) / Connection.Ping.Latency.Recent.length
      } else {
        if (Connection.Online && !Connection.ClosedIntentionally) {
          Connection.Ping.Hiccups++
          if (Connection.Ping.Hiccups > 1) {
            this.emit('error', {
              type: 'ping_hiccup',
              error: 'Ping hiccup! Not sure if online...',
              message: Connection.Ping.Hiccups
            })
          }
          if (Connection.Ping.Hiccups > 3) {
            // Online, but assume no connection
            SetIsOnline(false)
            Connection.WebSocket.close()
          }
        }
      }
    }
    let SetFee = (ServerInfo) => {
      let feeCushion = 1.2
      let NewFee = ServerInfo.load_factor * ServerInfo.validated_ledger.base_fee_xrp * 1000 * 1000 * feeCushion
      if (NewFee !== Connection.Server.Fee.Last) {
        // Fee changed
      }
      // Set uptime as well, since we have ServerInfo over here
      Connection.Server.Uptime = ServerInfo.uptime
      // Fee
      Connection.Server.Fee.Last = NewFee
      Connection.Server.Fee.Recent.unshift(NewFee)
      Connection.Server.Fee.Recent.slice(0, 30)
      Connection.Server.Fee.Avg = Connection.Server.Fee.Recent.reduce((a, b) => {
        return a + b
      }, 0) / Connection.Server.Fee.Recent.length
      Connection.Server.Fee.Moment = new Date()
    }
    let WebSocketState = () => {
      let LedgerCount = 0
      if (Connection.Server.Ledgers !== '') {
        LedgerCount = Connection.Server.Ledgers.split(',').map((m) => {
          let Range = m.split('-')
          if (Range.length > 1) {
            return parseInt(Range[1]) - parseInt(Range[0])
          }
          return 1
        }).reduce((a, b) => {
          return a + b
        }, 0)
      }
      let CurrentDate = new Date()
      return {
        online: Connection.Online,
        latencyMs: {
          last: Connection.Ping.Latency.Last,
          avg: Connection.Ping.Latency.Avg,
          secAgo: Connection.Ping.Latency.Moment ? (CurrentDate - Connection.Ping.Latency.Moment) / 1000 : null
        },
        server: {
          version: Connection.Server.Version,
          uptime: Connection.Server.Uptime,
          publicKey: Connection.Server.PublicKey,
          uri: Connection.Server.Endpoint
        },
        ledger: {
          last: Connection.Server.LastLedger,
          validated: Connection.Server.Ledgers,
          count: LedgerCount
        },
        fee: {
          last: Connection.Server.Fee.Last,
          avg: Math.floor(Connection.Server.Fee.Avg),
          secAgo: Connection.Server.Fee.Moment ? (CurrentDate - Connection.Server.Fee.Moment) / 1000 : null
        },
        secLastContact: Connection.MomentLastResponse ? (CurrentDate - Connection.MomentLastResponse) / 1000 : null
      }
    }
    let WebSocketClose = () => {
      return new Promise((resolve, reject) => {
        if (Connection.WebSocket.readyState !== Connection.WebSocket.CLOSED && Connection.WebSocket.readyState !== Connection.WebSocket.CLOSING) {
          OpenRequests.forEach(Request => {
            if (!Connection.Online) {
              Request.reject(new Error('Connection closed'))
            }
            clearTimeout(Request.timeout)
          })
          Connection.WebSocket.onclose = (ConnectionCloseEvent) => {
            SetIsOnline(false)
            this.emit('close', ConnectionCloseEvent)
            resolve(ConnectionCloseEvent)
          }
          Connection.WebSocket.close()
        } else {
          if (Connection.ClosedIntentionally) {
            reject(new Error('WebSocket in CLOSED or CLOSING state'))
          } else {
            // Do not reject, not closed, probably in retry-state.
            // We will cleanup and prevent new connection opening
            clearTimeout(Request.timeout)
          }
        }
        Connection.ClosedIntentionally = true
      })
    }
    let WebSocketRequest = (Request, Timeout) => {
      RequestId++
      let RequestTimeout = Connection.Timeout.RequestSeconds
      if (typeof Timeout !== 'undefined') {
        if (!isNaN(parseFloat(Timeout))) {
          RequestTimeout = parseFloat(Timeout)
        }
      }

      let OpenRequest = {
        id: RequestId,
        promise: null,
        resolve: null,
        reject: null,
        timeout: null,
        command: null,
        request: Request,
        moment: new Date()
      }

      if (Request && typeof Request === 'object' && ([ 'subscribe', 'unsubscribe' ].indexOf(Request.command.toLowerCase()) > -1)) {
        if (typeof Request.id === 'undefined') {
          // Initial request, no id yet
          if (Object.keys(Request).length === 2 && Request.command === 'subscribe' && typeof Request.streams !== 'undefined' && Request.streams.length === 1 && Request.streams[0] === 'ledger') {
            // This is our own subscription
          } else {
            Connection.Subscriptions.push(Request)
          }
        }
      }

      OpenRequest.promise = new Promise((resolve, reject) => {
        OpenRequest.reject = (rejectData) => {
          clearTimeout(OpenRequest.timeout)
          OpenRequests.splice(OpenRequests.indexOf(OpenRequest), 1)
          OpenRequest = null
          reject(rejectData)
        }
        OpenRequest.resolve = (resolveData) => {
          clearTimeout(OpenRequest.timeout)
          OpenRequests.splice(OpenRequests.indexOf(OpenRequest), 1)
          Object.assign(resolveData, {
            __command: OpenRequest.command,
            __replyMs: new Date() - OpenRequest.moment
          })
          OpenRequest = null
          resolve(resolveData)
        }

        OpenRequest.timeout = setTimeout(reject, RequestTimeout * 1000, new Error('Request Timeout'))
        if (Connection.WebSocket.readyState === Connection.WebSocket.OPEN) {
          if (typeof Request === 'object') {
            Object.assign(Request, {
              id: RequestId
            })
            if (typeof Request.command === 'string') {
              OpenRequest.command = Request.command
            }
            try {
              Connection.WebSocket.send(JSON.stringify(Request))
            } catch (e) {
              reject(e)
            }
          } else {
            reject(new Error('Request not typeof object'))
          }
        } else {
          // Todo: reconnect?
          reject(new Error('WebSocket not in OPEN state'))
        }
      })

      OpenRequests.push(OpenRequest)

      return OpenRequest.promise
    }

    Object.assign(this, {
      send: WebSocketRequest,
      close: WebSocketClose,
      getState: WebSocketState
    })

    let MasterPromise = new Promise((resolve, reject) => {
      let CreateConnection = () => {
        Connection.TryCount++
        let RetryConnection = () => {
          if (!Connection.ClosedIntentionally) {
            let RetryInSeconds = 2 + (3 * Connection.TryCount)
            if (RetryInSeconds < 0) RetryInSeconds = 0
            if (RetryInSeconds > 60) RetryInSeconds = 60
            clearTimeout(Connection.RetryTimeout)
            Connection.RetryTimeout = setTimeout(() => {
              this.emit('retry', {
                endpoint: Endpoint,
                retryInSeconds: RetryInSeconds,
                tryCount: Connection.TryCount
              })
              CreateConnection()
            }, RetryInSeconds * 1000)
          }
        }

        Connection.Timeout.$ = setTimeout(() => {
          RetryConnection()
        }, Connection.Timeout.ConnectSeconds * 1000)
        try {
          if (typeof window === 'undefined' && typeof global !== 'undefined' && typeof global['WebSocket'] === 'undefined') {
            // We're running nodejs, no WebSocket client availabe.
            const WebSocket = require('websocket').w3cwebsocket
            Connection.WebSocket = new WebSocket(Endpoint)
          } else {
            // W3C WebSocket
            Connection.WebSocket = new WebSocket(Endpoint)
          }
        } catch (ConnectionError) {
          if (!Connection.WebSocket) {
            SetIsOnline(false)
            reject(ConnectionError)
          }
        }

        if (Connection.WebSocket) {
          Connection.WebSocket.onclose = (ConnectionCloseEvent) => {
            SetIsOnline(false)
            RetryConnection()
          }
          Connection.WebSocket.onerror = (ConnectionError) => {
            SetIsOnline(false)
            RetryConnection()
            Connection.WebSocket.close()
          }
          Connection.WebSocket.onopen = (ConnectEvent) => {
            WebSocketRequest({
              command: 'server_info'
            }).then((ServerInfo) => {
              if (typeof ServerInfo.info === 'object' && typeof ServerInfo.info.build_version !== 'undefined' && typeof ServerInfo.info.pubkey_node !== 'undefined') {
                Connection.Server.Version = ServerInfo.info.build_version
                Connection.Server.Uptime = ServerInfo.info.uptime
                Connection.Server.PublicKey = ServerInfo.info.pubkey_node
                Connection.Server.Ledgers = ServerInfo.info.complete_ledgers
                Connection.Server.LastLedger = ServerInfo.info.validated_ledger.seq
                SetFee(ServerInfo.info)
              } else {
                reject(new Error('Invalid rippled server, received no .info.build_version or .info.pubkey_node at server_info request'))
              }
            }).catch((ServerInfoTimeout) => {
              // Only emit error if has been online before, else then is not executed so noone listening
              if (Connection.HasBeenOnline) {
                this.emit('error', {
                  type: 'serverinfo_timeout',
                  error: 'Connected, sent server_info, got no info within ' + Connection.Timeout.PingTimeoutSeconds + ' seconds, assuming not connected'
                })
              }
              Connection.WebSocket.close()
            })
            WebSocketRequest({
              command: 'ping'
            }, Connection.Timeout.PingTimeoutSeconds).then((Pong) => {
              ProcessPong(Pong)
              SetIsOnline(true)
              this.emit('reconnect', {
                endpoint: Endpoint,
                tryCount: Connection.TryCount,
                subscriptions: Connection.Subscriptions
              })
              Connection.TryCount = 0
              resolve(this)
              Connection.Subscriptions.forEach((Subscription) => {
                WebSocketRequest(Subscription).then(() => {}).catch(() => {})
              })
            }).catch((PingTimeout) => {
              if (Connection.HasBeenOnline) {
                this.emit('error', {
                  type: 'ping_error',
                  error: 'Connected, sent ping, got no pong, assuming not connected',
                  message: PingTimeout
                })
              }
              Connection.WebSocket.close()
            })
          }
          Connection.WebSocket.onmessage = (Message) => {
            let MessageJson
            try {
              MessageJson = JSON.parse(Message.data)
              Connection.MomentLastResponse = new Date()
            } catch (e) {
              this.emit('error', {
                type: 'ping_timeout',
                error: 'Connected, sent ping, got no pong within ' + Connection.Timeout.PingTimeoutSeconds + ' seconds, assuming not connected',
                message: Message
              })
            }

            if (MessageJson && MessageJson !== null && typeof MessageJson.id !== 'undefined') {
              let ReplyAt = OpenRequests.filter(Request => {
                return Request.id === MessageJson.id
              })
              if (ReplyAt.length === 1) {
                if (typeof MessageJson.status !== 'undefined') {
                  if (typeof MessageJson.type !== 'undefined') {
                    if (typeof MessageJson.result !== 'undefined') {
                      ReplyAt[0].resolve(MessageJson.result)
                    } else {
                      ReplyAt[0].resolve(MessageJson)
                    }
                  } else {
                    ReplyAt[0].reject(new Error('Message received without .type property'))
                  }
                } else {
                  ReplyAt[0].reject(new Error('Message received without .status property'))
                }
                ReplyAt = null
                Message = null
                MessageJson = null
              } else {
                this.emit('error', {
                  type: 'message_invalid_response',
                  error: 'Invalid response, .id not in OpenRequests',
                  message: MessageJson
                })
              }
            } else {
              if (MessageJson && typeof MessageJson.validated_ledgers !== 'undefined' && typeof MessageJson.ledger_index !== 'undefined') {
                if (MessageJson.type === 'ledgerClosed') {
                  Connection.Server.Ledgers = MessageJson.validated_ledgers
                  Connection.Server.LastLedger = MessageJson.ledger_index
                  // Get new fee
                  this.send({ command: 'server_info' }).then((i) => {
                    SetFee(i.info)
                  }).catch((e) => {
                    if (Connection.HasBeenOnline && Connection.Online && !Connection.ClosedIntentionally) {
                      console.log('server_info error', e)
                    }
                  })
                }
                this.emit('ledger', MessageJson)
              } else if (MessageJson && typeof MessageJson.type !== 'undefined' && MessageJson.type === 'transaction') {
                this.emit('transaction', MessageJson)
              } else if (MessageJson && typeof MessageJson.validation_public_key !== 'undefined') {
                this.emit('validation', MessageJson)
              } else {
                this.emit('error', {
                  type: 'message_invalid_json',
                  error: 'Invalid JSON message, no request (no .id property), and not a specified subscription',
                  message: MessageJson
                })
              }
            }
          }
        }
      }

      CreateConnection()
    })

    return MasterPromise
  }
}

module.exports = RippledWsClient
