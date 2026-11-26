import React, { useLayoutEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, FileText, FolderOpen } from 'lucide-react'
import { Button } from './components/ui/button'
import { Input } from './components/ui/input'
import { Textarea } from './components/ui/textarea'
import { saveReviewed, suggest } from './Profile.jsx'
import MailConnection from './MailConnection.jsx'
import Connections from './Connections.jsx'
import Budget from './Budget.jsx'
import './first-run.css'

const storageKey = 'pluto.setup.v1'
const steps = [
  ['Profile', 'Your name and résumé', 'Start with the résumé you want to use for applications. You can review and edit its text before saving.'],
  ['Preferences', 'What are you looking for?', 'Choose the roles and places you want to search. Leave a question open if you’re still deciding.'],
  ['Email', 'Choose an inbox', 'Connect the account where you receive employer replies. You choose when to check it in Job mail.'],
  ['AI provider', 'Choose your drafting provider', 'Use an existing subscription, an API key or a model on your computer. You can also write drafts yourself.'],
  ['Budget', 'Plan your daily budget', 'Try a daily target and a pricing scenario. Saving this estimate sets your target in Today.'],
]
const identityKeys = ['name', 'resumeText', 'resumeSource']
const preferenceKeys = ['targetRoles', 'location', 'workArrangement', 'startDate', 'notice']
const privateAnswers = new Set(['workArrangement', 'startDate', 'notice'])

function storeSetup(value) {
  localStorage.setItem(storageKey, JSON.stringify(value))
  return value
}

export function replaySetup() {
  return storeSetup({ status: 'active', step: 0, edits: {} })
}

export function initialSetup(snapshot) {
  let saved
  try { saved = JSON.parse(localStorage.getItem(storageKey)) } catch { /* An unreadable checkpoint starts from the workspace. */ }
  if (saved?.status === 'closed') return null
  if (saved?.status === 'active' && Number.isInteger(saved.step) && steps[saved.step] && saved.edits) return saved
  const populated = Object.keys(snapshot.profile || {}).length || snapshot.jobs?.length || snapshot.notes?.length ||
    snapshot.schedule?.enabled || snapshot.schedule?.query
  if (populated || (snapshot.existingWorkspace && saved?.status !== 'new')) return null
  return storeSetup({ status: 'new', step: 0, edits: {} })
}

function savedField(profile, key) {
  return privateAnswers.has(key) ? profile.applicationAnswers?.[key] : profile[key]
}

// Only fields actually edited in setup participate in the profile's conflict check.
async function commitFields(edits, keys) {
  const original = {}, reviewed = {}
  for (const key of keys) {
    if (!Object.hasOwn(edits, key)) continue
    const { base, value } = edits[key]
    if (privateAnswers.has(key)) {
      original.applicationAnswers ??= {}
      reviewed.applicationAnswers ??= {}
      original.applicationAnswers[key] = base
      if (value.trim()) reviewed.applicationAnswers[key] = value.trim()
    } else {
      original[key] = base
      reviewed[key] = typeof value === 'string' ? value.trim() : value
    }
  }
  if (Object.keys(reviewed).length) await saveReviewed(original, reviewed)
}

