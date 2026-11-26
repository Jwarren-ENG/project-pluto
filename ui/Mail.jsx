import React, { useEffect, useRef, useState } from 'react'
import { Button } from './components/ui/button'
import { Input } from './components/ui/input'
import { formatRecordDate } from '../desktop/record-dates.mjs'

const providers = { apple: 'Apple Mail', gmail: 'Gmail', outlook: 'Outlook' }
const purposes = {
  receipt: 'Application receipt',
  'interview-invite': 'Interview invitation',
  'interview-scheduled': 'Interview scheduled',
  'interview-rescheduled': 'Interview rescheduled',
  'interview-canceled': 'Interview canceled',
}
const call = (action, data = {}) => window.pluto.call('mail.' + action, data)

function interviewTime(day, time) {
  if (!time) return day
  if (!day) throw new Error('Enter the confirmed interview date for this time.')
  const local = new Date(day + 'T' + time)
  if (!Number.isFinite(local.valueOf()) || local.getHours() !== Number(time.slice(0, 2)) ||
      local.getMinutes() !== Number(time.slice(3))) throw new Error('Check the local interview time.')
  return local.toISOString()
}

function RoleUpdates({ job, provider, active, refresh }) {
  const [matches, setMatches] = useState(null)
  const [review, setReview] = useState(null)
  const [day, setDay] = useState('')
  const [time, setTime] = useState('')
  const [secret, setSecret] = useState(null)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const pending = useRef(null)

  useEffect(() => () => {
    const request = pending.current
    pending.current = null
    if (request?.scanId) call('scan', { provider, jobId: job.id, scanId: request.scanId, cancel: true }).catch(() => {})
  }, [provider, job.id])

  useEffect(() => {
    if (!secret) return
    const expire = () => {
      if (Date.now() >= secret.until) {
        setSecret(null)
        setNotice('Verification code expired.')
      }
    }
    const timer = setTimeout(expire, Math.max(0, secret.until - Date.now()))
    window.addEventListener('focus', expire)
    document.addEventListener('visibilitychange', expire)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('focus', expire)
      document.removeEventListener('visibilitychange', expire)
    }
  }, [secret])

  async function perform(kind, work) {
    if (pending.current) return
    const request = { kind }
    pending.current = request
    setBusy(kind)
    setNotice('')
    setError('')
    setSecret(null)
    try { await work(request) }
    catch (err) {
      if (pending.current === request) setError(kind === 'code'
        ? 'Could not find a verification code. Check that you requested one for this role and try again.'
        : err.message || 'Could not complete the employer update.')
    } finally {
      if (pending.current === request) {
        pending.current = null
        setBusy('')
      }
    }
  }

  function scan() {
    perform('scan', async request => {
      setMatches(null)
      setReview(null)
      request.scanId = crypto.randomUUID()
      const page = await call('scan', { provider, jobId: job.id, scanId: request.scanId })
      if (pending.current !== request) return
      const rows = page.matches.filter(row => Object.hasOwn(purposes, row.purpose) &&
        row.jobId === job.id && row.company === job.company && row.title === job.title && row.jobUrl === job.url &&
        row.message?.provider === provider && row.message.key)
      setMatches(rows)
      setNotice(rows.length ? rows.length + (rows.length === 1 ? ' matching update.' : ' matching updates.') : 'No matching updates for this role.')
    })
  }

  function findCode() {
    perform('code', async request => {
      setReview(null)
      const requestedAt = new Date().toISOString()
      const value = await call('verificationCode', { provider, jobId: job.id, requestedAt })
      if (pending.current !== request) return
      const received = Date.parse(value?.receivedAt)
      const expiry = typeof value?.expiresAt === 'number' ? value.expiresAt : Date.parse(value?.expiresAt)
      const until = Math.min(Number.isFinite(received) ? received + 10 * 60_000 : Infinity,
        Number.isFinite(expiry) ? expiry : Infinity)
      if (typeof value?.code === 'string' && value.code && Number.isFinite(until) && until > Date.now()) {
        setSecret({ value: value.code, until })
      } else {
        setNotice('No current verification code found for this role.')
      }
    })
  }

  function select(row) {
    setSecret(null)
    setReview(row)
    setDay('')
    setTime('')
    setError('')
    setNotice('')
  }

  const canConfirmDate = ['interview-scheduled', 'interview-rescheduled', 'interview-canceled'].includes(review?.purpose)

  function record() {
    perform('record', async request => {
      const payload = { provider, jobId: job.id, messageKey: review.message.key }
      if (canConfirmDate && (day || time)) payload.interviewAt = interviewTime(day, time)
      const result = await call('recordUpdate', payload)
      if (pending.current === request) {
        setReview(null)
        setMatches(rows => rows.filter(row => row.message.key !== payload.messageKey))
        if (result?.duplicate) setNotice('Already linked to this role.')
        else if (canConfirmDate && result?.interviewAt && !result.appointmentChanged) {
          setNotice('Update linked to this role. The existing interview appointment was retained.')
        } else setNotice('Update linked to this role.')
      }
      try { await refresh() }
      catch {
        if (pending.current === request) setError('The update was recorded. Reopen Applications to see the latest history.')
      }
    })
  }

  return <div className="stack">
    <div className="toolbar">
      <Button type="button" size="sm" variant="outline" disabled={Boolean(busy)} onClick={scan}>
        {busy === 'scan' ? 'Checking updates…' : 'Check for updates'}
      </Button>
      {active && <Button type="button" size="sm" variant="outline" disabled={Boolean(busy)} onClick={findCode}>
        {busy === 'code' ? 'Finding code…' : 'Find verification code'}
      </Button>}
    </div>
    {secret && secret.until > Date.now() && <div className="toolbar" aria-label="Temporary verification code">
      <span>Verification code <strong>{secret.value}</strong></span>
      <small>Hidden at {new Date(secret.until).toLocaleTimeString()}</small>
      <Button type="button" size="sm" variant="link" onClick={() => setSecret(null)}>Hide code</Button>
    </div>}
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert">{error}</p>}
    {matches?.length > 0 && <ul aria-label="Matched employer updates">{matches.map(row =>
      <li key={row.message.key}>
        <Button type="button" size="sm" variant="link" className="h-auto max-w-full whitespace-normal text-left"
          disabled={Boolean(busy)} onClick={() => select(row)}>{row.message.subject || purposes[row.purpose]}</Button>
        <small> · {purposes[row.purpose]}</small>
      </li>)}</ul>}
    {review && <section className="space-y-2 border-t py-3" aria-label="Review employer update">
      <h3>{purposes[review.purpose]}</h3>
      <p><strong>{job.company} · {job.title}</strong><br/>{review.message.subject}</p>
      <p>{review.message.from}{review.message.receivedAt && <> · <time dateTime={review.message.receivedAt}>{formatRecordDate(review.message.receivedAt)}</time></>}</p>
      {review.message.preview && <blockquote>{review.message.preview}</blockquote>}
      {review.purpose === 'receipt' && <p>Link this receipt as submission evidence. Submitted materials require their own evidence.</p>}
      {canConfirmDate && <div className="field-grid">
        <label>{review.purpose === 'interview-canceled' ? 'Canceled interview date, if known' : 'Confirmed interview date, if known'}<Input type="date" value={day} disabled={Boolean(busy)} onChange={event => {
          setDay(event.target.value)
          if (!event.target.value) setTime('')
        }}/></label>
        <label>Confirmed time in your time zone, if known<Input type="time" value={time} disabled={Boolean(busy) || !day}
          onChange={event => setTime(event.target.value)}/></label>
      </div>}
      <div className="toolbar">
        <Button type="button" size="sm" disabled={Boolean(busy)} onClick={record}>Link update to role</Button>
        <Button type="button" size="sm" variant="ghost" disabled={Boolean(busy)} onClick={() => select(null)}>Cancel review</Button>
      </div>
    </section>}
  </div>
}

