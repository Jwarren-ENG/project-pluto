import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'

const scope = 'https://www.googleapis.com/auth/drive.file'
const oauth = 'https://oauth2.googleapis.com'
const files = 'https://www.googleapis.com/drive/v3/files'
const uploads = 'https://www.googleapis.com/upload/drive/v3/files'
const storageKey = 'drive.google.account'
const registrationKey = 'drive.google.registration'
const fields = 'id,name,mimeType,trashed,sha256Checksum,appProperties'
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,256}$/.test(value)
const hash = value => createHash('sha256').update(value).digest('hex')
const formPost = params => ({ method: 'POST', body: new URLSearchParams(params) })

function registration({ clientId, clientSecret = '' }) {
  if (typeof clientId !== 'string' || !/^[a-zA-Z0-9._-]{1,200}\.apps\.googleusercontent\.com$/.test(clientId.trim())) {
    throw new Error('Enter the Google desktop app client ID.')
  }
  if (typeof clientSecret !== 'string' || clientSecret.trim().length > 512 || /\s/.test(clientSecret.trim())) {
    throw new Error('Check the Google desktop client secret.')
  }
  return { clientId: clientId.trim(), clientSecret: clientSecret.trim() }
}

// The system browser returns only to this attempt's IPv4 loopback listener.
async function authorize(clientId, openExternal, signal) {
  const state = randomBytes(32).toString('base64url')
  const verifier = randomBytes(64).toString('base64url')
  const completion = Promise.withResolvers()
  let redirect
  const server = createServer({ requestTimeout: 6000, headersTimeout: 5000, maxHeaderSize: 8192 }, (req, res) => {
    const reply = (code, message) => {
      res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'", Connection: 'close' })
      res.end(message)
    }
    if (!redirect || req.method !== 'GET' || req.headers.host !== redirect.host || req.url.split('?')[0] !== '/') {
      return reply(404, 'Unknown callback.')
    }
    const params = new URL(req.url, redirect).searchParams
    if (params.getAll('state').length !== 1 || params.get('state') !== state) return reply(400, 'Invalid sign-in state.')
    if (params.has('error')) {
      reply(200, 'Google Drive sign-in ended. Return to Pluto.')
      completion.reject(new Error('Google Drive sign-in was declined or interrupted.'))
      return
    }
    const codes = params.getAll('code')
    if (codes.length !== 1 || !codes[0] || codes[0].length > 8192) return reply(400, 'Invalid authorization code.')
    reply(200, 'Return to Pluto to finish connecting Google Drive.')
    completion.resolve(codes[0])
  })
  const abort = () => completion.reject(signal.reason)
  server.maxConnections = 12
  server.setTimeout(6000, socket => socket.destroy())
  server.on('error', () => completion.reject(new Error('Could not open the local Google Drive sign-in callback.')))
  signal.addEventListener('abort', abort, { once: true })
  try {
    signal.throwIfAborted()
    server.listen({ host: '127.0.0.1', port: 0, signal }, () => {
      if (signal.aborted) return
      redirect = new URL('http://127.0.0.1:' + server.address().port + '/')
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
      url.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirect.href, response_type: 'code',
        scope, state, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        access_type: 'offline', prompt: 'consent select_account' }).toString()
      Promise.resolve().then(() => openExternal(url.href)).catch(() => completion.reject(new Error('Could not open the Google sign-in page.')))
    })
    return { code: await completion.promise, redirect_uri: redirect.href, code_verifier: verifier }
  } finally {
    signal.removeEventListener('abort', abort)
    server.close()
    server.closeAllConnections()
  }
}

function validatePdf({ pdf, filename, jobId }) {
  if (!Buffer.isBuffer(pdf) || pdf.length < 8 || pdf.length > 5_000_000 || pdf.toString('ascii', 0, 5) !== '%PDF-') {
    throw new Error('A reviewed PDF of up to 5 MB is required.')
  }
  if (!validId(jobId)) throw new Error('Choose a saved application.')
  if (typeof filename !== 'string' || !/\.pdf$/i.test(filename) || filename.length > 255 || /[\\/\x00-\x1f\x7f]/.test(filename)) {
    throw new Error('Provide a PDF filename without a folder path.')
  }
}

