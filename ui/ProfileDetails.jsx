import React, { useEffect, useRef, useState } from 'react'
import { Button } from './components/ui/button.jsx'
import { Input } from './components/ui/input.jsx'
import { Textarea } from './components/ui/textarea.jsx'
import './profile-details.css'

const MAX_STORIES = 24
const MAX_COUNTRIES = 20
const storyFields = { title: 'Story title', context: 'Context', action: 'What you did', result: 'Result or evidence' }
const answerLabels = {
  address: 'Mailing address', linkedInUrl: 'LinkedIn URL', portfolioUrl: 'Portfolio URL', otherUrl: 'Other professional URL',
  workArrangement: 'Preferred work arrangement', relocation: 'Open to relocation?',
  travel: 'Travel availability', salaryCurrency: 'Salary currency', salaryMin: 'Minimum desired base salary',
  salaryMax: 'Upper end of desired base salary', startDate: 'Earliest start date', notice: 'Notice period',
}
const blankStory = () => ({ id: crypto.randomUUID(), title: '', context: '', action: '', result: '', useInDrafts: false })
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right)
const conflict = () => new Error('These details changed while you were editing. Cancel and reopen the editor to review the latest version.')
const words = text => String(text || '').trim().toLowerCase().replace(/\s+/g, ' ')
const rowsOf = value => Array.isArray(value) ? value : []
const storyKey = row => [row.context, row.action, row.result].some(value => words(value)) ?
  JSON.stringify([row.context, row.action, row.result].map(words)) : words(row.title)

function checkUnique(rows, key, message) {
  if (new Set(rows.map(key)).size !== rows.length) throw new Error(message)
}

// A story's text and permission move together. Similarly, country-specific
// declarations must stay attached to the country the applicant reviewed.
function mergeRows(baseRows, currentRows, editedRows, mergeChanged) {
  const before = baseRows ?? [], current = currentRows ?? [], edited = editedRows ?? []
  for (const rows of [before, current, edited]) {
    if (!Array.isArray(rows) || rows.some(row => !row?.id) || new Set(rows.map(row => row.id)).size !== rows.length) throw conflict()
  }
  const result = new Map(current.map(row => [row.id, row]))
  const original = new Map(before.map(row => [row.id, row]))
  const reviewed = new Map(edited.map(row => [row.id, row]))
  for (const id of new Set([...original.keys(), ...reviewed.keys()])) {
    const base = original.get(id), next = reviewed.get(id), latest = result.get(id)
    if (equal(base, next) || equal(latest, next)) continue
    if (!equal(base, latest)) {
      if (!mergeChanged || !base || !latest || !next) throw conflict()
      result.set(id, mergeChanged(base, latest, next))
    } else if (next) result.set(id, next)
    else result.delete(id)
  }
  return [...result.values()]
}

function mergeCountry(original, latest, edited) {
  if (original.country !== latest.country || original.country !== edited.country) throw conflict()
  const merged = { ...latest }
  for (const key of ['authorized', 'sponsorship']) {
    if (original[key] === edited[key]) continue
    if (latest[key] !== original[key] && latest[key] !== edited[key]) throw conflict()
    if (edited[key] === undefined) delete merged[key]
    else merged[key] = edited[key]
  }
  return merged
}

