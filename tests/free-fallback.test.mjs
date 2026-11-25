import test from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import { createFreeFallback } from '../desktop/free-fallback.mjs'

const origin = 'http://127.0.0.1:21347'
const router = 'https://openrouter.ai/api/v1'
const auto = 'openrouter/free'
const account = 'one-account'
const localKey = 'test-instance-inference'
const cliToken = 'test-instance-management'
const upstream = 'fictional-openrouter-key'
const name = 'Project Pluto free fallback'
const entry = (id, created, changes = {}) => ({
  id, name: id.split('/')[1], created, pricing: { prompt: '0', completion: '0' },
  architecture: { input_modalities: ['text'], output_modalities: ['text'] }, ...changes,
})
const older = entry('test/older:free', 1000)
const newer = entry('test/newer:free', 2000)
const latch = () => Promise.withResolvers()

function fixture(overrides = {}) {
  const prefs = overrides.prefs ?? new Map()
  const vault = overrides.vault ?? new Map()
  const calls = []
  const lifecycle = []
  const secrets = overrides.secrets ?? {
    get: k => vault.get(k), set: (k, v) => vault.set(k, v), remove: k => vault.delete(k),
  }
  const omniRoute = overrides.omniRoute ?? {
    async start({ onProgress }) {
      lifecycle.push('start')
      onProgress({ phase: 'installing', bytes: 12, totalBytes: 12 })
      return { baseURL: origin + '/v1', cliToken }
    },
    async stop() { lifecycle.push('stop') },
  }
  const fetchImpl = async (url, init) => {
    const call = { url, ...init, body: init.body && JSON.parse(init.body) }
    calls.push(call)
    const custom = await overrides.handle?.(call)
    if (custom !== undefined) return custom instanceof Response ? custom : Response.json(custom)
    if (url.startsWith(router + '/models?')) return Response.json({ data: [older, newer] })
    if (url === router + '/key') return Response.json({ data: { label: 'test' } })
    assert.equal(new URL(url).origin, origin)
    if (init.method === 'DELETE') return Response.json({ message: 'Removed' })
    if (url.includes('/api/providers?')) return Response.json({ connections: [], total: 0 })
    const connection = { id: account, provider: 'openrouter', name, isActive: true }
    if (url.endsWith('/api/providers/bulk')) return Response.json({ success: 1, failed: 0, created: [connection] })
    if (url.endsWith('/api/providers/' + account)) return Response.json({ connection })
    if (url.endsWith('/api/keys')) return Response.json({ id: 'local-id', key: localKey })
    if (url.endsWith('/v1/chat/completions')) return Response.json({ choices: [{ message: { content: ' Draft. ' } }], usage: { cost: 0 } })
    throw new Error('Unexpected endpoint')
  }
  let keyReads = 0
  const service = createFreeFallback({ prefs, secrets, fetchImpl, omniRoute,
    getOpenRouterKey: overrides.getOpenRouterKey ?? (() => { keyReads++; return upstream }) })
  return { service, calls, lifecycle, prefs, vault, keyReads: () => keyReads }
}

async function reach(service, phase) {
  for (let n = 0; n < 300; n++) {
    const status = service.status()
    if (status.phase === phase) return status
    if (status.phase === 'error') assert.fail(status.error)
    await sleep(2)
  }
  assert.fail('Did not reach ' + phase)
}
async function ready(f) { await f.service.enable(); return reach(f.service, 'ready') }

test('off by default: no key access, background work, or draft transmission', async () => {
  const f = fixture()
  assert.equal((await f.service.restore()).phase, 'off')
  assert.equal(f.service.status().selectedModel, auto)
  assert.equal(f.keyReads(), 0)
  await assert.rejects(f.service.draft('Reviewed', 'Facts'), /not ready/)
  assert.equal(f.calls.length, 0)
  assert.deepEqual(f.lifecycle, [])
  f.prefs.set('providers.openrouter', { configured: true })
  assert.equal(f.service.status().hasKey, true)
})

