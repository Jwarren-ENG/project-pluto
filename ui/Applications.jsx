import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Button } from './components/ui/button'
import { Input } from './components/ui/input'
import { Textarea } from './components/ui/textarea'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './components/ui/table'

const stages = ['Saved', 'Preparing', 'Applied', 'Interview', 'Offer', 'Closed']
const employerStages = new Set(['Applied', 'Interview', 'Offer', 'Closed'])
const fields = ['company', 'title', 'url', 'location', 'salary', 'description', 'resumeText', 'draft']

function localTime(iso) {
  if (!iso) return ''
  const date = new Date(iso)
  const pad = n => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function editable(job) {
  return {
    ...Object.fromEntries(fields.map(key => [key, job[key] ?? ''])),
    interviewAt: localTime(job.interviewAt), stage: job.stage ?? 'Saved', evidence: '',
  }
}

function receiptText(value) {
  return typeof value === 'string' ? value : Object.entries(value ?? {}).map(([k, v]) => `${k}: ${v}`).join('\n')
}

function RecordHistory({ job }) {
  const sent = job.submittedSnapshot
  return <>
    {sent && <details className="border-t py-4"><summary className="cursor-pointer font-medium">Submitted copy</summary>
      <p>{sent.company} · {sent.title} · <time dateTime={sent.submittedAt}>{new Date(sent.submittedAt).toLocaleString()}</time></p>
      <h3>Employer receipt</h3><pre>{receiptText(sent.evidence)}</pre>
      <h3>Submitted résumé</h3><pre>{sent.resumeText || 'No résumé text was recorded.'}</pre>
      <h3>Submitted draft</h3><pre>{sent.draft || 'No draft text was recorded.'}</pre>
    </details>}
    {!!job.history?.length && <details className="border-t py-4"><summary className="cursor-pointer font-medium">Application history</summary>
      <ol>{job.history.slice().reverse().map((e, i) => <li key={e.recordedAt + '/' + i}>
        <strong>{e.stage}</strong> · <time dateTime={e.recordedAt}>{new Date(e.recordedAt).toLocaleString()}</time>
        {e.evidence && <pre>{receiptText(e.evidence)}</pre>}
        {e.interviewAt && <p>Interview · {new Date(e.interviewAt).toLocaleString()}</p>}
      </li>)}</ol>
    </details>}
  </>
}

function JobEditor({ initial, state, refresh, notify, close, reportEditor, requestLeave }) {
  const [base, setBase] = useState(initial)
  const [form, setForm] = useState(() => editable(initial))
  const [suggestion, setSuggestion] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const running = useRef(false)
  const latest = state.jobs.find(j => j.id === base.id)
  const stale = latest && latest.updatedAt !== base.updatedAt
  const hasChanges = JSON.stringify(form) !== JSON.stringify(editable(base))
  const dirty = hasChanges || suggestion !== null
  useLayoutEffect(() => {
    const working = busy === 'Saving' ? 'Saving your application…' : busy === 'Drafting' ? 'Finishing your draft…' : null
    reportEditor({ kind: 'application', dirty, working })
    return () => reportEditor(null)
  }, [dirty, busy, reportEditor])
  const needsProof = employerStages.has(form.stage) && form.stage !== (base.stage ?? 'Saved')
  const profile = state.profile
  const canDraft = form.title.trim() && (profile?.confirmedFacts?.length || profile?.resumeText?.trim() || profile?.summary?.trim() || profile?.experienceStories?.some(s => s?.useInDrafts === true && s.action?.trim()))
  const change = (field, value) => setForm(prev => ({ ...prev, [field]: value }))

  function load(saved) {
    setBase(saved)
    setForm(editable(saved))
    setSuggestion(null)
    setError('')
  }

  async function run(name, fn) {
    if (running.current) return
    running.current = true
    setBusy(name)
    setError('')
    try { await fn() } catch (err) { setError(err.message || String(err)) }
    finally { running.current = false; setBusy('') }
  }

  async function save(event) {
    event.preventDefault()
    await run('Saving', async () => {
      let at = base.interviewAt ?? null
      if (form.interviewAt !== localTime(at)) {
        const date = form.interviewAt ? new Date(form.interviewAt) : null
        if (date && (!Number.isFinite(date.valueOf()) || localTime(date) !== form.interviewAt)) {
          throw new Error('Choose a valid interview time in your local time zone.')
        }
        at = date?.toISOString() ?? null
      }
      let saved
      try {
        saved = await window.pluto.call('workspace.saveJob', {
          ...form, id: base.id, updatedAt: base.updatedAt, interviewAt: at,
        })
      } catch (err) {
        if (base.id) await refresh().catch(() => {})
        throw err
      }
      load(saved)
      notify('Saved ' + saved.title + ' at ' + saved.company + '.')
      await refresh()
    })
  }

  function generate() {
    run('Drafting', async () => {
      const job = Object.fromEntries(['company', 'title', 'description', 'location', 'salary'].map(k => [k, form[k]]))
      const draft = await window.pluto.call('providers.draft', { job })
      if (!draft || typeof draft !== 'string') throw new Error('The provider returned an empty draft.')
      if (form.draft.trim()) setSuggestion(draft)
      else change('draft', draft)
      notify('Draft ready for review.')
    })
  }

  function openEmployer() {
    run('Opening', () => window.pluto.call('application.open', { id: base.id }))
  }
  function saveToDrive() {
    run('Uploading', async () => {
      const result = await window.pluto.call('application.drivePdf', { id: base.id, updatedAt: base.updatedAt })
      notify(result.alreadySaved ? 'This résumé is already in Google Drive.' : 'Reviewed résumé saved in Google Drive.')
    })
  }

  function printResume() {
    run('Exporting', async () => {
      const wrote = await window.pluto.call('application.pdf', { id: base.id })
      if (wrote) notify('Reviewed résumé PDF saved.')
    })
  }

  const input = (key, label, options = {}) => <label>{label}
    <Input {...options} aria-label={label} value={form[key]} disabled={!!busy} onChange={e => change(key, e.target.value)} />
  </label>
  return <div className="stack">
    <form className="stack" onSubmit={save}>
      <header className="section-heading pb-4">
        <h2>{base.id ? base.title : 'New application'}</h2>
        <Button type="button" variant="ghost" size="sm" disabled={!!busy} onClick={() => requestLeave(close)}>
          Close
        </Button>
      </header>
      <section className="space-y-3 border-t py-5" aria-labelledby="role-details-heading">
        <div className="section-heading"><h3 id="role-details-heading">Role details</h3>
          <Button type="button" variant="outline" size="sm" onClick={openEmployer}
            disabled={!!busy || !base.id || !base.url || form.url !== base.url}>Open employer application</Button>
        </div>
        <div className="field-grid">
          {input('company', 'Company', { required: true, autoFocus: true })}
          {input('title', 'Job title', { required: true })}
          {input('location', 'Location')}
          {input('salary', 'Base salary')}
        </div>
        {input('url', 'Employer posting URL', { type: 'url', placeholder: 'https://' })}
        {!!form.url && (!base.id || form.url !== base.url) && <small className="muted">Save this posting to open the employer form.</small>}
        <label>Job description<Textarea aria-label="Job description" rows={4} value={form.description} disabled={!!busy} onChange={e => change('description', e.target.value)} /></label>
      </section>
      <section className="space-y-3 border-t py-5" aria-labelledby="materials-heading">
        <h3 id="materials-heading">Application materials</h3>
        <label>Reviewed résumé text<Textarea aria-label="Reviewed résumé text" rows={6} value={form.resumeText} disabled={!!busy} onChange={e => change('resumeText', e.target.value)} /></label>
        <div className="toolbar">
          {profile?.resumeText && <Button type="button" variant="outline" size="sm" disabled={!!busy || form.resumeText === profile.resumeText}
            onClick={() => change('resumeText', profile.resumeText)}>{form.resumeText ? 'Replace with profile résumé' : 'Use profile résumé'}</Button>}
          <Button type="button" variant="outline" size="sm" disabled={!!busy || !base.id || !base.resumeText?.trim() || form.resumeText !== base.resumeText}
            onClick={printResume}>Save résumé PDF</Button>
          <Button type="button" variant="outline" size="sm" disabled={!!busy || !base.id || !base.resumeText?.trim() || form.resumeText !== base.resumeText}
            onClick={saveToDrive}>{busy === 'Uploading' ? 'Saving to Drive…' : 'Save to Google Drive'}</Button>
        </div>
        {form.resumeText.trim() && form.resumeText !== base.resumeText && <small className="muted">Save your edits before exporting the PDF.</small>}
        <label>Application draft<Textarea aria-label="Application draft" rows={5} value={form.draft} disabled={!!busy} onChange={e => change('draft', e.target.value)} /></label>
        <div className="toolbar">
          <Button type="button" variant="outline" size="sm" onClick={generate} disabled={!!busy || !canDraft || suggestion !== null}>
            {busy === 'Drafting' ? 'Drafting…' : 'Draft with AI'}
          </Button>
          <small className="muted">{canDraft ? 'Uses your confirmed facts, examples you approved for drafts, and this role.' : 'Add a reviewed profile and job title to draft with AI.'}</small>
        </div>
        {suggestion !== null && <section aria-label="Suggested replacement" className="space-y-2 py-3">
          <h4>Suggested replacement</h4><pre>{suggestion}</pre>
          <div className="toolbar">
            <Button type="button" variant="outline" size="sm" onClick={() => { change('draft', suggestion); setSuggestion(null) }}>Use suggested draft</Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setSuggestion(null)}>Keep my draft</Button>
          </div>
        </section>}
      </section>
      <section className="space-y-3 border-t py-5" aria-labelledby="application-status-heading">
        <h3 id="application-status-heading">Application status</h3>
        <div className="field-grid">
          <label>Stage<select aria-label="Stage" value={form.stage} disabled={!!busy} onChange={e => change('stage', e.target.value)}>
            {stages.map(stage => <option key={stage}>{stage}</option>)}
          </select></label>
          {(form.stage === 'Interview' || base.interviewAt) && input('interviewAt', 'Interview time (local)', { type: 'datetime-local' })}
        </div>
        <label>{needsProof ? 'Employer evidence (required)' : 'Add employer evidence'}
          <Textarea aria-label={needsProof ? 'Employer evidence (required)' : 'Add employer evidence'} rows={3} value={form.evidence}
            disabled={!!busy} required={needsProof} placeholder="Receipt text, confirmation number or employer reply" onChange={e => change('evidence', e.target.value)} />
        </label>
        {needsProof && form.stage === 'Applied' && <p className="muted">Saving Applied records this receipt and freezes the résumé and draft shown above.</p>}
        {stale && <div role="status"><p>A newer version of this application was saved. Your edits are still in the form.</p>
          <Button variant="outline" size="sm" type="button" onClick={() => requestLeave(() => load(latest))}>Discard edits and load saved version</Button></div>}
        {error && <p role="alert">{error}</p>}
        <div className="toolbar"><Button type="submit" size="sm" disabled={!!busy || !!stale}>{busy === 'Saving' ? 'Saving…' : 'Save application'}</Button></div>
      </section>
    </form>
    <RecordHistory job={base} />
  </div>
}

