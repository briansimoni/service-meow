const Koa = require('koa')
const Router = require('@koa/router')
const views = require('koa-views')
const path = require('path')
const oidc = require('openid-client')
const session = require('koa-session')
const bodyParser = require('koa-bodyparser')
const { SamlAppBuilder } = require('./saml')
const { getMe } = require('./user-util')
const formatXml = require('xml-formatter')
require('dotenv').config()

const {
  CLIENT_ID,
  CLIENT_SECRET,
  TENNANT_ID,
  REDIRECT_URI,
  SESSION_SECRET
} = process.env

/** @type oidc.Client */
let client

const app = new Koa()
app.keys = [SESSION_SECRET]
app.use(session(app))
app.use(bodyParser())

const protectedRouter = new Router()
const unProtectedRouter = new Router()

// authentication middleware
// makes the protected router "protected"
protectedRouter.use(async (ctx, next) => {
  if (!ctx.session.user) {
    return ctx.redirect('/login')
  }
  await next()
})

unProtectedRouter.get('/auth', async ctx => {
  const codeVerifier = oidc.generators.codeVerifier()
  const codeChallenge = oidc.generators.codeChallenge(codeVerifier)

  const authorizationUrl = client.authorizationUrl({
    scope: 'openid profile',
    code_challenge_method: 'S256',
    code_challenge: codeChallenge
  })
  ctx.session.codeVerifier = codeVerifier
  ctx.redirect(authorizationUrl)
})

unProtectedRouter.get('/callback', async ctx => {
  const params = client.callbackParams(ctx.request)
  const codeVerifier = ctx.session.codeVerifier
  const tokenSet = await client.callback(REDIRECT_URI, params, {
    code_verifier: codeVerifier
  })
  const userInfo = await client.userinfo(tokenSet.access_token)
  ctx.session.user = userInfo
  // ctx.session.tokenSet = tokenSet
  ctx.session.accessToken = tokenSet.access_token
  ctx.redirect('/')
})

unProtectedRouter.get('/login', async ctx => {
  await ctx.render('login', { user: ctx.session.user })
})

unProtectedRouter.get('/logout', async ctx => {
  ctx.session.maxAge = -1
  await ctx.render('login', { justLoggedOut: true })
})

protectedRouter.get('/', async ctx => {
  await ctx.render('index', {
    user: ctx.session.user,
    rawUser: JSON.stringify(ctx.session.user, null, 2)
  })
})

protectedRouter.get('/tickets', async ctx => {
  await ctx.render('tickets', { user: ctx.session.user })
})

protectedRouter.get('/saml', async ctx => {
  const samlBuilder = new SamlAppBuilder()
  const me = await getMe(ctx.session.accessToken)
  const apps = await samlBuilder.getApplicationsByUser(me.id)
  await ctx.render('saml-list', { user: ctx.session.user, apps })
})

protectedRouter.get('/saml-create', async ctx => {
  await ctx.render('saml-create', { user: ctx.session.user })
})

protectedRouter.post('/saml-create', async ctx => {
  const me = await getMe(ctx.session.accessToken)
  const { entityId } = ctx.request.body
  const appBuilder = new SamlAppBuilder()
  await appBuilder.buildSamlApp({
    displayName: entityId,
    identifierUris: [entityId],
    ownerId: me.id
  })
  await ctx.render('saml-create', {
    user: ctx.session.user,
    createdApp: entityId
  })
})

protectedRouter.get('/saml/:id', async ctx => {
  const id = ctx.params.id
  const saml = new SamlAppBuilder()
  const app = await saml.getApplicationById(id)
  let userAccessUrl
  try {
    userAccessUrl = `https://myapps.microsoft.com/signin/${app.identifierUris[0].replace(/[:./]/g, '')}/${app.appId}/?tenantId=${TENNANT_ID}`
  } catch (error) {
    console.warn('unable to create user accessUrl', error.message)
  }

  const metadataUrl = `https://login.microsoftonline.com/${TENNANT_ID}/federationmetadata/2007-06/federationmetadata.xml?appid=${app.appId}`
  await ctx.render('saml-item-view', {
    user: ctx.session.user,
    app,
    stringifiedApp: JSON.stringify(app, null, 2),
    userAccessUrl,
    metadataUrl
  })
})

unProtectedRouter.post('/sso/(.*)', async ctx => {
  const { SAMLResponse } = ctx.request.body
  const xmlResponse = Buffer.from(SAMLResponse, 'base64').toString('utf-8')
  const formattedXml = formatXml(xmlResponse)
  await ctx.render('sso', { assertion: formattedXml })
})

protectedRouter.get('/oauth', async ctx => {
  await ctx.render('oauth', { user: ctx.session.user })
})

const render = views(path.join(__dirname, 'views'), {
  map: {
    html: 'handlebars'
  },
  options: {
    partials: {
      footer: 'footer',
      header: 'header',
      sidebar: 'sidebar'
    }
  }
})

app.use(render)
protectedRouter.use(render)

// 404 middleware
app.use(async (ctx, next) => {
  try {
    await next()
    const status = ctx.status || 404
    if (status === 404) {
      ctx.throw(404)
    }
  } catch (err) {
    ctx.status = err.status || 500
    if (ctx.status === 404) {
      await ctx.render('404', { user: ctx.session.user })
    } else {
      await ctx.render('error', { status: ctx.status, error: err })
    }
  }
})
app.use(unProtectedRouter.routes())
app.use(unProtectedRouter.allowedMethods())

app.use(protectedRouter.routes())
app.use(protectedRouter.allowedMethods())

app.on('error', async (error, ctx) => {
  console.log(error)
})

async function main () {
  console.log('server is starting up')
  const azureIssuer = await oidc.Issuer.discover(
    `https://login.microsoftonline.com/${TENNANT_ID}/v2.0/.well-known/openid-configuration`
  )
  client = new azureIssuer.Client({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uris: [REDIRECT_URI],
    response_types: ['code']
  })

  const port = process.env.PORT || 80
  const server = app.listen(port, '0.0.0.0', async () => {
    console.log('listening on', port)
  })

  process.on('SIGINT', () => {
    console.info('SIGINT signal received. Server shutting down')
    server.close(() => {
      console.log('server shut down gracefully')
      process.exit(0)
    })
  })

  process.on('SIGTERM', () => {
    console.info('SIGTERM signal received. Server shutting down')
    server.close(() => {
      console.log('server shut down gracefully')
      process.exit(0)
    })
  })
}
main()
