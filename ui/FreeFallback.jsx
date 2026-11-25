import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { Button } from './components/ui/button.jsx'
import { Input } from './components/ui/input.jsx'

const automatic = 'openrouter/free'
const setupPhases = new Set(['starting', 'downloading', 'installing', 'checking'])
const phaseLabels = {
  off: 'Off',
  starting: 'Starting OmniRoute setup',
  downloading: 'Downloading OmniRoute',
  installing: 'Installing OmniRoute',
  checking: 'Checking the fallback connection',
  ready: 'Ready for drafting',
  error: 'Setup needs attention',
}
const actionErrors = {
  enableFallback: 'Couldn’t enable OmniRoute. Check your OpenRouter key and try again.',
  disableFallback: 'Couldn’t turn off OmniRoute. Try again.',
  setFallbackModel: 'Couldn’t save the model choice. Check the available models and try again.',
}
const call = (action, payload = {}) => window.pluto.call('providers.' + action, payload)

function Enrollment({ hasKey, onConfirm, onCancel }) {
  const id = useId()
  const dialog = useRef(null)
  const [useSaved, setUseSaved] = useState(hasKey)
  const [key, setKey] = useState('')
  useLayoutEffect(() => {
    const element = dialog.current
    element.showModal()
    return () => element.close()
  }, [])

  function submit(event) {
    event.preventDefault()
    if (useSaved || key.trim()) onConfirm(useSaved ? {} : { apiKey: key.trim() })
  }

  return <dialog ref={dialog} aria-labelledby={id + '-title'} aria-describedby={id + '-consent'}
    className="fixed inset-0 m-auto w-[min(30rem,90vw)] border bg-background p-5 text-foreground backdrop:bg-black/35"
    onCancel={event => { event.preventDefault(); onCancel() }}>
    <h2 id={id + '-title'}>Enable OmniRoute for drafts?</h2>
    <p>The first setup downloads OmniRoute and needs several gigabytes of free disk space. It runs on this computer while Pluto is open.</p>
    <p id={id + '-consent'}>When your primary provider reaches its quota, Pluto will send your reviewed profile and job details to OpenRouter and its free serving provider for drafting. Free usage limits apply.</p>
    <form onSubmit={submit}>
      <fieldset>
        <legend>OpenRouter key</legend>
        {hasKey && <>
          <label><input type="radio" name={id} checked={useSaved} onChange={() => { setUseSaved(true); setKey('') }} /> Use saved OpenRouter key</label>
          <label><input type="radio" name={id} checked={!useSaved} onChange={() => setUseSaved(false)} /> Use a dedicated key</label>
        </>}
        {!useSaved && <label>Dedicated OpenRouter API key
          <Input type="password" autoComplete="off" spellCheck={false} value={key} required
            onChange={event => setKey(event.target.value)} />
        </label>}
        {!useSaved && <p>Pluto saves this key securely on this computer when you enable the fallback.</p>}
      </fieldset>
      <div className="toolbar">
        <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
        <Button type="submit" disabled={!useSaved && !key.trim()}>Enable fallback</Button>
      </div>
    </form>
  </dialog>
}

function SetupProgress({ status, label }) {
  const { phase, bytes, totalBytes } = status
  const reportsBytes = phase === 'downloading' || phase === 'installing'
  const hasBytes = reportsBytes && Number.isFinite(bytes) && bytes >= 0
  const measured = hasBytes && Number.isFinite(totalBytes) && totalBytes > 0
  return <div>
    <progress aria-label={label} max={measured ? totalBytes : undefined}
      value={measured ? Math.min(bytes, totalBytes) : undefined} />
    {hasBytes && <span> {bytes.toLocaleString()}{measured && ' of ' + totalBytes.toLocaleString()} bytes</span>}
    <p>Setup continues if you leave Connections. Turn the switch off to cancel.</p>
  </div>
}

