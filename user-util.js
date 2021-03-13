const graph = require('@microsoft/microsoft-graph-client')
require('isomorphic-fetch')

/**
 * @param {String} accessToken
 */
async function getMe (accessToken) {
  const clientOptions = {
    authProvider: { getAccessToken: async () => accessToken }
  }
  const client = graph.Client.initWithMiddleware(clientOptions)
  const me = await client.api('/me').get()
  return me
}

module.exports = {
  getMe
}
