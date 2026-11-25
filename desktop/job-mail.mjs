const providers = new Set(['gmail', 'outlook', 'apple'])
const batchSize = 4
const perEmployerLimit = 15
const fields = new Set(['provider', 'scanId', 'jobId', 'offset', 'cancel'])

function words(value) {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}
const contains = (text, phrase) => phrase && (' ' + text + ' ').includes(' ' + phrase + ' ')

function postingReferences(url) {
  try {
    const { pathname, searchParams } = new URL(url)
    const parts = pathname.split('/').flatMap(part => part.split(/[_-]/))
    for (const [key, value] of searchParams) {
      if (/^(?:gh_jid|jobid|job_id|reqid|requisitionid)$/i.test(key)) parts.push(value)
    }
    return parts.filter(part => /^(?:[a-z]{1,4})?\d{5,16}$/i.test(part)).map(words)
  } catch { return [] }
}

const recruiting = /\b(?:your (?:job )?(?:application|candidacy|interview)|thank you for (?:applying|your (?:application|interest))|thanks for applying|application (?:received|confirmation|update|status)|received your (?:résumé|resume)|(?:schedule|scheduling|invitation to|invite you to|invite to|confirm your|upcoming|invited to) (?:an? |the |your )?(?:interview|phone screen|assessment)|interview (?:request|invitation|confirmation|availability|for|with)|offer (?:of employment|letter)|next (?:step|steps) (?:in|for) (?:our|the|your) (?:hiring|interview|application)|move forward with (?:you|other candidates))\b/u
const promotion = /\b(?:job alerts?|jobs? (?:you (?:might|may) like|recommendations?)|recommended (?:jobs|openings)|new (?:job openings|jobs matching|career opportunities)|career newsletter|talent (?:community|network)|similar jobs|interview tips|apply (?:now|today)|start your application|view all jobs|hiring (?:newsletter|digest)|weekly (?:career|jobs?)|update your job preferences)\b/u
const transactional = /\b(?:bank statement|account statement|credit card statement|payment (?:received|due|confirmation)|transaction alert|security (?:alert|code)|verification code|investment newsletter)\b/u
const financialApplication = /\b(?:application for (?:a |an |your )?(?:loan|mortgage|credit card|bank account)|(?:loan|mortgage|credit card) application)\b/u
const beforeTitle = new Set('for regarding re fw fwd about as of the a an your our to opening role position application interview invitation confirmation received status update'.split(' '))
const afterTitle = new Set('at with for role position opening application interview interviews invitation confirmation update status assessment offer next hiring req requisition job id was is has'.split(' '))

function namedRole(text, job) {
  const padded = ' ' + text + ' '
  const needle = ' ' + job.role + ' '
  let at = padded.indexOf(needle)
  while (at !== -1) {
    const before = padded.slice(0, at).split(' ').at(-1)
    const after = padded.slice(at + needle.length).split(' ')[0]
    const begins = !before || beforeTitle.has(before) || before === job.employer.split(' ').at(-1)
    const ends = !after || afterTitle.has(after) || after === job.employer.split(' ')[0] || job.refs.includes(after)
    if (begins && ends) return true
    at = padded.indexOf(needle, at + 1)
  }
  return false
}

function trackedJobs(rows) {
  return rows.filter(job => job.id && typeof job.company === 'string' && job.company.length <= 160 && words(job.company) && words(job.title))
    .map(({ id, company, title, url }) => ({ id, company, title, url, employer: words(company), role: words(title), refs: postingReferences(url) }))
}

function matchJob(message, jobs) {
  const subject = words(message.subject)
  const preview = words(message.preview)
  const content = subject + ' ' + preview
  if (!recruiting.test(content) || promotion.test(content) || transactional.test(subject) || financialApplication.test(content)) return
  const sender = words(message.from)
  const explicitRefs = [...content.matchAll(/\b(?:req(?:uisition)?(?: id| number)?|job id|job number) (?:no )?([a-z]{0,4}\d{5,16})\b/g)].map(m => m[1])
  const candidates = []
  for (const job of jobs) {
    if (![subject, preview, sender].some(field => contains(field, job.employer))) continue
    if (explicitRefs.length && job.refs.length && !job.refs.some(ref => explicitRefs.includes(ref))) continue
    const ref = job.refs.some(id => contains(subject, id) || contains(preview, id))
    if (contains(subject, job.role + ' at') && !contains(subject, job.role + ' at ' + job.employer)) continue
    const inSubject = namedRole(subject, job)
    // A title in a sender's signature alone says nothing about the applicant's role.
    const inPreview = namedRole(preview, job) && (
      new RegExp('\\b' + job.role + ' (?:role|position|opening|application|interview|at)\\b', 'u').test(preview) ||
      new RegExp('\\b(?:for|regarding|as|about) (?:(?:the|our|a|an) )?' + job.role + '\\b', 'u').test(preview))
    if (ref || inSubject || inPreview) candidates.push({ job, ref, inSubject })
  }
  // A requisition identifies otherwise identical roles. Give the subject precedence over incidental preview mentions.
  const exact = candidates.filter(c => c.ref)
  const subjects = candidates.filter(c => c.inSubject)
  const best = exact.length ? exact : subjects.length ? subjects : candidates
  return best.length === 1 ? best[0].job : undefined
}

