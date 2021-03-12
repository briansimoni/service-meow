const graph = require('@microsoft/microsoft-graph-client')
const certificates = require('./certs.json')
require('isomorphic-fetch')
require('dotenv').config()

const { CLIENT_ID, CLIENT_SECRET, TENNANT_ID } = process.env

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
    // was fully created. This will poll every one 500ms
    // https://docs.microsoft.com/en-us/graph/application-saml-sso-configure-api
    let app
    let attempts = 0
    process.stdout.write('Polling for application')
    while (!app && attempts < 30) {
      process.stdout.write('.')
      await new Promise(resolve => {
        setTimeout(() => {
          resolve()
        }, 500)
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

  /**
   * Combines all of the functions together to build a SAML application
   * @param {Object} opts
   * @param {String} opts.displayName
   * @param {String<Array>} opts.identifierUris also known as the entityid - will also be used for reply urls
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
  }
}

async function main () {
  const appBuilder = new SamlAppBuilder()
  try {
    await appBuilder.buildSamlApp({
      displayName: 'http://localhost/test/2/saml',
      identifierUris: ['http://localhost/test/2/saml']
    })
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
