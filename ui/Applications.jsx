import React, { useRef, useState } from 'react'

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
    {sent && <details className="panel"><summary>Submitted copy</summary>
      <p>{sent.company} · {sent.title} · <time dateTime={sent.submittedAt}>{new Date(sent.submittedAt).toLocaleString()}</time></p>
      <h3>Employer receipt</h3><pre>{receiptText(sent.evidence)}</pre>
      <h3>Submitted résumé</h3><pre>{sent.resumeText || 'No résumé text was recorded.'}</pre>
      <h3>Submitted draft</h3><pre>{sent.draft || 'No draft text was recorded.'}</pre>
    </details>}
    {!!job.history?.length && <details className="panel"><summary>Application history</summary>
      <ol>{job.history.slice().reverse().map((e, i) => <li key={e.recordedAt + '/' + i}>
        <strong>{e.stage}</strong> · <time dateTime={e.recordedAt}>{new Date(e.recordedAt).toLocaleString()}</time>
        {e.evidence && <pre>{receiptText(e.evidence)}</pre>}
        {e.interviewAt && <p>Interview · {new Date(e.interviewAt).toLocaleString()}</p>}
      </li>)}</ol>
    </details>}
  </>
}

function JobEditor({ initial, state, refresh, notify, close }) {
  const [base, setBase] = useState(initial)
  const [form, setForm] = useState(() => editable(initial))
  const [suggestion, setSuggestion] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const running = useRef(false)
  const latest = state.jobs.find(j => j.id === base.id)
  const stale = latest && latest.updatedAt !== base.updatedAt
  const hasChanges = JSON.stringify(form) !== JSON.stringify(editable(base))
  const needsProof = employerStages.has(form.stage) && form.stage !== (base.stage ?? 'Saved')
  const profile = state.profile
  const canDraft = form.title.trim() && (profile?.confirmedFacts?.length || profile?.resumeText?.trim() || profile?.summary?.trim())
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
      const applicant = Object.fromEntries(['name', 'summary', 'targetRoles', 'location'].map(k => [k, profile[k] ?? '']))
      if (Array.isArray(profile.confirmedFacts)) applicant.confirmedFacts = profile.confirmedFacts.map(f => typeof f === 'string' ? f : f.text)
      else applicant.resumeText = profile.resumeText
      const draft = await window.pluto.call('providers.draft', { profile: applicant, job })
      if (!draft || typeof draft !== 'string') throw new Error('The provider returned an empty draft.')
      if (form.draft.trim()) setSuggestion(draft)
      else change('draft', draft)
      notify('Draft ready for review.')
    })
  }

  function openEmployer() {
    run('Opening', () => window.pluto.call('application.open', { id: base.id }))
  }
  function printResume() {
    run('Exporting', async () => {
      const wrote = await window.pluto.call('application.pdf', { id: base.id })
      if (wrote) notify('Reviewed résumé PDF saved.')
    })
  }
  const input = (key, label, options = {}) => <label>{label}
    <input {...options} value={form[key]} onChange={e => change(key, e.target.value)} />
  </label>
  return <div className="stack">
    <form className="stack" onSubmit={save}>
      <section className="panel stack">
        <div className="section-heading"><h2>{base.id ? base.title : 'New application'}</h2>
          <button type="button" className="secondary" disabled={!!busy} onClick={close}>{hasChanges || suggestion ? 'Discard changes and close' : 'Close'}</button>
        </div>
        <fieldset className="field-grid" disabled={!!busy}><legend>Role details</legend>
          {input('company', 'Company', { required: true })}
          {input('title', 'Job title', { required: true })}
          {input('url', 'Employer posting URL', { type: 'url', placeholder: 'https://' })}
          {input('location', 'Location')}
          {input('salary', 'Base salary')}
        </fieldset>
        <label>Job description<textarea rows={4} value={form.description} disabled={!!busy} onChange={e => change('description', e.target.value)} /></label>
        <div className="toolbar"><button type="button" className="secondary" onClick={openEmployer}
          disabled={!!busy || !base.id || !base.url || form.url !== base.url}>Open employer application</button>
          {!!form.url && (!base.id || form.url !== base.url) && <small className="muted">Save this posting to open the employer form.</small>}
        </div>
      </section>
      <section className="panel stack"><h2>Application materials</h2>
        <label>Reviewed résumé text<textarea rows={6} value={form.resumeText} disabled={!!busy} onChange={e => change('resumeText', e.target.value)} /></label>
        <div className="buttons">
          {profile?.resumeText && <button type="button" className="secondary" disabled={!!busy || form.resumeText === profile.resumeText}
            onClick={() => change('resumeText', profile.resumeText)}>{form.resumeText ? 'Replace with profile résumé' : 'Use profile résumé'}</button>}
          <button type="button" className="secondary" disabled={!!busy || !base.id || !base.resumeText?.trim() || form.resumeText !== base.resumeText}
            onClick={printResume}>Save résumé PDF</button>
        </div>
        {form.resumeText.trim() && form.resumeText !== base.resumeText && <small className="muted">Save your edits before exporting the PDF.</small>}
        <label>Application draft<textarea rows={5} value={form.draft} disabled={!!busy} onChange={e => change('draft', e.target.value)} /></label>
        <div className="toolbar"><button type="button" className="secondary" onClick={generate} disabled={!!busy || !canDraft || suggestion !== null}>
          {busy === 'Drafting' ? 'Drafting…' : 'Draft with AI'}</button>
          <small className="muted">{canDraft ? 'Uses the reviewed profile and this role with your connected provider.' : 'Add a reviewed profile and job title to draft with AI.'}</small>
        </div>
        {suggestion !== null && <fieldset className="stack"><legend>Suggested replacement</legend><pre>{suggestion}</pre>
          <div className="buttons"><button type="button" className="secondary" onClick={() => { change('draft', suggestion); setSuggestion(null) }}>Use suggested draft</button>
            <button type="button" className="secondary" onClick={() => setSuggestion(null)}>Keep my draft</button></div>
        </fieldset>}
      </section>
      <section className="panel stack"><h2>Application status</h2>
        <fieldset className="field-grid" disabled={!!busy}><legend>Progress</legend>
          <label>Stage<select value={form.stage} onChange={e => change('stage', e.target.value)}>
            {stages.map(stage => <option key={stage}>{stage}</option>)}
          </select></label>
          {(form.stage === 'Interview' || base.interviewAt) && input('interviewAt', 'Interview time (local)', { type: 'datetime-local' })}
        </fieldset>
        <label>{needsProof ? 'Employer evidence (required)' : 'Add employer evidence'}
          <textarea rows={3} value={form.evidence} disabled={!!busy} required={needsProof}
            placeholder="Receipt text, confirmation number or employer reply" onChange={e => change('evidence', e.target.value)} />
        </label>
        {needsProof && form.stage === 'Applied' && <p className="muted">Saving Applied records this receipt and freezes the résumé and draft shown above.</p>}
        {stale && <div role="status"><p>A newer version of this application was saved. Your edits are still in the form.</p>
          <button className="secondary" type="button" onClick={() => load(latest)}>Discard edits and load saved version</button></div>}
        {error && <p role="alert">{error}</p>}
        <div className="buttons"><button className="primary" type="submit" disabled={!!busy || !!stale}>{busy === 'Saving' ? 'Saving…' : 'Save application'}</button></div>
      </section>
    </form>
    <RecordHistory job={base} />
  </div>
}

