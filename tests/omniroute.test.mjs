import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, chmod } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createOmniRoute } from '../desktop/omniroute.mjs'

async function fixture(t, fetchImpl) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pluto-omni-test-'))
  const service = createOmniRoute({ directory, fetchImpl })
  t.after(async () => { await service.stop(); await rm(directory, { recursive: true, force: true }) })
  return { directory, service }
}

test('never downloads before start or after a pre-cancelled start', async t => {
  let calls = 0
  const { service, directory } = await fixture(t, () => { calls++ })
  await service.stop()
  await assert.rejects(service.start({ signal: AbortSignal.abort() }), /cancelled/)
  assert.equal(calls, 0)
  assert.deepEqual(await readdir(directory), [])
})

test('fresh downloads use the official pinned URL, verify SHA256 before extraction, and remove partial installs', async t => {
  const calls = [], events = []
  const { service, directory } = await fixture(t, async (url, options) => {
    calls.push({ url, options })
    return new Response('wrong archive', { headers: { 'content-length': '13' } })
  })
  await assert.rejects(service.start({ onProgress: v => events.push(v) }), /checksum/)
  assert.match(calls[0].url, /^https:\/\/nodejs\.org\/dist\/v24\.22\.3\/node-v24\.22\.3-/)
  assert.equal(calls[0].options.redirect, 'error')
  assert.deepEqual(events.at(-1), { phase: 'downloading', bytes: 13, totalBytes: 13 })
  assert.deepEqual(await readdir(directory), [])
})

test('refuses oversized artifacts before extraction and sanitizes fetch errors', async t => {
  for (const [response, pattern] of [[() => new Response('bad', { headers: { 'content-length': '9999999999' } }), /too large/],
    [() => { throw new Error('OmniRoute private token and prompt') }, /could not install/]]) {
    const { service, directory } = await fixture(t, response)
    await assert.rejects(service.start(), error => pattern.test(error.message) && !error.message.includes('private token'))
    assert.deepEqual(await readdir(directory), [])
  }
})

test('concurrent starts share the install and stop aborts, cleans and permits a restart', async t => {
  let count = 0
  const entered = Promise.withResolvers()
  const { service, directory } = await fixture(t, async (url, { signal }) => {
    if (++count > 1) return new Response('{}')
    entered.resolve()
    await new Promise((resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }) })
  })
  const a = service.start(), b = service.start()
  assert.equal(a, b)
  await entered.promise
  await Promise.all([assert.rejects(a), service.stop(), service.stop()])
  assert.equal(count, 1)
  assert.deepEqual(await readdir(directory), [])
  await assert.rejects(service.start(), /checksum/)
  assert.equal(count, 2)
})

test('refuses a shared runtime folder before contacting the network', { skip: process.platform === 'win32' }, async t => {
  let called = false
  const { directory, service } = await fixture(t, () => { called = true })
  await chmod(directory, 0o755)
  await assert.rejects(service.start(), /private runtime directory/)
  assert.equal(called, false)
})

