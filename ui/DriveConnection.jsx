import React, { useId, useLayoutEffect, useRef, useState } from 'react'
import { Button } from './components/ui/button.jsx'
import { Input } from './components/ui/input.jsx'

const call = (action, ...args) => window.pluto.call('drive.' + action, ...args)
const errorMessage = problem => problem.message.replace(/^Error invoking remote method 'pluto:action': (?:Error: )?/, '')

export default function DriveConnection({ notify }) {
  const title = useId()
  const dialog = useRef(null)
  const pending = useRef(null)
  const [account, setAccount] = useState(null)
  const [mode, setMode] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [signInFailed, setSignInFailed] = useState(false)
  const [clientId, setClientId] = useState('')
  const [secret, setSecret] = useState('')

  useLayoutEffect(() => {
    perform('settings')
    return () => {
      const request = pending.current
      pending.current = null
      if (request?.action === 'connect' && !request.canceling) call('cancel').catch(() => {})
    }
  }, [])
  useLayoutEffect(() => {
    if (!mode) return
    const element = dialog.current
    element.showModal()
    return () => element.close()
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
    const request = { action }
    pending.current = request
    setBusy(action)
    setError('')
    setSecret('')
    try {
      if (action === 'importRegistration') {
        const setup = await call('importRegistration')
        if (pending.current !== request || setup === null) return
        setAccount(setup)
        if (!setup.registrationAvailable) throw new Error('The file did not finish Google setup. Try another setup file.')
        setSignInFailed(false)
        if (setup.connected || setup.busy) return
        request.action = 'connect'
        setBusy('connect')
      }
      const result = await call(request.action, payload)
      if (pending.current !== request) return
      setAccount(result)
      if (request.action === 'settings') return
      setSignInFailed(false)
      setMode('')
      setClientId('')
      notify?.(result.connected ? 'Google Drive connected.' :
        payload?.revoke ? 'Google access revoked and Drive unlinked.' : 'Google Drive unlinked.')
    } catch (problem) {
      if (pending.current !== request) return
      const message = errorMessage(problem)
      if (request.canceling && message === 'Google Drive sign-in canceled.') {
        setMode('')
        setClientId('')
        notify?.(message)
      } else {
        setError(message)
        if (request.action === 'connect') setSignInFailed(true)
      }
    } finally {
      if (pending.current === request) {
        pending.current = null
        setBusy('')
      }
    }
  }
  async function cancel() {
    const request = pending.current
    if (request?.action !== 'connect' || request.canceling) return
    request.canceling = true
    setBusy('cancel')
    try { await call('cancel') }
    catch (problem) {
      if (pending.current !== request) return
      request.canceling = false
      setBusy('connect')
      setError(errorMessage(problem))
    }
  }
  function open(next) { setError(''); setMode(next) }

  const needsSetup = account && !account.connected && !account.registrationAvailable
  const readyToConnect = account && !account.connected && account.registrationAvailable
  const canReplaceSetup = readyToConnect && signInFailed && account.registrationSource === 'imported'
  const disabled = Boolean(busy || account?.busy)
  const signingIn = busy === 'connect' || busy === 'cancel'
  const signInProgress = signingIn && <>
    <p role="status">{busy === 'cancel' ? 'Canceling Google Drive sign-in…' : 'Finish Google Drive sign-in in your browser.'}</p>
    <Button type="button" variant="outline" disabled={busy === 'cancel'} onClick={cancel}>Cancel Drive sign-in</Button>
  </>

  return <section className="panel" aria-labelledby={title}>
    <h2 id={title}>Google Drive</h2>
    <p>Save a reviewed résumé PDF from Applications to your Drive.</p>
    {busy === 'settings' && <p role="status">Checking Drive connection…</p>}
    {account?.connected && <p role="status">Connected as {account.email}</p>}
    {readyToConnect && !signingIn && <p role="status">Google Drive is disconnected.</p>}
    {!mode && error && <p role="alert">{error}</p>}
    {needsSetup && <>
      <h3>Google sign-in needs app setup</h3>
      <p>Ask the app owner for the Google setup file. Import it here to continue to Google in your browser.</p>
    </>}
    {account?.busy && <p role="status">A Google Drive action is in progress.</p>}
    <div className="toolbar">
      {account?.busy && <Button type="button" variant="outline" disabled={Boolean(busy)} onClick={() => perform('settings')}>Refresh Drive status</Button>}
      {!account && error && <Button type="button" variant="outline" disabled={disabled} onClick={() => perform('settings')}>Retry Drive status</Button>}
      {!account && error && <Button type="button" variant="outline" disabled={disabled} onClick={() => perform('disconnect')}>Unlink Google Drive</Button>}
      {readyToConnect && <Button type="button" disabled={disabled}
        onClick={() => perform('connect')}>Connect Google Drive</Button>}
      {(needsSetup || canReplaceSetup) && <Button type="button" variant={needsSetup ? 'default' : 'outline'} disabled={disabled}
        onClick={() => perform('importRegistration')}>Import Google setup file</Button>}
      {account?.connected && <>
        <Button type="button" variant="outline" disabled={disabled} onClick={() => perform('disconnect')}>Unlink Google Drive</Button>
        <Button type="button" variant="outline" disabled={disabled} onClick={() => open('revoke')}>Revoke Google access</Button>
      </>}
    </div>
    {busy === 'importRegistration' && <p role="status">Choose the Google setup file in the file picker.</p>}
    {needsSetup && <details>
      <summary>Setup for the app owner</summary>
      <p>In Google Cloud, enable the Google Drive API and configure the consent screen for your users. Create a Desktop app OAuth client and download its JSON setup file.</p>
      <Button type="button" variant="outline" disabled={disabled} onClick={() => open('manual')}>Advanced manual setup</Button>
    </details>}
    {!mode && signInProgress}
    {mode && <dialog ref={dialog} aria-labelledby={title + '-dialog'}
      className="fixed inset-0 m-auto w-[min(30rem,90vw)] border bg-background p-5 text-foreground backdrop:bg-black/35"
      onCancel={event => { event.preventDefault(); if (signingIn) cancel(); else dismiss() }}>
      {mode === 'manual' ? <form onSubmit={event => { event.preventDefault(); perform('connect', { clientId, clientSecret: secret }) }}>
        <h2 id={title + '-dialog'}>Google Drive desktop client setup</h2>
        <p>Use a Google desktop OAuth client with the Drive API enabled. Google will ask for access to the files you use with Pluto.</p>
        <fieldset disabled={disabled}>
          <label>Google desktop client ID
            <Input value={clientId} onChange={event => setClientId(event.target.value)} required maxLength={256} autoComplete="off" spellCheck={false} />
          </label>
          <label>Google desktop client secret (if issued)
            <Input type="password" value={secret} onChange={event => setSecret(event.target.value)} maxLength={512} autoComplete="off" spellCheck={false} />
          </label>
        </fieldset>
        {error && <p role="alert">{error}</p>}
        {signInProgress}
        {!busy && <div className="toolbar">
          <Button type="submit">Continue with Google</Button>
          <Button type="button" variant="outline" onClick={dismiss}>Cancel</Button>
        </div>}
      </form> : <>
        <h2 id={title + '-dialog'}>Revoke Google access?</h2>
        <p>Google revokes all grants for this account in the same Google Cloud project. If Gmail uses that project, it will also need a new sign-in. Unlinking on this device is available separately.</p>
        {error && <p role="alert">{error}</p>}
        <div className="toolbar">
          <Button type="button" variant="outline" disabled={disabled} onClick={dismiss}>Cancel</Button>
          <Button type="button" disabled={disabled} onClick={() => perform('disconnect', { revoke: true })}>Revoke and unlink</Button>
        </div>
      </>}
    </dialog>}
  </section>
}
