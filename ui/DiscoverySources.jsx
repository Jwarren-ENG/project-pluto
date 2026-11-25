import React, { useEffect, useRef, useState } from 'react'
import { Button } from './components/ui/button'
import { Input } from './components/ui/input'

const simplify = 'https://github.com/SimplifyJobs/New-Grad-Positions'
const call = (action, payload = {}) => window.pluto.call('sources.' + action, payload)

export default function DiscoverySources({ onCount }) {
  const [sources, setSources] = useState(null)
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const field = useRef(null)
  const mounted = useRef(false)
  const lock = useRef(false)
  async function load() {
    const value = await call('list')
    if (mounted.current) { setSources(value); onCount({ active: value.filter(row => row.enabled).length, total: value.length }) }
  }
  useEffect(() => {
    mounted.current = true
    load().catch(err => { if (mounted.current) setError(err.message) })
    return () => { mounted.current = false }
  }, [])
  async function update(action, payload) {
    if (lock.current) return
    lock.current = true
    setBusy(true)
    setError('')
    const previous = sources
    if (action === 'setEnabled') {
      const next = sources.map(row => row.id === payload.id ? { ...row, enabled: payload.enabled } : row)
      setSources(next)
      onCount({ active: next.filter(row => row.enabled).length, total: next.length })
    }
    try {
      if (action) await call(action, payload)
      await load()
      if (mounted.current && action === 'add') setUrl('')
    } catch (err) {
      if (mounted.current) {
        if (action === 'setEnabled') {
          setSources(previous)
          onCount({ active: previous.filter(row => row.enabled).length, total: previous.length })
        }
        setError(err.message)
      }
    }
    finally { lock.current = false; if (mounted.current) setBusy(false) }
  }
  return <section className="panel" aria-labelledby="discover-sources-title">
    <h2 id="discover-sources-title">Sources</h2>
    <p>Save the job lists you want Pluto to check when you search or run daily discovery.</p>
    {sources?.length > 0 && <ul className="discovery-source-list">{sources.map(source =>
      <li key={source.id}>
        <label><input type="checkbox" checked={source.enabled} disabled={busy}
          onChange={e => update('setEnabled', { id: source.id, enabled: e.target.checked })}/>
          <span>{source.label}<small>{source.url}</small></span></label>
        <Button variant="link" type="button" disabled={busy} aria-label={'Remove ' + source.label}
          onClick={() => update('remove', { id: source.id })}>Remove</Button>
      </li>)}</ul>}
    <form onSubmit={e => { e.preventDefault(); update('add', { url: url.trim() }) }}>
      <label htmlFor="source-url">Job list or careers page URL</label>
      <div className="source-entry">
        <Input ref={field} id="source-url" type="url" required maxLength={2048} placeholder="https://" value={url}
          onChange={e => setUrl(e.target.value)} disabled={busy}/>
        <Button type="submit" disabled={busy || !url.trim()}>Add source</Button>
      </div>
    </form>
    {!sources?.some(source => source.url.replace(/\/$/, '').toLowerCase() === simplify.toLowerCase()) &&
      <Button type="button" variant="link" onClick={() => { setUrl(simplify); field.current?.focus() }}>Use the Simplify new grad list</Button>}
    {error && <p role="alert">{error}</p>}
    {!sources && error && <Button variant="link" onClick={() => update(null)}>Retry sources</Button>}
  </section>
}
