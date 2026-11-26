import React, { useEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { featureNames, hasDraftMaterial } from '../desktop/workflow-features.mjs'
import './optional-workflows.css'

const descriptions = {
  studyGuides: 'Generate a study guide for a tracked role in Notebook.',
  interviewPrep: 'Practice with questions drawn from a role and your experience.',
  emailCheck: 'Check a tracked role for a code, submission receipt or interview update.',
  autoApply: 'Allow the connected Job Kit to submit eligible applications when you run a search.',
}

function Requirement({ label, detail, action, onClick }) {
  return <li><span><strong>{label}</strong> · {detail}</span>
    {action && <button type="button" className="workflow-link" onClick={onClick}>{action}</button>}
  </li>
}

export default function OptionalWorkflows({ state, settings, accounts, refresh, go }) {
  const [closed, setClosed] = useState({})
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [kit, setKit] = useState(null)
  const lock = useRef(false)
  const features = state.features || {}
  useEffect(() => {
    if (!features.autoApply) return
    let current = true
    window.pluto.call('jobkit.status').then(value => { if (current) setKit(value) })
      .catch(() => { if (current) setKit(null) })
    return () => { current = false }
  }, [features.autoApply])
  async function toggle(key) {
    if (lock.current) return
    lock.current = true
    setBusy(key)
    setError('')
    try {
      await window.pluto.call('workspace.saveFeature', { key, enabled: !features[key] })
      setClosed(previous => ({ ...previous, [key]: false }))
      await refresh()
    } catch (err) { setError(err.message) }
    finally { lock.current = false; setBusy('') }
  }
  const focus = id => document.getElementById(id)?.focus()
  const hasProfile = hasDraftMaterial(state.profile)
  const connectedMail = accounts?.filter(row => row.email && !row.error).map(row => row.email)
  const jobs = <Requirement label="Tracked role" detail={state.jobs?.length ? 'Available' : 'Add a role to work with'}
    action="Applications" onClick={() => go('Applications')}/>
  const profileRow = <Requirement label="Profile" detail={hasProfile ? 'Profile details available' : 'Add your résumé or experience'}
    action="Review profile" onClick={() => go('Profile')}/>
  return <section className="optional-workflows" aria-labelledby="optional-workflows-heading">
    <h2 id="optional-workflows-heading" tabIndex={-1}>Optional workflows</h2>
    {Object.entries(featureNames).map(([key, label]) => {
      const enabled = features[key] === true
      const expanded = enabled && !closed[key]
      const panel = 'requirements-' + key
      return <div key={key} className="workflow-row">
        <div className="workflow-line">
          <div><h3>{label}</h3><p>{descriptions[key]}</p></div>
          <button className="workflow-switch" role="switch" aria-label={label} aria-checked={enabled}
            aria-controls={panel} disabled={Boolean(busy)} onClick={() => toggle(key)}><span/></button>
        </div>
        <button type="button" className="workflow-disclosure" disabled={!enabled} aria-expanded={expanded}
          aria-controls={panel} onClick={() => setClosed(previous => ({ ...previous, [key]: !previous[key] }))}>
          {busy === key ? 'Saving…' : 'Requirements'} <ChevronDown size={15} aria-hidden="true"/>
        </button>
        <div id={panel} hidden={!expanded}>
          <ul>
            {(key === 'studyGuides' || key === 'interviewPrep') && <>
              <Requirement label="AI provider" detail={settings?.providers?.[settings.activeProvider]?.label || 'Choose an account or a model'}
                action="AI connection" onClick={() => focus('ai-connections-heading')}/>
              {profileRow}{jobs}
            </>}
            {key === 'emailCheck' && <>
              <Requirement label="Email account" detail={connectedMail?.length ? connectedMail.join(', ') : 'Connect a mailbox'}
                action="Email connection" onClick={() => focus('email-connections-heading')}/>
              {jobs}
            </>}
            {key === 'autoApply' && <>
              <Requirement label="Job Kit" detail={kit?.managed?.configured || kit?.kit?.connected ? 'Workspace connected' : 'Connect a job workspace on Today'}
                action="Job Kit workflow" onClick={() => go('Today')}/>
              {profileRow}
              <Requirement label="Daily target" detail={state.profile?.budget?.jobsPerDay != null ? state.profile.budget.jobsPerDay + ' jobs per day in Pluto' : 'Set your application budget'}
                action="Daily budget" onClick={() => go('Daily budget')}/>
              <Requirement label="Submission permission" detail="Your assistant checks the Job Kit’s permissions and remaining capacity before each submission."/>
            </>}
          </ul>
          {(key === 'studyGuides' || key === 'interviewPrep') && <p>Generating a draft uses your selected model’s allowance or API credits. Reading and editing saved notes is free.</p>}
          {key === 'emailCheck' && <p>Open an application to check its mailbox updates.</p>}
          {key === 'autoApply' && <p>Start the task from Today. Switching this on does not start a run.</p>}
        </div>
      </div>
    })}
    {error && <p role="alert">{error}</p>}
  </section>
}