export default function Applications({ state, notify, refresh, seed, setSeed }) {
  const [filter, setFilter] = useState('')
  if (seed) {
    const job = seed.id ? state.jobs.find(j => j.id === seed.id) : seed
    if (!job) return <section className="panel"><p>This application is unavailable.</p><button className="secondary" onClick={() => setSeed(null)}>All applications</button></section>
    return <JobEditor key={seed.id ?? JSON.stringify([seed.url, seed.title, seed.description])}
      initial={job} state={state} refresh={refresh} notify={notify} close={() => setSeed(null)} />
  }
  const visible = state.jobs.filter(j => (j.company + ' ' + j.title + ' ' + j.stage).toLowerCase().includes(filter.trim().toLowerCase()))
  return <section className="panel stack">
    <div className="section-heading"><h2>Tracked roles</h2><button className="primary" onClick={() => setSeed({})}>Add role</button></div>
    {!!state.jobs.length && <label>Find an application<input type="search" value={filter} onChange={e => setFilter(e.target.value)} /></label>}
    {visible.length ? visible.map(j => <button key={j.id} className="record-row" onClick={() => setSeed({ id: j.id })}>
      <span><strong>{j.title}</strong><small>{j.company}</small></span><span className="stage">{j.stage}</span>
    </button>) : <p className="muted">{state.jobs.length ? 'No applications match this search.' : 'Add a role to start tracking its application.'}</p>}
  </section>
}
