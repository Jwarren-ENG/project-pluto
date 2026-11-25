import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, chmod } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createCodexSession } from '../desktop/codex.mjs'

const provider = 'https://chatgpt.com/backend-api/codex'
const catalog = { models: [{ slug: 'example-model', visibility: 'list', apply_patch_tool_type: 'freeform', tool_mode: 'code_mode_only' }] }
async function fixture(t, options = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'pluto-cli-test-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const original = path.join(home, '.codex')
  await mkdir(original)
  await mkdir(path.join(home, '.project-pluto', 'codex-auth'), { recursive: true })
  await writeFile(path.join(original, 'auth.json'), 'synthetic credential fixture')
  const calls = [], messages = []
  let signedIn = false
  const signin = state => ({ chatgpt: 'Logged in using ChatGPT', other: 'Logged in using an API key - secret-fixture', signedOut: 'Not logged in' })[state]
  function spawn(exe, args, opts) {
    const c = new EventEmitter()
    c.stdout = new PassThrough()
    c.stderr = new PassThrough()
    const log = { exe, args, opts, killed: false }
    calls.push(log)
    const send = obj => c.stdout.write(JSON.stringify(obj) + '\n')
    const close = code => setImmediate(() => c.emit('close', code))
    c.kill = () => { log.killed = true; close(null); return true }
    c.stdin = new Writable({ write(data, _, cb) {
      const m = JSON.parse(data.toString())
      messages.push(m)
      setImmediate(() => {
        const reply = result => send({ id: m.id, result })
        if (m.method === 'initialize') reply({})
        if (m.method === 'config/read') reply({ config: { model_provider: 'openai', forced_login_method: 'chatgpt', openai_base_url: provider,
          chatgpt_base_url: 'https://chatgpt.com/backend-api/', ...options.config } })
        if (m.method === 'account/read') reply({ account: { type: options.account || 'chatgpt' } })
        if (m.method === 'model/list') reply(m.params.cursor
          ? { data: [{ model: 'example-model' }, { model: 'beta', displayName: 'Beta', isDefault: true }], nextCursor: options.loop ? 'p2' : null }
          : { data: [{ model: 'not-visible', hidden: true }, { model: 'example-model' }], nextCursor: 'p2' })
        if (m.method === 'thread/start') reply({ thread: { id: 't', ephemeral: true, environments: [], path: null }, modelProvider: 'openai',
          model: 'example-model', sandbox: { type: 'readOnly' }, approvalPolicy: 'never', runtimeWorkspaceRoots: [], ...options.thread })
        if (m.method === 'turn/start') {
          reply({ turn: { id: 'a' } })
          if (options.hold) return options.hold()
          if (options.interaction) return send({ id: 55, method: 'item/tool/requestUserInput', params: {} })
          const status = options.info ? 'failed' : 'completed'
          send({ method: 'turn/completed', params: { threadId: 't', turn: { id: 'a', status,
            error: options.info && { codexErrorInfo: options.info, message: 'secret-fixture usage limit exceeded' },
            items: [{ type: 'agentMessage', text: options.text || 'synthetic draft' }] } } })
        }
      })
      cb()
    } })
    if (args.at(-1) === 'status') setImmediate(() => {
      const state = opts.env.CODEX_HOME === original ? options.original || 'chatgpt' : options.overlay || (signedIn ? 'chatgpt' : options.original || 'chatgpt')
      c.stderr.write(signin(state) + '\n')
      close(state === 'signedOut' ? 1 : 0)
    })
    if (args.at(-1) === 'login') setImmediate(() => { signedIn = true; c.stderr.write('sensitive login link fixture'); close(0) })
    if (args.at(-1) === 'models') setImmediate(() => { c.stdout.write(JSON.stringify(catalog)); close(0) })
    return c
  }
  const env = { HOME: home, APPDATA: home, PATH: home, OPENAI_API_KEY: 'secret-fixture', OPENAI_BASE_URL: 'http://wrong.invalid',
    HTTPS_PROXY: 'http://wrong.invalid', CODEX_API_KEY: 'secret-fixture', NODE_OPTIONS: 'untrusted' }
  const session = createCodexSession({ env, home, temp: home, spawn, platform: 'darwin', arch: 'arm64',
    locate: async () => ({ binary: '/fixture/native/codex' }), ...options.session })
  return { session, calls, messages, home }
}