export default function Applications({ state, notify, refresh, seed, setSeed, reportEditor, requestLeave }) {
  const [filter, setFilter] = useState('')
  const returnTo = useRef(null)
  useEffect(() => {
    if (!seed && returnTo.current) {
      const target = document.getElementById(returnTo.current) ?? document.getElementById('add-role')
      target?.focus()
      returnTo.current = null
    }
  }, [seed])
  function open(value, trigger) {
    returnTo.current = trigger
    setSeed(value)
  }
  if (seed) {
    const job = seed.id ? state.jobs.find(j => j.id === seed.id) : seed
    if (!job) return <section><p>This application is unavailable.</p><Button variant="outline" size="sm" onClick={() => setSeed(null)}>All applications</Button></section>
    return <JobEditor key={seed.id ?? JSON.stringify([seed.url, seed.title, seed.description])}
      initial={job} state={state} refresh={refresh} notify={notify} reportEditor={reportEditor} requestLeave={requestLeave} close={() => setSeed(null)} />
  }
  const query = filter.trim().toLowerCase()
  const visible = state.jobs.filter(j => (j.company + ' ' + j.title + ' ' + j.stage).toLowerCase().includes(query))
  return <section aria-label="Tracked roles" className="stack">
    <div className="section-heading pb-4">
      {state.jobs.length > 0 ? <Input type="search" aria-label="Find an application" placeholder="Find an application" className="max-w-sm"
        value={filter} onChange={e => setFilter(e.target.value)} /> : <h2>Tracked roles</h2>}
      <Button id="add-role" type="button" size="sm" onClick={() => open({}, 'add-role')}>Add role</Button>
    </div>
    <Table aria-label="Applications" className="max-sm:table-fixed max-sm:[&_td]:px-1.5 max-sm:[&_th]:px-1.5">
      <TableHeader><TableRow>
        <TableHead scope="col" className="max-sm:w-[29%]">Company</TableHead>
        <TableHead scope="col">Role</TableHead>
        <TableHead scope="col" className="max-sm:w-[25%]">Stage</TableHead>
      </TableRow></TableHeader>
      <TableBody>
        {visible.map(job => <TableRow key={job.id}>
          <TableCell className="whitespace-normal [overflow-wrap:anywhere]">{job.company}</TableCell>
          <TableCell className="whitespace-normal">
            <Button id={'open-role-' + job.id} type="button" variant="link" size="sm" className="block h-auto max-w-full whitespace-normal px-0 text-left [overflow-wrap:anywhere]"
              aria-label={`Open ${job.title} at ${job.company}`} onClick={() => open({ id: job.id }, 'open-role-' + job.id)}>
              {job.title}
            </Button>
          </TableCell>
          <TableCell>{job.stage}</TableCell>
        </TableRow>)}
        {!visible.length && <TableRow><TableCell colSpan={3} className="whitespace-normal py-6">
          {state.jobs.length ? 'No applications match this search.' : 'Add a role to start tracking its application.'}
        </TableCell></TableRow>}
      </TableBody>
    </Table>
  </section>
}