test('bounded streamed catalog reports actual progress and independently filters pricing, slugs and modalities', async () => {
  const first = latch(), finish = latch()
  const data = [older, newer, newer, entry('provider/paid', 9000), entry(auto, 9000),
    ...['', null, false, '-1', '1e-1000', '0.0001'].map(value => entry('p/bad:free', 99, { pricing: { prompt: '0', completion: value } })),
    entry('p/request:free', 0, { pricing: { prompt: 0, completion: 0, request: '0.1' } }),
    entry('p/image:free', 0, { architecture: { input_modalities: ['text'], output_modalities: ['image'] } }),
    entry('p/embedding:free', 0, { architecture: { input_modalities: ['image'], output_modalities: ['text'] } })]
  const bytes = Buffer.from(JSON.stringify({ data }))
  const f = fixture({ handle(call) {
    if (!call.url.startsWith(router + '/models?')) return
    return new Response(new ReadableStream({ async start(stream) {
      stream.enqueue(bytes.subarray(0, 17))
      first.resolve()
      await finish.promise
      stream.enqueue(bytes.subarray(17)); stream.close()
    } }), { headers: { 'Content-Length': String(bytes.length) } })
  } })
  const start = await f.service.enable()
  assert.equal(start.phase, 'starting')
  await first.promise
  await sleep(0)
  assert.equal(f.service.status().bytes, 17)
  assert.equal(f.service.status().totalBytes, bytes.length)
  await assert.rejects(f.service.draft('secret instructions', 'secret facts'), /not ready/)
  finish.resolve()
  const status = await reach(f.service, 'ready')
  assert.deepEqual(status.models, [{ id: newer.id, label: newer.name, created: 2000000 }, { id: older.id, label: older.name, created: 1000000 }])
  assert.equal(status.modelCount, 2)
  status.models[0].id = 'fake/paid'
  assert.throws(() => f.service.setModel({ model: 'fake/paid' }), /available/)
  assert.throws(() => f.service.setModel({ model: 'fake/slip:free' }), /available/)
  assert.equal(f.service.setModel({ model: newer.id }).selectedModel, newer.id)
  assert.equal(f.prefs.get('freeFallback').models.length, 2)
  await f.service.close()
})

test('validates without inference; registers one account; restricts local keys; sends one zero-price request to loopback only', async () => {
  const f = fixture()
  await ready(f)
  assert.ok(f.calls.every(c => !c.url.includes('completions') && c.redirect === 'error'))
  const auth = f.calls.find(c => c.url === router + '/key')
  assert.equal(auth.headers.Authorization, 'Bearer ' + upstream)
  const catalog = f.calls.find(c => c.url.includes('/models?'))
  assert.equal(catalog.headers.Authorization, undefined)
  const reg = f.calls.find(c => c.url === origin + '/api/providers/bulk')
  assert.equal(reg.headers['x-omniroute-cli-token'], cliToken)
  assert.equal(reg.body.provider, 'openrouter')
  assert.equal(reg.body.validateKeys, false)
  assert.deepEqual(reg.body.entries, [{ name, apiKey: upstream }])
  const keys = f.calls.find(c => c.url === origin + '/api/keys')
  assert.deepEqual(keys.body.allowedModels, [auto, newer.id, older.id].map(v => 'openrouter/' + v))
  assert.deepEqual(keys.body.allowedConnections, [account])
  assert.equal(keys.body.noLog, true)
  for (const model of [auto, older.id]) {
    f.service.setModel({ model })
    assert.equal(await f.service.draft('review instructions', 'review facts'), 'Draft.')
    const chat = f.calls.at(-1)
    assert.equal(chat.url, origin + '/v1/chat/completions')
    assert.equal(chat.headers.Authorization, 'Bearer ' + localKey)
    assert.equal(chat.headers['x-omniroute-connection'], account)
    assert.equal(chat.headers['x-omniroute-cli-token'], undefined)
    assert.equal(chat.body.model, 'openrouter/' + model)
    assert.deepEqual(chat.body.messages.map(m => m.content), ['review instructions', 'review facts'])
    assert.ok(Object.values(chat.body.provider.max_price).every(v => v === 0))
    assert.equal(chat.body.provider.allow_fallbacks, false)
    assert.deepEqual(chat.body.tools, [])
    assert.equal(chat.body.tool_choice, 'none')
    assert.ok(chat.body.plugins.every(p => p.enabled === false))
  }
  assert.ok(!JSON.stringify([f.service.status(), [...f.prefs]]).includes(upstream))
  await f.service.disable()
  assert.deepEqual(f.lifecycle, ['start', 'stop'])
  assert.equal(f.calls.filter(c => c.method === 'DELETE').length, 2)
})