// Opt-in: supply the private directory populated by a previous real start, or a fresh private directory.
// These probes exercise the installed production entry without any employer data or upstream API key.
test('real private runtime requires authentication, enforces inference auth, and stops its listener', {
  skip: !process.env.PLUTO_TEST_OMNIROUTE_DIRECTORY, timeout: 15 * 60_000,
}, async t => {
  const service = createOmniRoute({ directory: process.env.PLUTO_TEST_OMNIROUTE_DIRECTORY })
  t.after(() => service.stop())
  const { baseURL, cliToken, signal } = await service.start()
  const url = new URL('/api/providers?provider=openrouter&limit=2', baseURL)
  const headers = { 'x-omniroute-cli-token': cliToken }
  assert.equal((await fetch(url)).status, 401)
  const ok = await fetch(url, { headers })
  assert.equal(ok.status, 200)
  assert.deepEqual((await ok.json()).connections, [])
  const premature = await fetch(baseURL + '/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'openrouter/openrouter/free', messages: [{ role: 'user', content: 'Fictional test.' }] }) })
  assert.equal(premature.status, 401)
  const key = await fetch(new URL('/api/keys', url), { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Fictional test', modelAccessMode: 'restricted', allowedModels: ['openrouter/openrouter/free'], noLog: true }) })
  assert.equal(key.status, 201)
  const local = await key.json()
  assert.ok(typeof local.key === 'string' && local.key.length > 0)
  assert.equal((await fetch(url, { headers: { Authorization: 'Bearer ' + local.key } })).status, 403)
  await service.stop()
  assert.equal(signal.aborted, true)
  await assert.rejects(fetch(url, { signal: AbortSignal.timeout(1000) }))
  const again = await service.start()
  assert.notEqual(again.cliToken, cliToken)
})


// Use the actual pinned provider executor with its official base URL override pointed at a local
// synthetic OpenRouter. Only the test transport can install this override.
test('real OmniRoute forwards the selected model and price limits to a synthetic OpenRouter', {
  skip: !process.env.PLUTO_TEST_OMNIROUTE_DIRECTORY, timeout: 90_000,
}, async () => {
  const http = await import('node:http')
  const { setTimeout: pause } = await import('node:timers/promises')
  const { createFreeFallback } = await import('../desktop/free-fallback.mjs')
  const calls = [], upstream = []
  let upstreamStatus = 200
  const name = 'sample/model:free'
  const serving = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
    upstream.push({ path: req.url, method: req.method, body })
    res.setHeader('Content-Type', 'application/json')
    if (upstreamStatus !== 200) {
      res.writeHead(upstreamStatus)
      res.end(JSON.stringify({ error: { message: 'Synthetic provider error', code: upstreamStatus } }))
      return
    }
    res.end(JSON.stringify({ id: 'chatcmpl-fictional', object: 'chat.completion', created: 1700000000, model: name,
      choices: [{ index: 0, message: { role: 'assistant', content: 'Synthetic draft.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6, cost: 0 } }))
  })
  await new Promise(resolve => serving.listen(0, '127.0.0.1', resolve))
  const fixtureURL = 'http://127.0.0.1:' + serving.address().port + '/api/v1/chat/completions'
  const omniRoute = createOmniRoute({ directory: process.env.PLUTO_TEST_OMNIROUTE_DIRECTORY })
  const fallback = createFreeFallback({ prefs: new Map(), secrets: { async remove() {} },
    getOpenRouterKey: () => 'fictional-upstream', omniRoute, async fetchImpl(url, init) {
      if (new URL(url).hostname === 'openrouter.ai') {
        assert.equal(init.method, 'GET')
        return Response.json({ data: url.includes('/models?')
          ? [{ id: name, pricing: { prompt: '0', completion: '0' }, architecture: { input_modalities: ['text'], output_modalities: ['text'] } }]
          : { label: 'test' } })
      }
      assert.equal(new URL(url).hostname, '127.0.0.1')
      if (url.endsWith('/api/providers/bulk')) {
        const body = JSON.parse(init.body)
        body.providerSpecificData.baseUrl = fixtureURL
        init = { ...init, body: JSON.stringify(body) }
      }
      const res = await fetch(url, init)
      calls.push([new URL(url).pathname, res.status])
      return res
    } })
  try {
    await fallback.enable()
    for (let i = 0; i < 600 && !['ready','error'].includes(fallback.status().phase); i++) await pause(50)
    assert.equal(fallback.status().phase, 'ready', JSON.stringify({ status: fallback.status(), calls }))
    for (const selected of ['openrouter/free', name]) {
      fallback.setModel({ model: selected })
      assert.equal(await fallback.draft('Edit this fictional note.', 'Test item.'), 'Synthetic draft.')
      const request = upstream.at(-1)
      assert.equal(request.method, 'POST')
      assert.equal(request.body.model, selected)
      assert.deepEqual(request.body.provider.max_price, { prompt: 0, completion: 0, request: 0, image: 0, audio: 0 })
      assert.equal(request.body.provider.allow_fallbacks, false)
      assert.ok(!request.body.tools?.length)
      assert.ok(request.body.plugins.some(p => p.id === 'web' && p.enabled === false))
    }
    assert.equal(upstream.length, 2)
    upstreamStatus = 401
    await assert.rejects(fallback.draft('Fictional instructions.', 'Test item.'), /HTTP 401/)
    assert.equal(upstream.length, 3)
    assert.equal(upstream[2].body.model, name)
    assert.equal(fallback.status().phase, 'error')
  } finally {
    await fallback.close()
    serving.closeAllConnections()
    await new Promise(resolve => serving.close(resolve))
  }
})
