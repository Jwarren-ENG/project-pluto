import React, { useEffect, useId, useRef, useState } from 'react'
import { Button } from './components/ui/button.jsx'
import { Input } from './components/ui/input.jsx'

const call = (action, payload = {}) => window.pluto.call('drive.' + action, payload)

export default function DriveConnection({ notify }) {
  const title = useId()
  const dialog = useRef(null)
  const mounted = useRef(false)
  const pending = useRef('')
  const [account, setAccount] = useState(null)
  const [mode, setMode] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [clientId, setClientId] = useState('')
  const [secret, setSecret] = useState('')

  async function load() {
    setError('')
    try {
      const result = await call('settings')
      if (mounted.current && !pending.current) setAccount(result)
    } catch (problem) { if (mounted.current) setError(problem.message) }
  }
  useEffect(() => {
    mounted.current = true
    load()
    return () => {
      mounted.current = false
      if (pending.current === 'connect') call('cancel').catch(() => {})
    }
  }, [])
  useEffect(() => {
    if (mode) dialog.current.showModal()
  }, [mode])

  function dismiss() {
    if (pending.current) return
    setSecret('')
    setClientId('')
    setError('')
    setMode('')
  }
  async function perform(action, payload) {
    if (pending.current) return
    pending.current = action
    setBusy(action)
    setError('')
    setSecret('')
    try {
      const result = await call(action, payload)
      if (!mounted.current) return
      setAccount(result)
      setMode('')
      setClientId('')
      notify?.(result.connected ? 'Google Drive connected.' :
        payload?.revoke ? 'Google access revoked and Drive unlinked.' : 'Google Drive unlinked.')
    } catch (problem) { if (mounted.current) setError(problem.message) }
    finally {
      pending.current = ''
      if (mounted.current) setBusy('')
    }
  }
  async function cancel() {
    try { await call('cancel') }
    catch (problem) { if (mounted.current) setError(problem.message) }
  }
  function open(next) { setError(''); setMode(next) }

  return <section className="panel" aria-labelledby={title}>
    <h2 id={title}>Google Drive</h2>
    <p>Save a reviewed résumé PDF from Applications to your Drive.</p>
    {!account && !error && <p role="status">Checking Drive connection…</p>}
    {account && <p role="status">{account.connected ? 'Connected as ' + account.email : 'Google Drive is disconnected.'}</p>}
    {!mode && error && <p role="alert">{error}</p>}
    <div className="toolbar">
      {!account && error && <Button type="button" variant="outline" onClick={load}>Retry Drive status</Button>}
      {!account && error && <Button type="button" variant="outline" disabled={Boolean(busy)} onClick={() => perform('disconnect', {})}>Unlink Google Drive</Button>}
      {account && !account.connected && <Button type="button" disabled={Boolean(busy)}
        onClick={() => account.registrationAvailable ? perform('connect', {}) : open('connect')}>Connect Google Drive</Button>}
      {!mode && busy === 'connect' && <Button type="button" variant="outline" onClick={cancel}>Cancel Drive sign-in</Button>}
      {account?.connected && <>
        <Button type="button" variant="outline" disabled={Boolean(busy)} onClick={() => perform('disconnect', {})}>Unlink Google Drive</Button>
        <Button type="button" variant="outline" disabled={Boolean(busy)} onClick={() => open('revoke')}>Revoke Google access</Button>
      </>}
    </div>
    {!mode && busy === 'connect' && <p role="status">Finish Google Drive sign-in in your browser.</p>}
    {mode && <dialog ref={dialog} aria-labelledby={title + '-dialog'}
      className="fixed inset-0 m-auto w-[min(30rem,90vw)] border bg-background p-5 text-foreground backdrop:bg-black/35"
      onCancel={event => { event.preventDefault(); if (busy === 'connect') cancel(); else dismiss() }}>
      {mode === 'connect' ? <form onSubmit={event => { event.preventDefault(); perform('connect', { clientId, clientSecret: secret }) }}>
        <h2 id={title + '-dialog'}>Google Drive desktop client setup</h2>
        <p>Use a Google desktop OAuth client with the Drive API enabled. Google will ask for access to the files you use with Pluto.</p>
        <fieldset disabled={Boolean(busy)}>
          <label>Google desktop client ID
            <Input value={clientId} onChange={event => setClientId(event.target.value)} required maxLength={256} autoComplete="off" spellCheck={false} />
          </label>
          <label>Google desktop client secret (if issued)
            <Input type="password" value={secret} onChange={event => setSecret(event.target.value)} maxLength={512} autoComplete="off" spellCheck={false} />
          </label>
        </fieldset>
        {busy === 'connect' && <p role="status">Finish Google Drive sign-in in your browser.</p>}
        {error && <p role="alert">{error}</p>}
        <div className="toolbar">
          {!busy && <Button type="submit">Continue with Google</Button>}
          <Button type="button" variant="outline" onClick={busy ? cancel : dismiss}>{busy ? 'Cancel Drive sign-in' : 'Cancel'}</Button>
        </div>
      </form> : <>
        <h2 id={title + '-dialog'}>Revoke Google access?</h2>
        <p>Google revokes all grants for this account in the same Google Cloud project. If Gmail uses that project, it will also need a new sign-in. Unlinking on this device is available separately.</p>
        {error && <p role="alert">{error}</p>}
        <div className="toolbar">
          <Button type="button" variant="outline" disabled={Boolean(busy)} onClick={dismiss}>Cancel</Button>
          <Button type="button" disabled={Boolean(busy)} onClick={() => perform('disconnect', { revoke: true })}>Revoke and unlink</Button>
        </div>
      </>}
    </dialog>}
  </section>
}
