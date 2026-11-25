import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createProviders } from '../desktop/providers.mjs'

const sample = {
  profile: { name: 'Riley Example', summary: 'Managed a fictional library project.', phone: 'private-phone', notes: 'private-note' },
  job: { company: 'Example Library', title: 'Catalog Coordinator', description: 'Improve the catalog.', evidence: 'private-receipt' },
}
function fixture(handle = () => ({}), extras = {}) {
  const prefs = new Map()
  const vault = new Map()
  const secrets = { get: key => vault.get(key), set: (key, value) => vault.set(key, value), remove: key => vault.delete(key) }
  const calls = []
  const fetchImpl = async (url, init) => {
    const call = { url, ...init, body: init.body && JSON.parse(init.body) }
    calls.push(call)
    const result = await handle(call)
    return result instanceof Response ? result : Response.json(result)
  }
  const deps = { prefs, secrets, fetchImpl, ...extras }
  return { service: createProviders(deps), deps, prefs, vault, calls }
}

for (const [provider, endpoint, model] of [
  ['openai', 'https://api.openai.com/v1/chat/completions', 'gpt-4.1-mini'],
  ['anthropic', 'https://api.anthropic.com/v1/messages', 'claude-sonnet-4-6'],
  ['openrouter', 'https://openrouter.ai/api/v1/chat/completions', 'openrouter/auto'],
  ['custom', 'https://example.test/api/v1/chat/completions', 'demo-model'],
  ['ollama', 'http://127.0.0.1:11434/api/chat', 'demo-model'],
]) {
  test(provider + ' configures, tests, drafts, restores and disconnects', async () => {
    const { service, deps, calls, prefs, vault } = fixture(call => {
      if (call.url.endsWith('/api/show')) return { model_info: { architecture: 'fictional' } }
      if (provider === 'anthropic') return { content: [{ type: 'thinking', thinking: 'internal' }, { type: 'text', text: 'Draft.' }] }
      if (provider === 'ollama') return { message: { content: 'Draft.' } }
      return { choices: [{ message: { content: 'Draft.' } }] }
    })
    const apiKey = 'fictional-key-for-testing'
    const cfg = { provider, model, ...(provider !== 'ollama' && { apiKey }), ...(provider === 'custom' && { endpoint: 'https://example.test/api/v1/' }) }
    const state = await service.configure(cfg)
    assert.equal(state.activeProvider, provider)
    assert.equal(state.providers[provider].configured, true)
    assert.ok(!JSON.stringify([state, [...prefs]]).includes(apiKey))
    assert.deepEqual(await service.test({ provider }), { ok: true })
    assert.ok(!JSON.stringify(calls.at(-1).body).includes('Riley'))
    const restored = createProviders(deps)
    assert.equal(await restored.draft(sample), 'Draft.')
    const call = calls.at(-1)
    assert.equal(call.url, endpoint)
    assert.equal(call.redirect, 'error')
    assert.equal(call.body.model, model)
    assert.ok(JSON.stringify(call.body).includes('Riley'))
    assert.doesNotMatch(JSON.stringify(call.body), /private-phone|private-receipt|private-note/)
    if (provider === 'anthropic') {
      assert.ok(call.body.system)
      assert.equal(call.headers['x-api-key'], apiKey)
      assert.equal(call.body.messages.length, 1)
      assert.equal(call.headers['anthropic-version'], '2023-06-01')
    } else if (provider === 'ollama') {
      assert.equal(call.headers.Authorization, undefined)
      assert.equal(call.body.stream, false)
      assert.equal(vault.size, 0)
    } else assert.equal(call.headers.Authorization, 'Bearer ' + apiKey)
    await service.disconnect({ provider })
    assert.equal(service.settings().activeProvider, null)
    assert.equal(vault.size, 0)
    await assert.rejects(service.draft(sample), /Choose an AI provider/)
  })
}

