import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import * as fs from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

const NODE = '24.22.3'
const OMNI = '3.8.54'
const HOST = '127.0.0.1'
const archiveLimit = 100 * 1024 * 1024
const manifestDirectory = fileURLToPath(new URL('./omniroute-runtime/', import.meta.url))
// https://nodejs.org/dist/v24.22.3/SHASUMS256.txt
const hashes = {
  'darwin-arm64': 'ff6e17d4874b76d272212b908cc020d6e815fba5a6c7eaaa06add725840307fd',
  'darwin-x64': '977614af0504c81045e7fd85596dbca0e5f951b96681516dadafedcca8c447f7',
  'linux-arm64': '261af2af250dfd7e9f25cf151d1b2713a0adf8f10a9ad116c4947f68627affe8',
  'linux-x64': '061ec3e3062115705b56b51fa9cc330ab50d34b6969387d4e4b1a50c6809acc2',
  'win-arm64': 'b3cc74a295b39d4f273271e96f58c06dd2b35757ca12abec64c7d0598b434f14',
  'win-x64': 'e612af99f626ab415ea225af6bce5c971feb448cb5cae250bb1c3fa50c5f7d9f',
}
const windows = process.platform === 'win32'
const target = (windows ? 'win' : process.platform) + '-' + process.arch
const nodeFolder = 'node-v' + NODE + '-' + target
const archiveName = nodeFolder + (windows ? '.zip' : '.tar.gz')
const randomSecret = () => randomBytes(32).toString('hex')
class RuntimeError extends Error {}
const safeError = text => new RuntimeError(text)

function paths(root) {
  const nodeRoot = path.join(root, nodeFolder)
  const app = path.join(root, 'app')
  const pkg = path.join(app, 'node_modules', 'omniroute')
  return {
    node: path.join(nodeRoot, windows ? 'node.exe' : 'bin/node'),
    npm: path.join(nodeRoot, windows ? 'node_modules/npm/bin/npm-cli.js' : 'lib/node_modules/npm/bin/npm-cli.js'),
    app, pkg, entry: path.join(pkg, 'dist/server-ws.mjs'), tokenHelper: path.join(pkg, 'bin/cli/utils/cliToken.mjs'),
  }
}

function privateEnvironment(home, node) {
  const binaries = windows ? path.join(process.env.SystemRoot, 'System32') : '/usr/bin:/bin:/usr/sbin:/sbin'
  return {
    PATH: path.dirname(node) + path.delimiter + binaries, HOME: home, USERPROFILE: home,
    APPDATA: home, LOCALAPPDATA: home, XDG_CONFIG_HOME: home, XDG_DATA_HOME: home, XDG_CACHE_HOME: home,
    TMPDIR: home, TEMP: home, TMP: home, ...(windows && { SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec }),
    NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1', NO_COLOR: '1',
    npm_config_userconfig: windows ? 'NUL' : '/dev/null', npm_config_globalconfig: path.join(home, 'empty.npmrc'),
    npm_config_update_notifier: 'false', npm_config_ignore_scripts: 'true', npm_config_fetch_retries: '1',
  }
}

function launch(executable, args, options, signal, { ipc = false, capture = false } = {}) {
  signal.throwIfAborted()
  const child = spawn(executable, args, { ...options, windowsHide: true, shell: false,
    stdio: ['ignore', capture ? 'pipe' : 'ignore', 'ignore', ...(ipc ? ['ipc'] : [])] })
  const exited = new AbortController()
  const kill = () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') }
  signal.addEventListener('abort', kill, { once: true })
  const done = new Promise((resolve, reject) => {
    child.once('error', () => reject(safeError('The private OmniRoute process could not start.')))
    child.once('close', code => code === 0 ? resolve() : reject(safeError('The private OmniRoute process stopped.')))
  }).finally(() => { signal.removeEventListener('abort', kill); exited.abort() })
  // A server may exit at any point after start() returns.
  void done.catch(() => {})
  return { child, done, kill, exited: exited.signal }
}

