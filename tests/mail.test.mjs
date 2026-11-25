import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import http from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createMail } from '../desktop/mail.mjs'

const google = { provider: 'gmail', clientId: 'fixture.apps.googleusercontent.com', clientSecret: 'fixture-registration' }
const outlook = { provider: 'outlook', clientId: '00000000-1111-2222-3333-444444444444' }
const email = 'candidate@example.test'
const response = (body, status = 200) => Response.json(body, { status })
const bearer = (extra = {}) => response({ token_type: 'Bearer', access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_in: 3600, ...extra })

// Call only this process's ephemeral IPv4 loopback listener. No real browser,
// cloud authorization, provider credentials, or mailbox are used.
function callback(auth, values, options = {}) {
  const url = new URL(auth.searchParams.get('redirect_uri'))
  assert.ok(['localhost', '127.0.0.1'].includes(url.hostname))
  const path = options.path ?? url.pathname
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: url.port, method: options.method || 'GET',
      path: path + '?' + new URLSearchParams(values), headers: { Host: options.host || url.host } }, res => {
      res.resume()
      res.on('end', () => resolve(res.statusCode))
    })
    req.on('error', reject)
    req.end()
  })
}
function fixture({ fetchImpl, openExternal, ...extra } = {}) {
  const store = new Map(), calls = [], opened = Promise.withResolvers()
  const secrets = { get: k => store.get(k), set: (k, v) => store.set(k, v), remove: k => store.delete(k) }
  const mail = createMail({ ...extra, secrets, openExternal: async href => {
    const auth = new URL(href)
    opened.resolve(auth)
    if (openExternal) await openExternal(auth)
  }, fetchImpl: async (url, options) => {
    const u = new URL(url)
    calls.push({ u, options })
    assert.equal(options.redirect, 'error')
    assert.ok(['gmail.googleapis.com', 'graph.microsoft.com', 'oauth2.googleapis.com', 'login.microsoftonline.com'].includes(u.hostname))
    if (!fetchImpl) throw new Error('Unexpected provider request')
    return fetchImpl(u, options)
  } })
  return { mail, opened: opened.promise, store, calls }
}

