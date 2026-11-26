import React, { useEffect, useId, useRef, useState } from 'react'
import { ChevronDown, Copy } from 'lucide-react'
import { Button } from './components/ui/button'
import { formatRecordDate, recordDate } from '../desktop/record-dates.mjs'
import './job-kit.css'

const tasks = [
  ['run', 'Run a job search'],
  ['status', 'Review application status'],
  ['interview-prep', 'Prepare for an interview'],
]
const dayFormat = { year: 'numeric', month: 'short', day: 'numeric' }

function call(action, payload) {
  if (typeof window.pluto?.call !== 'function') throw new Error('Job Kit requires the desktop service.')
  return window.pluto.call('jobkit.' + action, payload)
}

function sourceCounts(stats) {
  if (!stats) return ''
  return [['applications', 'application'], ['interviews', 'interview'], ['notes', 'note']]
    .filter(([key]) => Number.isInteger(stats[key]) && stats[key] > 0)
    .map(([key, label]) => stats[key] + ' ' + label + (stats[key] === 1 ? '' : 's')).join(' · ')
}

function SourceRow({ kind, label, managedName, source, busy, choose }) {
  const connected = source?.connected
  const counts = connected && sourceCounts(source.stats)
  const action = managedName
    ? (connected ? 'Change additional' : 'Add additional')
    : (connected ? 'Change' : 'Connect')

  return <div>
    <dt>{label}</dt>
    <dd>
      {managedName && <div>{managedName}<small>Managed locally</small></div>}
      {connected && <div>
        {managedName && 'Additional ' + kind + ' · '}{source.name || source.label || 'Connected'}
        {counts && <small>{counts}</small>}
      </div>}
      {!connected && !managedName && 'Optional · Not connected'}
    </dd>
    <dd className="job-kit-source-actions">
      <Button type="button" variant="link" size="sm" disabled={busy} onClick={() => choose(kind)}>
        {action} {kind}
      </Button>
    </dd>
  </div>
}

function RefreshDate({ value }) {
  if (!value) return 'No refresh recorded'
  if (!recordDate(value)) return 'Date unavailable'
  return <time dateTime={value}>
    {formatRecordDate(value, dayFormat, { ...dayFormat, hour: 'numeric', minute: '2-digit' })}
  </time>
}