function UpdateControls({ jobs, activeJob, refresh }) {
  const [accounts, setAccounts] = useState(null)
  const [provider, setProvider] = useState('')
  const [jobId, setJobId] = useState(jobs.length === 1 ? jobs[0].id : '')
  const [attempt, setAttempt] = useState(0)
  const [error, setError] = useState('')
  const job = activeJob || jobs.find(row => row.id === jobId)
  const canFindCode = Boolean(activeJob) && job.stage !== 'Closed'
  useEffect(() => {
    let live = true
    setError('')
    call('settings').then(rows => {
      if (!live) return
      const connected = rows.filter(row => Object.hasOwn(providers, row.provider) && row.email && !row.error)
      setAccounts(connected)
      setProvider(connected[0]?.provider || '')
    }).catch(() => { if (live) setError('Could not load employer update sources.') })
    return () => { live = false }
  }, [attempt])

  if (error) return <div className="toolbar"><p role="alert">{error}</p>
    <Button type="button" variant="link" size="sm" onClick={() => setAttempt(attempt + 1)}>Retry sources</Button></div>
  if (!accounts) return <p role="status">Loading sources…</p>
  if (!accounts.length) return <p className="muted">No mail source configured for employer updates.</p>
  return <div className="stack pt-2">
    <div className="field-grid">
      {!activeJob && <label>Tracked role<select aria-label="Tracked role" value={jobId} onChange={event => setJobId(event.target.value)}>
        <option value="">Choose a role</option>
        {jobs.map(row => <option key={row.id} value={row.id}>{row.company} · {row.title}</option>)}
      </select></label>}
      {accounts.length > 1 ? <label>Update source<select aria-label="Update source" value={provider} onChange={event => setProvider(event.target.value)}>
        {accounts.map(row => <option key={row.provider} value={row.provider}>{providers[row.provider]} · {row.email}</option>)}
      </select></label> : <small>Source · {providers[provider]}</small>}
    </div>
    {job && provider && <RoleUpdates key={JSON.stringify([provider, job.id, job.company, job.title, job.url, canFindCode])}
      job={job} active={canFindCode} provider={provider} refresh={refresh}/>}
  </div>
}

function EnabledEmployerUpdates({ state, activeJob, refresh }) {
  const [open, setOpen] = useState(false)
  return <details className="border-t py-3" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer font-medium">Employer updates</summary>
    {open && (state.jobs.length
      ? <UpdateControls jobs={state.jobs} activeJob={activeJob} refresh={refresh}/>
      : <p className="muted">Save a role to check its employer updates.</p>)}
  </details>
}

export default function EmployerUpdates({ state, activeJob, refresh, go }) {
  if (state.features?.emailCheck === true) return <EnabledEmployerUpdates state={state} activeJob={activeJob} refresh={refresh}/>
  if (activeJob || !go) return null
  return <div><Button type="button" variant="link" size="sm" className="px-0" onClick={() => go('Connections', 'features')}>
    Optional workflow settings
  </Button></div>
}
