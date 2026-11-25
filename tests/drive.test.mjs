import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { createDrive } from '../desktop/drive.mjs'

const scope = 'https://www.googleapis.com/auth/drive.file'
const client = { clientId: 'fictional-drive.apps.googleusercontent.com', clientSecret: 'fictional-desktop-value' }
const pdf = Buffer.from('%PDF-1.7\nFictional reviewed text\n%%EOF')
const packet = { pdf, filename: 'Example résumé.pdf', jobId: 'job-example' }
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const json = (value, status = 200) => Response.json(value, { status })

function fixture(overrides = {}) {
  const grants = new Map(), prefs = new Map(), remote = new Map(), calls = []
  let launched, sequence = 0
  const browser = Promise.withResolvers()
  const handlers = { ...overrides }
  const dependencies = {
    registrations: overrides.registrations,
    secrets: { get: key => grants.get(key), set: (key, value) => grants.set(key, value), remove: key => grants.delete(key) },
    prefs,
    openExternal: async raw => {
      launched = new URL(raw)
      browser.resolve(launched)
      if (handlers.wait) return
      const callback = new URL(launched.searchParams.get('redirect_uri'))
      callback.searchParams.set('state', launched.searchParams.get('state'))
      callback.searchParams.set('code', 'fictional-code')
      await fetch(callback)
    },
    fetchImpl: async (raw, options) => {
      const url = new URL(raw)
      calls.push({ path: url.pathname, method: options.method || 'GET' })
      assert.equal(options.redirect, 'error')
      if (url.origin === 'https://oauth2.googleapis.com') {
        if (url.pathname === '/revoke') {
          assert.equal(options.body.get('token'), JSON.parse(grants.get('drive.google.account')).refreshToken)
          return handlers.revoke?.() || new Response('')
        }
        assert.equal(url.pathname, '/token')
        assert.equal(options.body.get('client_id'), client.clientId)
        assert.equal(options.body.get('client_secret'), client.clientSecret)
        const initial = options.body.get('grant_type') === 'authorization_code'
        if (initial) {
          assert.equal(options.body.get('redirect_uri'), launched.searchParams.get('redirect_uri'))
          assert.equal(options.body.get('code'), 'fictional-code')
          assert.equal(createHash('sha256').update(options.body.get('code_verifier')).digest('base64url'), launched.searchParams.get('code_challenge'))
        } else assert.ok(options.body.get('refresh_token'))
        return json({ token_type: 'Bearer', access_token: 'fictional-access', refresh_token: initial ? 'fictional-refresh' : 'fictional-rotation',
          expires_in: 3600, scope, ...handlers.token?.(initial) })
      }
      assert.equal(url.origin, 'https://www.googleapis.com')
      assert.equal(options.headers.Authorization, 'Bearer fictional-access')
      if (url.pathname.endsWith('/about')) return json({ user: { emailAddress: 'applicant@example.invalid', permissionId: 'fixture-owner' } })
      if (url.pathname.endsWith('/generateIds')) return json({ ids: ['drive-file-' + ++sequence] })
      if (url.pathname === '/upload/drive/v3/files') {
        assert.equal(url.searchParams.get('uploadType'), 'multipart')
        const separator = options.headers['Content-Type'].split('boundary=')[1]
        const parts = options.body.toString('latin1').split('--' + separator)
        const meta = JSON.parse(Buffer.from(parts[1].split('\r\n\r\n')[1], 'latin1').toString('utf8'))
        const content = Buffer.from(parts[2].slice(parts[2].indexOf('\r\n\r\n') + 4, -2), 'latin1')
        assert.equal(meta.mimeType, 'application/pdf')
        const file = { ...meta, sha256Checksum: digest(content), trashed: false }
        assert.ok(!remote.has(meta.id))
        remote.set(meta.id, file)
        return handlers.create?.(file) || json(file)
      }
      const id = url.pathname.split('/').at(-1)
      if (options.method === 'PATCH') {
        const file = remote.get(id)
        file.sha256Checksum = digest(options.body)
        return json(file)
      }
      if (handlers.get) return handlers.get(id)
      return remote.has(id) ? json(remote.get(id)) : json({}, 404)
    },
  }
  return { drive: createDrive(dependencies), dependencies, handlers, grants, prefs, remote, calls, browser: browser.promise }
}

