import { featureNames, workflowFeatures } from './workflow-features.mjs'
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync, constants, copyFileSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { DatabaseSync } from 'node:sqlite'
import { compareRecordDates, recordDate, upcomingInterviews, validDay } from './record-dates.mjs'

import { importKitTracker } from './kit-tracker.mjs'

const stages = ['Saved', 'Preparing', 'Applied', 'Interview', 'Offer', 'Closed']
const defaults = { enabled: false, hour: 9, minute: 0, query: '', lastRunDate: null }
const endCase = '<!-- end:pluto-record -->'
const maxText = 2_000_000
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const hash = value => createHash('sha256').update(value).digest('hex')

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Expected a ${name} object.`)
  return value
}

function text(value, name, { required = false, line = false } = {}) {
  if (typeof value !== 'string' || value.length > maxText || value.includes('\0')) throw new Error(`Invalid ${name}.`)
  if (line && /[\r\n]/.test(value)) throw new Error(`${name} must fit on one line.`)
  if (required && !value.trim()) throw new Error(`${name} is required.`)
  return line ? value.trim() : value
}

function validId(value) {
  if (typeof value !== 'string' || !idPattern.test(value)) throw new Error('Invalid workspace ID.')
  return value
}

function webUrl(value) {
  if (!value) return ''
  const url = new URL(text(value, 'job URL', { line: true }))
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Use an HTTP or HTTPS job URL without credentials.')
  return value
}

function interviewTime(value) {
  if (value === '' || value === null) return null
  if (validDay(value)) return value
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value) || !validDay(value.slice(0, 10)) || !Number.isFinite(Date.parse(value))) {
    throw new Error('Enter a valid interview date and time.')
  }
  return new Date(value).toISOString()
}

function receipt(value) {
  if (typeof value === 'string') return text(value, 'evidence').trim()
  object(value, 'evidence')
  // Accept a matched email or portal reference without persisting a mailbox or provider payload.
  const result = {}
  for (const key of ['text', 'source', 'url', 'messageId', 'subject', 'receivedAt', 'reference']) {
    if (value[key] != null) result[key] = text(value[key], `evidence ${key}`).trim()
  }
  if (!['text', 'url', 'messageId', 'subject', 'reference'].some(key => result[key])) throw new Error('Include the receipt text or an identifying reference.')
  return result
}

const employerPurposes = new Map([
  ['receipt', 'Application receipt'], ['interview-invite', 'Interview invitation'],
  ['interview-scheduled', 'Interview scheduled'], ['interview-rescheduled', 'Interview rescheduled'],
  ['interview-canceled', 'Interview canceled'],
])
const mailSources = new Map([['gmail', 'Gmail'], ['outlook', 'Outlook'], ['apple', 'Apple Mail']])
const messageFields = { provider: 12, key: 256, subject: 500, preview: 500, receivedAt: 40, from: 320, account: 320, url: 4096 }
const credentialMail = /\b(?:otp|totp|passcode|password|2fa|mfa|one time (?:code|pin|token)|(?:verification|verify|login|log in|sign in|security|authentication|confirmation|access|meeting) (?:code|pin|number|token)|(?:use|enter) (?:this|the|your) code|your (?:code|pin)|(?:code|pin) (?:is )?\d{4,8})\b/i
const zonedTime = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,9})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/

function mailDate(value, allowDay) {
  if (value == null || value === '') return null
  if (allowDay && validDay(value)) return value
  if (typeof value !== 'string' || !zonedTime.test(value) || !validDay(value.slice(0, 10)) || !Number.isFinite(Date.parse(value))) {
    throw new Error('Use a valid date or an interview time with an explicit UTC offset.')
  }
  return new Date(value).toISOString()
}

function employerUpdate(input) {
  object(input, 'employer update')
  if (![null, Object.prototype].includes(Object.getPrototypeOf(input)) ||
      Object.keys(input).some(key => !['jobId', 'message', 'purpose', 'interviewAt'].includes(key))) {
    throw new Error('Unexpected employer update details.')
  }
  const { jobId, purpose, message } = input
  validId(jobId)
  if (!employerPurposes.has(purpose)) throw new Error('Choose a reviewed employer update.')
  object(message, 'matched mail message')
  if (![null, Object.prototype].includes(Object.getPrototypeOf(message))) throw new Error('Invalid matched mail metadata.')
  for (const [field, val] of Object.entries(message)) {
    if (!Object.hasOwn(messageFields, field) || typeof val !== 'string' || val.length > messageFields[field] || /[\x00-\x1f\x7f]/.test(val)) {
      throw new Error('Invalid matched mail metadata.')
    }
  }
  if (!mailSources.has(message.provider) || !message.subject?.trim() || typeof message.key !== 'string' ||
      !/^[a-z0-9_-]{1,256}$/i.test(message.key) || /^\d{1,10}$/.test(message.key)) {
    throw new Error('A reviewed message needs its provider and stable message reference.')
  }
  const content = [message.subject, message.preview].join(' ').normalize('NFKC')
  const headerAndContent = [message.from, content].join(' ').normalize('NFKC')
  if (credentialMail.test(headerAndContent.replace(/[^\p{L}\p{N}]+/gu, ' '))) {
    throw new Error('Verification messages cannot be recorded as employer updates.')
  }
  const reviewedAt = mailDate(input.interviewAt, true)
  if (reviewedAt && (purpose === 'receipt' || purpose === 'interview-invite')) {
    throw new Error('Only a scheduled, rescheduled or canceled interview can identify an appointment date.')
  }
  // Persist a scoped reference and controlled label only. Mail text, links and mailbox identity stay in the scan.
  const key = hash(JSON.stringify([message.provider, message.key]))
  const receivedAt = mailDate(message.receivedAt, false) ?? ''
  const evidence = { source: mailSources.get(message.provider), messageId: key, receivedAt, reference: employerPurposes.get(purpose) }
  return { jobId, key, purpose, evidence, reviewedAt, content }
}

function sameSlot(a, b) {
  if (a === b) return true
  return zonedTime.test(a) && zonedTime.test(b) && Date.parse(a) === Date.parse(b)
}

// A reviewed move can replace a future appointment only when its previous slot is identified.
function identifiesPreviousSlot(content, current) {
  const slots = [...content.matchAll(/\b(?:(?:moved|rescheduled|changed) from|previously(?: scheduled)? (?:for|at))\s+(\d{4}-\d{2}-\d{2}(?:T[\d:.]+(?:Z|[+-]\d{2}:\d{2}))?)(?![\w:+-])/gi)]
  return slots.length === 1 && sameSlot(current, slots[0][1])
}

function applyInterviewMail(job, update, changedAt, lastConfirmation) {
  const { purpose, reviewedAt, evidence: { receivedAt }, content } = update
  if (['Offer', 'Closed'].includes(job.stage)) return
  if (lastConfirmation && (!receivedAt || receivedAt <= lastConfirmation)) return
  const current = job.interviewAt ?? null
  const cancel = purpose === 'interview-canceled'
  if (cancel && !sameSlot(current, reviewedAt)) return
  if (!cancel && current && !sameSlot(current, reviewedAt)) {
    const identifiedMove = purpose === 'interview-rescheduled' && identifiesPreviousSlot(content, current)
    if (!identifiedMove && (!reviewedAt || upcomingInterviews([{ ...job, stage: 'Interview' }]).length)) return
  }
  if (!cancel) job.stage = 'Interview'
  job.interviewAt = cancel ? null : reviewedAt
  job.interviewStatus = cancel ? 'canceled' : reviewedAt ? 'scheduled' : 'pending'
  // With no arrival time, a later review must postdate this one before it can reopen a canceled round.
  job.interviewMailAt = receivedAt || changedAt
  job.evidence = update.evidence
}

function transaction(db, action, write = true) {
  db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN')
  try {
    const result = action()
    db.exec('COMMIT')
    return result
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

function initialize(db) {
  db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;')
  if (db.prepare('PRAGMA user_version').get().user_version > 1) throw new Error('This workspace needs a newer version of Pluto.')
  db.exec('PRAGMA journal_mode=WAL;')
  transaction(db, () => db.exec(`
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY, job_id TEXT REFERENCES jobs(id), data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id), data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS events_job ON events(job_id, seq);
    CREATE UNIQUE INDEX IF NOT EXISTS employer_message_key ON events(json_extract(data, '$.employerMessageKey'))
      WHERE json_extract(data, '$.employerMessageKey') IS NOT NULL;
    CREATE TABLE IF NOT EXISTS submissions (job_id TEXT PRIMARY KEY REFERENCES jobs(id), data TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS protect_submission_update BEFORE UPDATE ON submissions
      BEGIN SELECT RAISE(ABORT, 'Submitted snapshots are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS protect_submission_delete BEFORE DELETE ON submissions
      BEGIN SELECT RAISE(ABORT, 'Submitted snapshots are immutable'); END;
    CREATE TABLE IF NOT EXISTS vault_sync (
      vault TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL,
      PRIMARY KEY(vault, kind, id)
    );
    PRAGMA user_version=1;
  `))
}

const decodeRow = row => row ? JSON.parse(row.data) : null

function checkRevision(previous, input) {
  if (previous && input.updatedAt != null && previous.updatedAt !== input.updatedAt) {
    throw new Error('This record changed. Refresh it before saving.')
  }
}

function nextRevision(previous) {
  return new Date(Math.max(Date.now(), previous ? Date.parse(previous.updatedAt) + 1 : 0)).toISOString()
}

export function createWorkspace(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const file = join(directory, 'workspace.sqlite3')
  closeSync(openSync(file, 'a', 0o600))
  const db = new DatabaseSync(file)
  try { initialize(db) } catch (err) { db.close(); throw err }

  const getJob = id => decodeRow(db.prepare('SELECT data FROM jobs WHERE id=?').get(id))
  const getNote = id => decodeRow(db.prepare('SELECT data FROM notes WHERE id=?').get(id))
  const setting = key => decodeRow(db.prepare('SELECT data FROM settings WHERE key=?').get(key))
  const set = (key, val) => {
    db.prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data').run(key, JSON.stringify(val))
    return val
  }
  const getFeatures = () => workflowFeatures(setting('optionalWorkflows'))
  const getSubmission = id => decodeRow(db.prepare('SELECT data FROM submissions WHERE job_id=?').get(id))
  const history = id => db.prepare('SELECT data FROM events WHERE job_id=? ORDER BY seq').all(id).map(decodeRow)
  const jobView = job => ({ ...job, submittedSnapshot: getSubmission(job.id), history: history(job.id) })
  const storeJob = job => db.prepare('INSERT INTO jobs VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(job.id, JSON.stringify(job))

  function saveJob(input) {
    object(input, 'job')
    return transaction(db, () => {
      const id = validId(input.id ?? randomUUID())
      const old = getJob(id)
      checkRevision(old, input)
      const changedAt = nextRevision(old)
      const job = { id, stage: 'Saved', evidence: '', interviewAt: null, createdAt: changedAt, caseNotes: '', ...old }
      for (const key of ['company', 'title']) {
        job[key] = text(input[key] ?? job[key], key, { required: true, line: true })
      }
      for (const key of ['description', 'location', 'salary', 'draft', 'resumeText', 'caseNotes']) {
        job[key] = text(input[key] ?? job[key] ?? '', key)
      }
      job.url = webUrl(input.url ?? job.url ?? '')
      job.stage = input.stage ?? job.stage
      if (!stages.includes(job.stage)) throw new Error('Unknown application stage.')
      if (input.interviewAt !== undefined) job.interviewAt = interviewTime(input.interviewAt)
      const reopened = old?.interviewStatus === 'canceled' && old.stage !== 'Interview' && job.stage === 'Interview'
      if (job.interviewAt !== (old?.interviewAt ?? null) || reopened) {
        job.interviewStatus = job.interviewAt ? 'scheduled' : 'pending'
        job.interviewMailAt = changedAt
      }
      const supplied = input.evidence == null ? '' : receipt(input.evidence)
      const fresh = !!supplied && JSON.stringify(supplied) !== JSON.stringify(old?.evidence)
      const transition = job.stage !== (old?.stage ?? 'Saved')
      const submission = getSubmission(id)
      if (transition && ['Saved', 'Preparing'].includes(job.stage) && (submission || ['Interview', 'Offer'].includes(old?.stage))) {
        throw new Error('A verified application or employer outcome cannot return to a draft stage.')
      }
      if (transition && ['Applied', 'Interview', 'Offer', 'Closed'].includes(job.stage) && !fresh) {
        throw new Error('Record new employer evidence for this stage change.')
      }
      if (transition && job.stage === 'Applied' && (submission || ['Interview', 'Offer'].includes(old?.stage))) {
        throw new Error('A later employer outcome cannot be replaced by an application receipt.')
      }
      if (fresh) job.evidence = supplied
      if (old && JSON.stringify(old) === JSON.stringify(job)) return jobView(old)
      job.updatedAt = changedAt
      storeJob(job)
      if (!old || transition || fresh || old.interviewAt !== job.interviewAt) {
        const event = { jobId: id, stage: job.stage, recordedAt: changedAt, evidence: fresh ? supplied : '', interviewAt: job.interviewAt }
        db.prepare('INSERT INTO events(job_id,data) VALUES (?,?)').run(id, JSON.stringify(event))
      }
      if (job.stage === 'Applied' && !submission) {
        const sent = { jobId: id, company: job.company, title: job.title, url: job.url, submittedAt: changedAt, evidence: supplied, draft: job.draft, resumeText: job.resumeText }
        db.prepare('INSERT INTO submissions VALUES (?,?)').run(id, JSON.stringify(sent))
      }
      return jobView(job)
    })
  }

  // Main resolves the provider message and purpose from its account- and role-checked scan cache.
  function recordEmployerUpdate(input) {
    const update = employerUpdate(input)
    const { jobId, key, purpose, evidence, reviewedAt } = update
    return transaction(db, () => {
      const job = getJob(jobId)
      if (!job) throw new Error('The tracked job no longer exists.')
      const result = (recorded, appointmentChanged) => ({
        recorded, duplicate: !recorded, jobId, purpose, stage: job.stage, interviewAt: job.interviewAt ?? null, appointmentChanged,
      })
      const previous = decodeRow(db.prepare("SELECT data FROM events WHERE json_extract(data,'$.employerMessageKey')=?").get(key))
      if (previous) {
        if (previous.jobId !== jobId || previous.purpose !== purpose || previous.reviewedInterviewAt !== reviewedAt) {
          throw new Error('This message was already recorded with different review details.')
        }
        return result(false, false)
      }
      const oldAt = job.interviewAt
      const oldStatus = job.interviewStatus
      const changedAt = nextRevision(job)
      if (purpose === 'receipt') {
        if (!getSubmission(jobId)) {
          // A receipt identifies the role. Only the employer or user can establish which materials were sent.
          const sent = { jobId, company: job.company, title: job.title, url: job.url, submittedAt: evidence.receivedAt,
            evidence, draft: '', resumeText: '' }
          db.prepare('INSERT INTO submissions(job_id,data) VALUES (?,?)').run(jobId, JSON.stringify(sent))
        }
        if (job.stage === 'Saved' || job.stage === 'Preparing') {
          job.stage = 'Applied'
          job.evidence = evidence
        }
      } else {
        let lastConfirmation = job.interviewMailAt
        if (!lastConfirmation && job.interviewAt) {
          // Older workspaces recorded manual appointments in history before the mail watermark existed.
          const last = history(jobId).findLast(event => !event.purpose && sameSlot(event.interviewAt, job.interviewAt) &&
            recordDate(event.recordedAt)?.instant)
          if (last) lastConfirmation = new Date(last.recordedAt).toISOString()
        }
        applyInterviewMail(job, update, changedAt, lastConfirmation)
      }
      const appointmentChanged = oldAt !== job.interviewAt || oldStatus !== job.interviewStatus
      job.updatedAt = changedAt
      storeJob(job)
      const event = {
        jobId, stage: purpose === 'receipt' ? 'Applied' : 'Interview', purpose, employerMessageKey: key,
        evidence, recordedAt: evidence.receivedAt, appointmentChanged, reviewedInterviewAt: reviewedAt,
        interviewAt: purpose === 'interview-canceled' ? null : reviewedAt,
      }
      db.prepare('INSERT INTO events(job_id,data) VALUES (?,?)').run(jobId, JSON.stringify(event))
      return result(true, appointmentChanged)
    })
  }

  function storeNote(input) {
    object(input, 'note')
    const id = validId(input.id ?? randomUUID())
    const old = getNote(id)
    checkRevision(old, input)
    const title = text(input.title ?? old?.title, 'note title', { required: true, line: true })
    const body = text(input.body ?? old?.body ?? '', 'note body')
    const jobId = input.jobId === undefined ? old?.jobId ?? null : input.jobId || null
    if (jobId && !getJob(validId(jobId))) throw new Error('The linked job does not exist in this workspace.')
    if (old && old.title === title && old.body === body && old.jobId === jobId) return old
    const updatedAt = nextRevision(old)
    const note = { id, title, body, jobId, createdAt: old?.createdAt ?? updatedAt, updatedAt }
    db.prepare('INSERT INTO notes VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET job_id=excluded.job_id,data=excluded.data')
      .run(id, jobId, JSON.stringify(note))
    return note
  }

  function snapshot() {
    const submissions = new Map(db.prepare('SELECT job_id, data FROM submissions').all().map(r => [r.job_id, decodeRow(r)]))
    const events = new Map()
    for (const row of db.prepare('SELECT job_id, data FROM events ORDER BY seq').all()) {
      if (!events.has(row.job_id)) events.set(row.job_id, [])
      events.get(row.job_id).push(decodeRow(row))
    }
    const jobs = db.prepare('SELECT data FROM jobs').all().map(decodeRow)
      .map(job => ({ ...job, submittedSnapshot: submissions.get(job.id) ?? null, history: events.get(job.id) ?? [] })).sort(byRecent)
    const notes = db.prepare('SELECT data FROM notes').all().map(decodeRow).sort(byRecent)
    const evidence = jobs.flatMap(job => job.history.filter(e => e.evidence).map(e => ({ ...e, company: job.company, title: job.title })))
      .sort((a, b) => compareRecordDates(recordDate(a.recordedAt), recordDate(b.recordedAt), -1))
    const interviews = upcomingInterviews(jobs)
      .map(({ id: jobId, company, title, interviewAt }) => ({ jobId, company, title, interviewAt }))
    return { profile: setting('profile'), features: getFeatures(), jobs, notes, schedule: { ...defaults, ...setting('schedule') }, evidence, upcomingInterviews: interviews }
  }

  function sync(directory, mode) {
    const root = vaultRoot(directory, mode)
    const report = { written: 0, imported: 0, unchanged: 0, preserved: [], conflicts: [] }
    if (!root) return report
    return transaction(db, () => {
      const files = findManaged(root, report)
      const state = snapshot()
      const records = new Map()
      for (const j of state.jobs) records.set('job/' + j.id, jobPage(j))
      for (const n of state.notes) records.set('note/' + n.id, notePage(n))
      const keys = mode === 'export' ? new Set([...records.keys(), ...files.keys()]) : files.keys()
      for (const key of keys) {
        const [kind, id] = key.split('/')
        const local = records.get(key)
        const matches = files.get(key) ?? []
        const ambiguous = matches.length > 1
        const file = matches[0]
        const prior = decodeRow(db.prepare('SELECT data FROM vault_sync WHERE vault=? AND kind=? AND id=?').get(root, kind, id))
        const path = file?.path ?? (local && join(root, defaultFilename(kind, id, local.title)))
        const issue = reason => ({ kind, id, path: file?.path ?? path, reason })
        const remember = page => db.prepare('INSERT INTO vault_sync VALUES (?,?,?,?) ON CONFLICT(vault,kind,id) DO UPDATE SET data=excluded.data')
          .run(root, kind, id, JSON.stringify({ content: pageHash(page), generated: page.generated == null ? null : hash(page.generated) }))
        if (ambiguous) {
          report.conflicts.push({ ...issue('Multiple files use this managed ID.'), paths: matches.map(f => f.path) })
          continue
        }
        if (file?.error) { report.conflicts.push(issue(file.error)); continue }
        if (!file && prior) { report.preserved.push(issue('Previously exported file is missing or moved outside the managed folder.')); continue }
        const disk = file?.page
        if (disk?.generated != null && hash(disk.generated) !== prior?.generated && disk.generated !== local?.generated) {
          report.conflicts.push(issue('The generated case record changed in the vault. Restore its generated section to sync; the text below it is editable.'))
          continue
        }
        if (!local && (mode === 'export' || kind !== 'note')) {
          report.preserved.push(issue('This managed file has no matching workspace record.')); continue
        }
        const remoteHash = disk && pageHash(disk)
        const localHash = local && pageHash(local)
        const equal = localHash === remoteHash
        if (disk && !equal && local && remoteHash !== prior?.content && localHash !== prior?.content) {
          report.conflicts.push(issue('Both copies changed or have no common baseline. Merge the note in either place and make both copies agree.'))
          continue
        }
        if (mode === 'import') {
          if (!equal && (remoteHash !== prior?.content || !local)) {
            if (kind === 'note') {
              if (disk.jobId && !getJob(disk.jobId)) { report.conflicts.push(issue('The linked job is missing.')); continue }
              storeNote({ id, title: disk.title, body: disk.body, jobId: disk.jobId })
            } else {
              const job = getJob(id)
              storeJob({ ...job, caseNotes: disk.body, updatedAt: nextRevision(job) })
            }
            report.imported++
          } else report.unchanged++
          remember(disk)
          continue
        }
        if (disk && !equal && remoteHash !== prior?.content) {
          report.preserved.push(issue('This vault edit is ready to import.')); continue
        }
        if (equal && disk.generated === local.generated) {
          remember(local); report.unchanged++; continue
        }
        if (!writePage(path, renderPage(kind, id, local, file?.header), file?.raw)) {
          report.conflicts.push(issue('The destination already exists or changed during export.')); continue
        }
        remember(local)
        report.written++
      }
      return report
    })
  }

  // SQLite changes this value on a connection when a different connection commits.
  const revisionQuery = db.prepare('PRAGMA data_version')
  const dataVersion = () => revisionQuery.get().data_version
  return {
    dataVersion,
    importKitJobs: (source, rows, meetings) => transaction(db, () => importKitTracker(db, source, rows, meetings)),
    snapshot: ({ includeVersion = false } = {}) => transaction(db, () => {
      const state = snapshot()
      if (includeVersion) state.dataVersion = dataVersion()
      return state
    }, false),
    saveJob,
    recordEmployerUpdate,
    saveNote: input => transaction(db, () => storeNote(input)),
    saveProfile: input => transaction(db, () => set('profile', { ...setting('profile'), ...object(input, 'profile') })),
    getFeatures,
    saveFeature: ({ key, enabled }) => transaction(db, () => {
      if (!Object.hasOwn(featureNames, key) || typeof enabled !== 'boolean') throw new Error('Invalid workflow preference.')
      return set('optionalWorkflows', { ...getFeatures(), [key]: enabled })
    }),
    getProfile: () => setting('profile'),
    saveReviewedProfile: ({ changes, expected }) => transaction(db, () => {
      object(changes, 'profile changes')
      object(expected, 'original profile values')
      const profile = setting('profile') || {}
      for (const [key, next] of Object.entries(changes)) {
        if (!Object.hasOwn(expected, key)) throw new Error('Missing original profile value.')
        if (!isDeepStrictEqual(profile[key] ?? null, expected[key]) && !isDeepStrictEqual(profile[key], next)) {
          throw new Error('This profile changed while you were editing. Reopen the editor to review the latest version.')
        }
      }
      return set('profile', { ...profile, ...changes })
    }),
    saveSchedule: input => transaction(db, () => {
      object(input, 'schedule')
      const result = { ...defaults, ...setting('schedule') }
      for (const k of Object.keys(defaults)) if (input[k] !== undefined) result[k] = input[k]
      if (typeof result.enabled !== 'boolean' || !Number.isInteger(result.hour) || result.hour < 0 || result.hour > 23 ||
          !Number.isInteger(result.minute) || result.minute < 0 || result.minute > 59) throw new Error('Invalid schedule time or enabled setting.')
      text(result.query, 'schedule query')
      if (result.lastRunDate === '') result.lastRunDate = null
      if (result.lastRunDate != null && !validDay(result.lastRunDate)) throw new Error('Use YYYY-MM-DD for the last run date.')
      return set('schedule', result)
    }),
    exportVault: directory => sync(directory, 'export'),
    importVault: directory => sync(directory, 'import'),
    close: () => db.close(),
  }
}

function byRecent(a, b) {
  return b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)
}

function notePage({ title, body, jobId }) { return { title, body, jobId } }
function pageHash(page) {
  // Case headings and receipts have a separate protected digest.
  const body = page.body.replaceAll('\r\n', '\n')
  return hash(JSON.stringify(page.generated == null ? [page.title, body, page.jobId] : [body]))
}

function evidenceText(e) {
  return typeof e === 'string' ? e : Object.entries(e).map(([key, value]) => `${key}: ${value}`).join('\n')
}

function jobPage(job) {
  const title = `${job.company} · ${job.title}`
  const lines = ['# ' + title, '', 'Stage: ' + job.stage]
  for (const [label, value] of [['Posting', job.url], ['Location', job.location], ['Salary', job.salary], ['Interview', job.interviewAt]]) {
    if (value) lines.push(label + ': ' + value)
  }
  if (job.history.some(e => e.evidence)) {
    lines.push('', '## Employer evidence', '')
    for (const e of job.history.filter(e => e.evidence)) lines.push(`- ${e.recordedAt} · ${e.stage}\n` + evidenceText(e.evidence))
  }
  const sent = job.submittedSnapshot
  if (sent) {
    lines.push('', '## Submitted materials', '', 'Recorded: ' + sent.submittedAt)
    for (const [label, value] of [['Résumé', sent.resumeText], ['Application draft', sent.draft]]) {
      lines.push('', '### ' + label, '', value || 'No text was recorded.')
    }
  }
  lines.push('', '## Case notes', '', 'Edit the Markdown below the record marker.')
  return { title, body: job.caseNotes, generated: lines.join('\n').replaceAll('\r\n', '\n').replaceAll(endCase, '&lt;!-- end:pluto-record --&gt;') }
}

function vaultRoot(directory, mode) {
  const vault = realpathSync(directory)
  if (!lstatSync(vault).isDirectory()) throw new Error('Choose an Obsidian vault directory.')
  const current = join(vault, 'Project Pluto')
  const previous = join(vault, 'PROJECT PLUTO')
  const existing = name => lstatSync(name, { throwIfNoEntry: false })
  const root = !existing(current) && existing(previous) ? previous : current
  if (mode === 'export') {
    try { mkdirSync(root, { mode: 0o700 }) } catch (err) { if (err.code !== 'EEXIST') throw err }
  }
  let stat
  try { stat = lstatSync(root) } catch (err) { if (err.code === 'ENOENT' && mode === 'import') return null; throw err }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('The managed vault folder must be a real directory.')
  return root
}

function defaultFilename(kind, id, title) {
  let readable = title.replace(/[^\p{L}\p{N} _-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 64)
  while (Buffer.byteLength(readable) > 100) readable = [...readable].slice(0, -1).join('')
  return `${kind === 'job' ? 'Case' : 'Note'} - ${readable || kind} - ${id}.md`
}

function renderPage(kind, id, page, header) {
  let meta = header ?? `pluto-type: ${kind}\npluto-id: ${id}`
  if (kind === 'note') {
    meta = meta.split('\n').filter(line => !/^pluto-job:/.test(line)).join('\n')
    if (page.jobId) meta += '\npluto-job: ' + page.jobId
  }
  const content = kind === 'note' ? '# ' + page.title : page.generated + '\n' + endCase
  return `---\n${meta}\n---\n${content}\n\n${page.body}`
}

function parseFile(raw, path) {
  const data = raw.replace(/^\uFEFF/, '').replaceAll('\r\n', '\n')
  const head = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(data)
  if (!head) return null
  const field = name => [...head[1].matchAll(new RegExp('^' + name + ':[ \\t]*(.*?)[ \\t]*$', 'gm'))].map(m => m[1])
  const kinds = field('pluto-type'), ids = field('pluto-id'), jobs = field('pluto-job')
  if (!kinds.length && !ids.length) return null
  if (kinds.length !== 1 || !['note', 'job'].includes(kinds[0]) || ids.length !== 1 || !idPattern.test(ids[0])) {
    return { path, error: 'Invalid managed ID or file type.' }
  }
  const result = { kind: kinds[0], id: ids[0], path, raw, header: head[1] }
  const rest = data.slice(head[0].length)
  if (result.kind === 'note') {
    const title = /^# ([^\n]+)(?:\n\n|\n|$)/.exec(rest)
    const body = title && rest.slice(title[0].length)
    if (!title || !title[1].trim() || title[1].length > maxText || /[\0\r]/.test(title[1]) ||
        jobs.length > 1 || (jobs.length && !idPattern.test(jobs[0])) || body.length > maxText || body.includes('\0')) {
      return { ...result, error: 'The note needs a valid heading, relationship and Markdown body.' }
    }
    result.page = { title: title[1].trim(), body, jobId: jobs[0] ?? null }
  } else {
    const boundary = '\n' + endCase + '\n\n'
    const at = rest.indexOf(boundary)
    if (at < 0) return { ...result, error: 'The case record marker is missing.' }
    const body = rest.slice(at + boundary.length)
    if (body.length > maxText || body.includes('\0')) return { ...result, error: 'Case notes must contain supported Markdown text.' }
    result.page = { generated: rest.slice(0, at), body }
  }
  return result
}

function findManaged(root, report) {
  const files = new Map()
  function visit(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue
      if (entry.isDirectory()) { visit(path); continue }
      if (!entry.isFile() || !/\.md$/i.test(entry.name)) continue
      if (lstatSync(path).size > 24_000_000) { report.preserved.push({ path, reason: 'File is too large to sync.' }); continue }
      const file = parseFile(readFileSync(path, 'utf8'), path)
      if (!file) continue
      if (!file.id) { report.conflicts.push({ path, reason: file.error }); continue }
      const key = file.kind + '/' + file.id
      if (!files.has(key)) files.set(key, [])
      files.get(key).push(file)
    }
  }
  visit(root)
  return files
}

function writePage(path, content, expected) {
  // Create beside the destination so installation is atomic on the same volume.
  const temp = join(dirname(path), '.pluto-' + randomUUID() + '.tmp')
  const fd = openSync(temp, 'wx', 0o600)
  try {
    try { writeFileSync(fd, content, 'utf8'); fsyncSync(fd) } finally { closeSync(fd) }
    if (expected === undefined) {
      try {
        linkSync(temp, path)
      } catch (err) {
        if (err.code === 'EEXIST') return false
        if (!['EPERM', 'EOPNOTSUPP', 'ENOTSUP', 'ENOSYS'].includes(err.code)) throw err
        // Removable and network volumes can lack hard links. Keep exclusive creation there too.
        try { copyFileSync(temp, path, constants.COPYFILE_EXCL) }
        catch (copyError) { if (copyError.code === 'EEXIST') return false; throw copyError }
      }
    } else {
      const st = lstatSync(path, { throwIfNoEntry: false })
      if (!st?.isFile() || readFileSync(path, 'utf8') !== expected) return false
      renameSync(temp, path)
    }
    return true
  } finally { rmSync(temp, { force: true }) }
}