export default function FreeFallback() {
  const id = useId()
  const [status, setStatus] = useState(null)
  const [enrolling, setEnrolling] = useState(false)
  const [busy, setBusy] = useState(false)
  const [readFailed, setReadFailed] = useState(false)
  const [actionError, setActionError] = useState('')
  const generation = useRef(0)

  // A command or unmount invalidates older reads. Leaving the panel only stops polling.
  useEffect(() => () => { generation.current++ }, [])
  useEffect(() => {
    if (busy || readFailed || (status && !setupPhases.has(status.phase))) return
    const request = generation.current
    let current = true
    async function read() {
      try {
        const next = await call('fallbackStatus')
        if (current && generation.current === request) setStatus(next)
      } catch {
        if (current && generation.current === request) setReadFailed(true)
      }
    }
    const timer = window.setTimeout(read, status ? 1000 : 0)
    return () => { current = false; window.clearTimeout(timer) }
  }, [status, busy, readFailed])

  async function change(action, payload = {}) {
    if (busy) return
    const request = ++generation.current
    setBusy(true)
    setActionError('')
    try {
      const next = await call(action, payload)
      if (request === generation.current) setStatus(next?.phase ? next : null)
    } catch {
      if (request === generation.current) {
        setActionError(actionErrors[action])
        setStatus(null) // Reconcile a command whose result could not be confirmed.
      }
    } finally {
      if (request === generation.current) setBusy(false)
    }
  }

  async function openEnrollment() {
    // The user may just have saved an OpenRouter key elsewhere in Connections.
    const request = ++generation.current
    try {
      const latest = await call('fallbackStatus')
      if (request !== generation.current) return
      setStatus(latest)
      setEnrolling(latest.phase === 'off' || latest.phase === 'error')
    } catch {
      if (request === generation.current) setReadFailed(true)
    }
  }

  const running = setupPhases.has(status?.phase)
  const on = Boolean(status?.enabled || running)
  const models = (status?.models || []).filter(model => model.id !== automatic)
  const selected = status?.selectedModel || automatic
  const missingSelection = selected !== automatic && !models.some(model => model.id === selected)
  const label = status?.stage === 'catalog' && status.phase === 'downloading' ? 'Downloading the free model list' : phaseLabels[status?.phase]

  return <section className="panel" aria-labelledby={id + '-title'}>
    <h2 id={id + '-title'}>Free drafting fallback</h2>
    <p id={id + '-terms'}>Use OmniRoute with OpenRouter’s free models when your primary drafting provider reaches its quota.</p>
    {actionError && <p role="alert">{actionError}</p>}
    {readFailed ? <div>
      <p role="alert">Couldn’t read the OmniRoute status.</p>
      <Button type="button" variant="outline" onClick={() => { setStatus(null); setReadFailed(false) }}>Retry status</Button>
    </div> : !status ? <p role="status">Reading fallback settings…</p> : <>
      <label>
        <input type="checkbox" role="switch" checked={on} disabled={busy}
          aria-describedby={id + '-terms'} onChange={event => event.target.checked ? openEnrollment() : change('disableFallback')} />
        {' '}Enable free drafting fallback
      </label>
      <p role="status">{label}{status.phase === 'ready' && Number.isInteger(status.modelCount) &&
        ' · ' + status.modelCount + (status.modelCount === 1 ? ' free model' : ' free models')}</p>
      {running && <SetupProgress status={status} label={label} />}
      {status.phase === 'error' && <>
        {status.error && <p role="alert">{status.error}</p>}
        <Button type="button" variant="outline" disabled={busy} onClick={openEnrollment}>Retry setup</Button>
      </>}
      <label htmlFor={id + '-model'}>Fallback model</label>
      <select id={id + '-model'} value={selected} disabled={busy || status.phase !== 'ready' || (!models.length && !missingSelection)}
        aria-describedby={id + '-routing'} onChange={event => change('setFallbackModel', { model: event.target.value })}>
        <option value={automatic}>Automatic (free models)</option>
        {models.map(model => <option key={model.id} value={model.id}>{model.label || model.id}</option>)}
        {missingSelection && <option value={selected} disabled>{selected} (currently unavailable)</option>}
      </select>
      <p id={id + '-routing'}>Automatic lets OpenRouter choose an available free model. You can use it if your preferred model is unavailable.</p>
      {enrolling && <Enrollment hasKey={status.hasKey} onCancel={() => setEnrolling(false)}
        onConfirm={payload => { setEnrolling(false); change('enableFallback', payload) }} />}
    </>}
  </section>
}
