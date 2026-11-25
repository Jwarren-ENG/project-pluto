import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'

const gmail = 'https://gmail.googleapis.com/gmail/v1/users/me'
const graph = 'https://graph.microsoft.com/v1.0/me'
const microsoft = 'https://login.microsoftonline.com/common/oauth2/v2.0'
const providers = {
  gmail: {
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    scope: 'https://www.googleapis.com/auth/gmail.readonly',
    redirectHost: '127.0.0.1', path: '/',
  },
  outlook: {
    authorize: microsoft + '/authorize', token: microsoft + '/token',
    scope: 'offline_access https://graph.microsoft.com/User.Read https://graph.microsoft.com/Mail.Read',
    redirectHost: 'localhost', path: '/pluto/outlook',
  },
}
const limit = 15
const text = (value, max) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : ''
const digest = value => createHash('sha256').update(value).digest('base64url')
const secretKey = provider => 'mail.' + provider
const problem = message => new Error(message)
const aborted = () => problem('Cancelled.')

function registration(provider, payload) {
  const clientId = String(payload.clientId ?? '').trim()
  const valid = provider === 'gmail'
    ? /^[a-zA-Z0-9._-]{1,200}\.apps\.googleusercontent\.com$/.test(clientId)
    : /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(clientId)
  if (!valid) throw problem('Enter the client ID from your desktop app registration.')
  const clientSecret = provider === 'gmail' ? String(payload.clientSecret ?? '').trim() : ''
  if (clientSecret.length > 512 || /\s/.test(clientSecret)) throw problem('Check the Google desktop client secret.')
  return { clientId, clientSecret }
}

// A new listener and verifier belong to exactly one sign-in. Stray browser
// requests cannot settle the attempt or see a code, token, or provider error.
async function authorize(provider, clientId, openExternal, signal) {
  const config = providers[provider]
  const state = randomBytes(32).toString('base64url')
  const verifier = randomBytes(64).toString('base64url')
  const completion = Promise.withResolvers()
  let redirect
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 6000, headersTimeout: 5000 }, (req, res) => {
    const reply = (status, message) => {
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'", Connection: 'close' })
      res.end(message)
    }
    if (!redirect || req.headers.host !== redirect.host || req.method !== 'GET' ||
        req.url.split('?')[0] !== config.path) return reply(404, 'Unknown callback.')
    let params
    try { params = new URL(req.url, redirect).searchParams } catch { return reply(400, 'Invalid callback.') }
    if (params.getAll('state').length !== 1 || params.get('state') !== state) return reply(400, 'Invalid sign-in state.')
    const codes = params.getAll('code')
    if (params.has('error')) {
      reply(200, 'Sign-in was not completed. Return to Project Pluto.')
      completion.reject(problem(params.get('error') === 'access_denied' ? 'Permission was declined.' : 'The provider could not complete sign-in. Check the desktop registration.'))
    } else if (codes.length === 1 && codes[0] && codes[0].length <= 8192) {
      reply(200, 'Return to Project Pluto to finish connecting.')
      completion.resolve(codes[0])
    } else reply(400, 'Missing authorization code.')
  })
  server.maxConnections = 12
  server.setTimeout(6000, socket => socket.destroy())
  const onAbort = () => completion.reject(signal.reason)
  const onError = () => completion.reject(problem('Could not open the local sign-in callback. Try again.'))
  server.on('error', onError)
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    signal.throwIfAborted()
    server.listen({ port: 0, host: '127.0.0.1', signal }, () => {
      if (signal.aborted) return
      const { port } = server.address()
      redirect = new URL('http://' + config.redirectHost + ':' + port + config.path)
      const url = new URL(config.authorize)
      url.search = new URLSearchParams({ response_type: 'code', client_id: clientId,
        redirect_uri: redirect.href, state, code_challenge_method: 'S256',
        code_challenge: digest(verifier), scope: config.scope,
        ...(provider === 'gmail' ? { access_type: 'offline', prompt: 'consent select_account' } : { prompt: 'select_account' }),
      }).toString()
      Promise.resolve().then(() => openExternal(url.href)).catch(() => completion.reject(problem('Could not open the system browser. Try again.')))
    })
    const code = await completion.promise
    return { code, code_verifier: verifier, redirect_uri: redirect.href }
  } finally {
    signal.removeEventListener('abort', onAbort)
    server.close()
    server.closeAllConnections()
  }
}

class ProviderError extends Error {
  constructor(status, code) {
    let message = 'The mail provider could not complete this request. Try again.'
    if (code === 'invalid_grant' || status === 401) message = 'Sign-in has expired. Disconnect this account and connect it again.'
    else if (['invalid_client', 'unauthorized_client', 'invalid_request'].includes(code)) message = 'The provider rejected the request. Check the client registration and redirect URI.'
    else if (status === 403) message = 'Read access was denied. Check the app permissions and any organization approval.'
    else if (status === 429) message = 'The provider has limited requests. Try again later.'
    super(message)
    this.status = status
  }
}

