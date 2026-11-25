const ROOT = 'https://openrouter.ai/api/v1'
const CATALOG = ROOT + '/models?max_price=0&input_modalities=text&output_modalities=text'
const AUTO = 'openrouter/free'
const PREF = 'freeFallback'
const SECRET = 'freeFallback.openrouterKey'
const OWNER = 'Project Pluto free fallback'
const previousOwner = 'PROJECT PLUTO free fallback'
const CATALOG_LIMIT = 4 * 1024 * 1024
const LOCAL_ID = /^[a-zA-Z0-9_-]{1,128}$/

class FallbackError extends Error {}
const fail = message => new FallbackError(message)
const messageFor = error => error instanceof FallbackError ? error.message : 'Free fallback could not complete. Check the connection and try again.'
const zero = value => value === 0 || (typeof value === 'string' && /^0+(?:\.0+)?$/.test(value))
const token = value => typeof value === 'string' && /^[!-~]{1,2048}$/.test(value)

function freeModels(data) {
  if (!Array.isArray(data)) throw fail('OpenRouter returned an invalid model catalog.')
  const choices = new Map()
  for (const m of data) {
    if (typeof m?.id !== 'string' || m.id.length > 240 || !/^[\w.-]+\/[\w.-]+:free$/.test(m.id)) continue
    const { pricing, architecture } = m
    if (!zero(pricing?.prompt) || !zero(pricing?.completion)) continue
    // Ancillary prices and price overrides cannot make a selectable model billable.
    if (!Object.values(pricing).every(zero)) continue
    if (!Array.isArray(architecture?.input_modalities) || !architecture.input_modalities.includes('text') ||
        !Array.isArray(architecture.output_modalities) || !architecture.output_modalities.includes('text')) continue
    const label = typeof m.name === 'string' && m.name.trim() ? m.name.trim().slice(0, 180) : m.id
    const created = m.created * 1000
    choices.set(m.id, { id: m.id, label, ...(Number.isSafeInteger(m.created) && created > 0 &&
      Number.isSafeInteger(created) && { created }) })
  }
  const models = [...choices.values()].sort((a, b) => (b.created || 0) - (a.created || 0) || a.id.localeCompare(b.id))
  if (!models.length || models.length > 999) throw fail('OpenRouter did not return a usable catalog of free text models.')
  return models
}

function localGateway(result) {
  const url = typeof result?.baseURL === 'string' && URL.parse(result.baseURL)
  if (!url || !['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) ||
      !url.port || !/^\/v1\/?$/.test(url.pathname) || url.username || url.password || url.search || url.hash) {
    throw fail('OmniRoute must provide a private loopback API address.')
  }
  if ((result.apiKey != null && !token(result.apiKey)) || (result.cliToken != null && !token(result.cliToken)) ||
      !(result.apiKey || result.cliToken)) throw fail('OmniRoute did not provide local authentication.')
  return {
    origin: url.origin,
    admin: result.cliToken ? { 'x-omniroute-cli-token': result.cliToken } : { Authorization: 'Bearer ' + result.apiKey },
    inferenceKey: result.apiKey, lifetime: result.signal,
  }
}

function cancellableRead(read, signal) {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => reject(fail('Free fallback was cancelled.'))
    signal.addEventListener('abort', abort, { once: true })
    Promise.resolve().then(read).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

async function jsonRequest(fetchImpl, url, { signal, headers, method = 'GET', body, limit = 256 * 1024, progress }) {
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(60_000)])
  requestSignal.throwIfAborted()
  const response = await fetchImpl(url, {
    method, signal: requestSignal, redirect: 'error', cache: 'no-store',
    headers: { Accept: 'application/json', ...(body && { 'Content-Type': 'application/json' }), ...headers },
    ...(body && { body: JSON.stringify(body) }),
  })
  if (!response.ok) {
    void response.body?.cancel().catch(() => {})
    const error = fail('Free fallback request failed (HTTP ' + response.status + ').')
    error.httpStatus = response.status
    throw error
  }
  const reader = response.body?.getReader()
  if (!reader) throw fail('Free fallback received an empty response.')
  const abort = () => { void reader.cancel().catch(() => {}) }
  requestSignal.addEventListener('abort', abort, { once: true })
  try {
    const length = response.headers.get('content-length')
    const declared = length !== null && /^\d+$/.test(length) ? Number(length) : null
    if (declared !== null && declared > limit) throw fail('Free fallback response exceeded its size limit.')
    const total = response.headers.get('content-encoding') && response.headers.get('content-encoding') !== 'identity' ? null : declared
    const chunks = []
    let bytes = 0
    progress?.(0, total)
    for (;;) {
      requestSignal.throwIfAborted()
      const { done, value } = await reader.read()
      requestSignal.throwIfAborted()
      if (done) break
      bytes += value.byteLength
      if (bytes > limit) throw fail('Free fallback response exceeded its size limit.')
      chunks.push(value)
      progress?.(bytes, total)
    }
    if (total !== null && total !== bytes) throw fail('Free fallback download was incomplete.')
    progress?.(bytes, bytes)
    return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'))
  } finally {
    requestSignal.removeEventListener('abort', abort)
    abort()
    reader.releaseLock()
  }
}

