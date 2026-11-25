import React, { useEffect, useRef, useState } from 'react'
import { Button } from './components/ui/button.jsx'
import { Input } from './components/ui/input.jsx'
import { Textarea } from './components/ui/textarea.jsx'

const TEXT_LIMIT = 80_000
const EXCERPT_LIMIT = 8000
const profileFields = { name: 'Name', email: 'Email', phone: 'Phone', summary: 'Professional summary' }
const preferences = { targetRoles: 'Target roles', location: 'Preferred work locations' }
const headings = /^(?:professional |work |technical |academic |relevant )?(?:experience|education|skills|projects|certifications|achievements|summary|profile|objective|employment|leadership|interests|awards|languages|qualifications|contact(?: information)?)\s*:?$/i
const emailPattern = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i
const phonePattern = /(?:\+\d{1,3}[ .-]?)?(?:\(\d{2,4}\)|\d{3})[ .-]?\d{3}[ .-]?\d{4}\b/
const valueOf = value => typeof value === 'string' ? value : ''

// Suggestions keep the original line so an edited fact still has an inspectable source.
export function suggest(text, source, isExcerpt = false) {
  const lines = text.split(/\r\n?|\n/).map(line => line.trim()).filter(Boolean)
  const fields = {}, evidence = {}, facts = []
  let section = '', omitted = false
  const seen = new Set()
  if (!isExcerpt) {
    const first = (lines[0] ?? '').split(/[|•]/)[0].trim()
    if (first.length < 80 && !headings.test(first) && !/résumé|resume|curriculum vitae/i.test(first) &&
        /^\p{L}[\p{L}\p{M}'’.\-]*(?: +\p{L}[\p{L}\p{M}'’.\-]*){1,4}$/u.test(first)) {
      fields.name = first
      evidence.name = lines[0]
    }
    for (const line of lines.slice(0, 8)) {
      if (headings.test(line) && !/^contact/i.test(line)) break
      for (const [field, pattern] of [['email', emailPattern], ['phone', phonePattern]]) {
        const match = line.match(pattern)
        if (match && !fields[field]) { fields[field] = match[0]; evidence[field] = line }
      }
    }
  }
  for (const quote of lines) {
    const preference = !isExcerpt && quote.match(/^(target roles?|preferred roles?|preferred (?:work )?locations?)\s*:\s*(.+)$/i)
    if (preference) {
      const key = /location/i.test(preference[1]) ? 'location' : 'targetRoles'
      if (!fields[key]) { fields[key] = preference[2].trim(); evidence[key] = quote; continue }
    }
    if (headings.test(quote)) { section = quote.replace(/:$/, ''); continue }
    if (!isExcerpt && Object.values(evidence).includes(quote)) continue
    const phrase = quote.replace(/^[•●▪*]\s*|^[-–]\s+/u, '').trim()
    if (!phrase || phrase.length < 3 || seen.has(phrase)) continue
    if (!isExcerpt && /^summary$|^(?:professional (?:summary|profile)|profile|objective)$/i.test(section) && !fields.summary) {
      fields.summary = phrase
      evidence.summary = quote
      continue
    }
    if (phrase.length > 1800 || facts.length >= (isExcerpt ? 16 : 32)) { omitted = true; continue }
    facts.push({ text: phrase, quote, source, section, included: !isExcerpt })
    seen.add(phrase)
  }
  return { fields, evidence, facts, omitted }
}

function savedRows(profile) {
  if (!Array.isArray(profile.confirmedFacts)) return []
  return profile.confirmedFacts.flatMap(fact => {
    if (typeof fact === 'string') return [{ text: fact, source: 'Saved profile', included: true }]
    return fact && typeof fact.text === 'string' ? [{ ...fact, included: true }] : []
  })
}

export function hasProfile(profile = {}) {
  return profile?.profileConfirmed === true ||
    ['name', 'email', 'phone', 'summary', 'resumeText'].some(key => valueOf(profile?.[key]).trim()) ||
    savedRows(profile || {}).some(row => row.text.trim())
}

export function reviewedChanges(original, latest, reviewed) {
  const changes = {}
  for (const [key, value] of Object.entries(reviewed)) {
    if (JSON.stringify(original[key]) === JSON.stringify(value)) continue
    if (JSON.stringify(original[key]) !== JSON.stringify(latest[key]) &&
        JSON.stringify(latest[key]) !== JSON.stringify(value)) {
      throw new Error('This profile changed while you were editing. Cancel and reopen it to review the latest version.')
    }
    changes[key] = value
  }
  return changes
}