function publicMessage(message, provider) {
  if (message?.provider !== provider || typeof message.key !== 'string' || !message.key || message.key.length > 256) return
  const clean = (value, max) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : ''
  let url = ''
  try {
    const link = new URL(message.url)
    if (link.protocol === 'https:' && !link.username && !link.password && !link.port &&
        ['mail.google.com', 'outlook.live.com', 'outlook.office.com', 'outlook.office365.com', 'outlook.cloud.microsoft'].includes(link.hostname)) url = link.href
  } catch { /* A local Apple Mail result can have no web link. */ }
  return { provider, key: message.key, from: clean(message.from, 320), subject: clean(message.subject, 500),
    preview: clean(message.preview, 500), account: clean(message.account, 320), receivedAt: clean(message.receivedAt, 40), url }
}

export function createJobMail({ mail, getJobs, timeoutMs = 60_000 }) {
  const active = new Map()

  async function cancel(run) {
    run.cancelled = true
    if (run.reading) await mail.scan({ provider: run.provider, cancel: true })
  }

  async function scan(payload = {}) {
    if (!payload || Object.keys(payload).some(key => !fields.has(key)) || !providers.has(payload.provider) ||
        typeof payload.scanId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(payload.scanId)) throw new Error('Choose a connected mail source and tracked jobs.')
    const { provider, scanId, jobId, offset = 0 } = payload
    const pending = active.get(provider)
    if (payload.cancel === true) {
      if (pending?.id === scanId) await cancel(pending)
      return null
    }
    if (pending) throw new Error('A job mail check is already running for this source.')
    if (!Number.isSafeInteger(offset) || offset < 0 || (jobId !== undefined && (typeof jobId !== 'string' || !jobId))) throw new Error('Invalid job mail selection.')
    const run = { id: scanId, provider, reading: false, cancelled: false, timedOut: false }
    active.set(provider, run)
    const timer = setTimeout(() => { run.timedOut = true; cancel(run).catch(() => {}) }, timeoutMs)
    const check = () => {
      if (run.timedOut) throw new Error('Job mail check timed out. Try again or choose one job.')
      if (run.cancelled) throw new Error('Job mail check cancelled.')
    }
    try {
      const jobs = trackedJobs(await getJobs())
      const scope = jobId ? jobs.filter(job => job.id === jobId) : jobs
      if (jobId && !scope.length) throw new Error('The selected job is no longer available.')
      const employers = [...new Map(scope.map(job => [job.employer, job.company])).entries()]
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      const page = employers.slice(offset, offset + batchSize)
      const messages = new Map()
      if (page.length) {
        check()
        let accounts
        try { accounts = await mail.settings() }
        catch { throw new Error('Couldn’t read mail sources. Check Connections and try again.') }
        if (!accounts.some(account => account.provider === provider && account.email && !account.error)) {
          throw new Error('Connect this mail source in Connections before checking for replies.')
        }
      }
      for (const [employer, company] of page) {
        check()
        run.reading = true
        let rows
        try { rows = await mail.scan({ provider, company }) }
        catch {
          check()
          throw new Error('Couldn’t check this mail source. Check access in Connections and try again.')
        }
        finally { run.reading = false }
        check()
        for (const row of rows.slice(0, perEmployerLimit)) {
          const message = publicMessage(row, provider)
          if (!message) continue
          const job = matchJob(message, jobs)
          if (job?.employer === employer && (!jobId || job.id === jobId)) {
            messages.set(message.key, { jobId: job.id, company: job.company, title: job.title, jobUrl: job.url, message })
          }
        }
      }
      // A job can change while a provider request is in flight. Recheck the match before it crosses IPC.
      const latest = messages.size ? trackedJobs(await getJobs()) : []
      check()
      const matches = [...messages.values()].filter(row => {
        const job = matchJob(row.message, latest)
        return job?.id === row.jobId && job.title === row.title && job.company === row.company && job.url === row.jobUrl
      }).sort((a, b) => b.message.receivedAt.localeCompare(a.message.receivedAt))
      const checked = Math.min(offset + page.length, employers.length)
      return { matches, checked, totalCompanies: employers.length, nextOffset: checked < employers.length ? checked : null }
    } finally {
      clearTimeout(timer)
      active.delete(provider)
    }
  }

  return { scan, close: () => Promise.allSettled([...active.values()].map(cancel)) }
}