async function downloadNode(file, fetchImpl, signal, progress) {
  const url = 'https://nodejs.org/dist/v' + NODE + '/' + archiveName
  const response = await fetchImpl(url, { signal, redirect: 'error', headers: { 'Accept-Encoding': 'identity' } })
  const rawLength = response.headers.get('content-length')
  const totalBytes = rawLength === null ? null : Number(rawLength)
  if (!response.ok || !response.body || (totalBytes !== null && (!Number.isSafeInteger(totalBytes) || totalBytes <= 0 || totalBytes > archiveLimit))) {
    void response.body?.cancel().catch(() => {})
    throw safeError('The official Node.js download is unavailable or too large.')
  }
  let bytes = 0
  const digest = createHash('sha256')
  const measured = new Transform({ transform(chunk, encoding, callback) {
    bytes += chunk.length
    if (bytes > archiveLimit) return callback(safeError('The Node.js download exceeded its size limit.'))
    digest.update(chunk)
    progress({ phase: 'downloading', bytes, totalBytes })
    callback(null, chunk)
  } })
  await pipeline(Readable.fromWeb(response.body), measured, createWriteStream(file, { flags: 'wx', mode: 0o600 }), { signal })
  if ((totalBytes !== null && bytes !== totalBytes) || digest.digest('hex') !== hashes[target]) {
    throw safeError('The official Node.js download did not match its pinned checksum.')
  }
}

// npm's content-addressable cache contains completed, integrity-checked downloads.
// The lock fixes their identities, but npm exposes no authoritative total download size.
async function cacheBytes(dir) {
  let entries
  try { entries = await fs.readdir(dir, { withFileTypes: true }) }
  catch (error) { if (error.code === 'ENOENT') return 0; throw error }
  let bytes = 0
  for (const entry of entries) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) bytes += await cacheBytes(file)
    else if (entry.isFile()) bytes += (await fs.stat(file)).size
  }
  return bytes
}

async function installPackages(layout, env, home, signal, progress) {
  const cache = path.join(home, 'cache')
  const run = launch(layout.node, [layout.npm, 'ci', '--ignore-scripts', '--no-audit', '--no-fund', '--omit=dev',
    '--registry=https://registry.npmjs.org/', '--cache=' + cache], { cwd: layout.app, env }, signal)
  let done = false
  const track = async () => {
    while (!done && !signal.aborted) {
      const bytes = await cacheBytes(path.join(cache, '_cacache/content-v2'))
      if (done || signal.aborted) return
      if (bytes > 1536 * 1024 * 1024) { run.kill(); throw safeError('The private dependency download exceeded its size limit.') }
      progress({ phase: 'installing', bytes, totalBytes: null })
      await delay(1000, undefined, { signal: run.exited }).catch(() => {})
    }
  }
  try { await Promise.all([run.done.finally(() => { done = true }), track()]) }
  finally { done = true; run.kill(); await run.done.catch(() => {}) }
}