test('restore rechecks fresh catalog and falls back to automatic if the selected model disappeared', async () => {
  const f = fixture()
  await ready(f)
  f.service.setModel({ model: newer.id })
  await f.service.close()
  const next = fixture({ prefs: f.prefs, handle: c => c.url.includes('/models?') ? { data: [older] } : undefined })
  await assert.rejects(next.service.draft('a', 'b'), /not ready/)
  await next.service.restore()
  await reach(next.service, 'ready')
  assert.equal(next.service.status().selectedModel, auto)
  assert.equal(next.prefs.get('freeFallback').selectedModel, auto)
  assert.deepEqual(next.service.status().models.map(m => m.id), [older.id])
  await next.service.close()
})

test('dedicated key is isolated, secrets survive restart, and disabling deletes only the dedicated key', async () => {
  const f = fixture()
  f.vault.set('providers.openrouter.key', 'keep-this-standard-key')
  await f.service.enable({ apiKey: 'dedicated-key' })
  await reach(f.service, 'ready')
  assert.equal(f.keyReads(), 0)
  assert.ok(!JSON.stringify([...f.prefs]).includes('dedicated-key'))
  assert.equal(f.vault.get('freeFallback.openrouterKey'), 'dedicated-key')
  await f.service.close()
  const restored = fixture({ prefs: f.prefs, vault: f.vault })
  await restored.service.restore(); await reach(restored.service, 'ready')
  assert.equal(restored.keyReads(), 0)
  await restored.service.disable()
  assert.deepEqual([...f.vault], [['providers.openrouter.key', 'keep-this-standard-key']])
})

test('enabling and disabling while secure storage is delayed cannot revive stale credentials or requests', async () => {
  const entered = latch(), release = latch()
  const vault = new Map()
  const f = fixture({ secrets: { get: k => vault.get(k), async set(k, v) {
    if (v === 'stale') { entered.resolve(); await release.promise }
    vault.set(k, v)
  }, remove: k => vault.delete(k) } })
  await f.service.enable({ apiKey: 'stale' })
  await entered.promise
  const disable = f.service.disable()
  assert.equal(f.service.status().phase, 'off')
  const enable = f.service.enable({ apiKey: 'current' })
  release.resolve()
  await Promise.all([disable, enable]); await reach(f.service, 'ready')
  assert.equal(vault.get('freeFallback.openrouterKey'), 'current')
  assert.ok(f.calls.every(c => !JSON.stringify(c).includes('stale')))
  await f.service.close()
})

test('refuses a foreign account on a gateway and updates an existing owned connection without stacking', async () => {
  for (const owner of ['foreign', name, 'PROJECT PLUTO free fallback']) {
    const owned = owner !== 'foreign'
    const f = fixture({ handle(c) {
      if (c.url.includes('providers?')) return { connections: [{ id: account, provider: 'openrouter', name: owner }], total: 1 }
    } })
    await f.service.enable()
    await reach(f.service, owned ? 'ready' : 'error')
    assert.equal(f.calls.filter(c => c.url.endsWith('/api/providers/bulk') && c.method === 'POST').length, 0)
    assert.equal(f.calls.filter(c => c.method === 'PUT').length, owned ? 1 : 0)
    await f.service.close()
  }
})