export function detailChanges(original, latest, reviewed) {
  const changes = {}
  if (Object.hasOwn(reviewed, 'experienceStories') && !equal(original.experienceStories || [], reviewed.experienceStories)) {
    const rows = mergeRows(original.experienceStories, latest.experienceStories, reviewed.experienceStories)
    checkUnique(rows, storyKey, 'This story is already in your profile. Edit the existing story instead.')
    if (rows.length > MAX_STORIES) throw new Error('Keep up to 24 experience stories.')
    if (!equal(rows, latest.experienceStories || [])) changes.experienceStories = rows
  }
  if (Object.hasOwn(reviewed, 'applicationAnswers')) {
    const base = original.applicationAnswers || {}, current = latest.applicationAnswers || {}, edited = reviewed.applicationAnswers
    const merged = { ...current }
    for (const key of [...Object.keys(answerLabels), 'workAuthorization']) {
      if (equal(base[key], edited[key]) || equal(current[key], edited[key])) continue
      if (key === 'workAuthorization') {
        const rows = mergeRows(base[key], current[key], edited[key], mergeCountry)
        checkUnique(rows, row => words(row.country), 'Keep one work authorization entry per country.')
        if (rows.length > MAX_COUNTRIES) throw new Error('Keep up to 20 country entries.')
        if (rows.length) merged[key] = rows
        else delete merged[key]
      } else {
        if (!equal(base[key], current[key])) throw conflict()
        if (edited[key] === undefined) delete merged[key]
        else merged[key] = edited[key]
      }
    }
    // Currency and amounts may each be edited alone, but changing a currency
    // must not silently reinterpret someone else's salary edit.
    const salaryKeys = ['salaryCurrency', 'salaryMin', 'salaryMax']
    const mySalaryChange = salaryKeys.some(key => !equal(base[key], edited[key]))
    const theirSalaryChange = salaryKeys.some(key => !equal(base[key], current[key]) && !equal(current[key], edited[key]))
    if (mySalaryChange && theirSalaryChange &&
        (base.salaryCurrency !== edited.salaryCurrency || base.salaryCurrency !== current.salaryCurrency)) throw conflict()
    if (merged.salaryMin != null && merged.salaryMax != null && merged.salaryMin > merged.salaryMax) {
      throw new Error('The upper end of the salary range must be at least the minimum.')
    }
    if (!equal(merged, current)) changes.applicationAnswers = merged
  }
  return changes
}

function normalizeStory(form) {
  const row = { id: form.id }
  for (const key of Object.keys(storyFields)) row[key] = (form[key] || '').trim()
  if (!row.title) throw new Error('Give the story a title so you can find it again.')
  if (form.useInDrafts && !row.action) throw new Error('Describe what you did before allowing this story in drafts.')
  row.useInDrafts = form.useInDrafts === true
  return row
}

function normalizeAnswers(form) {
  const answers = {}
  for (const key of Object.keys(answerLabels)) {
    const raw = form[key]
    if (raw == null || raw === '') continue
    if (key === 'relocation') { if (typeof raw === 'boolean') answers[key] = raw; continue }
    const value = String(raw).trim()
    if (!value) continue
    if (key.endsWith('Url')) {
      let url
      try { url = new URL(value) } catch { /* Report the field below. */ }
      if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
        throw new Error('Enter a full web address for ' + answerLabels[key] + '.')
      }
    }
    if (key === 'salaryCurrency' && !/^[a-z]{3}$/i.test(value)) throw new Error('Use a three-letter currency code, such as USD.')
    if (key === 'salaryMin' || key === 'salaryMax') {
      if (!/^\d{1,10}(\.\d{1,2})?$/.test(value)) throw new Error('Enter a salary amount with up to two decimal places.')
      answers[key] = Number(value)
    } else answers[key] = key === 'salaryCurrency' ? value.toUpperCase() : value
  }
  if (answers.salaryMin != null && answers.salaryMax != null && answers.salaryMin > answers.salaryMax) {
    throw new Error('The upper end of the salary range must be at least the minimum.')
  }
  const countries = rowsOf(form.workAuthorization).flatMap(row => {
    const country = (row.country || '').trim()
    if (!country && row.authorized == null && row.sponsorship == null) return []
    if (!country) throw new Error('Enter a country for the work authorization answers.')
    const entry = { id: row.id, country }
    for (const key of ['authorized', 'sponsorship']) if (typeof row[key] === 'boolean') entry[key] = row[key]
    return [entry]
  })
  checkUnique(countries, row => words(row.country), 'Keep one work authorization entry per country.')
  if (countries.length) answers.workAuthorization = countries
  return answers
}

const boolText = value => value === true ? 'Yes' : value === false ? 'No' : 'Unanswered'

function Choice({ label, value, change }) {
  return <label>{label}<select value={boolText(value)} onChange={e => change({ Yes: true, No: false }[e.target.value])}>
    {['Unanswered', 'Yes', 'No'].map(option => <option key={option}>{option}</option>)}
  </select></label>
}

function StoryForm({ value, change }) {
  return <>
    <label>Story title<Input autoFocus maxLength={120} value={value.title} onChange={e => change('title', e.target.value)} required/></label>
    {[['context', 'What was happening, and who was involved?'], ['action', 'Which part did you handle yourself?'],
      ['result', 'What changed, or how did you check your work? A number is optional.']].map(([key, help]) =>
      <label key={key}>{storyFields[key]}<span className="pd-hint" id={'pd-hint-' + key}>{help}</span>
        <Textarea aria-label={storyFields[key]} aria-describedby={'pd-hint-' + key} rows={2} maxLength={1600} value={value[key]} onChange={e => change(key, e.target.value)}/></label>)}
    <label className="pd-check"><input type="checkbox" checked={value.useInDrafts === true} onChange={e => change('useInDrafts', e.target.checked)}/>
      Use in application drafts</label>
    <p className="pd-hint">When you request a draft, your drafting provider can receive this story if you select this box.</p>
  </>
}