async function install(directory, fetchImpl, signal, progress) {
  if (!hashes[target]) throw safeError('OmniRoute has no verified runtime for this platform.')
  const lockBytes = await fs.readFile(path.join(manifestDirectory, 'dependency-lock.json'))
  const manifest = await fs.readFile(path.join(manifestDirectory, 'package.json'))
  const lock = JSON.parse(lockBytes)
  if (JSON.parse(manifest).dependencies?.omniroute !== OMNI || lock.packages?.['node_modules/omniroute']?.version !== OMNI ||
      Object.entries(lock.packages).some(([name, p]) => name &&
        (!p.resolved?.startsWith('https://registry.npmjs.org/') || !/^sha512-[A-Za-z0-9+/]+=*$/.test(p.integrity || '')))) {
    throw safeError('The packaged OmniRoute dependency lock could not be verified.')
  }
  const hash = createHash('sha256').update(lockBytes).digest('hex')
  const final = path.join(directory, 'runtime-' + nodeFolder + '-' + hash.slice(0, 16))
  async function installed() {
    try {
      const layout = paths(final)
      if ((await fs.readFile(path.join(final, '.complete'), 'utf8')) !== hash ||
          JSON.parse(await fs.readFile(path.join(layout.pkg, 'package.json'))).version !== OMNI) return false
      await Promise.all([layout.node, layout.entry, layout.tokenHelper].map(p => fs.access(p)))
      return true
    } catch { return false }
  }
  if (await installed()) return paths(final)
  const stage = await fs.mkdtemp(path.join(directory, 'install-'))
  try {
    const archive = path.join(stage, archiveName)
    await downloadNode(archive, fetchImpl, signal, progress)
    const layout = paths(stage)
    const home = path.join(stage, 'install-home')
    await fs.mkdir(home, { mode: 0o700 })
    const env = privateEnvironment(home, layout.node)
    progress({ phase: 'installing', bytes: 0, totalBytes: null })
    const tar = windows ? path.join(process.env.SystemRoot, 'System32', 'tar.exe') : '/usr/bin/tar'
    await launch(tar, ['-xf', archive, '-C', stage], { cwd: stage, env }, signal).done
    await fs.mkdir(layout.app, { mode: 0o700 })
    await fs.writeFile(path.join(layout.app, 'package.json'), manifest)
    await fs.writeFile(path.join(layout.app, 'package-lock.json'), lockBytes)
    await installPackages(layout, env, home, signal, progress)
    await fs.access(layout.entry)
    await fs.unlink(archive)
    await fs.rm(home, { recursive: true, force: true })
    signal.throwIfAborted()
    await fs.writeFile(path.join(stage, '.complete'), hash, { mode: 0o600 })
    try { await fs.rename(stage, final) } catch (error) {
      // A concurrent Pluto install may have published the same immutable runtime.
      if (!await installed()) throw error
    }
    return paths(final)
  } finally { await fs.rm(stage, { recursive: true, force: true }) }
}

async function availablePort() {
  const socket = net.createServer()
  await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, HOST, resolve) })
  const { port } = socket.address()
  await new Promise((resolve, reject) => socket.close(error => error ? reject(error) : resolve()))
  return port
}

// The subprocess reports its own successful bind, and exits if its Electron parent dies.
// This verifies listener ownership before transmitting even the local management credential.
const supervisor = `
import net from 'node:net'
import { rmSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
process.on('disconnect', () => {
  try { rmSync(process.env.DATA_DIR, { recursive: true, force: true }) } finally { process.exit(0) }
})
if (process.platform !== 'win32') process.umask(0o077)
const listen = net.Server.prototype.listen
net.Server.prototype.listen = function (...args) {
  this.once('listening', () => {
    const address = this.address()
    if (address?.port === Number(process.env.PORT) && address.address === '127.0.0.1') process.send({ bound: address.port })
  })
  return listen.apply(this, args)
}
await import(pathToFileURL(process.argv[1]).href)
`

