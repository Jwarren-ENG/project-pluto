import React, { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react'
import { Button } from './components/ui/button'
import { Input } from './components/ui/input'
import { Textarea } from './components/ui/textarea'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './components/ui/table'
import { formatRecordDate } from '../desktop/record-dates.mjs'
import { hasDraftMaterial } from '../desktop/workflow-features.mjs'

const blankNote = () => ({ title: '', body: '', jobId: null })
const noteFields = ['title', 'body', 'jobId']
const matches = (left, right) => noteFields.every(key => left?.[key] === right?.[key])
const draftKinds = { studyGuides: 'Study guide', interviewPrep: 'Interview prep' }
const dayFormat = { month: 'short', day: 'numeric', year: 'numeric' }
const hasText = value => typeof value === 'string' && Boolean(value.trim())

function PreparationNotes({ state, go, pending, generate, jobId, setJobId }) {
  const enabled = Object.keys(draftKinds).filter(kind => state.features?.[kind] === true)
  const settings = <Button variant="link" type="button" className="px-0" disabled={Boolean(pending)}
    onClick={() => go('Connections', 'features')}>Manage in Connections</Button>
  if (!enabled.length) return <p className="muted">Study guides and interview prep are off. {settings}</p>
  const selected = state.jobs.find(job => job.id === jobId)
  const reviewed = hasDraftMaterial(state.profile)
  return <section aria-labelledby="prep-heading" className="mb-5 border-y py-4">
    <div className="section-heading"><h2 id="prep-heading">Preparation notes</h2>{settings}</div>
    <p>Your drafting provider uses the selected role and your reviewed profile. You can edit the result before saving.</p>
    <label htmlFor="prep-role">Tracked role</label>
    <select id="prep-role" value={selected?.id ?? ''} onChange={event => setJobId(event.target.value)}
      disabled={Boolean(pending) || !state.jobs.length}>
      <option value="">Choose a role</option>
      {state.jobs.map(job => <option key={job.id} value={job.id}>{job.company} · {job.title}</option>)}
    </select>
    {!state.jobs.length && <p>Add a tracked role in Applications to draft a preparation note.</p>}
    {!reviewed && <p>Review your résumé or add a confirmed fact in Profile to use it in a draft.</p>}
    <div className="toolbar">{enabled.map(kind =>
      <Button key={kind} id={'draft-' + kind} type="button" variant="outline" disabled={Boolean(pending) || !selected || !reviewed}
        onClick={() => generate(kind, selected)}>Draft {draftKinds[kind].toLowerCase()}</Button>
    )}</div>
    {pending === 'Drafting' && <p role="status">Preparing your draft…</p>}
  </section>
}

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

export default function Notebook({ state, notify, refresh, seed, setSeed, reportEditor, requestLeave, go }) {
  const [editor, setEditor] = useState(null)
  const [original, setOriginal] = useState(null)
  const [filter, setFilter] = useState('')
  const [prepJobId, setPrepJobId] = useState('')
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const [pending, setPending] = useState('')
  const running = useRef(false)
  const latest = editor?.id && state.notes.find(n => n.id === editor.id)
  const stale = latest && latest.updatedAt !== editor.updatedAt
  const dirty = editor && !matches(editor, original)
  // A fresh snapshot can replace a clean reader. An editing session owns its base revision until save or discard.
  const followRefresh = useEffectEvent(note => {
    if (!dirty && note && (note.updatedAt !== editor.updatedAt || !matches(note, editor))) open(note)
  })
  useLayoutEffect(() => { if (latest) followRefresh(latest) }, [latest])

  useLayoutEffect(() => {
    reportEditor({ kind: 'note', dirty: Boolean(dirty), working: pending ? pending + '…' : null })
    return () => reportEditor(null)
  }, [dirty, pending, reportEditor])

  const returnTo = useRef(null)
  const openSeed = useEffectEvent(id => {
    setSeed(null)
    if (editor?.id === id) return
    const note = state.notes.find(item => item.id === id)
    if (note) requestLeave(() => open(note, 'open-note-' + id))
    else setError({ message: 'This note is no longer in the workspace.' })
  })
  useEffect(() => { if (seed?.noteId) openSeed(seed.noteId) }, [seed?.noteId])
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
    const value = note ?? blankNote()
    setOriginal(value)
    setEditor({ ...value })
    setError(null)
  }

  function close() {
    setEditor(null)
    setOriginal(null)
    setError(null)
  }

  function edit(changes) {
    const next = { ...editor, ...changes }
    if (stale && matches(next, original)) open(latest)
    else setEditor(next)
  }

  function generate(kind, job) {
    run('Drafting', async () => {
      const body = await window.pluto.call('learning.draft', { kind, jobId: job.id })
      if (!hasText(body)) throw new Error('The provider returned an empty draft. Try again or write a note.')
      returnTo.current = 'draft-' + kind
      setOriginal(blankNote())
      setEditor({ title: draftKinds[kind] + ' · ' + job.company + ' · ' + job.title, jobId: job.id, body })
      notify('Draft ready for review.')
    })
  }

  async function run(name, fn) {
    if (running.current) return
    running.current = true
    setPending(name)
    setError(null)
    try { await fn() } catch (err) { setError({ action: name, message: err.message || String(err) }) }
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
  const query = filter.trim().toLowerCase()
  const visible = editor || !query ? state.notes : state.notes.filter(n => {
    const job = byId.get(n.jobId)
    return [n.title, n.body, job?.company, job?.title].join(' ').toLowerCase().includes(query)
  })

  return <div className="stack">
    {editor ? <form className="space-y-4" onSubmit={save}>
      <header className="section-heading border-b pb-4"><h2>{editor.id ? 'Edit note' : 'New note'}</h2>
        <Button type="button" variant="ghost" size="sm" disabled={!!pending} onClick={() => requestLeave(close)}>
          Close
        </Button>
      </header>
      <div className="field-grid">
        <label>Title<Input aria-label="Title" autoFocus required value={editor.title} disabled={!!pending} onChange={e => edit({ title: e.target.value })} /></label>
        <label>Linked application<select aria-label="Linked application" value={editor.jobId ?? ''} disabled={!!pending}
          onChange={e => edit({ jobId: e.target.value || null })}>
          <option value="">General note</option>
          {state.jobs.map(j => <option value={j.id} key={j.id}>{j.company} · {j.title}</option>)}
        </select></label>
      </div>
      {state.linkedNotes?.includes(editor.id) &&
        <Button type="button" variant="link" size="sm" className="self-start px-0" disabled={!!pending}
          onClick={() => run('Opening source', () => window.pluto.call('jobkit.openNote', { id: editor.id }))}>
          Open original note in Obsidian
        </Button>}
      <label>Markdown<Textarea aria-label="Markdown" rows={10} className="field-sizing-fixed h-[clamp(10rem,38vh,24rem)] overflow-y-auto"
        value={editor.body} disabled={!!pending} onChange={e => edit({ body: e.target.value })} /></label>
      {stale && <div role="status"><p>A newer version was saved. Your edits are still in the form.</p>
        <Button type="button" variant="outline" size="sm" onClick={() => requestLeave(() => open(latest))}>Discard edits and load saved version</Button></div>}
      <div className="toolbar"><Button size="sm" type="submit" disabled={!!pending || !!stale}>{pending === 'Saving' ? 'Saving…' : 'Save note'}</Button></div>
    </form> : <section aria-label="Notes" className="stack">
      <div className="section-heading pb-4">
        {state.notes.length > 0 ? <Input type="search" aria-label="Find a note" placeholder="Find a note" className="max-w-sm"
          value={filter} onChange={e => setFilter(e.target.value)} /> : <h2>Notes</h2>}
        <Button type="button" id="new-note" size="sm" disabled={!!pending} onClick={() => open(null, 'new-note')}>New note</Button>
      </div>
      <PreparationNotes state={state} go={go} pending={pending} generate={generate} jobId={prepJobId} setJobId={setPrepJobId} />
      {error?.action === 'Drafting' && <p role="alert">{error.message}</p>}
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
                {formatRecordDate(note.updatedAt, dayFormat)}
              </time></TableCell>
            </TableRow>
          })}
          {!visible.length && <TableRow><TableCell colSpan={3} className="whitespace-normal py-6">
            {state.notes.length ? 'No notes match this search.' : 'Create a general note or link one to an application.'}
          </TableCell></TableRow>}
        </TableBody>
      </Table>
    </section>}
    {error && error.action !== 'Drafting' && <p role="alert">{error.message}</p>}
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