function AnswersForm({ value, change }) {
  const countries = rowsOf(value.workAuthorization)
  const editCountry = (id, key, next) => change('workAuthorization', countries.map(row => row.id === id ? { ...row, [key]: next } : row))
  function input(key, props = {}) {
    return <label key={key}>{answerLabels[key]}<Input value={value[key] ?? ''} onChange={e => change(key, e.target.value)}
      maxLength={200} {...props}/></label>
  }
  return <>
    <p className="pd-hint">These answers stay in your local profile. You can leave any question unanswered.</p>
    <fieldset><legend>Address and links</legend>
      <label>Mailing address<Textarea autoFocus rows={2} maxLength={500} value={value.address || ''} onChange={e => change('address', e.target.value)}/></label>
      {['linkedInUrl', 'portfolioUrl', 'otherUrl'].map(key => input(key, { type: 'url', maxLength: 1000 }))}
    </fieldset>
    <fieldset><legend>Work preferences</legend><div className="pd-grid">
      <label>{answerLabels.workArrangement}<select value={value.workArrangement || ''} onChange={e => change('workArrangement', e.target.value)}>
        <option value="">Unanswered</option>{['Remote', 'Hybrid', 'On site', 'Flexible'].map(option => <option key={option}>{option}</option>)}
      </select></label>
      <Choice label={answerLabels.relocation} value={value.relocation} change={next => change('relocation', next)}/>
    </div>{input('travel')}</fieldset>
    <fieldset><legend>Desired annual base salary</legend>
      {input('salaryCurrency', { placeholder: 'Three-letter code', maxLength: 3 })}
      <div className="pd-grid">{['salaryMin', 'salaryMax'].map(key => input(key, { inputMode: 'decimal', maxLength: 13 }))}</div>
    </fieldset>
    <fieldset><legend>Availability</legend><div className="pd-grid">{input('startDate', { type: 'date' })}{input('notice')}</div></fieldset>
    <fieldset><legend>Work authorization by country</legend>
      {countries.map((row, index) => <fieldset className="pd-country" key={row.id}><legend>Country entry {index + 1}</legend>
        <label>Country<Input maxLength={100} value={row.country || ''} onChange={e => editCountry(row.id, 'country', e.target.value)}/></label>
        <div className="pd-grid"><Choice label="Authorized to work in this country?" value={row.authorized} change={next => editCountry(row.id, 'authorized', next)}/>
          <Choice label="Need employer sponsorship?" value={row.sponsorship} change={next => editCountry(row.id, 'sponsorship', next)}/></div>
        <Button type="button" variant="link" onClick={() => change('workAuthorization', countries.filter(item => item.id !== row.id))}>Remove country</Button>
      </fieldset>)}
      <Button type="button" variant="outline" disabled={countries.length >= MAX_COUNTRIES}
        onClick={() => change('workAuthorization', [...countries, { id: crypto.randomUUID(), country: '' }])}>Add country</Button>
    </fieldset>
  </>
}