export function createOmniRoute({ directory, fetchImpl = globalThis.fetch }) {
  if (!path.isAbsolute(directory)) throw safeError('OmniRoute requires an absolute private directory.')
  let starting, active, stopping
  async function run(job, callerSignal, progress) {
    const timeout = AbortSignal.timeout(12 * 60_000)
    const signal = AbortSignal.any([job.control.signal, timeout, ...(callerSignal ? [callerSignal] : [])])
    try {
      signal.throwIfAborted()
      await fs.mkdir(directory, { recursive: true, mode: 0o700 })
      const root = await fs.lstat(directory)
      if (!root.isDirectory() || (!windows && (root.mode & 0o077))) throw safeError('OmniRoute requires a private runtime directory.')
      const layout = await install(directory, fetchImpl, signal, progress)
      signal.throwIfAborted()
      progress({ phase: 'starting', bytes: 0, totalBytes: null })
      job.home = await fs.mkdtemp(path.join(directory, 'session-'))
      const port = await availablePort()
      const env = { ...privateEnvironment(job.home, layout.node), DATA_DIR: job.home, HOSTNAME: HOST,
        APP_BIND_HOST: HOST, PORT: String(port), LIVE_WS_HOST: HOST, EMBED_WS_PROXY_HOST: HOST,
        EMBED_WS_PROXY_PORT: String(await availablePort()), OMNIROUTE_ENABLE_LIVE_WS: '0', REQUIRE_API_KEY: 'true', ENABLE_REQUEST_LOGS: 'false',
        OMNIROUTE_EMERGENCY_FALLBACK: 'false', OMNIROUTE_PREFERRED_ACCOUNT_FAILOVER_ENABLED: 'false',
        OMNIROUTE_CONTROL_PLANE_PROXY_DIRECT_FALLBACK: 'false', OMNIROUTE_CLOUD_SYNC_SECRETS: 'false', INITIAL_PASSWORD: randomSecret(), JWT_SECRET: randomSecret(),
        API_KEY_SECRET: randomSecret(), STORAGE_ENCRYPTION_KEY: randomSecret(), OMNIROUTE_CLI_SALT: randomSecret() }
      const helper = 'import { getCliToken } from ' + JSON.stringify(pathToFileURL(layout.tokenHelper).href) + ';process.stdout.write(await getCliToken())'
      const derive = launch(layout.node, ['--input-type=module', '-e', helper], { cwd: layout.pkg, env }, signal, { capture: true })
      let cliToken = ''
      for await (const chunk of derive.child.stdout) {
        cliToken += chunk
        if (cliToken.length > 64) { derive.kill(); throw safeError('OmniRoute local authentication is unavailable.') }
      }
      await derive.done
      if (!/^[a-f0-9]{64}$/.test(cliToken)) throw safeError('OmniRoute local authentication is unavailable.')
      signal.throwIfAborted()
      const server = launch(layout.node, ['--input-type=module', '-e', supervisor, layout.entry],
        { cwd: layout.pkg, env }, job.control.signal, { ipc: true })
      job.server = server
      const boot = AbortSignal.any([signal, server.exited, AbortSignal.timeout(60_000)])
      const bound = new Promise(resolve => server.child.on('message', message => { if (message?.bound === port) resolve() }))
      await waitForBound(bound, boot)
      const baseURL = 'http://' + HOST + ':' + port + '/v1'
      const management = 'http://' + HOST + ':' + port + '/api/providers?provider=openrouter&limit=2'
      // The production entry attaches the socket's loopback provenance used by CLI authentication.
      const get = headers => fetchImpl(management, { headers, signal: boot, redirect: 'error' })
      const denied = await get({})
      void denied.body?.cancel().catch(() => {})
      if (![401, 403].includes(denied.status)) throw safeError('The private OmniRoute management API requires authentication.')
      const authenticated = await get({ 'x-omniroute-cli-token': cliToken })
      void authenticated.body?.cancel().catch(() => {})
      if (!authenticated.ok) throw safeError('OmniRoute did not accept its private local credential.')
      boot.throwIfAborted()
      job.result = { baseURL, cliToken, signal: server.exited }
      return job.result
    } catch (error) {
      job.control.abort()
      if (job.server) await job.server.done.catch(() => {})
      await clean(job)
      if (signal.aborted && (callerSignal?.aborted || timeout.aborted)) throw safeError('OmniRoute setup was cancelled or timed out.')
      throw error instanceof RuntimeError ? error : safeError('OmniRoute could not install or start its verified private runtime.')
    }
  }
  async function clean(job) {
    if (job.home) await fs.rm(job.home, { recursive: true, force: true })
    if (active === job) active = undefined
  }
  function start({ signal, onProgress = () => {} } = {}) {
    if (signal?.aborted) return Promise.reject(safeError('OmniRoute setup was cancelled.'))
    if (stopping) return stopping.then(() => start({ signal, onProgress }))
    if (starting) return starting
    if (active?.result && !active.result.signal.aborted) return Promise.resolve(active.result)
    const job = { control: new AbortController() }
    const previous = active
    active = job
    starting = (async () => {
      if (previous) await clean(previous)
      return run(job, signal, onProgress)
    })().finally(() => { starting = undefined })
    return starting
  }
  function stop() {
    if (stopping) return stopping
    const job = active
    if (!job) return Promise.resolve()
    job.control.abort()
    stopping = (async () => {
      await starting?.catch(() => {})
      await job.server?.done.catch(() => {})
      await clean(job)
    })().finally(() => { stopping = undefined })
    return stopping
  }
  return { start, stop }
}

function waitForBound(bound, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(safeError('The private OmniRoute listener did not start.'))
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    bound.then(() => { signal.removeEventListener('abort', abort); resolve() })
  })
}