test('signed-in draft pins transport and model, isolates tools and sends reviewed text only over stdin', async t => {
  let release
  const reached = new Promise(resolve => { release = resolve })
  const { session, calls, messages, home } = await fixture(t, { hold: release })
  const controller = new AbortController()
  const draft = session.draft('Reviewed writing request', 'Untrusted employer text', controller.signal, 'example-model')
  await reached
  const server = calls.find(c => c.args.includes('app-server'))
  assert.equal(server.opts.shell, false)
  assert.ok(path.isAbsolute(server.exe))
  const params = messages.find(m => m.method === 'thread/start').params
  assert.equal(params.developerInstructions, 'Reviewed writing request')
  assert.equal(params.allowProviderModelFallback, false)
  assert.equal(params.model, 'example-model')
  for (const name of ['environments','runtimeWorkspaceRoots','selectedCapabilityRoots','dynamicTools']) assert.deepEqual(params[name], [])
  assert.equal(params.ephemeral, true)
  assert.equal(params.approvalPolicy, 'never')
  assert.equal(params.sandbox, 'read-only')
  assert.deepEqual(JSON.parse(messages.find(m => m.method === 'turn/start').params.input[0].text), { reviewedMaterial: 'Untrusted employer text' })
  for (const call of calls) {
    assert.doesNotMatch(call.args.join(' '), /Reviewed writing request|Untrusted employer text|secret-fixture/)
    for (const name of ['OPENAI_API_KEY','OPENAI_BASE_URL','HTTPS_PROXY','CODEX_API_KEY','NODE_OPTIONS']) assert.equal(call.opts.env[name], undefined)
  }
  const file = JSON.parse(server.args.find(arg => arg.startsWith('model_catalog_json=')).split('=').slice(1).join('='))
  const preset = JSON.parse(await readFile(file)).models[0]
  assert.equal(preset.apply_patch_tool_type, null)
  assert.equal(preset.shell_type, 'disabled')
  assert.equal(preset.tool_mode, 'direct')
  assert.equal(preset.multi_agent_version, 'disabled')
  assert.deepEqual(preset.experimental_supported_tools, [])
  controller.abort('secret-fixture')
  await assert.rejects(draft, /^Error: Codex drafting was cancelled/)
  assert.equal(server.killed, true)
  assert.deepEqual((await readdir(home)).filter(name => name.startsWith('pluto-draft-')), [])
})

test('default model and text result', async t => {
  const { session, messages } = await fixture(t)
  assert.deepEqual(await session.status(), { state: 'chatgpt' })
  assert.equal(await session.draft('instructions', 'material'), 'synthetic draft')
  assert.equal(messages.find(m => m.method === 'thread/start').params.model, null)
})

test('model picker uses account model/list, filters hidden entries, paginates and deduplicates', async t => {
  const { session, messages, calls } = await fixture(t)
  assert.deepEqual(await session.models(), [{ id: 'example-model', label: 'example-model', recommended: false }, { id: 'beta', label: 'Beta', recommended: true }])
  assert.deepEqual(messages.filter(m => m.method === 'model/list').map(m => m.params.cursor), [null, 'p2'])
  assert.equal(messages.some(m => m.method === 'turn/start'), false)
  assert.equal(calls.some(c => c.args.includes('debug')), false)
  const loop = await fixture(t, { loop: true })
  await assert.rejects(loop.session.models(), /isolated/)
})