test('custom credentials are bound to the entire normalized base URL', async () => {
  const { service, calls } = fixture(() => ({ choices: [{ message: { content: 'OK' } }] }))
  await service.configure({ provider: 'custom', endpoint: 'https://example.test/tenant-one/v1/', model: 'one', apiKey: 'old-secret' })
  await service.configure({ provider: 'custom', endpoint: 'https://example.test/tenant-one/v1', model: 'two' })
  for (const endpoint of ['https://example.test/tenant-two/v1', 'https://different.test/v1']) {
    await assert.rejects(service.configure({ provider: 'custom', endpoint }), /API key/)
  }
  await service.test({ provider: 'custom' })
  assert.equal(calls.at(-1).headers.Authorization, 'Bearer old-secret')
  await service.configure({ provider: 'custom', endpoint: 'https://different.test/v1', apiKey: 'new-secret' })
  await service.test({ provider: 'custom' })
  assert.equal(calls.at(-1).url, 'https://different.test/v1/chat/completions')
  assert.equal(calls.at(-1).headers.Authorization, 'Bearer new-secret')
})

test('invalid destinations, unknown providers and missing keys fail before contacting a service', async () => {
  const { service, calls } = fixture()
  for (const endpoint of ['http://example.test', 'https://user:pass@example.test', 'https://example.test?key=fake', 'https://example.test/#fragment']) {
    await assert.rejects(service.configure({ provider: 'custom', endpoint, model: 'x', apiKey: 'test' }))
  }
  for (const endpoint of ['http://example.test', 'http://localhost.example.test', 'http://127.0.0.1/api', 'https://localhost']) {
    await assert.rejects(service.configure({ provider: 'ollama', endpoint, model: 'x' }))
  }
  await assert.rejects(service.configure({ provider: 'openai', endpoint: 'https://other.test', apiKey: 'test' }), /fixed/)
  await assert.rejects(service.configure({ provider: 'openai' }), /key/)
  await assert.rejects(service.configure({ provider: 'constructor' }), /supported/)
  assert.equal(calls.length, 0)
})

test('local mode refuses a remotely hosted Ollama model before sending any profile data', async () => {
  const { service, calls } = fixture(() => ({ remote_model: 'remote-test', remote_host: 'https://example.test' }))
  await service.configure({ provider: 'ollama', model: 'remote-test' })
  await assert.rejects(service.draft(sample), /installed local/)
  assert.deepEqual(calls.map(c => c.body), [{ model: 'remote-test' }])
})

test('Firecrawl checks credit access and returns plain web results without changing active AI', async () => {
  const { service, calls } = fixture(call => call.url.endsWith('credit-usage')
    ? { success: true, data: { remainingCredits: 0 } }
    : { success: true, data: { web: [
      { title: 'Example', url: 'https://example.test/job', description: 'Fictional opening' },
      { url: 'https://example.test/job' }, { url: 'javascript:void(0)' }, { url: 'https://user:password@example.test' }, { url: 'https://example.org' },
    ] } })
  await service.configure({ provider: 'ollama', model: 'example' })
  await service.configure({ provider: 'firecrawl', apiKey: 'fictional-firecrawl' })
  assert.deepEqual(await service.test({ provider: 'firecrawl' }), { ok: true })
  assert.equal(calls[0].method, 'GET')
  assert.equal(calls[0].url, 'https://api.firecrawl.dev/v2/team/credit-usage')
  assert.deepEqual(await service.search({ query: 'Example jobs' }), [
    { title: 'Example', url: 'https://example.test/job', description: 'Fictional opening' },
    { title: 'example.org', url: 'https://example.org/', description: '' },
  ])
  assert.equal(calls[1].url, 'https://api.firecrawl.dev/v2/search')
  assert.deepEqual(calls[1].body, { query: 'Example jobs', limit: 10, sources: ['web'] })
  assert.equal(calls[1].headers.Authorization, 'Bearer fictional-firecrawl')
  await service.disconnect({ provider: 'firecrawl' })
  assert.equal(service.settings().activeProvider, 'ollama')
  await assert.rejects(service.search({ query: 'roles' }), /Connect Firecrawl/)
})

test('unexpected content and remote errors do not leak upstream messages or report success', async () => {
  for (const response of [new Response('fictional-secret in error', { status: 401 }), new Response('fictional-secret'), {}, { choices: [] }]) {
    const { service } = fixture(() => response)
    await service.configure({ provider: 'openai', apiKey: 'fictional-secret' })
    await assert.rejects(service.test({ provider: 'openai' }), error => !error.message.includes('fictional-secret'))
  }
  const { service } = fixture(() => ({ success: false, error: 'private' }))
  await service.configure({ provider: 'firecrawl', apiKey: 'fictional' })
  await assert.rejects(service.test({ provider: 'firecrawl' }), /credit access/)
  await assert.rejects(service.search({ query: 'test' }), /unexpected/)
  await assert.rejects(service.search({ query: '  ' }), /query/)
})

