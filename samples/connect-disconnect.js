const XRPLClient = require('../') // rippled-ws-client normally, when not ran from this package.

new XRPLClient('wss://xrplcluster.com').then(connection => {
    console.log('Connected')
    connection.close().then(() => {
        console.log('Disconnected')
    })
}).catch(console.error)