export function createFreeFallback({ prefs, secrets, fetchImpl = globalThis.fetch, getOpenRouterKey, omniRoute }) {
  const saved = prefs.get(PREF)
  let consent = saved?.enabled === true
  let source = saved?.keySource === 'dedicated' ? 'dedicated' : 'standard'
  let selection = consent && typeof saved.selectedModel === 'string' && /^[\w.-]+\/[\w.-]+:free$/.test(saved.selectedModel) ? saved.selectedModel : AUTO
  let models = []
  let cachedModels = consent && Array.isArray(saved?.models) ? saved.models : []
  const initial = () => ({ enabled: consent, phase: consent ? 'starting' : 'off', stage: '', modelCount: 0,
    bytes: 0, totalBytes: null, error: null, hasKey: false })
  let state = initial()
  let session, gateway
  let closed = false
  let queue = Promise.resolve()
  function serialize(action) {
    const operation = queue.then(action)
    queue = operation.catch(() => {})
    return operation
  }
  const status = () => ({ ...state, hasKey: state.hasKey || prefs.get('providers.openrouter')?.configured === true, models: models.map(m => ({ ...m })), selectedModel: selection })
  function persist() { prefs.set(PREF, { enabled: consent, keySource: source, selectedModel: selection, models: cachedModels }) }

  // Release only resources created by this instance. The runner owns its isolated data directory.
  async function stop() {
    const local = gateway
    gateway = undefined
    if (!local) return
    try {
      if (local.lifetime?.aborted) return
      for (const route of [local.keyId && '/api/keys/' + local.keyId, local.connectionId && '/api/providers/' + local.connectionId]) {
        if (route) await jsonRequest(fetchImpl, local.origin + route, { method: 'DELETE', headers: local.admin,
          signal: local.lifetime ? AbortSignal.any([local.lifetime, AbortSignal.timeout(3_000)]) : AbortSignal.timeout(3_000) }).catch(() => {})
      }
    } finally {
      await omniRoute.stop()
    }
  }

  async function setup(controller, supplied) {
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15 * 60_000)])
    const check = () => signal.throwIfAborted()
    try {
      await stop()
      check()
      if (!omniRoute?.start || !omniRoute?.stop) throw fail('The managed OmniRoute gateway is unavailable.')
      let key = supplied ?? await cancellableRead(
        () => source === 'dedicated' ? secrets.get(SECRET) : getOpenRouterKey?.(), signal)
      check()
      if (!token(key)) throw fail('Enter an OpenRouter API key or connect OpenRouter first.')
      state.hasKey = true
      if (supplied !== undefined) {
        await secrets.set(SECRET, supplied)
        check()
      }
      state.phase = 'downloading'
      state.stage = 'catalog'
      const catalog = await jsonRequest(fetchImpl, CATALOG, {
        signal, limit: CATALOG_LIMIT, headers: { 'Accept-Encoding': 'identity' },
        progress(bytes, totalBytes) { check(); Object.assign(state, { bytes, totalBytes }) },
      })
      check()
      const eligible = freeModels(catalog.data)
      state.phase = 'checking'
      state.stage = 'credential'
      const keyInfo = await jsonRequest(fetchImpl, ROOT + '/key', { signal, headers: { Authorization: 'Bearer ' + key } })
      check()
      if (typeof keyInfo?.data?.label !== 'string' || keyInfo.data.is_management_key === true ||
          keyInfo.data.is_provisioning_key === true) throw fail('OpenRouter did not confirm a usable inference key.')

      Object.assign(state, { phase: 'starting', stage: 'gateway', bytes: 0, totalBytes: null })
      gateway = {} // The runner may partially start before its promise rejects.
      const config = await omniRoute.start({ signal, onProgress(update) {
        if (signal.aborted || state.stage !== 'gateway') return
        const bytes = Number.isSafeInteger(update?.bytes) && update.bytes >= 0 ? update.bytes : 0
        const totalBytes = Number.isSafeInteger(update?.totalBytes) && update.totalBytes >= bytes ? update.totalBytes : null
        Object.assign(state, { phase: ['installing', 'downloading', 'checking'].includes(update?.phase) ? update.phase : 'starting', bytes, totalBytes })
      } })
      check()
      gateway = localGateway(config)
      state.phase = 'checking'
      state.stage = 'registration'
      const local = gateway
      const localSignal = local.lifetime ? AbortSignal.any([signal, local.lifetime]) : signal
      const admin = (path, options = {}) => jsonRequest(fetchImpl, local.origin + path, { signal: localSignal, headers: local.admin, ...options })
      const list = await admin('/api/providers?provider=openrouter&limit=2')
      check()
      // A pin can be released by OmniRoute following exhaustion. Never share this pool with any other account.
      if (!Array.isArray(list.connections) || list.connections.length > 1 || list.total > 1) {
        throw fail('OmniRoute needs an isolated OpenRouter connection.')
      }
      const existing = list.connections[0]
      const existingOptions = existing?.providerSpecificData ?? {}
      if (existing && !((existing.name === OWNER || existing.name === previousOwner) && existing.provider === 'openrouter' &&
          typeof existing.id === 'string' && LOCAL_ID.test(existing.id) && !existing.proxyEnabled &&
          Object.keys(existingOptions).every(k => k === 'validationModelId' && existingOptions[k] === AUTO))) {
        throw fail('OmniRoute already has another OpenRouter connection.')
      }
      // The ordinary create endpoint starts an extra provider probe which can generate a completion.
      // We already authenticated against /key. Import exactly one connection without that second probe.
      const registration = existing
        ? await admin('/api/providers/' + existing.id, { method: 'PUT', body: { apiKey: key, isActive: true, name: OWNER } })
        : await admin('/api/providers/bulk', { method: 'POST', body: { provider: 'openrouter', validateKeys: false,
          entries: [{ name: OWNER, apiKey: key }], providerSpecificData: { validationModelId: AUTO } } })
      key = undefined
      const connection = existing ? registration?.connection : registration?.created?.[0]
      if ((!existing && (registration?.success !== 1 || registration?.failed !== 0 || registration?.created?.length !== 1)) ||
          !connection || typeof connection.id !== 'string' || !LOCAL_ID.test(connection.id) || connection.isActive !== true ||
          connection.provider !== 'openrouter' || connection.name !== OWNER || (existing && existing.id !== connection.id)) {
        throw fail('OmniRoute did not confirm the OpenRouter connection.')
      }
      local.connectionId = connection.id
      check()
      if (!local.inferenceKey) {
        const generated = await admin('/api/keys', { method: 'POST', body: {
          name: OWNER, modelAccessMode: 'restricted', allowedModels: [AUTO, ...eligible.map(m => m.id)].map(v => 'openrouter/' + v),
          allowedConnections: [connection.id], allowedCombos: [], noLog: true,
        } })
        if (!token(generated?.key) || typeof generated?.id !== 'string' || !LOCAL_ID.test(generated.id)) {
          throw fail('OmniRoute could not create a restricted inference key.')
        }
        local.keyId = generated.id
        local.inferenceKey = generated.key
      }
      check()
      localSignal.throwIfAborted()
      local.lifetime?.addEventListener('abort', () => {
        if (gateway === local && !controller.signal.aborted) {
          state.phase = 'error'
          state.error = 'The managed OmniRoute gateway stopped. Restart the fallback.'
        }
      }, { once: true })
      models = eligible
      cachedModels = eligible
      if (!eligible.some(m => m.id === selection)) selection = AUTO
      persist()
      Object.assign(state, { phase: 'ready', stage: '', modelCount: models.length })
    } catch (error) {
      if (!controller.signal.aborted) {
        state.phase = 'error'
        state.error = signal.aborted ? 'Free fallback setup timed out.' : messageFor(error)
      }
      await stop().catch(() => {})
    }
  }

  function begin(apiKey) {
    if (closed) throw fail('Free fallback is closed.')
    if (apiKey !== undefined && !token(apiKey)) throw fail('Enter a valid OpenRouter API key.')
    if (session && state.phase !== 'error' && apiKey === undefined) return status()
    session?.abort()
    session = new AbortController()
    consent = true
    if (apiKey !== undefined) source = 'dedicated'
    models = []
    state = initial()
    persist()
    const controller = session
    void serialize(() => setup(controller, apiKey))
    return status()
  }

  return {
    status,
    async enable({ apiKey } = {}) { return begin(apiKey) },
    async restore() { return consent ? begin() : status() },
    setModel({ model } = {}) {
      if (closed || state.phase !== 'ready' || !(model === AUTO || models.some(m => m.id === model))) {
        throw fail('Select an available free text model.')
      }
      selection = model
      persist()
      return status()
    },
    async disable() {
      session?.abort()
      session = undefined
      consent = false
      source = 'standard'
      selection = AUTO
      cachedModels = []
      models = []
      state = initial()
      persist()
      await serialize(async () => {
        try { await stop() } finally { await secrets.remove(SECRET) }
      }).catch(() => { throw fail('Free fallback was disabled, but local cleanup could not complete.') })
      return status()
    },
    async draft(instructions, user, callerSignal) {
      if (closed || !session || state.phase !== 'ready' || !gateway?.inferenceKey) throw fail('Free fallback is not ready.')
      if (![instructions, user].every(v => typeof v === 'string' && v.trim()) ||
          Buffer.byteLength(instructions) + Buffer.byteLength(user) > 256 * 1024) throw fail('Free fallback requires bounded text input.')
      const local = gateway
      const signal = AbortSignal.any([session.signal, ...[callerSignal, local.lifetime].filter(Boolean)])
      try {
        const data = await jsonRequest(fetchImpl, local.origin + '/v1/chat/completions', {
          signal, method: 'POST', headers: { Authorization: 'Bearer ' + local.inferenceKey, 'x-omniroute-connection': local.connectionId },
          body: { model: 'openrouter/' + selection, messages: [{ role: 'system', content: instructions }, { role: 'user', content: user }],
            provider: { allow_fallbacks: false, max_price: { prompt: 0, completion: 0, request: 0, image: 0, audio: 0 } },
            stream: false, max_tokens: 1200, modalities: ['text'], tools: [], tool_choice: 'none',
            plugins: ['web', 'file-parser', 'context-compression', 'fusion', 'response-healing', 'armor'].map(id => ({ id, enabled: false })) },
        })
        signal.throwIfAborted()
        const message = data?.choices?.[0]?.message
        if (data?.error || (data?.usage?.cost != null && !zero(data.usage.cost)) || message?.tool_calls?.length ||
            typeof message?.content !== 'string' || !message.content.trim()) throw fail('OmniRoute did not return a free text draft.')
        return message.content.trim()
      } catch (error) {
        if (!signal.aborted && gateway === local && (error.httpStatus === 401 || error.httpStatus === 403)) {
          state.phase = 'error'
          state.error = 'Free fallback authorization failed. Check the key and restart setup.'
        }
        throw fail(signal.aborted ? 'Free fallback draft was cancelled.' : messageFor(error))
      }
    },
    close() {
      closed = true
      session?.abort()
      return serialize(stop)
    },
  }
}