test('other auth is preserved, missing and unsupported CLI are distinguishable', async t => {
  const { session, calls } = await fixture(t, { original: 'other' })
  assert.deepEqual(await session.status(), { state: 'other' })
  await assert.rejects(session.login(), /another authentication method/)
  await assert.rejects(session.draft('x','y'), /Connect/)
  await assert.rejects(session.models(), /Connect/)
  assert.ok(calls.every(c => c.args.join(' ') === 'login status'))
  for (const state of ['missing','unsupported']) {
    const f = await fixture(t, { session: { locate: async () => ({ state }) } })
    assert.deepEqual(await f.session.status(), { state })
  }
})

test('signed out opens official native login once and verifies the resulting state', async t => {
  const { session, calls } = await fixture(t, { original: 'signedOut' })
  assert.deepEqual(await session.status(), { state: 'signedOut' })
  const first = session.login()
  await assert.rejects(session.login(), /already in progress/)
  assert.deepEqual(await first, { state: 'chatgpt' })
  assert.deepEqual(await session.login(), { state: 'chatgpt' })
  const logins = calls.filter(c => c.args.at(-1) === 'login')
  assert.equal(logins.length, 1)
  assert.ok(logins[0].args.includes('forced_login_method="chatgpt"'))
  assert.ok(!logins[0].args.includes('--with-api-key'))
})

test('rejects invalid or oversized UTF-8 input, pre-cancel and argument injection before launch', async t => {
  const { session, calls } = await fixture(t)
  for (const input of [null, {}, '', '🙂'.repeat(24576)]) await assert.rejects(session.draft('i',input), /96 KiB/)
  await assert.rejects(session.draft('i','u',undefined,'-c bad'), /model/)
  await assert.rejects(session.draft('i','u',AbortSignal.abort()), /cancelled/)
  assert.equal(calls.length, 0)
})

test('unapproved identity, settings, tools and workspace changes fail before the reviewed turn', async t => {
  for (const options of [{ account: 'apiKey' }, { config: { openai_base_url: 'https://other.invalid' } },
    { config: { mcp_servers: { fixture: {} } } }, { thread: { runtimeWorkspaceRoots: ['/other'] } }]) {
    const { session, messages } = await fixture(t, options)
    await assert.rejects(session.draft('i','u'), e => !e.code && !e.message.includes('secret-fixture'))
    assert.equal(messages.some(m => m.method === 'turn/start'), false)
  }
  for (const options of [{ interaction: true }, { text: 'x'.repeat(32769) }]) {
    const { session } = await fixture(t, options)
    await assert.rejects(session.draft('i','u'), /isolated/)
  }
})

test('only the structured subscription usage limit allows fallback', async t => {
  for (const info of ['usageLimitExceeded','rateLimitExceeded','unauthorized','serverOverloaded','sessionBudgetExceeded', {httpConnectionFailed:{httpStatusCode:401}}]) {
    const { session } = await fixture(t, { info })
    await assert.rejects(session.draft('i','u'), e => e.code === (info === 'usageLimitExceeded' ? 'MODEL_QUOTA' : undefined) && !e.message.includes('secret-fixture'))
  }
})

test('Windows global npm uses the native payload even when a command shim exists', async t => {
  const { home, session, calls } = await fixture(t, { session: { locate: undefined, arch: 'x64', platform: 'win32' } })
  const root = path.join(home,'npm','node_modules','@openai','codex')
  const dir = path.join(root,'node_modules','@openai','codex-win32-x64','vendor','x86_64-pc-windows-msvc','bin')
  await mkdir(dir,{recursive:true})
  await writeFile(path.join(root,'package.json'), JSON.stringify({name:'@openai/codex',repository:{url:'git+https://github.com/openai/codex.git'}}))
  await writeFile(path.join(home,'npm','codex.cmd'), 'unused fixture')
  const native = path.join(dir,'codex.exe')
  await writeFile(native,'fixture'); await chmod(native,0o700)
  await session.status()
  assert.equal(path.basename(calls[0].exe),'codex.exe')
  assert.equal(calls[0].opts.shell,false)
})
