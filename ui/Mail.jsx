import React, { useEffect, useRef, useState } from 'react'
import { Button } from './components/ui/button'

const labels = { apple: 'Apple Mail', gmail: 'Gmail', outlook: 'Outlook' }
const call = (action, payload = {}) => window.pluto.call(action, payload)

function noteBody(message, includePreview) {
  const lines = [
    'From: ' + (message.from || 'Unknown sender'), 'Subject: ' + message.subject,
    'Received: ' + (message.receivedAt || 'Unavailable'), 'Mailbox: ' + message.account,
  ]
  if (includePreview && message.preview) lines.push('Excerpt: ' + message.preview)
  // In exported Markdown, treat all mail content as literal text.
  const quoted = lines.map(line => '    ' + line.replace(/[\r\n]+/g, ' ')).join('\n')
  const source = message.url ? '\n\nOriginal message: ' + message.url : ''
  return quoted + source + '\n\nMail reference: ' + message.key
}

async function noteId(jobId, messageKey) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([jobId, messageKey])))
  // A repeat link to the same message and job always addresses the same note.
  return 'mail-' + Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('')
}

export async function linkReviewedReply({ job, message, includePreview }, workspaceCall) {
  const id = await noteId(job.id, message.key)
  const latest = await workspaceCall('workspace.snapshot')
  const target = latest.jobs.find(item => item.id === job.id)
  if (!target || target.company !== job.company || target.title !== job.title || target.url !== job.url) {
    throw new Error('The tracked job changed. Choose it again and review the match.')
  }
  const existing = latest.notes.some(note => note.id === id ||
    (note.jobId === job.id && note.body?.endsWith('Mail reference: ' + message.key)))
  if (existing) return false
  await workspaceCall('workspace.saveNote', { id, updatedAt: '', jobId: job.id, title: 'Employer reply · ' + job.company,
    body: noteBody(message, includePreview) })
  return true
}

