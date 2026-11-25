import React, { useEffect, useRef, useState } from 'react'

const labels = { gmail: 'Gmail', outlook: 'Outlook' }
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
  if (!target || target.company !== job.company || target.title !== job.title) {
    throw new Error('The tracked job changed. Choose it again and review the match.')
  }
  const existing = latest.notes.some(note => note.id === id ||
    (note.jobId === job.id && note.body?.endsWith('Mail reference: ' + message.key)))
  if (existing) return false
  await workspaceCall('workspace.saveNote', { id, updatedAt: '', jobId: job.id, title: 'Employer reply · ' + job.company,
    body: noteBody(message, includePreview) })
  return true
}

export default function Mail({ state, notify, refresh }) {
  const [accounts, setAccounts] = useState([])
  const [provider, setProvider] = useState('gmail')
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [jobId, setJobId] = useState('')
  const [results, setResults] = useState(null)
  const [selected, select] = useState(null)
  const [includePreview, setIncludePreview] = useState(false)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [loaded, setLoaded] = useState(false)
  const mounted = useRef(false)
  const pending = useRef(null)
  const jobs = state?.jobs || []
  const job = jobs.find(item => item.id === jobId)
  const account = accounts.find(item => item.provider === provider)
  const clearResults = () => { setResults(null); select(null); setIncludePreview(false) }

  async function loadAccounts() {
    const data = await call('mail.settings')
    if (mounted.current) { setAccounts(data); setLoaded(true) }
  }
  useEffect(() => {
    mounted.current = true
    loadAccounts().catch(err => { if (mounted.current) setError(err.message) })
    return () => {
      mounted.current = false
      const op = pending.current
      if (op && ['scan', 'connect'].includes(op.kind)) call('mail.' + op.kind, { provider: op.provider, cancel: true }).catch(() => {})
    }
  }, [])

  async function run(kind, perform) {
    if (pending.current) return
    pending.current = { kind, provider }
    setBusy(kind)
    setError('')
    try { await perform() }
    catch (err) { if (mounted.current) setError(err.message || 'The request could not be completed.') }
    finally {
      pending.current = null
      if (mounted.current) setBusy('')
    }
  }

  function connect(event) {
    event.preventDefault()
    run('connect', async () => {
      const details = { provider, clientId, clientSecret }
      setClientSecret('')
      const result = await call('mail.connect', details)
      if (!mounted.current) return
      setClientId('')
      await loadAccounts()
      notify('Connected ' + result.email + '.')
    })
  }
  function search(event) {
    event.preventDefault()
    if (!job || !account?.email) return
    clearResults()
    run('scan', async () => {
      const messages = await call('mail.scan', { provider, company: job.company })
      if (mounted.current) setResults({ jobId: job.id, company: job.company, email: account.email, messages })
    })
  }
  const currentResults = results && job && results.jobId === job.id &&
    results.company === job.company && results.email === account?.email ? results : null

  function link() {
    if (!currentResults || !selected) return
    run('link', async () => {
      let created
      try { created = await linkReviewedReply({ job, message: selected, includePreview }, call) }
      finally { await refresh() }
      if (mounted.current) select(null)
      notify(created ? 'Reply linked to ' + job.title + ' at ' + job.company + '.' : 'This message is already linked to this job.')
    })
  }
  const running = busy || account?.busy
  async function cancel() {
    try { await call('mail.' + running, { provider, cancel: true }); await loadAccounts() }
    catch (err) { if (mounted.current) setError(err.message) }
  }

  return <section className="section" aria-label="Job email">
    <h2>Job email</h2>
    <section className="panel" aria-label="Mail connection">
      <label>Mail provider
        <select value={provider} disabled={!!running} onChange={event => {
          setProvider(event.target.value); setClientId(''); setClientSecret(''); setError(''); clearResults()
        }}>
          <option value="gmail">Gmail</option><option value="outlook">Outlook</option>
        </select>
      </label>
      {!loaded && !error && <p role="status">Loading accounts…</p>}
      {!loaded && error && <button type="button" onClick={() => run('load', loadAccounts)}>Retry</button>}
      {loaded && (account?.email || account?.error ? <>
        {account.error ? <p role="alert">{account.error}</p> : <p>Connected as <strong>{account.email}</strong>.</p>}
        <button type="button" disabled={!!running} onClick={() => run('disconnect', async () => {
          await call('mail.disconnect', { provider }); clearResults(); await loadAccounts(); notify('Account disconnected from this device.')
        })}>Disconnect account</button>
      </> : <form onSubmit={connect}>
        <fieldset disabled={!!running}>
          <legend>Connect {labels[provider]}</legend>
          <p>Use your own desktop app registration. Sign in with your provider in the system browser.</p>
          <details><summary>Registration instructions</summary>
            {provider === 'gmail' ? <p>In Google Cloud, enable the Gmail API, configure the consent screen, and create a Desktop app OAuth client. If the app is in testing, add your account as a test user. Copy the client ID and any issued client secret below.</p> :
              <p>In Microsoft Entra, register a public client for organizational and personal accounts. Under Mobile and desktop applications add <code>http://localhost/pluto/outlook</code>. Add delegated Microsoft Graph permissions for User.Read and Mail.Read.</p>}
          </details>
          <label>Desktop client ID<input required value={clientId} autoComplete="off" spellCheck={false} onChange={e => setClientId(e.target.value)} /></label>
          {provider === 'gmail' && <label>Desktop client secret, if issued<input type="password" autoComplete="off" value={clientSecret} onChange={e => setClientSecret(e.target.value)} /></label>}
          <button>Connect {labels[provider]}</button>
        </fieldset>
      </form>)}
      {running === 'connect' && <div role="status"><p>Waiting for sign-in in your browser…</p><button type="button" onClick={cancel}>Cancel sign-in</button></div>}
    </section>
    {account?.email && <section className="panel" aria-label="Search inbox">
      <form onSubmit={search}>
        <fieldset disabled={!!running}>
          <legend>Find an employer reply</legend>
          <label>Tracked job<select value={jobId} onChange={e => { setJobId(e.target.value); clearResults(); setError('') }}>
            <option value="">Choose a job</option>
            {jobs.map(item => <option key={item.id} value={item.id}>{item.company} · {item.title}</option>)}
          </select></label>
          <p>{jobs.length ? 'Search up to 15 inbox messages using the selected employer’s name.' : 'Save a job in your workspace to search for its employer.'}</p>
          <button disabled={!job}>Search inbox</button>
        </fieldset>
      </form>
      {running === 'scan' && <div role="status"><p>Searching the inbox…</p><button type="button" onClick={cancel}>Cancel search</button></div>}
      {currentResults && <div><p role="status">{currentResults.messages.length ? currentResults.messages.length + ' possible matches. Review the sender and subject before linking.' : 'No matching inbox messages found.'}</p>
        <ul>{currentResults.messages.map(message => <li key={message.key}>
          <button type="button" disabled={!!running} onClick={() => { select(message); setIncludePreview(false); setError('') }}>
            {message.subject} · {message.from || 'Unknown sender'}
          </button>
        </li>)}</ul>
      </div>}
    </section>}
    {currentResults && selected && <section className="panel" aria-label="Review reply">
      <h3>Review reply</h3>
      <p><strong>{selected.subject}</strong><br />From {selected.from || 'unknown sender'}<br />
        {selected.receivedAt && <time dateTime={selected.receivedAt}>{new Date(selected.receivedAt).toLocaleString()}</time>}</p>
      {selected.preview && <blockquote>{selected.preview}</blockquote>}
      {selected.url && <button type="button" disabled={!!running} onClick={() => run('open', () => call('app.openExternal', { url: selected.url }))}>Read original message</button>}
      <p>Save a note on <strong>{job.company} · {job.title}</strong> with the sender, subject, received time, mailbox and message reference. The job keeps its current stage.</p>
      {selected.preview && <label><input type="checkbox" disabled={!!running} checked={includePreview} onChange={e => setIncludePreview(e.target.checked)} /> Include the displayed excerpt in the note</label>}
      <button type="button" disabled={!!running} onClick={link}>Link reply to this job</button>
      <button type="button" disabled={!!running} onClick={() => select(null)}>Cancel review</button>
    </section>}
    {error && <p role="alert">{error}</p>}
  </section>
}