function publicMessage(provider, email, id, { from, subject, preview, date, link }) {
  const timestamp = new Date(date)
  return { key: digest(JSON.stringify([provider, email.toLowerCase(), id])), provider, account: email,
    from: text(from, 320), subject: text(subject, 500) || '(No subject)', preview: text(preview, 500),
    receivedAt: Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : '', url: link }
}

function outlookLink(value) {
  try {
    const url = new URL(value)
    if (url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      ['outlook.live.com', 'outlook.office.com', 'outlook.office365.com', 'outlook.cloud.microsoft'].includes(url.hostname)) return url.href
  } catch { /* The provider can omit webLink. */ }
  return ''
}

function employerPhrase(value) {
  if (typeof value !== 'string' || value.trim().length > 160) throw problem('Choose a tracked employer to search.')
  // Only literal words, never an empty query or user-supplied mailbox operators.
  const phrase = value.normalize('NFKC').replace(/[^\p{L}\p{M}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim()
  if (!phrase || !/[\p{L}\p{N}]/u.test(phrase)) throw problem('Enter an employer name containing letters or numbers.')
  return phrase
}

export function createMail({ secrets, openExternal, registrations = {}, fetchImpl = globalThis.fetch, signInTimeoutMs = 180000, scanTimeoutMs = 45000 }) {
  const active = new Map()
  const tokens = new Map()

  async function request(url, options, signal) {
    signal.throwIfAborted()
    let response, body
    try {
      response = await fetchImpl(url, { ...options, redirect: 'error', signal })
      body = await response.json().catch(() => null)
    } catch {
      signal.throwIfAborted()
      throw problem('Cannot reach the mail provider. Check your connection and try again.')
    }
    signal.throwIfAborted()
    if (!response.ok) throw new ProviderError(response.status, body?.error)
    if (!body || typeof body !== 'object') throw problem('The mail provider returned an unreadable response.')
    return body
  }

  async function tokenRequest(provider, account, fields, signal) {
    const params = { client_id: account.clientId, ...fields }
    if (provider === 'gmail' && account.clientSecret) params.client_secret = account.clientSecret
    const body = await request(providers[provider].token, { method: 'POST', body: new URLSearchParams(params) }, signal)
    if (typeof body.access_token !== 'string' || !body.access_token || String(body.token_type).toLowerCase() !== 'bearer') {
      throw problem('The provider did not grant an access token.')
    }
    if (typeof body.scope === 'string') {
      const granted = new Set(body.scope.toLowerCase().split(/\s+/).map(s => s.replace('https://graph.microsoft.com/', '')))
      const required = provider === 'gmail' ? [providers.gmail.scope] : ['user.read', 'mail.read']
      if (required.some(scope => !granted.has(scope))) throw problem('The required read permissions were not granted. Check consent and try again.')
    }
    return { value: body.access_token, refresh: body.refresh_token || account.refreshToken,
      expires: Date.now() + Math.max(0, Number(body.expires_in) || 0) * 1000 }
  }
  const get = (url, token, signal, headers = {}) => request(url, { headers: { Authorization: 'Bearer ' + token, ...headers } }, signal)

  async function readAccount(provider) {
    try {
      const value = await secrets.get(secretKey(provider))
      if (!value) return null
      const data = JSON.parse(value)
      if (!data.email || !data.clientId || !data.refreshToken) throw problem('Invalid record')
      return data
    } catch { throw problem('Cannot read the saved mail account. Check secure storage or disconnect it locally.') }
  }
  async function saveAccount(provider, account) {
    try { await secrets.set(secretKey(provider), JSON.stringify(account)) }
    catch { throw problem('Cannot save this account in secure storage. Check that it is available.') }
  }

  async function settings() {
    return Promise.all(Object.keys(providers).map(async provider => {
      const busy = active.get(provider)?.kind || ''
      try {
        const account = await readAccount(provider)
        return { provider, email: account?.email || '', busy, direct: Boolean(registrations[provider]?.clientId) }
      } catch (error) {
        return { provider, email: '', busy, error: error.message }
      }
    }))
  }

  function operation(kind, payload, timeout, task) {
    const provider = payload?.provider
    if (!Object.hasOwn(providers, provider)) throw problem('Choose Gmail or Outlook.')
    const current = active.get(provider)
    if (payload.cancel === true && kind !== 'disconnect') {
      if (current?.kind === kind) current.controller.abort(aborted())
      return current?.kind === kind ? current.done.catch(() => undefined).then(() => null) : null
    }
    if (current) throw problem('An account action is already in progress. Finish or cancel it first.')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(problem('The request timed out. Try again.')), timeout)
    const done = Promise.resolve().then(() => task(provider, controller.signal)).finally(() => {
      clearTimeout(timer)
      active.delete(provider)
    })
    active.set(provider, { kind, controller, done })
    return done
  }

  function connect(payload) {
    return operation('connect', payload, signInTimeoutMs, async (provider, signal) => {
      if (await readAccount(provider)) throw problem('Disconnect the current account before connecting another.')
      const client = registration(provider, payload.clientId ? payload : registrations[provider] || {})
      const grant = await authorize(provider, client.clientId, openExternal, signal)
      const token = await tokenRequest(provider, client, { grant_type: 'authorization_code', ...grant }, signal)
      if (typeof token.refresh !== 'string' || !token.refresh) throw problem('The provider did not grant offline access. Check consent and try again.')
      const identity = await get(provider === 'gmail' ? gmail + '/profile?fields=emailAddress' : graph + '?$select=mail,userPrincipalName', token.value, signal)
      const email = text(identity.emailAddress || identity.mail || identity.userPrincipalName, 320)
      if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw problem('The provider did not identify a mailbox for this account.')
      signal.throwIfAborted()
      await saveAccount(provider, { ...client, email, refreshToken: token.refresh })
      tokens.set(provider, { value: token.value, expires: token.expires })
      return { provider, email }
    })
  }

  async function search(provider, email, phrase, token, signal) {
    if (provider === 'outlook') {
      const url = new URL(graph + '/mailFolders/inbox/messages')
      url.search = new URLSearchParams({ '$search': '"' + phrase + '"', '$top': String(limit),
        '$select': 'id,from,subject,bodyPreview,receivedDateTime,webLink' }).toString()
      const { value } = await get(url, token, signal, { Prefer: 'IdType="ImmutableId"' })
      if (!Array.isArray(value)) throw problem('Outlook returned an unreadable message list.')
      return value.slice(0, limit).filter(m => typeof m?.id === 'string' && m.id).map(m =>
        publicMessage(provider, email, m.id, { from: m.from?.emailAddress?.address, subject: m.subject,
          preview: m.bodyPreview, date: m.receivedDateTime, link: outlookLink(m.webLink) }))
    }
    const url = new URL(gmail + '/messages')
    url.search = new URLSearchParams({ labelIds: 'INBOX', q: '"' + phrase + '"', maxResults: String(limit), fields: 'messages/id' }).toString()
    const list = await get(url, token, signal)
    if (list.messages != null && !Array.isArray(list.messages)) throw problem('Gmail returned an unreadable message list.')
    const found = []
    for (const item of (list.messages || []).slice(0, limit)) {
      if (!/^[a-zA-Z0-9_-]+$/.test(item?.id || '')) continue
      const messageUrl = new URL(gmail + '/messages/' + item.id)
      messageUrl.search = new URLSearchParams([['format', 'metadata'], ['metadataHeaders', 'From'], ['metadataHeaders', 'Subject'],
        ['fields', 'id,threadId,internalDate,snippet,payload/headers']]).toString()
      let m
      try { m = await get(messageUrl, token, signal) }
      catch (err) { if (err instanceof ProviderError && err.status === 404) continue; throw err }
      const header = name => m.payload?.headers?.find(h => h.name?.toLowerCase() === name)?.value
      const link = /^[\da-f]+$/i.test(m.threadId || '') ? 'https://mail.google.com/mail/u/?authuser=' + encodeURIComponent(email) + '#all/' + m.threadId : ''
      found.push(publicMessage(provider, email, item.id, { from: header('from'), subject: header('subject'),
        preview: m.snippet, date: m.internalDate ? Number(m.internalDate) : undefined, link }))
    }
    return found
  }

  function scan(payload) {
    return operation('scan', payload, scanTimeoutMs, async (provider, signal) => {
      const phrase = employerPhrase(payload.company)
      const account = await readAccount(provider)
      if (!account) throw problem('Connect this account before searching.')
      async function refreshToken() {
        const token = await tokenRequest(provider, account, { grant_type: 'refresh_token', refresh_token: account.refreshToken }, signal)
        if (token.refresh && token.refresh !== account.refreshToken) {
          account.refreshToken = token.refresh
          await saveAccount(provider, account)
        }
        tokens.set(provider, { value: token.value, expires: token.expires })
        return token.value
      }
      const cached = tokens.get(provider)
      if (cached && cached.expires > Date.now() + 30000) {
        try { return await search(provider, account.email, phrase, cached.value, signal) }
        catch (error) { if (!(error instanceof ProviderError) || error.status !== 401) throw error }
      }
      tokens.delete(provider)
      return search(provider, account.email, phrase, await refreshToken(), signal)
    })
  }

  function disconnect(payload) {
    return operation('disconnect', payload, scanTimeoutMs, async provider => {
      try { await secrets.remove(secretKey(provider)) }
      catch { throw problem('Cannot remove the saved account. Check secure storage and try again.') }
      tokens.delete(provider)
      return { provider, email: '' }
    })
  }
  function close() {
    for (const pending of active.values()) pending.controller.abort(aborted())
    tokens.clear()
  }
  return { settings, connect, disconnect, scan, close }
}
