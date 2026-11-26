import { createHash } from 'node:crypto'
import { recordDate } from './record-dates.mjs'

const stages = {
  Discovered: 'Saved', Shortlisted: 'Saved', Preparing: 'Preparing', Ready: 'Preparing',
  Submitting: 'Preparing', 'Submission uncertain': 'Preparing', Submitted: 'Applied',
  Interview: 'Interview', Assessment: 'Interview', Offer: 'Offer', Rejected: 'Closed',
  Withdrawn: 'Closed', Closed: 'Closed',
}
const string = value => typeof value === 'string' ? value.trim() : ''
const digest = value => createHash('sha256').update(value).digest('hex')
function identityUrl(url) {
  try {
    const u = new URL(url)
    if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password) return ''
    u.hash = ''
    for (const key of [...u.searchParams.keys()]) if (key.startsWith('utm_')) u.searchParams.delete(key)
    u.searchParams.sort()
    return u.href
  } catch { return '' }
}

function role(row) {
  const company = string(row.company), title = string(row.role), url = identityUrl(row.url)
  if (!company || !title || !url || !Object.hasOwn(stages, row.status)) throw new Error('A kit role has an incomplete employer, title, link or status.')
  const evidence = string(row.evidence)
  const submittedAt = recordDate(row.submitted_at) ? row.submitted_at : ''
  // jobkit.py sets submitted_at only on its evidenced Submitted transition.
  // Later transitions replace evidence, so never use rejection or meeting text as a receipt.
  const submitted = row.status === 'Submitted' ? Boolean(evidence) : Boolean(submittedAt)
  let stage = stages[row.status]
  if ((stage === 'Applied' && !submitted) || (['Offer','Interview','Closed'].includes(stage) && !evidence)) stage = submitted ? 'Applied' : 'Preparing'
  const receipt = !submitted ? null : {
    submittedAt, evidence: row.status === 'Submitted' ? { source: 'Job Kit', text: evidence } :
      { source: 'Job Kit', reference: 'Recorded submission date in the private tracker: ' + submittedAt },
    title, company, url, draft: '', resumeText: '',
  }
  return { fields: { company, title, url, location: string(row.location), stage, caseNotes: string(row.next_action) },
    evidence, receipt }
}

function trackerRows(jobs, meetings) {
  const label = item => JSON.stringify([string(item.company).toLowerCase(), string(item.role).toLowerCase()])
  const exact = new Map()
  const byId = new Map(jobs.map(job => [job.id, job]))
  const linked = new Map()
  const extra = []
  for (const job of jobs) exact.set(label(job), exact.has(label(job)) ? null : job)
  for (const meeting of meetings) {
    if (!string(meeting.company) || !string(meeting.role)) continue
    const job = meeting.job_id ? byId.get(meeting.job_id) : exact.get(label(meeting))
    if (!job) {
      extra.push({ row: { ...meeting, id: 'meeting/' + meeting.id }, meetings: [meeting], standalone: true })
      continue
    }
    if (!linked.has(job.id)) linked.set(job.id, [])
    linked.get(job.id).push(meeting)
  }
  return jobs.map(row => ({ row, meetings: linked.get(row.id) ?? [] })).concat(extra)
}

function appointment(meetings) {
  const starts = meetings.filter(m => m.status === 'Scheduled' && recordDate(m.start))
    .map(m => m.start).sort((a, b) => Date.parse(a) - Date.parse(b))
  return starts.find(t => Date.parse(t) >= Date.now()) || starts.at(-1) || null
}

// Called only by the trusted folder importer, inside one workspace transaction.
export function importKitTracker(db, source, rows, meetings = []) {
  const report = { inserted: 0, updated: 0, unchanged: 0, preserved: 0, receipts: 0 }
  const records = db.prepare('SELECT id,data FROM jobs').all().map(row => JSON.parse(row.data))
  const byId = new Map(records.map(row => [row.id,row]))
  const urls = new Set(records.map(row => identityUrl(row.url)).filter(Boolean))
  const upsert = db.prepare('INSERT INTO jobs(id,data) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data')
  const addReceipt = db.prepare('INSERT INTO submissions(job_id,data) VALUES (?,?) ON CONFLICT(job_id) DO NOTHING')
  const addEvent = db.prepare('INSERT INTO events(job_id,data) VALUES (?,?)')
  for (const entry of trackerRows(rows, meetings)) {
    const { row } = entry
    const id = 'kit-' + digest(JSON.stringify([source, row.id])).slice(0,32)
    const at = appointment(entry.meetings)
    const {fields, evidence, receipt} = entry.standalone
      ? { fields: {company:string(row.company),title:string(row.role),url:'',location:'',caseNotes:'',stage:at ? 'Interview' : 'Closed'},
          evidence:'Job Kit interview record: '+string(row.status),receipt:null }
      : role(row)
    fields.interviewAt = at
    if (at && !['Offer','Closed'].includes(fields.stage)) fields.stage = 'Interview'
    const old = byId.get(id)
    if (!old && fields.url && urls.has(fields.url)) { report.preserved++; continue }
    const now = new Date().toISOString()
    const job = old ? {...old} : { id, createdAt: recordDate(row.first_seen) ? row.first_seen : now,
      draft: '', resumeText: '', salary: '', description: '', interviewAt: null }
    const baseline = old?.kitImport?.baseline || {}
    for (const [key, value] of Object.entries({...fields, evidence})) {
      if (!old || job[key] === baseline[key]) job[key] = value
    }
    job.kitImport = { sourceId: row.id, status: row.status, baseline: {...fields, evidence} }
    if (!old || JSON.stringify(old) !== JSON.stringify(job)) {
      job.updatedAt = new Date(Math.max(Date.now(), old ? Date.parse(old.updatedAt) + 1 : 0)).toISOString()
      upsert.run(id, JSON.stringify(job))
      byId.set(id, job)
      urls.add(fields.url)
      if (!old || old.kitImport?.status !== row.status || baseline.evidence !== evidence) {
        addEvent.run(id,JSON.stringify({stage:job.stage,evidence,recordedAt: row.status==='Submitted' && receipt ? receipt.submittedAt : '',
          reason:'Imported Job Kit status: '+row.status}))
      }
      report[old ? 'updated' : 'inserted']++
    } else report.unchanged++
    if (receipt) report.receipts += Number(addReceipt.run(id,JSON.stringify({ jobId:id, ...receipt })).changes)
  }
  return report
}