export function createDrive({ prefs, secrets, openExternal, pickRegistrationFile, registrations = {}, fetchImpl = globalThis.fetch }) {
  let publisher
  if (registrations?.gmail?.clientId) {
    try { publisher = registration(registrations.gmail) }
    catch { /* An invalid publisher registration leaves manual setup available. */ }
  }
  let active, cachedToken
  function publicState(email = '', busy = '', imported = false) {
    return { connected: Boolean(email), email, busy, registrationAvailable: Boolean(publisher || imported),
      ...(imported && !publisher ? { registrationSource: 'imported' } : {}) }
  }
  async function localRegistration() {
    if (publisher) return null
    try {
      const raw = await secrets.get(registrationKey)
      return raw ? registration(JSON.parse(raw)) : null
    } catch { throw new Error('Could not read the Google setup. Unlock secure storage and try again.') }
  }
  function importRegistration() {
    return run('importRegistration', 300_000, async signal => {
      if (publisher || await read()) throw new Error('Google setup can only be imported on a disconnected copy without a publisher registration.')
      const file = await pickRegistrationFile()
      signal.throwIfAborted()
      if (file === null) return null
      const installed = file?.installed
      if (!installed || file.web || file.type === 'service_account') throw new Error('Choose the JSON file for a Google Desktop app client.')
      const client = registration({ clientId: installed.client_id, clientSecret: installed.client_secret })
      try { await secrets.set(registrationKey, JSON.stringify(client)) }
      catch { throw new Error('Could not save Google setup. Unlock secure storage and try again.') }
      return publicState('', '', true)
    })
  }
  function run(kind, milliseconds, work) {
    if (active) throw new Error('A Google Drive action is in progress.')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('Google Drive timed out. Try again.')), milliseconds)
    const done = Promise.resolve().then(() => work(controller.signal)).finally(() => { active = undefined; clearTimeout(timer) })
    active = { kind, controller, done }
    return done
  }
  async function request(url, options, signal) {
    signal.throwIfAborted()
    let response
    try { response = await fetchImpl(url, { ...options, redirect: 'error', signal }) }
    catch {
      signal.throwIfAborted()
      throw new Error('Google Drive could not be reached. Check the connection and try again.')
    }
    let data
    try { data = await response.json() } catch { /* Revocation can return an empty body. */ }
    signal.throwIfAborted()
    if (!response.ok) {
      const code = typeof data?.error === 'string' ? data.error : ''
      let message = 'Google Drive could not complete the request. Try again.'
      if (code === 'invalid_grant' || response.status === 401) message = 'Google Drive sign-in expired. Unlink it and connect again.'
      if (code === 'invalid_client') message = 'Google rejected the desktop client credentials.'
      if (response.status === 403) message = 'Google Drive denied access. Check Drive API setup, account permissions and available storage.'
      throw Object.assign(new Error(message), { status: response.status, code })
    }
    return data
  }
  async function read() {
    try {
      const value = await secrets.get(storageKey)
      if (!value) return null
      const account = JSON.parse(value)
      if (!account.refreshToken || !account.clientId || !account.permissionId || !account.email || account.scope !== scope) throw new Error()
      return account
    } catch { throw new Error('Could not read Google Drive credentials. Unlock secure storage or unlink the account.') }
  }
  async function save(account) {
    try { await secrets.set(storageKey, JSON.stringify(account)) }
    catch { throw new Error('Could not save the Google Drive grant in secure storage.') }
  }
  async function settings() {
    const account = await read()
    return publicState(account?.email, active?.kind, Boolean(await localRegistration()))
  }
  async function token(client, params, signal) {
    const data = await request(oauth + '/token', formPost({ client_id: client.clientId,
      ...(client.clientSecret && { client_secret: client.clientSecret }), ...params }), signal)
    if (!data?.access_token || typeof data.access_token !== 'string' || data.token_type?.toLowerCase() !== 'bearer') {
      throw new Error('Google did not return a usable Drive access token.')
    }
    // Google may omit scope when it is identical to the scope requested or originally granted.
    if (data.scope !== undefined && (typeof data.scope !== 'string' || data.scope.trim() !== scope)) {
      throw new Error('The Google grant must allow only files used by Pluto. Check the Drive desktop client and reconnect.')
    }
    return { value: data.access_token, expires: Date.now() + (Number(data.expires_in) || 0) * 1000, refresh: data.refresh_token }
  }

  function connect(payload = {}) {
    return run('connect', 180_000, async signal => {
      if (await read()) throw new Error('Unlink the current Google Drive account before connecting another.')
      const imported = await localRegistration()
      const client = publisher || imported || registration(payload)
      const grant = await authorize(client.clientId, openExternal, signal)
      const access = await token(client, { grant_type: 'authorization_code', ...grant }, signal)
      if (typeof access.refresh !== 'string' || !access.refresh) throw new Error('Google did not grant offline Drive access. Review consent and try again.')
      const about = await request('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress,permissionId)',
        { headers: { Authorization: 'Bearer ' + access.value } }, signal)
      const email = about?.user?.emailAddress
      const permissionId = about?.user?.permissionId
      if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(email) || !validId(permissionId)) throw new Error('Google Drive could not confirm the connected account.')
      await save({ ...client, scope, email, permissionId, refreshToken: access.refresh })
      cachedToken = access
      return publicState(email, '', Boolean(imported))
    })
  }
  async function cancel() {
    const current = active
    if (current?.kind === 'connect') {
      current.controller.abort(new Error('Google Drive sign-in canceled.'))
      await current.done.catch(() => {})
    }
    return settings()
  }
  function disconnect({ revoke = false } = {}) {
    if (typeof revoke !== 'boolean') throw new Error('Choose unlink or revoke.')
    return run('disconnect', 30_000, async signal => {
      if (revoke) {
        const account = await read()
        if (account) {
          try { await request(oauth + '/revoke', formPost({ token: account.refreshToken }), signal) }
          catch (error) { if (error.code !== 'invalid_token') throw error }
        }
      }
      await secrets.remove(storageKey)
      cachedToken = null
      return publicState('', '', Boolean(await localRegistration()))
    })
  }

  function uploadResume({ pdf, filename, jobId } = {}) {
    validatePdf({ pdf, filename, jobId })
    return run('upload', 60_000, async signal => {
      const account = await read()
      if (!account) throw new Error('Connect Google Drive before saving a résumé.')
      async function refresh() {
        const access = await token(account, { grant_type: 'refresh_token', refresh_token: account.refreshToken }, signal)
        if (access.refresh && access.refresh !== account.refreshToken) {
          account.refreshToken = access.refresh
          await save(account)
        }
        cachedToken = access
      }
      async function api(url, options = {}) {
        if (!cachedToken || cachedToken.expires <= Date.now() + 30_000) await refresh()
        const send = () => request(url, { ...options, headers: { ...options.headers, Authorization: 'Bearer ' + cachedToken.value } }, signal)
        try { return await send() } catch (error) { if (error.status !== 401) throw error }
        cachedToken = null
        await refresh()
        return send()
      }

      const role = hash(JSON.stringify([account.clientId, account.permissionId, jobId]))
      const recordKey = 'drive.resume.' + role
      const checksum = hash(pdf)
      const prior = prefs.get(recordKey)
      let id = prior?.id
      if (id && !validId(id)) throw new Error('The saved Drive file reference is invalid.')
      const inspect = () => api(files + '/' + id + '?fields=' + fields)
      function checkFile(file) {
        if (file?.id !== id || file.mimeType !== 'application/pdf' || file.appProperties?.plutoRole !== role) {
          throw new Error('Google Drive could not confirm the résumé file for this role.')
        }
      }
      function receipt(file, alreadySaved) {
        checkFile(file)
        if (file.trashed || file.sha256Checksum !== checksum) throw new Error('Google Drive could not verify the saved PDF. Retry Save to Google Drive.')
        prefs.set(recordKey, { id, confirmed: true })
        return { id, name: file.name, url: 'https://drive.google.com/open?id=' + id, alreadySaved }
      }
      if (id) {
        let file
        try { file = await inspect() } catch (error) { if (error.status !== 404) throw error }
        if (file) {
          checkFile(file)
          if (!file.trashed) {
            if (file.sha256Checksum === checksum) return receipt(file, true)
            const updated = await api(uploads + '/' + id + '?uploadType=media&fields=' + fields,
              { method: 'PATCH', headers: { 'Content-Type': 'application/pdf' }, body: pdf })
            return receipt(updated, false)
          }
        }
        if (file?.trashed || prior.confirmed) id = undefined
      }
      if (!id) {
        const reserved = await api(files + '/generateIds?count=1&space=drive&type=files')
        id = reserved?.ids?.[0]
        if (!validId(id)) throw new Error('Google Drive could not reserve a file ID.')
        // Reserve locally before sending bytes so a lost response can be reconciled after restart.
        prefs.set(recordKey, { id, confirmed: false })
      }
      const boundary = 'pluto_' + randomBytes(24).toString('hex')
      const metadata = { id, name: filename, mimeType: 'application/pdf', appProperties: { plutoRole: role } }
      const body = Buffer.concat([Buffer.from('--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' +
        JSON.stringify(metadata) + '\r\n--' + boundary + '\r\nContent-Type: application/pdf\r\n\r\n'), pdf, Buffer.from('\r\n--' + boundary + '--\r\n')])
      let file
      try {
        file = await api(uploads + '?uploadType=multipart&fields=' + fields,
          { method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + boundary }, body })
      } catch (error) {
        if (error.status !== 409) throw error
        return receipt(await inspect(), true)
      }
      return receipt(file, false)
    })
  }
  return { settings, connect, importRegistration, cancel, disconnect, uploadResume,
    close() { active?.controller.abort(new Error('Pluto closed.')); cachedToken = null } }
}
