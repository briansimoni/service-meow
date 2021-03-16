/**
 * saml.js is designed to either run on its own or as a dependency
 * It contains all of the logic for interfacing with the Azure graph API
 * and creating SAML applications
 */

const graph = require('@microsoft/microsoft-graph-client')
const CosmosClient = require('@azure/cosmos').CosmosClient
const certificates = require('./certs.json')
require('isomorphic-fetch')
require('dotenv').config()

const { CLIENT_ID, CLIENT_SECRET, TENNANT_ID, COSMOS_DB_KEY } = process.env

class ServiceMeowAuthProvider {
  constructor () {
    this.getAccessToken = this.getAccessToken.bind(this)
  }

  /**
   * @returns {Promise<String>}
   */
  async getAccessToken () {
    if (this.access_token && this.expiresDate > Date.now() / 1000) {
      return this.access_token
    }
    const params = new URLSearchParams()
    params.set('client_id', CLIENT_ID)
    params.set('client_secret', CLIENT_SECRET)
    params.set('grant_type', 'client_credentials')
    params.set('scope', 'https://graph.microsoft.com/.default')
    const response = await global.fetch(
      `https://login.microsoftonline.com/${TENNANT_ID}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: params
      }
    )
    const tokens = await response.json()
    const now = Date.now() / 1000 // now in seconds
    this.expiresDate = now + tokens.expires_in
    this.access_token = tokens.access_token
    return this.access_token
  }
}

class SamlAppBuilder {
  constructor () {
    const clientOptions = {
      authProvider: new ServiceMeowAuthProvider()
    }
    this.graphClient = graph.Client.initWithMiddleware(clientOptions)
    const client = new CosmosClient({
      endpoint: 'https://service-meow-db.documents.azure.com:443/',
      key: COSMOS_DB_KEY
    })
    const db = client.database('apps')
    const container = db.container('saml')
    this.container = container

    this.createApplication = this.createApplication.bind(this)
    this.setSamlSSOSettings = this.setSamlSSOSettings.bind(this)
    this.setSAMLUrls = this.setSAMLUrls.bind(this)
    this.setSigningCertificate = this.setSigningCertificate.bind(this)
    this.buildSamlApp = this.buildSamlApp.bind(this)
  }

  /**
   * @param {Object} opts
   * @returns {Object}
   */
  async createApplication (opts) {
    // You can't just make a POST to /applications
    // For some reason you have to use the applicationTemplates/{id}/instantiate
    // the following ID is the one the documentation says to use for "non-gallary applications"
    const nonGalleryTemplateAppId = '8adf8e6e-67b2-4cf2-a259-e3dc5476c621'
    const createResponse = await this.graphClient
      .api(`/applicationTemplates/${nonGalleryTemplateAppId}/instantiate`)
      .post({
        displayName: opts.displayName,
        identifierUris: opts.identifierUris
      })
    // per the guide that I used, it may take time to provision the app
    // It recommended that you poll the graph API until you see the app
    // was fully created. This will poll every one 1 second
    // https://docs.microsoft.com/en-us/graph/application-saml-sso-configure-api
    let app
    let attempts = 0
    process.stdout.write('Polling for application')
    while (!app && attempts < 15) {
      process.stdout.write('.')
      await new Promise(resolve => {
        setTimeout(() => {
          resolve()
        }, 1000)
      })
      try {
        app = await this.graphClient
          .api(`/applications/${createResponse.application.id}`)
          .get()
      } catch (err) {
        if (err.code !== 'Request_ResourceNotFound') {
          throw err
        }
      }
      attempts++
    }
    process.stdout.write('\n')
    if (attempts >= 30) {
      throw new Error('Attempts to poll for created application exceeded')
    }
    return createResponse
  }

  async setSamlSSOSettings (servicePrincipalId) {
    await this.graphClient
      .api(`/servicePrincipals/${servicePrincipalId}`)
      .patch({
        preferredSingleSignOnMode: 'SAML',
        appRoleAssignmentRequired: false
      })
  }

  /**
   * Sets the Assertion Consumer Service URIs
   * and the entity id(s) for the app
   * @param {String} appId
   * @param {Array<String>} uris
   * @param {Array<String>} uris
   */
  async setSAMLUrls (appId, identifierUris) {
    await this.graphClient.api(`/applications/${appId}`).patch({
      web: {
        redirectUris: identifierUris
      },
      identifierUris
    })
  }

  /**
   * Using the pre-generated self-signed certs that
   * were stored in the JSON file in this project,
   * this function will set the SAML signing certificate
   * for the app
   * @param {String} servicePrincipalId
   */
  async setSigningCertificate (servicePrincipalId) {
    await this.graphClient
      .api(`/servicePrincipals/${servicePrincipalId}`)
      .patch(certificates)
    const preferredTokenSigningKeyThumbprint = certificates.keyCredentials.find(
      cert => cert.usage === 'Sign'
    ).customKeyIdentifier
    await this.graphClient
      .api(`/servicePrincipals/${servicePrincipalId}`)
      .patch({
        preferredTokenSigningKeyThumbprint
      })
  }

  async addAppOwner (appId, ownerId) {
    await this.graphClient
      .api(`/applications/${appId}/owners/$ref`)
      .post({
        '@odata.id':
          `https://graph.microsoft.com/v1.0/users/${ownerId}`
      })
  }

  async getApplicationsByUser (ownerId) {
    // TODO: figure out how not to get SQL injected with cosmos db
    const items = await this.container.items.query({ query: `SELECT * FROM c WHERE c.ownerId = '${ownerId}'` }).fetchAll()
    const appPromises = items.resources.map((app) => this.graphClient.api(`/applications/${app.id}`).get())
    const apps = await Promise.all(appPromises)
    return apps
  }

  async getApplicationById (id) {
    return this.graphClient.api(`/applications/${id}`).get()
  }

  /**
   * Combines all of the functions together to build a SAML application
   * @param {Object} opts
   * @param {String} opts.displayName
   * @param {String<Array>} opts.identifierUris also known as the entityid - will also be used for reply urls
   * @param {String} opts.ownerId
   */
  async buildSamlApp (opts) {
    if (!Array.isArray(opts.identifierUris)) {
      throw new TypeError('Expected opts.identifierUris to be Array')
    }
    const enterpriseApp = await this.createApplication({
      displayName: opts.displayName
    })
    const { application, servicePrincipal } = enterpriseApp
    await this.setSamlSSOSettings(servicePrincipal.id)
    await this.setSAMLUrls(application.id, opts.identifierUris)
    await this.setSigningCertificate(servicePrincipal.id)
    await this.addAppOwner(application.id, opts.ownerId)
    await this.container.items.create({
      id: application.id,
      servicePrincipalId: servicePrincipal.id,
      displayName: opts.displayName,
      ownerId: opts.ownerId
    })
    console.log('successfully created app and added to db')
  }
}

// this main functions is just for testing purposes
async function main () {
  const appBuilder = new SamlAppBuilder()
  try {
    const client = new CosmosClient({
      endpoint: 'https://service-meow-db.documents.azure.com:443/',
      key: COSMOS_DB_KEY
    })

    const db = client.database('apps')
    const container = db.container('saml')
    const items = await container.items.query({ query: 'SELECT * FROM c' }).fetchAll()
    console.log(items)
    // await appBuilder.getApplicationsByUser()
    // await appBuilder.buildSamlApp({
    //   displayName: 'http://localhost/test/2/saml',
    //   identifierUris: ['http://localhost/test/2/saml']
    // })
    // console.log('app created successfully')
  } catch (err) {
    console.log(err)
    process.exit(1)
  }
}
if (require.main === module) {
  main()
}

module.exports = {
  SamlAppBuilder
}