test('OpenRouter browser sign-in exchanges a localhost code with a fresh S256 proof', async () => {
  let challenge, verifier
  const openExternal = async url => {
    const auth = new URL(url)
    assert.equal(auth.origin + auth.pathname, 'https://openrouter.ai/auth')
    assert.equal(auth.searchParams.get('code_challenge_method'), 'S256')
    assert.equal(auth.searchParams.has('code_verifier'), false)
    challenge = auth.searchParams.get('code_challenge')
    const callback = new URL(auth.searchParams.get('callback_url'))
    assert.equal(callback.hostname, 'localhost')
    assert.equal((await fetch(new URL('/wrong', callback))).status, 404)
    callback.searchParams.set('code', 'fictional-code')
    await fetch(callback)
  }
  const { service, prefs, vault } = fixture(call => {
    assert.equal(call.url, 'https://openrouter.ai/api/v1/auth/keys')
    assert.equal(call.body.code, 'fictional-code')
    assert.equal(call.body.code_challenge_method, 'S256')
    verifier = call.body.code_verifier
    assert.equal(createHash('sha256').update(verifier).digest('base64url'), challenge)
    return { key: 'fictional-user-key' }
  }, { openExternal })
  assert.equal(service.settings().openRouterSignIn, true)
  const state = await service.configure({ provider: 'openrouter', auth: 'oauth' })
  assert.equal(state.activeProvider, 'openrouter')
  assert.ok(!JSON.stringify([state, [...prefs]]).includes('fictional-user-key'))
  assert.ok(!JSON.stringify([...vault]).includes(verifier))
  const first = challenge
  await service.configure({ provider: 'openrouter', auth: 'oauth' })
  assert.notEqual(first, challenge)
})

test('interrupted OpenRouter sign-in cannot resurrect a disconnected account', async () => {
  let opened
  const waiting = new Promise(resolve => { opened = resolve })
  const { service, vault, calls } = fixture(undefined, { openExternal: opened })
  const pending = service.configure({ provider: 'openrouter', auth: 'oauth' })
  const rejection = assert.rejects(pending, /canceled/)
  const callback = new URL((new URL(await waiting)).searchParams.get('callback_url'))
  await service.disconnect({ provider: 'openrouter' })
  await rejection
  assert.equal(service.settings().activeProvider, null)
  assert.equal(vault.size, 0)
  assert.equal(calls.length, 0)
  await assert.rejects(fetch(callback))
})

test('without a browser opener, keys remain available and account sign-in is disabled', async () => {
  const { service } = fixture()
  assert.equal(service.settings().openRouterSignIn, false)
  await assert.rejects(service.configure({ provider: 'openrouter', auth: 'oauth' }), /browser sign-in/)
  assert.equal((await service.configure({ provider: 'openrouter', apiKey: 'fictional' })).activeProvider, 'openrouter')
})

test('drafts use selected facts from the reviewed profile, including edited excerpt facts', async () => {
  const { service, calls } = fixture(() => ({ choices: [{ message: { content: 'Draft.' } }] }))
  await service.configure({ provider: 'openai', apiKey: 'fictional' })
  const profile = { ...sample.profile, resumeText: 'deselected original', confirmedFacts: [{ text: 'Edited catalog fact', quote: 'raw source excerpt', source: 'private file name' }] }
  await service.draft({ profile, job: sample.job })
  let prompt = JSON.stringify(calls.at(-1).body)
  assert.match(prompt, /Edited catalog fact/)
  assert.doesNotMatch(prompt, /deselected original|raw source excerpt|private file name/)
  await service.draft({ profile: { ...profile, confirmedFacts: [] }, job: sample.job })
  assert.doesNotMatch(JSON.stringify(calls.at(-1).body), /deselected original/)
  const { confirmedFacts, ...legacyProfile } = profile
  await service.draft({ profile: legacyProfile, job: sample.job })
  assert.match(JSON.stringify(calls.at(-1).body), /deselected original/)
})

