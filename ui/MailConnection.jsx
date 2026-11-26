import React, { useEffect, useRef, useState } from 'react'
import { Button } from './components/ui/button'
import { Input } from './components/ui/input'

const names = { gmail: 'Gmail', outlook: 'Outlook', apple: 'Apple Mail' }
const call = (action, data = {}) => window.pluto.call('mail.' + action, data)

export default function MailConnection({ notify, go, focusOnOpen = false, onBusyChange }) {
  const [accounts, setAccounts] = useState(null)
  const [setup, setSetup] = useState('')
  const [mailboxes, setMailboxes] = useState(null)
  const [id, setId] = useState('')
  const [secret, setSecret] = useState('')
  const [waiting, setWaiting] = useState(null)
  useEffect(() => { onBusyChange?.(Boolean(waiting)) }, [waiting, onBusyChange])
  const [error, setError] = useState('')
  const heading = useRef(null)
  useEffect(() => { if (focusOnOpen) heading.current.focus() }, [focusOnOpen])
  const pending = useRef(null)
  const live = useRef(false)
  const dialog = useRef(null)
  const hasApple = accounts?.some(account => account.provider === 'apple' && account.available !== false)

  async function refresh() {
    try { const result = await call('settings'); if (live.current) setAccounts(result) }
    catch (err) { if (live.current) setError(err.message) }
  }
  function stop(task) {
    if (task?.action === 'appleAccounts') return call('appleAccounts', { cancel: true })
    if (task?.action === 'connect') return call('connect', { provider: task.provider, cancel: true })
    return Promise.resolve()
  }
  useEffect(() => {
    live.current = true
    refresh()
    return () => {
      live.current = false
      stop(pending.current).catch(() => {})
      pending.current = null
    }
  }, [])
  useEffect(() => {
    if (!setup) return
    const element = dialog.current
    element.showModal()
    return () => element.close()
  }, [setup])

  async function perform(action, provider, overrides = {}) {
    if (pending.current) return
    const task = { action, provider }
    pending.current = task
    setWaiting(task)
    setError('')
    if (action !== 'appleAccounts') setSecret('')
    try {
      const result = await call(action, action === 'appleAccounts' ? {} : { provider, ...overrides })
      if (!live.current || pending.current !== task) return
      if (action === 'appleAccounts') setMailboxes(result)
      else {
        setSetup('')
        setId('')
        notify?.(names[provider] + (action === 'connect' ? ' connected.' : ' disconnected.'))
      }
    } catch (err) {
      if (live.current && pending.current === task) setError(err.message)
    } finally {
      if (pending.current === task) {
        pending.current = null
        if (live.current) { setWaiting(null); if (action !== 'appleAccounts') await refresh() }
      }
    }
  }
  function start(account) {
    setError('')
    if (account.direct || account.provider === 'apple') return perform('connect', account.provider)
    setId('')
    setSecret('')
    setMailboxes(null)
    setSetup(account.provider)
    if (hasApple) perform('appleAccounts', account.provider)
  }
  async function cancel() {
    const task = pending.current
    try {
      if (task) await stop(task)
      if (live.current) { setSetup(''); setId(''); setSecret(''); setError('') }
    } catch (err) { if (live.current) setError(err.message) }
  }
  const providerLabel = names[setup]
  const registration = <form onSubmit={event => {
    event.preventDefault()
    perform('connect', setup, { clientId: id, clientSecret: secret })
  }}>
    <p>Use a desktop registration from your Project Pluto administrator.</p>
    <label>Desktop client ID<Input required maxLength={250} disabled={!!waiting} value={id} onChange={event => setId(event.target.value)} autoComplete="off" spellCheck={false}/></label>
    {setup === 'gmail' && <label>Desktop client secret, if issued<Input type="password" maxLength={512} disabled={!!waiting} autoComplete="off" value={secret} onChange={event => setSecret(event.target.value)}/></label>}
    <Button disabled={!!waiting} type="submit">Continue to {providerLabel}</Button>
  </form>

  return <section className="panel" aria-labelledby="email-connections-heading">
    <h2 id="email-connections-heading" ref={heading} tabIndex={-1}>Email</h2>
    <p>Connect an inbox to find replies about your tracked jobs.</p>
    {!accounts && !error && <p role="status">Checking connections…</p>}
    {accounts?.map(account => {
      const chosen = account.email || account.error
      const local = hasApple && !account.direct && account.provider !== 'apple'
      const detail = account.error || (account.email ? account.email + (account.via === 'apple' ? ' · via Apple Mail' : '')
        : local ? 'Choose an inbox from Apple Mail. Your Mac may ask for permission.' : '')
      return <div className="connection-row" key={account.provider}>
        <div><strong>{names[account.provider]}</strong>{detail && <small>{detail}</small>}</div>
        {!setup && waiting?.provider === account.provider && waiting.action === 'connect' ?
          <><span role="status">Waiting for permission…</span><Button type="button" variant="link" onClick={cancel}>Cancel</Button></> :
          <Button type="button" variant="outline" disabled={!!waiting} onClick={() => chosen ? perform('disconnect', account.provider) : start(account)}>
            {chosen ? 'Disconnect ' : 'Connect '}{names[account.provider]}
          </Button>}
      </div>
    })}
    {go && accounts?.some(account => account.email && !account.error) && <Button type="button" variant="link" onClick={() => go('Mail')}>Open job mail</Button>}
    {!setup && error && <p role="alert">{error}</p>}
    {!accounts && error && <Button type="button" variant="link" onClick={refresh}>Retry email status</Button>}
    {setup && <dialog ref={dialog} aria-labelledby="mail-setup-title"
      className="fixed inset-0 m-auto w-[min(32rem,90vw)] bg-background p-6 text-foreground backdrop:bg-black/35"
      onCancel={event => { event.preventDefault(); cancel() }}>
      <h2 id="mail-setup-title">Connect {providerLabel}</h2>
      {hasApple ? <>
        <p>Choose your {providerLabel} inbox from the accounts in Apple Mail.</p>
        {waiting?.action === 'appleAccounts' && <p role="status">Looking for accounts on this Mac…</p>}
        {mailboxes?.map(mailbox => <div key={mailbox.id} className="connection-row">
          <Button variant="link" type="button" disabled={!!waiting} onClick={() => perform('connect', setup, { appleAccountId: mailbox.id })}>
            {mailbox.email || mailbox.label}
          </Button>
          {mailbox.email && mailbox.label !== mailbox.email && <small>{mailbox.label}</small>}
        </div>)}
        {mailboxes?.length === 0 && <p>No accounts found. Add this inbox in Apple Mail under Mail → Add Account, then check again.</p>}
        {!waiting && (!mailboxes?.length || error) && <Button variant="link" type="button" onClick={() => perform('appleAccounts', setup)}>Check again</Button>}
        <details><summary>Use a desktop client ID instead</summary>{registration}</details>
      </> : <><p>This copy needs a {providerLabel} desktop client ID to open the permission screen.</p>{registration}</>}
      {waiting?.action === 'connect' && <p role="status">Connecting your inbox…</p>}
      {error && <p role="alert">{error}</p>}
      <Button type="button" variant="ghost" onClick={cancel}>Cancel</Button>
    </dialog>}
  </section>
}