function SourceDetails({ source, quote, section }) {
  if (!source && !quote) return null
  return <details>
    <summary>View source</summary>
    <p>{source || 'Saved profile'}{section && ' · ' + section}</p>
    {quote && <blockquote>{quote}</blockquote>}
  </details>
}

function Wizard({ original, refresh, notify, close, editing }) {
  const [step, setStep] = useState(0)
  const [resume, setResume] = useState(valueOf(original.resumeText))
  const [source, setSource] = useState(valueOf(original.resumeSource) || 'Résumé')
  const [excerpt, setExcerpt] = useState('')
  const [allowExcerpt, setAllowExcerpt] = useState(false)
  const [fields, setFields] = useState(() => Object.fromEntries(
    [...Object.keys(profileFields), ...Object.keys(preferences)].map(key => [key, valueOf(original[key])])))
  const [rows, setRows] = useState(() => savedRows(original))
  const [evidence, setEvidence] = useState({})
  const [omitted, setOmitted] = useState(false)
  const [factPage, setFactPage] = useState(0)
  const [editPreferences, setEditPreferences] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  const reviewedSource = useRef(null)
  const previousAuto = useRef({})
  const heading = useRef(null)
  const locked = useRef(false)
  useEffect(() => { heading.current?.focus() }, [step])
  const changeStep = value => { setError(''); setConfirmed(false); setStep(value) }

  async function run(task) {
    if (locked.current) return
    locked.current = true
    setBusy(true)
    setError('')
    try { await task() } catch (failure) { setError(failure.message || 'Please try again.') }
    finally { locked.current = false; setBusy(false) }
  }

  function review() {
    const permitted = allowExcerpt ? excerpt.trim() : ''
    const key = JSON.stringify([resume, source, permitted])
    if (reviewedSource.current !== key) {
      const result = suggest(resume, source)
      const extra = suggest(permitted, 'Selected chat excerpt', true)
      const previous = reviewedSource.current && JSON.parse(reviewedSource.current)
      // Edits and removals survive navigation. Only regenerate the source that changed.
      const retained = rows.filter(row => !row.origin ||
        (row.origin === 'resume' ? previous?.[0] === resume && previous?.[1] === source : previous?.[2] === permitted))
      const candidates = []
      if (!previous || previous[0] !== resume || previous[1] !== source) {
        // An existing profile may deliberately exclude some résumé phrases.
        if (!(editing && Array.isArray(original.confirmedFacts) && original.resumeText === resume)) {
          candidates.push(...result.facts.map(row => ({ ...row, origin: 'resume' })))
        }
      }
      if (!previous || previous[2] !== permitted) candidates.push(...extra.facts.map(row => ({ ...row, origin: 'excerpt' })))
      const known = new Set(retained.map(row => row.quote || row.text))
      const additions = candidates.filter(row => {
        if (known.has(row.quote)) return false
        known.add(row.quote)
        return true
      })
      setRows([...retained, ...additions])
      setFactPage(0)
      const values = { ...fields }, attributions = {}
      for (const field of Object.keys(fields)) {
        if (values[field] === previousAuto.current[field] || (!previous && !values[field] && !(editing && Object.hasOwn(original, field) && resume === original.resumeText))) {
          values[field] = result.fields[field] || ''
          if (result.evidence[field]) attributions[field] = result.evidence[field]
        }
      }
      previousAuto.current = Object.fromEntries(Object.keys(attributions).map(field => [field, values[field]]))
      setEvidence(attributions)
      setFields(values)
      setOmitted(result.omitted || extra.omitted)
      reviewedSource.current = key
    }
    changeStep(1)
  }

  const included = rows.filter(row => row.included && row.text.trim())
  function editRow(index, updates) { setRows(rows.map((row, i) => i === index ? { ...row, ...updates } : row)) }
  function fieldInput(key, label) {
    const props = { 'aria-label': label, value: fields[key], onChange: event => setFields({ ...fields, [key]: event.target.value }) }
    return <div key={key}><label>{label}
      {key === 'summary' ? <Textarea rows={3} {...props}/> : <Input type={key === 'email' ? 'email' : key === 'phone' ? 'tel' : 'text'} {...props}/>}
    </label>
      {evidence[key] && <SourceDetails source={source} quote={evidence[key]}/>}
    </div>
  }

  async function save() {
    if (!confirmed) return
    const reviewed = { ...fields, profileConfirmed: true, resumeText: resume, resumeSource: source,
      confirmedFacts: included.map(({ included, origin, ...fact }) => ({ ...fact, text: fact.text.trim() })) }
    const latest = await window.pluto.call('workspace.snapshot', {})
    const changes = reviewedChanges(original, latest.profile || {}, reviewed)
    await window.pluto.call('workspace.saveProfile', changes)
    close({ ...latest.profile, ...changes })
    try { await refresh(); notify('Profile saved.') }
    catch { notify('Profile saved. Reopen the workspace to refresh its contents.') }
  }

  const labels = ['Start with your résumé', 'Review your facts', 'Set your job preferences', 'Confirm your profile']
  return <section className="panel" aria-labelledby="profile-heading">
    <p>Step {step + 1} of {labels.length}</p>
    <h2 id="profile-heading" tabIndex={-1} ref={heading}>{labels[step]}</h2>
    <fieldset disabled={busy}>
      <legend>{['Résumé source', 'Profile details', 'Search preferences', 'Profile to save'][step]}</legend>
      {step === 0 && <>
        <p>Choose a résumé or paste its text. You can edit what PLUTO finds before saving it locally.</p>
        <Button type="button" onClick={() => run(async () => {
          const file = await window.pluto.call('resume.pick', {})
          if (file) { setResume(file.text); setSource(file.name) }
        })}>Choose résumé file</Button>
        <small>PDF, DOCX or TXT · up to 5 MiB</small>
        {resume && <p>{source} · {resume.length.toLocaleString()} characters</p>}
        <details><summary>{resume ? 'View or edit résumé text' : 'Paste résumé text'}</summary>
        <label>Résumé text
          <Textarea rows={8} maxLength={TEXT_LIMIT} value={resume} onChange={e => { setResume(e.target.value); setSource('Pasted résumé text') }}
            placeholder="Paste or edit the text you want to keep"/>
        </label></details>
        <details><summary>Add a selected chat excerpt (optional)</summary>
          <p>Paste a passage or choose a text file containing just that passage. Only the phrases you select in the next step are saved.</p>
          <label>Import excerpt from a TXT file<Input type="file" accept=".txt,text/plain" onChange={event => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (!file) return
            run(async () => {
              if (!/\.txt$/i.test(file.name) || file.size > 32 * 1024) throw new Error('Choose a TXT excerpt of up to 32 KiB.')
              const value = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer())
              if (value.length > EXCERPT_LIMIT || /[\x00-\x08\x0b\x0e-\x1f]/.test(value))
                throw new Error('Choose up to 8,000 characters of readable text.')
              setExcerpt(value); setAllowExcerpt(false)
            })
          }}/></label>
          <label>Selected chat excerpt<Textarea rows={4} maxLength={EXCERPT_LIMIT} value={excerpt} onChange={e => {
            setExcerpt(e.target.value); setAllowExcerpt(false)
          }}/></label>
          <label><Input type="checkbox" className="size-4 shrink-0 p-0 shadow-none" disabled={!excerpt.trim()} checked={allowExcerpt}
            onChange={e => setAllowExcerpt(e.target.checked)}/>Use only this excerpt to suggest profile facts</label>
        </details>
      </>}
      {step === 1 && <>
        {Object.entries(profileFields).map(([key, label]) => fieldInput(key, label))}
        <h3>Facts to keep</h3>
        <p>Edit the wording and select the facts that describe you. The source stays attached to each selected phrase.</p>
        {rows.slice(factPage * 5, factPage * 5 + 5).map((row, offset) => {
          const index = factPage * 5 + offset
          return <fieldset key={index}>
          <legend>{row.section || 'Profile fact'}</legend>
          <label><Input type="checkbox" className="size-4 shrink-0 p-0 shadow-none" checked={row.included} onChange={e => editRow(index, { included: e.target.checked })}/>Keep fact {index + 1}</label>
          <label>Fact {index + 1}<Textarea aria-label={'Fact ' + (index + 1)} rows={2} value={row.text} onChange={e => editRow(index, { text: e.target.value })}/></label>
          <SourceDetails source={row.source} quote={row.quote} section={row.section}/>
        </fieldset>})}
        {rows.length > 5 && <div className="actions">
          <Button type="button" variant="outline" disabled={factPage === 0} onClick={() => setFactPage(factPage - 1)}>Previous facts</Button>
          <span aria-live="polite">Facts {factPage * 5 + 1}–{Math.min(rows.length, factPage * 5 + 5)} of {rows.length}</span>
          <Button type="button" variant="outline" disabled={(factPage + 1) * 5 >= rows.length} onClick={() => setFactPage(factPage + 1)}>Next facts</Button>
        </div>}
        {omitted && <p>Some source lines exceed the suggestion limits. Add any missing fact below.</p>}
        <Button type="button" onClick={() => {
          setFactPage(Math.floor(rows.length / 5))
          setRows([...rows, { text: '', source: 'Entered by you', included: true }])
        }}>Add a fact</Button>
      </>}
      {step === 2 && <>
        <p>Tell PLUTO which opportunities you want to see. You can leave either preference open.</p>
        {Object.entries(preferences).map(([key, label]) =>
          (!original[key] && !evidence[key]) || editPreferences ? fieldInput(key, label) : <div key={key}>
            <p><strong>{label}</strong> · {fields[key]}</p>
            {evidence[key] && <SourceDetails source={source} quote={evidence[key]}/>}
          </div>)}
        {!editPreferences && Object.keys(preferences).some(key => original[key] || evidence[key]) &&
          <Button type="button" variant="outline" onClick={() => setEditPreferences(true)}>Edit preferences</Button>}
      </>}
      {step === 3 && <>
        <dl>{Object.entries({ ...profileFields, ...preferences }).map(([key, label]) =>
          <React.Fragment key={key}><dt>{label}</dt><dd>{fields[key] || 'Unspecified'}</dd></React.Fragment>)}</dl>
        <h3>{included.length} {included.length === 1 ? 'selected fact' : 'selected facts'}</h3>
        <ul>{included.map((row, i) => <li key={i}>{row.text}<SourceDetails source={row.source} quote={row.quote} section={row.section}/></li>)}</ul>
        {resume && <details><summary>Résumé text to save · {source}</summary><p style={{whiteSpace: 'pre-wrap'}}>{resume}</p></details>}
        <label><Input type="checkbox" className="size-4 shrink-0 p-0 shadow-none" checked={confirmed} onChange={e => setConfirmed(e.target.checked)}/>I confirm these details and selected sources for my profile.</label>
      </>}
    </fieldset>
    {error && <p role="alert">{error}</p>}
    {busy && <p role="status">{step === 3 ? 'Saving profile…' : 'Reading file…'}</p>}
    <div className="actions">
      {step !== 0 && <Button type="button" variant="outline" disabled={busy} onClick={() => changeStep(step - 1)}>Back</Button>}
      {editing && <Button type="button" variant="ghost" disabled={busy} onClick={() => close()}>Cancel edits</Button>}
      {step === 0 ? <Button type="button" disabled={busy} onClick={review}>Review facts</Button>
        : step === 3 ? <Button type="button" disabled={busy || !confirmed} onClick={() => run(save)}>Save confirmed profile</Button>
        : <Button type="button" disabled={busy} onClick={() => changeStep(step + 1)}>{step === 1 ? 'Continue to preferences' : 'Review profile'}</Button>}
    </div>
  </section>
}

export default function Profile({ state, refresh, notify }) {
  const profile = state?.profile || {}
  const [session, setSession] = useState(null)
  const [justSaved, setJustSaved] = useState(null)
  const saved = justSaved || profile
  useEffect(() => { setJustSaved(null) }, [state?.profile])
  if (session || !hasProfile(saved)) {
    return <Wizard original={session || profile} editing={Boolean(session)} refresh={refresh} notify={notify}
      close={value => { if (value) setJustSaved(value); setSession(null) }}/>
  }
  return <section className="panel">
    <h2>Your profile</h2>
    {saved.name && <h3>{saved.name}</h3>}
    {saved.summary && <p>{saved.summary}</p>}
    {saved.targetRoles && <p><strong>Target roles</strong> · {saved.targetRoles}</p>}
    {saved.location && <p><strong>Preferred work locations</strong> · {saved.location}</p>}
    <p>{savedRows(saved).length} confirmed facts</p>
    <Button type="button" onClick={() => setSession(saved)}>Edit profile</Button>
  </section>
}