test('canceling a replacement sign-in preserves the current connection and never exchanges the code', async () => {
  let opened
  const waiting = new Promise(resolve => { opened = resolve })
  const { service, vault, calls } = fixture(undefined, { openExternal: opened })
  await service.configure({ provider: 'openrouter', apiKey: 'existing-test-key' })
  const pending = service.configure({ provider: 'openrouter', auth: 'oauth' })
  const rejection = assert.rejects(pending, /canceled/)
  await waiting
  await service.configure({ provider: 'openrouter', auth: 'cancel' })
  await rejection
  assert.equal(service.settings().activeProvider, 'openrouter')
  assert.ok(JSON.stringify([...vault]).includes('existing-test-key'))
  assert.equal(calls.length, 0)
})

test('subscription drafts use the signed-in CLI, expose only selected fields, and never request an API key', async () => {
  let state = 'chatgpt'
  const prompts = []
  const codex = {
    status: async () => ({ state, email: 'omit-this-account-detail' }),
    login: () => assert.fail('an existing ChatGPT session can be reused'),
    draft: async (instructions, prompt) => { prompts.push([instructions, JSON.parse(prompt)]); return 'Draft via Codex.' },
  }
  const { service, vault, calls, deps } = fixture(undefined, { codex })
  assert.deepEqual(await service.subscriptionStatus(), { state: 'chatgpt' })
  assert.equal((await service.configure({ provider: 'codex' })).activeProvider, 'codex')
  await service.test({ provider: 'codex' })
  assert.equal(prompts.length, 0)
  const restored = createProviders(deps)
  const profile = { ...sample.profile, resumeText: 'deselected', confirmedFacts: [{ text: 'Approved example fact' }] }
  assert.equal(await restored.draft({ ...sample, profile }), 'Draft via Codex.')
  assert.ok(prompts[0][1].profile.confirmedFacts.includes('Approved example fact'))
  assert.doesNotMatch(JSON.stringify(prompts), /private-phone|private-receipt|deselected/)
  state = 'other'
  await assert.rejects(restored.draft(sample), /another login method/)
  assert.equal(prompts.length, 1)
  assert.equal(calls.length, 0)
  assert.equal(vault.size, 0)
  assert.equal((await restored.disconnect({ provider: 'codex' })).activeProvider, null)
  assert.equal(state, 'other')
})

test('browser login is explicit, never replaces an API login, and keeps the previous provider on failure', async () => {
  let state = 'signedOut', logins = 0
  const codex = {
    status: async () => ({ state }),
    login: async () => { logins++; state = 'chatgpt' },
  }
  const { service } = fixture(undefined, { codex })
  await service.configure({ provider: 'openai', apiKey: 'fictional' })
  await assert.rejects(service.configure({ provider: 'codex' }), /Sign in with ChatGPT/)
  assert.equal(logins, 0)
  for (const current of ['missing', 'unsupported', 'other']) {
    state = current
    await assert.rejects(service.configure({ provider: 'codex', auth: 'login' }))
    assert.equal(logins, 0)
    assert.equal(service.settings().activeProvider, 'openai')
  }
  state = 'signedOut'
  for (const options of [{ apiKey: 'fictional' }, { model: '--unsafe' }, { endpoint: 'https://example.org' }]) {
    await assert.rejects(service.configure({ provider: 'codex', ...options }))
  }
  assert.equal((await service.configure({ provider: 'codex', auth: 'login' })).activeProvider, 'codex')
  assert.equal(logins, 1)
})

test('canceling a pending ChatGPT login cannot activate the subscription later', async () => {
  let started, finish, state = 'signedOut'
  const waiting = new Promise(resolve => { started = resolve })
  const codex = {
    status: async () => ({ state }),
    login: async () => { started(); await new Promise(resolve => { finish = resolve }); state = 'chatgpt' },
  }
  const { service } = fixture(undefined, { codex })
  const attempt = service.configure({ provider: 'codex', auth: 'login' })
  await waiting
  await service.configure({ provider: 'openrouter', auth: 'cancel' })
  await service.configure({ provider: 'codex', auth: 'cancel' })
  finish()
  await assert.rejects(attempt, /canceled/)
  assert.equal(service.settings().activeProvider, null)
})