function Identity({ value, edit, run, connectKit, disabled }) {
  const [showText, setShowText] = useState(Boolean(value('resumeText')))
  const picker = useRef(null)
  const review = useRef(null)
  const restoreFocus = useRef(null)
  useLayoutEffect(() => {
    if (!disabled && restoreFocus.current) {
      const target = restoreFocus.current === 'review' ? review : picker
      target.current?.focus()
      restoreFocus.current = null
    }
  }, [disabled, showText])
  function openReview() {
    restoreFocus.current = 'review'
    setShowText(true)
  }
  async function pick() {
    restoreFocus.current = 'picker'
    const file = await window.pluto.call('resume.pick')
    if (!file) return
    const changes = { resumeText: file.text, resumeSource: file.name }
    if (!value('name').trim()) {
      const name = suggest(file.text, file.name).fields.name
      if (name) changes.name = name
    }
    edit(changes)
    openReview()
  }
  return <>
    <label>Name<Input autoComplete="name" maxLength={200} value={value('name')} onChange={e => edit({ name: e.target.value })} /></label>
    <div className="setup-source">
      <h2>Résumé</h2>
      <p>PDF, DOCX or TXT · up to 5 MiB</p>
      <div className="setup-source-actions">
        <Button ref={picker} type="button" variant="outline" onClick={() => run(pick)}><FileText aria-hidden="true" />Choose résumé file</Button>
        {!showText && <Button type="button" variant="link" onClick={openReview}>Paste résumé text</Button>}
      </div>
      {showText && <div className="setup-review">
        <label htmlFor="setup-resume">Review résumé text</label>
        <Textarea ref={review} id="setup-resume" rows={5} maxLength={80000} value={value('resumeText')}
          onChange={e => edit({ resumeText: e.target.value, resumeSource: value('resumeSource') || 'Pasted résumé text' })} />
        {value('resumeSource') && <small>{value('resumeSource')}</small>}
      </div>}
    </div>
    <Button type="button" variant="link" disabled={disabled} onClick={() => run(connectKit)}><FolderOpen aria-hidden="true" />Connect existing job kit</Button>
  </>
}

function Preferences({ value, edit }) {
  function field(key, label, options = {}) {
    return <label>{label}<Input value={value(key)} maxLength={200} {...options}
      onChange={event => edit({ [key]: event.target.value })} /></label>
  }
  return <div className="setup-preferences">
    {field('targetRoles', 'Target roles', { placeholder: 'e.g. Inventory Analyst, Operations Analyst' })}
    {field('location', 'Preferred work locations', { placeholder: 'City, region or country' })}
    <div className="setup-field-pair">
      <div><label htmlFor="setup-arrangement">Preferred work arrangement</label>
      <select id="setup-arrangement" value={value('workArrangement')} onChange={e => edit({ workArrangement: e.target.value })}>
        <option value="">Unanswered</option>
        {['Remote', 'Hybrid', 'On site', 'Flexible'].map(option => <option key={option}>{option}</option>)}
      </select></div>
      {field('startDate', 'Earliest start date', { type: 'date' })}
    </div>
    {field('notice', 'Notice period', { placeholder: 'e.g. Two weeks' })}
  </div>
}

