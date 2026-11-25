// Local choices belong to a provider row. Never infer a backend from an email
// domain, from Mail permissions, or from the account ID supplied to a scan.
export function createMailRouting({ cloudMail, appleMail }) {
  const connecting = new Map()
  const disconnecting = new Set()
  const sources = new Set(['gmail', 'outlook', 'apple'])
  let closed = false

  function sourceOf(payload) {
    if (!sources.has(payload?.provider)) throw new Error('Choose a supported mail provider.')
    return payload.provider
  }
  const backend = provider => provider === 'apple' || appleMail.settings(provider) ? appleMail : cloudMail

  async function settings() {
    const cloud = await cloudMail.settings()
    const local = appleMail.settings()
    const rows = cloud.map(row => {
      const binding = appleMail.settings(row.provider)
      const status = binding ? { direct: row.direct, ...binding } : { ...row }
      if (connecting.has(row.provider)) status.busy = 'connect'
      return status
    })
    return local.available ? [local, ...rows] : rows
  }

  async function cancel(provider) {
    const task = connecting.get(provider)
    if (task) {
      task.cancelled = true
      if (task.started) await task.mail.connect({ provider, cancel: true })
      await task.done.catch(() => {})
    }
    return null
  }
  async function connect(payload) {
    const provider = sourceOf(payload)
    if (payload.cancel === true) return cancel(provider)
    if (closed || disconnecting.has(provider) || connecting.has(provider)) throw new Error('A mail account action is already in progress.')
    const localChoice = Object.hasOwn(payload, 'appleAccountId')
    const mail = localChoice || provider === 'apple' ? appleMail : cloudMail
    if (!localChoice && provider !== 'apple' && appleMail.settings(provider)) throw new Error('Disconnect the selected Apple Mail account before connecting another mailbox.')
    const task = { mail, started: false, cancelled: false }
    connecting.set(provider, task)
    task.done = (async () => {
      if (localChoice) {
        if (provider === 'apple' || !appleMail.settings().available || payload.clientId || payload.clientSecret) throw new Error('Choose one available mailbox connection method.')
        const cloud = (await cloudMail.settings()).find(row => row.provider === provider)
        if (!cloud || cloud.direct) throw new Error('Use the registered connection for this provider.')
        if (cloud.busy || cloud.email || cloud.error) throw new Error('Resolve the existing cloud connection before choosing an Apple Mail account.')
      }
      if (task.cancelled || closed) throw new Error('Mail connection cancelled.')
      task.started = true
      return mail.connect(payload)
    })().finally(() => { connecting.delete(provider) })
    return task.done
  }

  async function scan(payload) {
    const provider = sourceOf(payload)
    if (payload.cancel !== true && (connecting.has(provider) || disconnecting.has(provider) || closed)) throw new Error('Finish the mail account action before scanning.')
    return backend(provider).scan(payload)
  }

  async function disconnect(payload) {
    const provider = sourceOf(payload)
    if (disconnecting.has(provider)) throw new Error('A mail account action is already in progress.')
    disconnecting.add(provider)
    try {
      const target = connecting.get(provider)?.mail || backend(provider)
      await cancel(provider)
      return await target.disconnect({ provider })
    } finally { disconnecting.delete(provider) }
  }
  function close() {
    closed = true
    for (const task of connecting.values()) task.cancelled = true
    appleMail.close()
    cloudMail.close()
  }
  return { settings, connect, scan, disconnect, appleAccounts: payload => appleMail.appleAccounts(payload), close }
}