test('system browser grant uses an isolated drive.file scope, S256 PKCE, checked state and a one-time loopback redirect', async () => {
  const f = fixture({ wait: true })
  f.grants.set('mail.gmail', 'unrelated mailbox grant')
  assert.deepEqual(await f.drive.settings(), { connected: false, email: '', busy: '', registrationAvailable: false })
  const signIn = f.drive.connect(client)
  const auth = await f.browser
  assert.equal(auth.origin, 'https://accounts.google.com')
  assert.equal(auth.searchParams.get('scope'), scope)
  assert.equal(auth.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(auth.searchParams.get('access_type'), 'offline')
  assert.ok(!auth.searchParams.has('client_secret'))
  const redirect = new URL(auth.searchParams.get('redirect_uri'))
  assert.equal(redirect.hostname, '127.0.0.1')
  redirect.searchParams.set('code', 'fictional-code')
  redirect.searchParams.set('state', 'wrong')
  assert.equal((await fetch(redirect)).status, 400)
  redirect.searchParams.set('state', auth.searchParams.get('state'))
  const stray = new URL(redirect); stray.pathname = '/stray'
  assert.equal((await fetch(stray)).status, 404)
  assert.equal((await fetch(redirect)).status, 200)
  assert.deepEqual(await signIn, { connected: true, email: 'applicant@example.invalid', busy: '', registrationAvailable: false })
  await assert.rejects(fetch(redirect))
  assert.equal(f.grants.get('mail.gmail'), 'unrelated mailbox grant')
  assert.equal([...f.prefs.keys()].length, 0)
  assert.deepEqual(Object.keys(await f.drive.settings()).sort(), ['busy', 'connected', 'email', 'registrationAvailable'])
})

test('publisher desktop registration opens Drive consent directly and exposes only its availability', async () => {
  const f = fixture({ registrations: { gmail: client, outlook: { clientId: 'ignored' } } })
  f.grants.set('mail.gmail', 'separate mail grant')
  assert.deepEqual(await f.drive.settings(), { connected: false, email: '', busy: '', registrationAvailable: true })
  const connected = await f.drive.connect({})
  const auth = await f.browser
  assert.equal(auth.searchParams.get('client_id'), client.clientId)
  assert.equal(auth.searchParams.get('scope'), scope)
  assert.equal(connected.registrationAvailable, true)
  assert.ok(!JSON.stringify(connected).includes(client.clientId))
  assert.equal(f.grants.get('mail.gmail'), 'separate mail grant')
  assert.equal((await f.drive.disconnect()).registrationAvailable, true)
  const manual = fixture({ registrations: { gmail: { clientId: 'invalid' } } })
  assert.equal((await manual.drive.settings()).registrationAvailable, false)
  await assert.rejects(manual.drive.connect({}), /client ID/)
  assert.ok((await manual.drive.connect(client)).connected)
})

test('cancel and denied consent release the listener and store no credentials', async () => {
  for (const reason of ['cancel', 'deny']) {
    const f = fixture({ wait: true })
    const outcome = assert.rejects(f.drive.connect(client), /canceled|declined/)
    const auth = await f.browser
    const callback = new URL(auth.searchParams.get('redirect_uri'))
    if (reason === 'cancel') await f.drive.cancel()
    else {
      callback.search = new URLSearchParams({ state: auth.searchParams.get('state'), error: 'access_denied' })
      await fetch(callback)
    }
    await outcome
    await assert.rejects(fetch(callback))
    assert.equal(f.grants.size, 0)
  }
})

test('declines incomplete or overbroad grants and offers a new sign-in after rejection', async () => {
  for (const token of [{ scope: 'openid' }, { scope: scope + ' https://www.googleapis.com/auth/gmail.readonly' }, { refresh_token: '' }]) {
    const f = fixture({ token: () => token })
    await assert.rejects(f.drive.connect(client), /grant|access/)
    assert.equal(f.grants.size, 0)
    delete f.handlers.token
    assert.ok((await f.drive.connect(client)).connected)
  }
})

test('saves only a reviewed PDF and updates the same file when the reviewed bytes change', async () => {
  const f = fixture()
  await assert.rejects(f.drive.uploadResume(packet), /Connect Google Drive/)
  for (const bad of [{ pdf: '/a/private/path.pdf' }, { pdf: Buffer.from('unreviewed text') }, { filename: '../x.pdf' }, { jobId: '#invalid' }]) {
    assert.throws(() => f.drive.uploadResume({ ...packet, ...bad }))
  }
  await f.drive.connect(client)
  const first = await f.drive.uploadResume(packet)
  assert.deepEqual(first, { id: 'drive-file-1', name: packet.filename, url: 'https://drive.google.com/open?id=drive-file-1', alreadySaved: false })
  assert.equal((await f.drive.uploadResume(packet)).alreadySaved, true)
  assert.equal(f.calls.filter(c => c.path.startsWith('/upload/')).length, 1)
  const revision = await f.drive.uploadResume({ ...packet, pdf: Buffer.concat([pdf, Buffer.from('\n')]) })
  assert.equal(revision.id, first.id)
  assert.equal(revision.alreadySaved, false)
  assert.equal(f.remote.size, 1)
  assert.ok(!JSON.stringify([...f.prefs]).includes('fictional-access'))
  assert.ok(!JSON.stringify([...f.prefs]).includes(packet.filename))
})

test('recovers ambiguous creation after restart, verifies conflicts and refreshes a separate Drive token', async () => {
  const f = fixture({ create: () => { throw new Error('dropped response') } })
  await f.drive.connect(client)
  await assert.rejects(f.drive.uploadResume(packet), /could not be reached/)
  const restarted = createDrive(f.dependencies)
  assert.equal((await restarted.uploadResume(packet)).alreadySaved, true)
  assert.equal(JSON.parse(f.grants.get('drive.google.account')).refreshToken, 'fictional-rotation')
  assert.equal(f.remote.size, 1)
  f.handlers.create = () => json({}, 409)
  const conflict = await restarted.uploadResume({ ...packet, jobId: 'second-role' })
  assert.equal(conflict.alreadySaved, true)
  f.handlers.get = id => json({ ...f.remote.get(id), appProperties: {} })
  await assert.rejects(restarted.uploadResume(packet), /confirm the résumé/)
})

test('an unauthorized upload refreshes once and a checksum mismatch never produces a receipt', async () => {
  const f = fixture()
  await f.drive.connect(client)
  await f.drive.uploadResume(packet)
  let attempts = 0
  f.handlers.get = id => ++attempts === 1 ? json({}, 401) : json(f.remote.get(id))
  assert.equal((await f.drive.uploadResume(packet)).alreadySaved, true)
  assert.equal(attempts, 2)
  f.handlers.create = file => json({ ...file, sha256Checksum: 'incorrect' })
  await assert.rejects(f.drive.uploadResume({ ...packet, jobId: 'new-role' }), /verify the saved PDF/)
})

test('unlink is local; explicit revoke failure keeps the grant available for retry', async () => {
  const f = fixture()
  f.grants.set('mail.gmail', 'unrelated fixture')
  await f.drive.connect(client)
  await f.drive.disconnect()
  assert.ok(!f.calls.some(call => call.path === '/revoke'))
  await f.drive.connect(client)
  f.handlers.revoke = () => json({}, 503)
  await assert.rejects(f.drive.disconnect({ revoke: true }))
  assert.equal((await f.drive.settings()).connected, true)
  delete f.handlers.revoke
  assert.equal((await f.drive.disconnect({ revoke: true })).connected, false)
  assert.equal(f.grants.get('mail.gmail'), 'unrelated fixture')
  assert.equal(f.calls.filter(call => call.path === '/revoke').length, 2)
})