test('catalog fails closed on absent eligible models, oversize declared or streamed bodies and incomplete downloads', async () => {
  for (const provide of [
    () => Response.json({ data: [] }), () => Response.json({ data: [entry('p/thing', 123)] }),
    () => new Response('{}', { headers: { 'content-length': String(16 * 1024 * 1024) } }),
    () => new Response(new Uint8Array(4 * 1024 * 1024 + 1)),
    () => new Response('{"data":[]}', { headers: { 'content-length': '55' } }),
  ]) {
    const f = fixture({ handle(c) { if (c.url.includes('/models?')) return provide() } })
    await f.service.enable(); await reach(f.service, 'error')
    assert.deepEqual(f.lifecycle, [])
    await assert.rejects(f.service.draft('a', 'b'), /not ready/)
  }
})

test('no upstream chat, credential rotation, or retries on local HTTP errors, network failure, cancellation or reported cost', async () => {
  for (const kind of [401, 403, 429, 503, 'network', 'cancel', 'charged', 'tools']) {
    const controller = new AbortController()
    const f = fixture({ handle(c) {
      if (!c.url.endsWith('/chat/completions')) return
      if (kind === 'network') throw new Error('private prompt and secret')
      if (kind === 'cancel') { controller.abort(); return {} }
      if (kind === 'charged') return { choices: [{ message: { content: 'wrong' } }], usage: { cost: 1 } }
      if (kind === 'tools') return { choices: [{ message: { content: 'wrong', tool_calls: [{}] } }] }
      return new Response('private prompt and secret', { status: kind })
    } })
    await ready(f)
    const before = f.calls.length
    await assert.rejects(f.service.draft('a', 'b', controller.signal), e => !e.message.includes('private') && !e.message.includes('wrong'))
    assert.deepEqual(f.calls.slice(before).map(c => c.url), [origin + '/v1/chat/completions'])
    await f.service.close()
  }
})

test('no external secret transmission upon invalid local gateway, unavailable runner, or credential rejection', async () => {
  for (const endpoint of ['https://example.com/v1', 'http://127.0.0.1:22/wrong/v1', 'http://u:p@127.0.0.1:80/v1', null, 'bad-key']) {
    const f = fixture({
      omniRoute: { start() { if (!endpoint) throw Error('sensitive output'); return { baseURL: endpoint, cliToken } }, stop() {} },
      handle(c) { if (c.url === router + '/key' && endpoint === 'bad-key') return new Response('sensitive output', { status: 401 }) },
    })
    await f.service.enable(); const state = await reach(f.service, 'error')
    assert.ok(!state.error.includes('sensitive'))
    assert.ok(f.calls.every(c => c.url.startsWith(router)))
    assert.ok(f.calls.every(c => !c.url.includes('completions')))
    await f.service.close()
  }
})

test('cancels queued key lookup and live drafts; a stopped managed process releases no further facts', async () => {
  const gate = latch(), entered = latch()
  const f = fixture({ getOpenRouterKey: () => { entered.resolve(); return gate.promise } })
  await f.service.enable(); await entered.promise
  await f.service.disable()
  gate.resolve('late-key')
  assert.equal(f.calls.length, 0)
  const lifetime = new AbortController()
  const pending = latch()
  const waiting = fixture({ omniRoute: { start: () => ({ baseURL: origin + '/v1', cliToken, signal: lifetime.signal }), stop() {} },
    handle(c) {
      if (c.url.endsWith('/chat/completions')) {
        pending.resolve()
        return new Promise((_, reject) => c.signal.addEventListener('abort', () => reject(Error('cancelled')), { once: true }))
      }
    } })
  await ready(waiting)
  const draft = waiting.service.draft('private', 'review')
  await pending.promise
  lifetime.abort()
  await assert.rejects(draft, /cancelled/)
  assert.equal(waiting.service.status().phase, 'error')
  await assert.rejects(waiting.service.draft('private', 'review'), /not ready/)
  assert.equal(waiting.calls.filter(c => c.url.endsWith('/chat/completions')).length, 1)
  await waiting.service.close()
})
