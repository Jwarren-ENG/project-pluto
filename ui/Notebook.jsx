import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Button } from './components/ui/button'
import { Input } from './components/ui/input'
import { Textarea } from './components/ui/textarea'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './components/ui/table'

function SyncReport({ result }) {
  if (!result) return null
  const { written, imported, unchanged, preserved, conflicts } = result
  return <div className="stack" role="status">
    <p>{written} written · {imported} imported · {unchanged} unchanged</p>
    {[['Conflicts', conflicts], ['Preserved files', preserved]].map(([title, rows]) => rows.length > 0 && <div key={title}>
      <h3>{title}</h3>
      <ul>{rows.map((row, i) => <li key={(row.id ?? row.path) + '/' + i}>
        <span>{row.reason}</span>
        {(row.paths ?? [row.path]).filter(Boolean).map(path => <div className="muted [overflow-wrap:anywhere]" key={path}>{path}</div>)}
      </li>)}</ul>
    </div>)}
  </div>
}

export default function Notebook({ state, notify, refresh, seed, setSeed, reportEditor, requestLeave }) {
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

  useLayoutEffect(() => {
    reportEditor({ kind: 'note', dirty: Boolean(dirty), working: pending === 'Saving' ? 'Saving your note…' : null })
    return () => reportEditor(null)
  }, [dirty, pending, reportEditor])

  const returnTo = useRef(null)
  const editing = editor !== null
  useEffect(() => {
    if (!editing && returnTo.current) {
      const target = document.getElementById(returnTo.current) ?? document.getElementById('new-note')
      target?.focus()
      returnTo.current = null
    }
  }, [editing])

  function open(note, trigger) {
    if (trigger) returnTo.current = trigger
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
    {editor ? <form className="space-y-4" onSubmit={save}>
      <header className="section-heading border-b pb-4"><h2>{editor.id ? 'Edit note' : 'New note'}</h2>
        <Button type="button" variant="ghost" size="sm" disabled={!!pending} onClick={() => requestLeave(close)}>
          Close
        </Button>
      </header>
      <div className="field-grid">
        <label>Title<Input aria-label="Title" autoFocus required value={editor.title} disabled={!!pending} onChange={e => setEditor({ ...editor, title: e.target.value })} /></label>
        <label>Linked application<select aria-label="Linked application" value={editor.jobId ?? ''} disabled={!!pending}
          onChange={e => setEditor({ ...editor, jobId: e.target.value || null })}>
          <option value="">General note</option>
          {state.jobs.map(j => <option value={j.id} key={j.id}>{j.company} · {j.title}</option>)}
        </select></label>
      </div>
      <label>Markdown<Textarea aria-label="Markdown" rows={10} value={editor.body} disabled={!!pending}
        onChange={e => setEditor({ ...editor, body: e.target.value })} /></label>
      {stale && <div role="status"><p>A newer version was saved. Your edits are still in the form.</p>
        <Button type="button" variant="outline" size="sm" onClick={() => requestLeave(() => open(latest))}>Discard edits and load saved version</Button></div>}
      <div className="toolbar"><Button size="sm" type="submit" disabled={!!pending || !!stale}>{pending === 'Saving' ? 'Saving…' : 'Save note'}</Button></div>
    </form> : <section aria-label="Notes" className="stack">
      <div className="section-heading pb-4">
        {state.notes.length > 0 ? <Input type="search" aria-label="Find a note" placeholder="Find a note" className="max-w-sm"
          value={filter} onChange={e => setFilter(e.target.value)} /> : <h2>Notes</h2>}
        <Button type="button" id="new-note" size="sm" disabled={!!pending} onClick={() => open(null, 'new-note')}>New note</Button>
      </div>
      <Table aria-label="Notebook notes" className="max-sm:table-fixed max-sm:[&_td]:px-1.5 max-sm:[&_th]:px-1.5">
        <TableHeader><TableRow>
          <TableHead scope="col" className="max-sm:w-[39%]">Note</TableHead>
            <TableHead scope="col" className="whitespace-normal">Linked application</TableHead>
            <TableHead scope="col" className="max-sm:w-[24%]">Updated</TableHead>
        </TableRow></TableHeader>
        <TableBody>
          {visible.map(note => {
            const job = byId.get(note.jobId)
            return <TableRow key={note.id}>
              <TableCell className="whitespace-normal">
                <Button type="button" id={'open-note-' + note.id} variant="link" size="sm" className="block h-auto max-w-full whitespace-normal px-0 text-left [overflow-wrap:anywhere]"
                  disabled={!!pending} aria-label={`Edit ${note.title}`} onClick={() => open(note, 'open-note-' + note.id)}>{note.title}</Button>
              </TableCell>
              <TableCell className="whitespace-normal [overflow-wrap:anywhere]">{job ? job.company + ' · ' + job.title : 'General note'}</TableCell>
              <TableCell className="whitespace-normal"><time dateTime={note.updatedAt}>
                {new Date(note.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
              </time></TableCell>
            </TableRow>
          })}
          {!visible.length && <TableRow><TableCell colSpan={3} className="whitespace-normal py-6">
            {state.notes.length ? 'No notes match this search.' : 'Create a general note or link one to an application.'}
          </TableCell></TableRow>}
        </TableBody>
      </Table>
    </section>}
    {error && <p role="alert">{error}</p>}
    <section className="mt-6 space-y-3 border-t py-5" aria-labelledby="vault-heading">
      <div className="section-heading"><h2 id="vault-heading">Obsidian vault</h2>
        <div className="toolbar">
          <Button type="button" variant="outline" size="sm" disabled={!!pending} onClick={() => sync('Exporting')}>{pending === 'Exporting' ? 'Exporting…' : 'Export to vault'}</Button>
          <Button type="button" variant="outline" size="sm" disabled={!!pending} onClick={() => sync('Importing')}>{pending === 'Importing' ? 'Importing…' : 'Import vault edits'}</Button>
        </div>
      </div>
      <p className="muted">Export includes notes, employer evidence and submitted materials. Import brings your vault edits into Pluto.</p>
      <SyncReport result={result} />
    </section>
  </div>
}