export default function JobKitWorkspace({ go, refresh, state }) {
  const id = useId()
  const [expanded, setExpanded] = useState(false)
  const [status, setStatus] = useState(null)
  const [skill, setSkill] = useState('run')
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const lock = useRef(false)
  const mounted = useRef(false)
  const timer = useRef(null)
  const revision = useRef(0)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      clearTimeout(timer.current)
    }
  }, [])

  async function readStatus() {
    const version = ++revision.current
    try {
      const next = await call('status')
      if (!next || typeof next !== 'object' || Array.isArray(next)) throw new Error('Job Kit status is unavailable.')
      if (mounted.current && version === revision.current) setStatus(next)
      return next
    } catch (err) {
      if (mounted.current && version === revision.current) setStatus(null)
      throw err
    }
  }

  async function perform(action, work) {
    if (lock.current) return
    lock.current = true
    setBusy(action)
    setNotice('')
    setError('')
    try {
      await work()
    } catch (err) {
      if (mounted.current) {
        const message = err?.message || 'The desktop service could not complete this action.'
        setError(/unsupported workspace action|no handler registered/i.test(message)
          ? 'This version of Pluto does not support this Job Kit action.' : message)
      }
    } finally {
      lock.current = false
      if (mounted.current) setBusy('')
    }
  }

  function toggle() {
    setExpanded(!expanded)
    if (!expanded) perform('status', readStatus)
  }

  const kit = status?.kit
  const vault = status?.vault
  const managed = status?.managed?.configured ? status.managed : null
  const sourceConnected = Boolean(kit?.connected || vault?.connected)
  const canSync = status?.canSync ?? Boolean(sourceConnected || managed)
  const canCopy = status?.canCopyTask ?? Boolean(kit?.connected || managed)
  const canOpenTask = status?.codexAvailable === true && canCopy
  const canOpen = status?.canOpenVault ?? Boolean(vault?.connected || managed?.vault)

  function checkRequestedRefresh(previousDate) {
    clearTimeout(timer.current)
    timer.current = setTimeout(async () => {
      const expected = revision.current + 1
      try {
        const latest = await readStatus()
        if (!mounted.current || revision.current !== expected) return
        if (latest.managed?.lastCompleted && latest.managed.lastCompleted !== previousDate) {
          if (latest.managed.ok === false) {
            setError('The requested refresh failed. Check the local tracker.')
          } else {
            setNotice('Refresh completed.')
            await refresh?.()
          }
        }
      } catch (err) {
        if (mounted.current && revision.current === expected) setError(err.message || 'Could not check refresh status.')
      }
    }, 4000)
  }

  function choose(kind) {
    perform(kind, async () => {
      const result = await call('choose', { kind })
      if (!mounted.current) return
      ++revision.current
      if (result?.kit || result?.vault) setStatus(result)
      else await readStatus()
      if (result && !result.canceled) await refresh?.()
    })
  }

  function sync() {
    perform('sync', async () => {
      const result = await call('sync')
      if (!mounted.current) return
      if (!result || result.ok === false) throw new Error(result?.message || 'The sources could not be refreshed.')
      ++revision.current
      setStatus(result)
      if (result.managedRequest) {
        setNotice('Refresh requested')
        checkRequestedRefresh(result.managed?.lastCompleted)
      } else {
        setNotice(result.lastSync?.issues?.length ? 'Sync finished with source issues.' : 'Refresh completed.')
      }
      if (!result.managedRequest || sourceConnected) await refresh?.()
    })
  }

  function openTask() {
    perform('openTask', async () => {
      const result = await call('openTask', { skill })
      if (result === false || result?.ok === false) throw new Error('Could not open the task in Codex.')
      if (mounted.current) setNotice('Task sent to Codex for review.')
    })
  }

  function copyTask() {
    perform('copy', async () => {
      const result = await call('copyTask', { skill })
      if (result === false || result?.ok === false || result?.copied === false) throw new Error('The task could not be copied.')
      if (mounted.current) setNotice('Task copied. Paste it into your assistant.')
    })
  }

  const available = status && status.supported !== false
  const report = sourceConnected ? status?.lastSync : null
  const sourceDates = [kit?.lastSyncedAt, vault?.lastSyncedAt].filter(value => recordDate(value))
  const recentDate = status?.lastCompleted || sourceDates.sort().at(-1) || (!report?.issues?.length && report?.at)
  return <section className="job-kit" aria-labelledby={id + '-title'}>
    <div className="job-kit-header">
      <h2 id={id + '-title'}>Job Kit workflow</h2>
      <Button type="button" variant="ghost" size="sm" aria-expanded={expanded} aria-controls={id + '-workflow'} onClick={toggle}>
        {expanded ? 'Hide workflow' : 'Show workflow'} <ChevronDown aria-hidden="true" size={16}/>
      </Button>
    </div>
    <div className="job-kit-nav">
      <Button type="button" variant="link" size="sm" onClick={() => go('Applications')}>Open applications
        {Array.isArray(state?.jobs) && <span className="job-kit-count" aria-hidden="true">{state.jobs.length}</span>}
      </Button>
      <Button type="button" variant="link" size="sm" onClick={() => go('Notebook')}>Open notebook
        {Array.isArray(state?.notes) && <span className="job-kit-count" aria-hidden="true">{state.notes.length}</span>}
      </Button>
    </div>
    <div id={id + '-workflow'} hidden={!expanded}>
      <div className="job-kit-status">
        <p>{busy === 'status' ? 'Checking local sources…' : !status ? 'Local status unavailable' :
          !available ? 'Job Kit is unavailable in this version of Pluto.' :
          managed ? 'Managed tracker connected' : (kit?.connected || vault?.connected) ? 'Local sources connected' : 'No sources connected'}</p>
        <Button type="button" variant="link" size="sm" disabled={Boolean(busy)} onClick={() => perform('status', readStatus)}>Check status</Button>
      </div>
      {available && <>
        <dl className="job-kit-sources">
          <SourceRow kind="kit" label="Job Kit" managedName={managed?.tracker} source={kit} busy={Boolean(busy)} choose={choose}/>
          <SourceRow kind="vault" label="Obsidian vault" managedName={managed?.vault} source={vault} busy={Boolean(busy)} choose={choose}/>
        </dl>
        <div className="job-kit-sync">
          <div>
            {recentDate || managed?.lastCompleted
              ? <p>{recentDate && managed ? 'Last source refresh' : 'Last refresh'} <span><RefreshDate value={recentDate || managed?.lastCompleted}/></span></p>
              : <p>No refresh recorded</p>}
            {recentDate && managed && <p>Last managed refresh <span><RefreshDate value={managed.lastCompleted}/></span></p>}
            {managed?.lastCompleted && managed.ok === false && <p>The last managed refresh failed.</p>}
          </div>
          <div className="job-kit-actions">
            <Button type="button" variant="outline" size="sm" disabled={Boolean(busy) || !canSync} onClick={sync}>
              {busy === 'sync' ? 'Refreshing…' : 'Sync from sources'}
            </Button>
            {canOpen && <Button type="button" variant="link" size="sm" disabled={Boolean(busy)}
              onClick={() => perform('open', async () => {
                const result = await call('openVault')
                if (result === false || result?.ok === false) throw new Error('Could not open the configured vault.')
              })}>Open in Obsidian</Button>}
          </div>
        </div>
        {report && <div className="job-kit-report">
          {report.jobs && <p>Applications · {report.jobs.inserted} added · {report.jobs.updated} updated · {report.jobs.receipts} {report.jobs.receipts === 1 ? 'receipt' : 'receipts'} added</p>}
          {Number.isInteger(report.imported) && <p>Notebook sync · {report.imported} added · {report.updated} updated · {report.preserved} preserved</p>}
          {report.issues?.length > 0 && <ul aria-label="Source issues">{report.issues.map((issue, index) =>
            <li key={index}>{issue}</li>)}</ul>}
        </div>}
        <div className="job-kit-task">
          <label htmlFor={id + '-skill'}>Task for your assistant</label>
          <div className="job-kit-actions">
            <select id={id + '-skill'} value={skill} disabled={Boolean(busy)} aria-describedby={id + '-hint'}
              onChange={event => { setSkill(event.target.value); setNotice('') }}>
              {tasks.filter(([value]) => value !== 'interview-prep' || state?.features?.interviewPrep).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
            {canOpenTask && <Button type="button" size="sm" disabled={Boolean(busy)} onClick={openTask}>
              {busy === 'openTask' ? 'Opening…' : 'Open task in Codex'}
            </Button>}
            <Button type="button" variant={canOpenTask ? 'outline' : 'default'} size="sm" disabled={Boolean(busy) || !canCopy} onClick={copyTask}>
              <Copy aria-hidden="true" size={15}/> {busy === 'copy' ? 'Copying…' : 'Copy task'}
            </Button>
          </div>
          <p id={id + '-hint'}>{canCopy
            ? (skill === 'run' && !state?.features?.autoApply ? 'Auto apply is off. Your assistant will prepare drafts for review.' : 'Review the prepared task in your assistant. It uses the connected workspace, your approvals and recorded receipts.')
            : 'Connect a Job Kit workspace to copy a task for your assistant.'}</p>
        </div>
      </>}
      <p role="status" className="job-kit-feedback">{notice}</p>
      {error && <p role="alert" className="job-kit-error">{error}</p>}
    </div>
  </section>
}