for (const config of [google, outlook]) {
  const { provider } = config
  test(provider + ' binds OAuth, PKCE and identity, then searches with read-only requests', async () => {
    const f = fixture({ fetchImpl(u) {
      if (u.pathname.endsWith('/token')) return bearer()
      if (u.pathname.endsWith('/profile')) return response({ emailAddress: email })
      if (u.pathname === '/v1.0/me') return response({ mail: null, userPrincipalName: email })
      if (u.pathname.endsWith('/users/me/messages')) return response({ messages: [{ id: '111a' }, { id: '111b' }] })
      if (u.pathname.endsWith('/111b')) return response({ error: 'removed' }, 404)
      if (u.pathname.endsWith('/111a')) return response({ id: '111a', threadId: 'fa11', internalDate: '1770000000000',
        payload: { headers: [{ name: 'Subject', value: 'Meeting with Acme' }, { name: 'From', value: 'jobs@example.test' }] },
        snippet: 'Fixture excerpt' })
      if (u.pathname.endsWith('/inbox/messages')) return response({ value: [{ id: 'immutable-fixture', from: { emailAddress: { address: 'jobs@example.test' } },
        subject: 'Meeting with Acme', bodyPreview: 'Fixture excerpt', receivedDateTime: '2026-06-01T12:00:00Z', webLink: 'https://outlook.office.com/mail/id/fixture' }] })
      throw new Error('Unexpected fixture URL')
    } })
    assert.ok((await f.mail.settings()).every(a => !a.email))
    const connected = f.mail.connect(config)
    const auth = await f.opened
    const state = auth.searchParams.get('state'), redirect = new URL(auth.searchParams.get('redirect_uri'))
    assert.ok(state.length >= 40)
    assert.equal(auth.searchParams.get('code_challenge_method'), 'S256')
    assert.equal(auth.hostname, provider === 'gmail' ? 'accounts.google.com' : 'login.microsoftonline.com')
    assert.equal(redirect.hostname, provider === 'gmail' ? '127.0.0.1' : 'localhost')
    assert.equal(redirect.pathname, provider === 'gmail' ? '/' : '/pluto/outlook')
    assert.doesNotMatch(auth.toString(), /fixture-registration|Mail.Send|gmail.modify/)
    assert.equal(await callback(auth, { state: 'wrong', code: 'wrong' }), 400)
    assert.equal(await callback(auth, { state, code: 'wrong' }, { host: 'unexpected.example' }), 404)
    assert.equal(await callback(auth, { state, code: 'wrong' }, { path: '/other' }), 404)
    assert.equal(await callback(auth, { state, code: 'wrong' }, { method: 'POST' }), 404)
    assert.equal(await callback(auth, [['state', state], ['state', state], ['code', 'wrong']]), 400)
    assert.equal(f.calls.length, 0)
    assert.equal(await callback(auth, { state, code: 'fixture-code' }), 200)
    assert.deepEqual(await connected, { provider, email })
    const exchange = f.calls[0].options.body
    assert.equal(exchange.get('code'), 'fixture-code')
    assert.equal(exchange.get('redirect_uri'), redirect.href)
    assert.equal(createHash('sha256').update(exchange.get('code_verifier')).digest('base64url'), auth.searchParams.get('code_challenge'))
    assert.equal(exchange.get('client_secret'), config.clientSecret || null)
    await assert.rejects(callback(auth, { state, code: 'replay' }))
    assert.equal(f.calls.length, 2)
    assert.doesNotMatch(JSON.stringify(await f.mail.settings()), /fixture-(access|refresh|registration)/)
    assert.doesNotMatch(f.store.get('mail.' + provider), /fixture-access|fixture-code/)
    const messages = await f.mail.scan({ provider, company: 'Acme & Co.' })
    assert.equal(messages.length, 1)
    assert.equal(messages[0].account, email)
    assert.equal(messages[0].subject, 'Meeting with Acme')
    assert.equal(messages[0].from, 'jobs@example.test')
    assert.equal(messages[0].preview, 'Fixture excerpt')
    assert.equal(messages[0].key.length, 43)
    assert.match(messages[0].url, /^https:\/\//)
    const read = f.calls[2]
    assert.equal(read.u.searchParams.get(provider === 'gmail' ? 'q' : '$search'), '"Acme Co"')
    assert.equal(read.u.searchParams.get(provider === 'gmail' ? 'maxResults' : '$top'), '15')
    assert.equal(read.options.headers.Authorization, 'Bearer fixture-access')
    if (provider === 'gmail') {
      assert.equal(read.u.searchParams.get('labelIds'), 'INBOX')
      assert.equal(f.calls[3].u.searchParams.get('format'), 'metadata')
    } else {
      assert.equal(read.options.headers.Prefer, 'IdType="ImmutableId"')
      assert.doesNotMatch(read.u.searchParams.get('$select'), /attachments|uniqueBody|body,/)
    }
    await f.mail.disconnect({ provider })
    assert.equal(f.store.size, 0)
    await assert.rejects(f.mail.scan({ provider, company: 'Acme' }), /Connect this account/)
  })
}

test('cancel, timeout, denial and launch errors release the callback without saving secrets', async () => {
  for (const mode of ['cancel', 'timeout', 'denied', 'launch']) {
    const f = fixture({ signInTimeoutMs: mode === 'timeout' ? 120 : 2000,
      openExternal: () => { if (mode === 'launch') throw new Error('private detail') } })
    const result = assert.rejects(f.mail.connect(google), mode === 'launch' ? /system browser/ : mode === 'cancel' ? /Cancelled/ : mode === 'denied' ? /declined/ : /timed out/)
    const auth = await f.opened
    if (mode === 'denied') await callback(auth, { state: auth.searchParams.get('state'), error: 'access_denied' })
    if (mode === 'cancel') {
      assert.throws(() => f.mail.connect(google), /already in progress/)
      await f.mail.connect({ provider: 'gmail', cancel: true })
    }
    await result
    await assert.rejects(callback(auth, { state: 'old', code: 'old' }))
    assert.equal(f.calls.length, 0)
    assert.equal(f.store.size, 0)
  }
})

test('refresh rotates credentials, preserves existing data on failure and sanitizes provider errors', async () => {
  let fail = false
  const f = fixture({ fetchImpl(u, options) {
    if (u.pathname.endsWith('/token')) {
      assert.equal(options.body.get('refresh_token'), fail ? 'rotated' : 'old')
      return fail ? response({ error: 'invalid_grant', error_description: 'private debug text' }, 400) : bearer({ refresh_token: 'rotated', expires_in: 0 })
    }
    return response({ value: [{ id: 'id', webLink: 'https://other.example/secret' }] })
  } })
  f.store.set('mail.outlook', JSON.stringify({ email, clientId: outlook.clientId, refreshToken: 'old' }))
  assert.equal((await f.mail.scan({ provider: 'outlook', company: 'Acme' }))[0].url, '')
  assert.equal(JSON.parse(f.store.get('mail.outlook')).refreshToken, 'rotated')
  fail = true
  await assert.rejects(f.mail.scan({ provider: 'outlook', company: 'Acme' }), err => /expired/.test(err.message) && !err.message.includes('debug'))
  assert.equal(JSON.parse(f.store.get('mail.outlook')).refreshToken, 'rotated')
})

test('scans can be cancelled and require an employer and a known provider', async () => {
  const entered = Promise.withResolvers()
  const f = fixture({ fetchImpl(u, { signal }) {
    entered.resolve()
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  } })
  f.store.set('mail.gmail', JSON.stringify({ email, clientId: google.clientId, refreshToken: 'fixture' }))
  await assert.rejects(f.mail.scan({ provider: 'gmail', company: '*' }), /employer name/)
  assert.throws(() => f.mail.scan({ provider: 'constructor', company: 'Acme' }), /Gmail or Outlook/)
  assert.equal(f.calls.length, 0)
  const stopped = assert.rejects(f.mail.scan({ provider: 'gmail', company: 'Acme' }), /Cancelled/)
  await entered.promise
  await f.mail.scan({ provider: 'gmail', cancel: true })
  await stopped
  assert.equal((await f.mail.settings()).find(x => x.provider === 'gmail').busy, '')
})

test('a missing grant or reduced Outlook scope cannot create a connected account', async () => {
  for (const extra of [{ refresh_token: '' }, { scope: 'User.Read' }]) {
    const f = fixture({ fetchImpl: () => bearer(extra) })
    const failed = assert.rejects(f.mail.connect(outlook), /offline access|read permissions/)
    const auth = await f.opened
    await callback(auth, { state: auth.searchParams.get('state'), code: 'fixture' })
    await failed
    assert.equal(f.calls.length, 1)
    assert.equal(f.store.size, 0)
  }
})

test('review saves one stable note on the chosen job in the actual workspace', async t => {
  const { createWorkspace } = await import('../desktop/workspace.mjs')
  const { createServer } = await import('vite')
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pluto-mail-fixture-'))
  const workspace = createWorkspace(dir)
  let server
  t.after(async () => { await server?.close(); workspace.close(); await rm(dir, { recursive: true, force: true }) })
  server = await createServer({ cacheDir: path.join(dir, 'vite'), logLevel: 'silent',
    server: { middlewareMode: true, hmr: false, watch: null }, optimizeDeps: { noDiscovery: true } })
  const { linkReviewedReply } = await server.ssrLoadModule('/ui/Mail.jsx')
  const one = workspace.saveJob({ company: 'Acme', title: 'Product', url: 'https://one.example' })
  const two = workspace.saveJob({ company: 'Acme', title: 'Deployment', url: 'https://two.example' })
  const message = { provider: 'gmail', account: email, from: 'jobs@example.test', subject: 'Next steps',
    preview: 'Private fixture excerpt', key: 'scoped-fixture', url: 'https://mail.google.com/example', receivedAt: '' }
  const ws = (action, payload) => {
    if (action === 'workspace.snapshot') return workspace.snapshot()
    assert.equal(action, 'workspace.saveNote')
    return workspace.saveNote(payload)
  }
  assert.equal(await linkReviewedReply({ job: two, message }, ws), true)
  let { notes, jobs } = workspace.snapshot()
  assert.equal(notes.length, 1)
  assert.equal(notes[0].jobId, two.id)
  assert.doesNotMatch(notes[0].body, /Private fixture excerpt/)
  assert.match(notes[0].body, /Next steps/)
  assert.match(notes[0].body, /https:\/\/mail.google.com\/example/)
  assert.deepEqual(jobs.find(j => j.id === two.id), two)
  workspace.saveNote({ ...notes[0], body: 'User edited this note.' })
  assert.equal(await linkReviewedReply({ job: two, message, includePreview: true }, ws), false)
  assert.equal(workspace.snapshot().notes[0].body, 'User edited this note.')
  assert.equal(await linkReviewedReply({ job: one, message, includePreview: true }, ws), true)
  assert.match(workspace.snapshot().notes.find(n => n.jobId === one.id).body, /Private fixture excerpt/)
  await assert.rejects(linkReviewedReply({ job: { ...one, title: 'Stale title' }, message }, ws), /tracked job changed/)
  assert.equal(workspace.snapshot().notes.length, 2)
})

test('publisher registrations open permission directly and stay in the main process', async () => {
  const f = fixture({registrations:{gmail:google}})
  const accounts = await f.mail.settings()
  assert.equal(accounts.find(a => a.provider === 'gmail').direct, true)
  assert.equal(accounts.find(a => a.provider === 'outlook').direct, false)
  assert.doesNotMatch(JSON.stringify(accounts), /fixture/)
  const declined = assert.rejects(f.mail.connect({provider:'gmail'}), /declined/)
  const auth = await f.opened
  assert.equal(auth.searchParams.get('client_id'), google.clientId)
  await callback(auth, {state:auth.searchParams.get('state'), error:'access_denied'})
  await declined
  assert.equal(f.store.size, 0)
})