export default function FirstRun({ initial, state, refresh, notify, onExit }) {
  const [session, setSession] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [connectionBusy, setConnectionBusy] = useState(false)
  const [budgetValid, setBudgetValid] = useState(true)
  const [revision, setRevision] = useState(0)
  const [error, setError] = useState('')
  const lock = useRef(false)
  const current = useRef(initial)
  const heading = useRef(null)
  const scroller = useRef(null)
  const { step, edits } = session
  const [shortName, title, intro] = steps[step]
  const disabled = busy || connectionBusy
  const profile = state.profile || {}
  useLayoutEffect(() => {
    scroller.current.scrollTop = 0
    heading.current.focus({ preventScroll: true })
  }, [step, revision])

  function checkpoint(next) {
    storeSetup(next)
    current.current = next
    setSession(next)
    setError('')
  }
  function value(key) {
    return edits[key]?.value ?? savedField(profile, key) ?? ''
  }
  function updatedFields(changes) {
    const next = { ...current.current.edits }
    for (const [key, value] of Object.entries(changes)) {
      const base = Object.hasOwn(next, key) ? next[key].base : savedField(profile, key)
      next[key] = { base, value }
    }
    return next
  }
  function edit(changes) {
    try { checkpoint({ ...current.current, status: 'active', edits: updatedFields(changes) }) }
    catch { setError('Could not keep this edit on your device. Check the available disk space and try again.') }
  }
  async function run(action) {
    if (lock.current || connectionBusy) return
    lock.current = true
    setBusy(true)
    setError('')
    try { await action() }
    catch (failure) { setError(failure.message || 'Please try again.') }
    finally { lock.current = false; setBusy(false) }
  }
  function exit() {
    storeSetup({ status: 'closed' })
    onExit()
  }
  function move(nextStep, clear = []) {
    const remaining = { ...current.current.edits }
    for (const key of clear) delete remaining[key]
    checkpoint({ status: 'active', step: nextStep, edits: remaining })
  }
  const keys = step === 0 ? identityKeys : step === 1 ? preferenceKeys : []
  async function next() {
    if (keys.some(key => Object.hasOwn(edits, key))) {
      await commitFields(edits, keys)
      await refresh()
    }
    move(step + 1, keys)
  }
  async function connectKit() {
    const result = await window.pluto.call('jobkit.choose', { kind: 'kit' })
    if (!result || result.canceled) return
    await refresh()
    if (result.kit?.connected) notify('Job kit connected.')
  }
  async function reloadStep() {
    await refresh()
    move(step, step === 4 ? ['budget'] : keys)
    setRevision(value => value + 1)
  }
  const budgetSetup = {
    draft: edits.budget?.value,
    onValidityChange: setBudgetValid,
    onEdit: budget => edit({ budget }),
    onSave: budget => run(async () => {
      await commitFields(updatedFields({ budget }), ['budget'])
      await refresh()
      exit()
    }),
  }
  return <main className={'first-run platform-' + window.pluto.platform} ref={scroller} aria-label="Workspace setup">
    <header className="setup-bar">
      <div className="setup-brand"><img src="./pluto.jpg" alt="" /><strong>Project Pluto</strong><span>Setup</span></div>
      <Button type="button" variant="ghost" disabled={disabled} onClick={() => run(exit)}>Skip setup</Button>
    </header>
    <div className="setup-sheet">
      <ol className="setup-progress" aria-label="Setup steps">{steps.map(([label], index) =>
        <li key={label} aria-current={index === step ? 'step' : undefined}>
          <span>{label}</span>
        </li>)}</ol>
      <section className="setup-step" key={step + ':' + revision} aria-labelledby="setup-heading">
        <div className="setup-intro">
          <p className="setup-counter" id="setup-position">Step {step + 1} of {steps.length} · {shortName}</p>
          <h1 ref={heading} tabIndex={-1} id="setup-heading" aria-describedby="setup-position">{title}</h1>
          <p>{intro}</p>
        </div>
        <div className="setup-controls">
          <fieldset className="setup-fields" disabled={busy} aria-label={title}>
            {step === 0 && <Identity {...{ value, edit, run, connectKit, disabled }} />}
            {step === 1 && <Preferences {...{ value, edit }} />}
            {step === 2 && <MailConnection notify={notify} onBusyChange={setConnectionBusy} />}
            {step === 3 && <Connections aiOnly notify={notify} onBusyChange={setConnectionBusy} />}
            {step === 4 && <Budget state={state} refresh={refresh} notify={notify} setup={budgetSetup} />}
          </fieldset>
          {error && <p role="alert">{error}</p>}
          {error.includes('changed while you were editing') && <Button type="button" variant="outline" disabled={disabled}
            onClick={() => run(reloadStep)}>Reload this step</Button>}
          <footer className="setup-footer">
            {step > 0 && <Button type="button" variant="ghost" disabled={disabled} onClick={() => run(() => move(step - 1))}><ArrowLeft aria-hidden="true" />Back</Button>}
            <Button className="setup-skip" type="button" variant="ghost" disabled={disabled}
              onClick={() => run(step === 4 ? exit : () => move(step + 1, keys))}>Skip this step</Button>
            {step === 4 ? <Button type="submit" form="setup-budget-form" disabled={disabled || !budgetValid}>Save budget and open Today<ArrowRight aria-hidden="true" /></Button> :
              <Button type="button" disabled={disabled} onClick={() => run(next)}>{step < 2 ? 'Save and continue' : 'Continue'}<ArrowRight aria-hidden="true" /></Button>}
          </footer>
        </div>
      </section>
    </div>
  </main>
}