function Editor({ session, onCommit, close, staged }) {
  const dialog = useRef(null), lock = useRef(false)
  const [form, setForm] = useState(session.form)
  const [remove, setRemove] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const story = session.kind === 'story'
  const title = story ? (session.existing ? 'Edit story' : 'Add story') : 'Edit application answers'
  useEffect(() => {
    const node = dialog.current
    node.showModal()
    return () => node.close()
  }, [])
  function change(key, value) {
    setForm(previous => ({ ...previous, [key]: value }))
    setError('')
  }
  async function save(removing = false) {
    if (lock.current) return
    setError('')
    lock.current = true
    setBusy(true)
    try {
      let next
      if (story) {
        const old = rowsOf(session.base.experienceStories)
        if (removing) next = { experienceStories: old.filter(row => row.id !== form.id) }
        else {
          const row = normalizeStory(form)
          next = { experienceStories: session.existing ? old.map(item => item.id === row.id ? row : item) : [...old, row] }
        }
      } else next = { applicationAnswers: normalizeAnswers(form) }
      await onCommit(session.base, next)
      close()
    } catch (problem) { setError(problem.message || 'Could not save these details. Please try again.') }
    finally { lock.current = false; setBusy(false) }
  }
  return <dialog className="pd-dialog" ref={dialog} aria-labelledby="pd-editor-title"
    onCancel={e => { e.preventDefault(); if (!lock.current) close() }}>
    <form autoComplete="off" onSubmit={e => { e.preventDefault(); save() }}>
      <div className="pd-editor-body"><h2 id="pd-editor-title">{title}</h2>
        {staged && <p className="pd-hint">You’ll confirm these changes at the end of setup.</p>}
        <fieldset disabled={busy} className="pd-form-content"><legend className="sr-only">{title}</legend>
          {story ? <StoryForm value={form} change={change}/> : <AnswersForm value={form} change={change}/>}
          {session.existing && <div className="pd-remove">
            {remove ? <><p>Remove this story and its draft permission?</p><Button type="button" variant="outline" onClick={() => save(true)}>Confirm removal</Button>
              <Button type="button" variant="ghost" onClick={() => setRemove(false)}>Keep story</Button></> :
              <Button type="button" variant="link" onClick={() => setRemove(true)}>Remove story</Button>}
          </div>}
        </fieldset>
      </div>
      <div className="pd-footer">{error && <p role="alert">{error}</p>}
        <div className="actions"><Button type="submit" className="primary" disabled={busy || remove}>{story ? 'Save story' : 'Save answers'}</Button>
          <Button type="button" variant="outline" disabled={busy} onClick={close}>Cancel</Button></div>
      </div>
    </form>
  </dialog>
}

function AnswerSummary({ answers }) {
  const pairs = Object.entries(answerLabels).filter(([key]) => answers?.[key] !== undefined && answers[key] !== '')
  const countries = rowsOf(answers?.workAuthorization)
  if (!pairs.length && !countries.length) return null
  return <details className="pd-summary"><summary>Review saved answers</summary>
    <dl>{pairs.map(([key, label]) => <React.Fragment key={key}><dt>{label}</dt>
      <dd>{typeof answers[key] === 'boolean' ? boolText(answers[key]) : String(answers[key])}</dd></React.Fragment>)}
      {countries.map(row => <React.Fragment key={row.id}><dt>{row.country}</dt>
        <dd>Work authorization · {boolText(row.authorized)}<br/>Sponsorship needed · {boolText(row.sponsorship)}</dd></React.Fragment>)}</dl>
  </details>
}

export default function ProfileDetails({ profile, onCommit, staged = false, review = false }) {
  const [session, setSession] = useState(null)
  const stories = rowsOf(profile.experienceStories)
  const openStory = row => setSession({ kind: 'story', form: row || blankStory(), base: profile, existing: Boolean(row) })
  return <div className="profile-details">
    <section aria-label="Experience stories">
      <h3>Experience stories</h3>
      {!review && <p>Keep examples from work or life outside it, such as a class project, caregiving or volunteering.</p>}
      {stories.map(row => <div className="pd-story" key={row.id}>
        <details><summary>{row.title}<small>{row.useInDrafts === true ? 'Allowed in drafts' : 'Local only'}</small></summary>
          <dl>{['context', 'action', 'result'].filter(key => row[key]).map(key => <React.Fragment key={key}>
            <dt>{storyFields[key]}</dt><dd>{row[key]}</dd></React.Fragment>)}</dl>
        </details>
        {!review && <Button type="button" variant="link" aria-label={'Edit story: ' + row.title} onClick={() => openStory(row)}>Edit story</Button>}
      </div>)}
      {!review && <Button type="button" variant="outline" disabled={stories.length >= MAX_STORIES} onClick={() => openStory(null)}>Add story</Button>}
      {review && !stories.length && <p>No stories added.</p>}
    </section>
    <section aria-label="Application answers"><h3>Application answers</h3>
      {!review && <p>Keep private details here for application forms. These answers are excluded from AI drafts.</p>}
      <AnswerSummary answers={profile.applicationAnswers}/>
      {review && !Object.keys(profile.applicationAnswers || {}).length && <p>No application answers added.</p>}
      {!review && <Button type="button" variant="outline"
        onClick={() => setSession({ kind: 'answers', form: profile.applicationAnswers || {}, base: profile })}>Edit application answers</Button>}
    </section>
    {session && <Editor session={session} staged={staged} onCommit={onCommit} close={() => setSession(null)}/>}
  </div>
}