export default function Mail({ state, notify, refresh, go }) {
  const [accounts, setAccounts] = useState(null)
  const [provider, setProvider] = useState('')
  const [jobId, setJobId] = useState('')
  const [results, setResults] = useState(null)
  const [selected, select] = useState(null)
  const [includePreview, setIncludePreview] = useState(false)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const pending = useRef(null)
  const mounted = useRef(false)
  const jobs = state?.jobs || []
  const matchesJob = (job, row) => job.id === row?.jobId && job.title === row.title && job.company === row.company && job.url === row.jobUrl
  const target = jobs.find(job => matchesJob(job, selected))
  const message = target && selected.message
  const linkedNotes = (state?.notes || []).filter(note => /^mail-[a-f0-9]{64}$/.test(note.id) && jobs.some(job => job.id === note.jobId))
  const visible = (results?.matches || []).filter(row => jobs.some(job => matchesJob(job, row)))
  const clear = () => { setResults(null); select(null); setError(''); setIncludePreview(false) }

  async function load() {
    setError('')
    try {
      const entries = await call('mail.settings')
      if (!mounted.current) return
      const connected = entries.filter(a => Object.hasOwn(labels, a.provider) && a.email && !a.error)
      setAccounts(connected)
      setProvider(value => connected.some(a => a.provider === value) ? value : connected[0]?.provider || '')
      if (entries.some(a => a.error)) setError('A mail source needs attention in Connections.')
    } catch {
      if (mounted.current) setError('Couldn’t load mail sources. Check Connections or try again.')
    }
  }

  useEffect(() => {
    mounted.current = true
    load()
    return () => {
      mounted.current = false
      const scan = pending.current
      pending.current = null
      if (scan) call('mail.scan', { ...scan, cancel: true }).catch(() => {})
    }
  }, [])

  async function search(offset = 0) {
    if (busy || pending.current || !provider || !jobs.length) return
    if (!offset) clear()
    const request = { provider, scanId: crypto.randomUUID() }
    pending.current = request
    setBusy('scan')
    setError('')
    try {
      const page = await call('mail.scan', { ...request, offset, ...(jobId && { jobId }) })
      if (pending.current !== request) return
      setResults(previous => {
        const byKey = new Map((offset ? previous?.matches || [] : []).map(row => [row.message.key, row]))
        for (const row of page.matches) byKey.set(row.message.key, row)
        const matches = [...byKey.values()].sort((a, b) => b.message.receivedAt.localeCompare(a.message.receivedAt))
        return { ...page, matches }
      })
    } catch (err) {
      if (pending.current === request) setError(err.message || 'Couldn’t check job mail.')
    } finally {
      if (pending.current === request) { pending.current = null; setBusy('') }
    }
  }

  async function cancel() {
    const request = pending.current
    if (!request) return
    pending.current = null
    setBusy('cancel')
    try { await call('mail.scan', { ...request, cancel: true }) }
    catch { if (mounted.current) setError('Couldn’t confirm cancellation. Try the check again.') }
    finally { if (mounted.current) setBusy('') }
  }

  async function link() {
    if (!target || !message || busy) return
    setBusy('link')
    setError('')
    try {
      const created = await linkReviewedReply({ job: target, message, includePreview }, call)
      await refresh()
      if (mounted.current) {
        select(null)
        notify(created ? 'Reply linked to ' + target.title + ' at ' + target.company + '.' : 'This reply is already linked.')
      }
    } catch (err) { if (mounted.current) setError(err.message) }
    finally { if (mounted.current) setBusy('') }
  }

  return <section className="section" aria-label="Recruiting messages">
    <p>Check for recruiting messages about jobs in your workspace. Review each match before linking it to a job.</p>
    {error && <p role="alert">{error}</p>}
    {!accounts && (error ? <Button type="button" variant="outline" onClick={load}>Retry mail sources</Button> : <p role="status">Loading mail sources…</p>)}
    {accounts && !accounts.length && <section className="panel">
      <p>Connect a mail source to check for replies.</p>
      <Button type="button" onClick={() => go('Connections', 'email')}>Connect an inbox</Button>
    </section>}
    {Boolean(accounts?.length) && <section className="panel" aria-label="Check job mail">
      <form onSubmit={event => { event.preventDefault(); search() }}>
        <fieldset disabled={Boolean(busy)}>
          <legend>Check job mail</legend>
          <label htmlFor="job-mail-source">Mail source</label>
          <select id="job-mail-source" value={provider} onChange={event => { setProvider(event.target.value); clear() }}>
            {accounts.map(a => <option key={a.provider} value={a.provider}>{labels[a.provider]}{a.provider !== 'apple' && ' · ' + a.email}</option>)}
          </select>
          <label htmlFor="job-mail-jobs">Tracked jobs</label>
          <select id="job-mail-jobs" value={jobId} onChange={event => { setJobId(event.target.value); clear() }}>
            <option value="">All tracked jobs</option>
            {jobs.map(job => <option key={job.id} value={job.id}>{job.company} · {job.title}</option>)}
          </select>
          <p>{jobs.length ? 'Each check searches up to four tracked employers and reviews up to 15 messages per employer.' : 'Save a job in Applications to check for its replies.'}</p>
          <Button type="submit" disabled={!jobs.length}>Check for replies</Button>
        </fieldset>
      </form>
      {busy === 'scan' && <div className="toolbar"><span role="status">Checking job mail…</span><Button type="button" variant="outline" onClick={cancel}>Cancel check</Button></div>}
      {results && <>
        <p role="status">{visible.length ? visible.length + (visible.length === 1 ? ' matching reply.' : ' matching replies.') : 'No matching replies found.'}
          {' '}Checked {results.checked} of {results.totalCompanies} tracked {results.totalCompanies === 1 ? 'employer' : 'employers'}.</p>
        {results.nextOffset != null && <Button type="button" variant="outline" disabled={Boolean(busy)} onClick={() => search(results.nextOffset)}>Check next employers</Button>}
        <ul>{visible.map(row => <li key={row.message.key}>
          <Button type="button" variant="link" disabled={Boolean(busy)} onClick={() => { select(row); setIncludePreview(false); setError('') }}>{row.message.subject}</Button>
          {' · '}{row.company} · {row.title}
        </li>)}</ul>
      </>}
    </section>}
    {message && <section className="panel" aria-label="Review reply">
      <h2>Review reply</h2>
      <p><strong>{message.subject}</strong><br />From {message.from || 'unknown sender'}<br />
        {message.receivedAt && <time dateTime={message.receivedAt}>{new Date(message.receivedAt).toLocaleString()}</time>}</p>
      {message.preview && <blockquote>{message.preview}</blockquote>}
      {message.url && <Button type="button" variant="outline" onClick={() => call('app.openExternal', { url: message.url }).catch(err => setError(err.message))}>Read original message</Button>}
      <p>Link this reply to <strong>{target.company} · {target.title}</strong>. The note includes the sender, subject, date and source.</p>
      {message.preview && <label><input type="checkbox" checked={includePreview} disabled={Boolean(busy)} onChange={event => setIncludePreview(event.target.checked)} /> Include the displayed excerpt in the note</label>}
      <div className="toolbar">
        <Button type="button" disabled={Boolean(busy)} onClick={link}>Link reply to this job</Button>
        <Button type="button" variant="outline" disabled={Boolean(busy)} onClick={() => select(null)}>Cancel review</Button>
      </div>
    </section>}
    {linkedNotes.length > 0 && <section className="panel" aria-label="Previously linked replies">
      <h2>Previously linked replies</h2>
      {linkedNotes.filter(note => !jobId || note.jobId === jobId).map(note => {
        const job = jobs.find(item => item.id === note.jobId)
        return <details key={note.id}><summary>{job.company} · {job.title} · {note.title}</summary><pre>{note.body}</pre></details>
      })}
    </section>}
  </section>
}
