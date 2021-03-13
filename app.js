const Koa = require('koa')
const Router = require('@koa/router')
const views = require('koa-views')
const path = require('path')
const oidc = require('openid-client')
const session = require('koa-session')
const bodyParser = require('koa-bodyparser')
const { SamlAppBuilder } = require('./saml')
const { getMe } = require('./user-util')
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
  const tokenSet = await client.callback('http://localhost/callback', params, {
    code_verifier: codeVerifier
  })
  const userInfo = await client.userinfo(tokenSet.access_token)
  ctx.session.user = userInfo
  ctx.session.accessToken = tokenSet.access_token
  ctx.redirect('/')
})

unProtectedRouter.get('/login', async ctx => {
  await ctx.render('login')
})

unProtectedRouter.get('/logout', async ctx => {
  ctx.session.maxAge = -1
  await ctx.render('login', { justLoggedOut: true })
})

protectedRouter.get('/', async ctx => {
  console.log(ctx.session.accessToken)
  const me = await getMe(ctx.session.accessToken)
  console.log(me)
  await ctx.render('index', {
    user: ctx.session.user,
    rawUser: JSON.stringify(ctx.session.user, null, 2)
  })
})

protectedRouter.get('/saml', async ctx => {
  await ctx.render('saml-view')
})

protectedRouter.get('/saml-create', async ctx => {
  await ctx.render('saml-create')
})

protectedRouter.post('/saml-create', async ctx => {
  console.log(ctx.session.accessToken)
  const me = await getMe(ctx.session.accessToken)
  const { entityId } = ctx.request.body
  const appBuilder = new SamlAppBuilder()
  await appBuilder.buildSamlApp({
    displayName: entityId,
    identifierUris: [entityId],
    ownerId: me.id
  })
  ctx.body = `You successfully created ${entityId}`
})

protectedRouter.get('/oauth', async ctx => {
  await ctx.render('oauth')
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
      await ctx.render('404')
    } else {
      throw err
    }
  }
})
app.use(unProtectedRouter.routes())
app.use(unProtectedRouter.allowedMethods())

app.use(protectedRouter.routes())
app.use(protectedRouter.allowedMethods())

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

  const server = app.listen('80', '0.0.0.0', async () => {
    console.log('listening on 80')
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
