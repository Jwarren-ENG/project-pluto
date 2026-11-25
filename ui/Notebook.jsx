import React, { useRef, useState } from 'react'

function SyncReport({ result }) {
  if (!result) return null
  const { written, imported, unchanged, preserved, conflicts } = result
  return <div className="stack" role="status">
    <p>{written} written · {imported} imported · {unchanged} unchanged</p>
    {[['Conflicts', conflicts], ['Preserved files', preserved]].map(([title, rows]) => rows.length > 0 && <div key={title}>
      <h3>{title}</h3>
      <ul>{rows.map((row, i) => <li key={(row.id ?? row.path) + '/' + i}>
        <span>{row.reason}</span>
        {(row.paths ?? [row.path]).filter(Boolean).map(path => <div className="muted" key={path}>{path}</div>)}
      </li>)}</ul>
    </div>)}
  </div>
}

export default function Notebook({ state, notify, refresh, seed, setSeed }) {
  const [editor, setEditor] = useState(() => {
    const note = seed?.noteId && state.notes.find(n => n.id === seed.noteId)
    return note ? { ...note } : null
  })
  const [original, setOriginal] = useState(editor)
  const [filter, setFilter] = useState('')
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')
  const [pending, setPending] = useState('')
  const running = useRef(false)
  const latest = editor?.id && state.notes.find(n => n.id === editor.id)
  const stale = latest && latest.updatedAt !== editor.updatedAt
  const dirty = editor && ['title', 'body', 'jobId'].some(k => editor[k] !== original?.[k])

  function open(note) {
    const value = note ?? { title: '', body: '', jobId: null }
    setOriginal(value)
    setEditor({ ...value })
    setError('')
  }

  function close() {
    setEditor(null)
    setOriginal(null)
    setError('')
    if (seed?.noteId) setSeed(null)
  }

  async function run(name, fn) {
    if (running.current) return
    running.current = true
    setPending(name)
    setError('')
    try { await fn() } catch (err) { setError(err.message || String(err)) }
    finally { running.current = false; setPending('') }
  }

  function save(event) {
    event.preventDefault()
    run('Saving', async () => {
      let saved
      try { saved = await window.pluto.call('workspace.saveNote', editor) }
      catch (err) { if (editor.id) await refresh().catch(() => {}); throw err }
      open(saved)
      notify('Note saved.')
      await refresh()
    })
  }

  function sync(mode) {
    run(mode, async () => {
      const report = await window.pluto.call(mode === 'Importing' ? 'workspace.importVault' : 'workspace.exportVault', {})
      if (!report) return
      setResult(report)
      notify(report.conflicts.length ? 'Vault sync finished with conflicts to review.' : 'Vault sync finished.')
      if (mode === 'Importing') await refresh()
    })
  }

  const byId = new Map(state.jobs.map(job => [job.id, job]))
  const visible = state.notes.filter(n => {
    const job = byId.get(n.jobId)
    return [n.title, n.body, job?.company, job?.title].join(' ').toLowerCase().includes(filter.trim().toLowerCase())
  })
  return <div className="stack">
    {editor ? <form className="panel stack" onSubmit={save}>
      <div className="section-heading"><h2>{editor.id ? 'Edit note' : 'New note'}</h2>
        <button type="button" className="secondary" disabled={!!pending} onClick={close}>{dirty ? 'Discard changes and close' : 'Close'}</button></div>
      <fieldset className="field-grid" disabled={!!pending}><legend>Note details</legend>
        <label>Title<input required value={editor.title} onChange={e => setEditor({ ...editor, title: e.target.value })} /></label>
        <label>Linked application<select value={editor.jobId ?? ''} onChange={e => setEditor({ ...editor, jobId: e.target.value || null })}>
          <option value="">General note</option>
          {state.jobs.map(j => <option value={j.id} key={j.id}>{j.company} · {j.title}</option>)}
        </select></label>
      </fieldset>
      <label>Markdown<textarea rows={10} value={editor.body} disabled={!!pending} onChange={e => setEditor({ ...editor, body: e.target.value })} /></label>
      {stale && <div role="status"><p>A newer version was saved. Your edits are still in the form.</p>
        <button type="button" className="secondary" onClick={() => open(latest)}>Discard edits and load saved version</button></div>}
      <div className="buttons"><button className="primary" type="submit" disabled={!!pending || !!stale}>{pending === 'Saving' ? 'Saving…' : 'Save note'}</button></div>
    </form> : <section className="panel stack">
      <div className="section-heading"><h2>Notes</h2><button className="primary" disabled={!!pending} onClick={() => open(null)}>New note</button></div>
      {state.notes.length > 0 && <label>Find a note<input type="search" value={filter} onChange={e => setFilter(e.target.value)} /></label>}
      {visible.map(n => { const job = byId.get(n.jobId); return <button key={n.id} className="record-row" disabled={!!pending} onClick={() => open(n)}>
        <span><strong>{n.title}</strong><small>{job ? job.company + ' · ' + job.title : 'General note'}</small></span>
        <time className="muted" dateTime={n.updatedAt}>{new Date(n.updatedAt).toLocaleDateString()}</time>
      </button> })}
      {!visible.length && <p className="muted">{state.notes.length ? 'No notes match this search.' : 'Create a general note or link one to an application.'}</p>}
    </section>}
    {error && <p role="alert">{error}</p>}
    <section className="panel stack"><h2>Obsidian vault</h2>
      <p className="muted">Choose your vault when syncing. Export includes notes, employer evidence and submitted materials.</p>
      <div className="buttons">
        <button type="button" className="secondary" disabled={!!pending} onClick={() => sync('Exporting')}>{pending === 'Exporting' ? 'Exporting…' : 'Export to vault'}</button>
        <button type="button" className="secondary" disabled={!!pending} onClick={() => sync('Importing')}>{pending === 'Importing' ? 'Importing…' : 'Import vault edits'}</button>
      </div>
      <SyncReport result={result} />
    </section>
  </div>
}
