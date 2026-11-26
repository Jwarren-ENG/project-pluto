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

const interview = /\b(?:interview|phone screen|screening call)\b/u
const canceled = /\b(?:cancell?ed|cancellation|called off)\b/u
const rescheduled = /\b(?:rescheduled|has been moved|moved to|new interview time|updated invitation)\b/u
const scheduled = /\b(?:scheduled|confirmed|confirmation|booked|calendar invitation)\b/u
const invite = /\b(?:invitation|invite(?:d)?|availability|available|schedule|scheduling|book a time|choose a time|select a time)\b/u
const conditional = /\b(?:unless|if|not yet|not (?:be |been )?(?:confirmed|scheduled|cancell?ed|rescheduled)|will be scheduled|to be scheduled|cancellation (?:policy|instructions)|(?:cannot|can t|unable to) (?:schedule|confirm))\b/u
const acknowledgment = /\b(?:thank(?:s| you) for (?:applying|(?:submitting )?your application)|(?:received|acknowledge receipt of) your (?:job )?application|(?:job )?application (?:confirmation|receipt|received|submitted)|application (?:was|has been|is now) (?:received|submitted)|successfully (?:applied|submitted your application))\b/u
const otpLanguage = /\b(?:(?:verification|confirmation|authentication|security|access|login|log in|sign in|one time) (?:code|password|passcode|pin)|one time (?:verification|security) code|otp|passcode|verification pin|meeting pin)\b/u
const secretContext = /\b(?:one time|2fa|mfa|two factor|verify your (?:email|identity)|(?:code|pin) (?:is )?(?=[a-z\d]*\d)[a-z\d]{4,10}\b|\d{4,8} (?:is )?your (?:code|pin))\b/u
const financialOrSensitive = /\b(?:banking|bank account|account balance|debit card|credit card|credit limit|wire transfer|funds transfer|transfer funds|payment|transaction|purchase|loan|mortgage|wallet|password reset|reset your password|recover your account)\b/u

function interviewPurpose(value) {
  const text = words(value)
  if (!interview.test(text) || conditional.test(text)) return
  if (canceled.test(text)) return 'interview-canceled'
  if (rescheduled.test(text)) return 'interview-rescheduled'
  if (scheduled.test(text)) return 'interview-scheduled'
  if (invite.test(text) || /^interview (?:for|with) /u.test(text)) return 'interview-invite'
}

function messagePurpose(message) {
  const content = words(message.subject + ' ' + message.preview)
  if (otpLanguage.test(content) || secretContext.test(content) || promotion.test(content) || transactional.test(content) || financialApplication.test(content)) return
  if (/\b(?:other candidates|not (?:been )?(?:selected|moving forward)|(?:won t|will not) be (?:proceeding|moving forward)|offer letter|offer of employment|interview (?:feedback|survey)|application (?:decision|withdrawn|rejected|declined))\b/u.test(content)) return
  // A footer offering to cancel or reschedule does not announce a change.
  const purposes = [message.subject, ...message.preview.split(/[.!?\n]+/)].map(interviewPurpose)
  for (const purpose of ['interview-canceled', 'interview-rescheduled', 'interview-scheduled', 'interview-invite']) {
    if (purposes.includes(purpose)) return purpose
  }
  if (acknowledgment.test(content) && !/\b(?:unfortunately|regret to inform|no longer|unable to proceed|not (?:been )?received|unsuccessful|application update)\b/u.test(content)) return 'receipt'
}
const promotion = /\b(?:job alerts?|jobs? (?:you (?:might|may) like|recommendations?)|recommended (?:jobs|openings)|new (?:job openings|jobs matching|career opportunities)|career newsletter|talent (?:community|network)|similar jobs|interview tips|apply (?:now|today)|start your application|view all jobs|hiring (?:newsletter|digest)|weekly (?:career|jobs?)|update your job preferences)\b/u
const transactional = /\b(?:bank statement|account statement|credit card statement|payment (?:received|due|confirmation)|transaction alert|security (?:alert|code)|verification code|investment newsletter)\b/u
const financialApplication = /\b(?:application for (?:a |an |your )?(?:loan|mortgage|credit card|bank account)|(?:loan|mortgage|credit card) application)\b/u
const beforeTitle = new Set('scheduled canceled cancelled rescheduled for regarding re fw fwd about as of the a an your our to opening role position application interview invitation confirmation received status update'.split(' '))
const afterTitle = new Set('at with for canceled cancelled rescheduled scheduled role position opening application interview interviews invitation confirmation update status assessment offer next hiring req requisition job id was is has'.split(' '))

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
    .map(({ id, company, title, url, stage }) => ({ id, company, title, url, stage, employer: words(company), role: words(title), refs: postingReferences(url) }))
}

function matchJob(message, jobs, { explicitReferencesOnly = false } = {}) {
  const subject = words(message.subject)
  const preview = words(message.preview)
  const content = subject + ' ' + preview
  const sender = words(message.from)
  const explicitRefs = [...content.matchAll(/\b(?:req(?:uisition)?(?: id| number)?|job id|job number) (?:no )?([a-z]{0,4}\d{5,16})\b/g)].map(m => m[1])
  const candidates = []
  for (const job of jobs) {
    if (![subject, preview, sender].some(field => contains(field, job.employer))) continue
    if (explicitRefs.length && (explicitReferencesOnly || job.refs.length) && !job.refs.some(ref => explicitRefs.includes(ref))) continue
    const ref = explicitReferencesOnly
      ? explicitRefs.some(id => job.refs.includes(id))
      : job.refs.some(id => contains(subject, id) || contains(preview, id))
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

const tenMinutes = 10 * 60 * 1000
const atsDomains = [
  ['greenhouse.io'], ['lever.co'], ['ashbyhq.com'], ['smartrecruiters.com'],
  ['myworkdayjobs.com', 'myworkday.com', 'workday.com'], ['icims.com'],
]
const withinDomain = (host, domain) => host === domain || host.endsWith('.' + domain)

function timestamp(value) {
  if (Number.isSafeInteger(value)) return value
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return NaN
  return Date.parse(value)
}

function employerSender(message, job, content) {
  // Only use the mailbox address, never a display name containing the employer.
  const from = message.from.trim()
  const address = /^(?:[^<>,@]*<([^<>]+)>|([^\s<>]+))$/.exec(from)
  const domain = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@([a-z0-9-]+(?:\.[a-z0-9-]+)+)$/i.exec(address?.[1] || address?.[2] || '')?.[1].toLowerCase()
  let posting
  try { posting = new URL(job.url) } catch { return false }
  if (!domain || posting.protocol !== 'https:' || posting.username || posting.password) return false
  const host = posting.hostname
  const ats = atsDomains.find(domains => domains.some(d => withinDomain(host, d)))
  if (ats) return ats.some(d => withinDomain(domain, d)) && contains(content, job.employer)
  // Strip only job-site prefixes. Never broaden to the last two labels (e.g. co.uk).
  const employerHost = host.replace(/^(?:(?:www|jobs|careers|apply|recruiting)\.)+/, '')
  if (!employerHost.includes('.') || /^(?:co|org|com|net|gov|ac)\.[a-z]{2}$/i.test(employerHost)) return false
  return withinDomain(domain, employerHost)
}

const portalSubjectWords = new Set('a access account applicant application applying at authentication candidate career careers code confirm confirmation email for here identity in is job log login one otp passcode password pin please portal recruiting recruitment security sign site the time to use verification verify your'.split(' '))

function applicationCode(message, job, jobs) {
  const raw = message.subject + ' ' + message.preview
  const content = words(raw)
  if (/^\s*(?:fw|fwd):/i.test(message.subject) || !otpLanguage.test(content) || financialOrSensitive.test(content) || financialApplication.test(content) ||
      !/\b(?:candidate|applicant|job application|application portal|careers portal|career site|applying|recruitment)\b/u.test(content) ||
      !employerSender(message, job, content)) return

  // Require an explicitly labelled token. A requisition, date or number elsewhere in the mail is insufficient.
  const candidates = new Set()
  const after = /\b(?:code|passcode|pin|otp|one[ -]time password)\b(?:\s+is)?[\s:#=–—-]*([a-z\d]{4,10})(?![\w-])/gi
  const before = /(?<![\w-])([a-z\d]{4,10})\s+(?:is\s+)?(?:your|the)\s+(?:(?:verification|security|one[ -]time|sign[ -]in|authentication)\s+)?(?:code|passcode|otp|pin)\b/gi
  for (const pattern of [after, before]) {
    for (const hit of raw.matchAll(pattern)) {
      if (/\d/.test(hit[1])) candidates.add(hit[1])
    }
  }
  if (candidates.size !== 1) return
  const [code] = candidates
  // OTP digits can coincide with a job ID. Only a labelled requisition can identify a role here.
  const target = matchJob(message, jobs, { explicitReferencesOnly: true })
  if (target) return target.id === job.id ? code : undefined
  // Accept a generic portal notice only when it cannot select between two tracked roles.
  const subject = (' ' + words(message.subject) + ' ').replaceAll(' ' + job.employer + ' ', ' ').trim()
  if (jobs.filter(other => other.employer === job.employer && other.stage !== 'Closed').length !== 1 ||
      subject.split(' ').some(word => word !== code.toLowerCase() && !portalSubjectWords.has(word)) ||
      /\b(?:req(?:uisition)?|job (?:id|number)|role|position|(?:application|applying) for)\b/u.test(content)) return
  return code
}

export function createJobMail({ mail, getJobs, timeoutMs = 60_000, now = Date.now }) {
  const active = new Map()

  async function cancel(run) {
    run.cancelled = true
    if (run.reading) await mail.scan({ provider: run.provider, cancel: true })
  }

  async function withSource(provider, id, operation) {
    if (active.has(provider)) throw new Error('A job mail check is already running for this source.')
    const run = { id, provider, reading: false, cancelled: false, timedOut: false }
    active.set(provider, run)
    const timer = setTimeout(() => { run.timedOut = true; cancel(run).catch(() => {}) }, timeoutMs)
    const check = () => {
      if (run.timedOut) throw new Error('Job mail check timed out. Try again or choose one job.')
      if (run.cancelled) throw new Error('Job mail check cancelled.')
    }
    async function connected() {
      check()
      let accounts
      try { accounts = await mail.settings() }
      catch { throw new Error('Couldn’t read mail sources. Check Connections and try again.') }
      check()
      const account = accounts.find(account => account.provider === provider && account.email && !account.error)
      if (!account) {
        throw new Error('Connect this mail source in Connections before checking for replies.')
      }
      return account.email
    }
    async function read(company) {
      check()
      run.reading = true
      try {
        const rows = await mail.scan({ provider, company })
        check()
        return rows.slice(0, perEmployerLimit)
      } catch {
        check()
        throw new Error('Couldn’t check this mail source. Check access in Connections and try again.')
      } finally { run.reading = false }
    }
    try {
      const result = await operation({ connected, read, check })
      check()
      return result
    } finally {
      clearTimeout(timer)
      active.delete(provider)
    }
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
    if (!Number.isSafeInteger(offset) || offset < 0 || (jobId !== undefined && (typeof jobId !== 'string' || !jobId))) throw new Error('Invalid job mail selection.')
    return withSource(provider, scanId, async ({ connected, read, check }) => {
      const jobs = trackedJobs(await getJobs())
      const scope = jobId ? jobs.filter(job => job.id === jobId) : jobs
      if (jobId && !scope.length) throw new Error('The selected job is no longer available.')
      const employers = [...new Map(scope.map(job => [job.employer, job.company])).entries()]
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      const page = employers.slice(offset, offset + batchSize)
      const messages = new Map()
      const mailbox = page.length ? await connected() : null
      for (const [employer, company] of page) {
        const rows = await read(company)
        for (const row of rows) {
          const message = publicMessage(row, provider)
          if (!message || message.account !== mailbox) continue
          const purpose = messagePurpose(message)
          if (!purpose) continue
          const job = matchJob(message, jobs)
          if (job?.employer === employer && (!jobId || job.id === jobId)) {
            messages.set(message.key, { jobId: job.id, company: job.company, title: job.title, jobUrl: job.url, message, purpose })
          }
        }
      }
      if (mailbox && await connected() !== mailbox) throw new Error('The mailbox changed. Check again.')
      // A job can change while a provider request is in flight. Recheck the match before it crosses IPC.
      const latest = messages.size ? trackedJobs(await getJobs()) : []
      check()
      const matches = [...messages.values()].filter(row => {
        const job = matchJob(row.message, latest)
        return job?.id === row.jobId && job.title === row.title && job.company === row.company && job.url === row.jobUrl
      }).sort((a, b) => b.message.receivedAt.localeCompare(a.message.receivedAt))
      const checked = Math.min(offset + page.length, employers.length)
      return { matches, checked, totalCompanies: employers.length, nextOffset: checked < employers.length ? checked : null }
    })
  }

  async function verificationCode(payload = {}) {
    if (!payload || Object.keys(payload).some(key => !['provider', 'jobId', 'requestedAt'].includes(key)) ||
        !providers.has(payload.provider) || typeof payload.jobId !== 'string' || !payload.jobId) {
      throw new Error('Choose one tracked job and a connected mail source.')
    }
    const { provider, jobId } = payload
    const requested = timestamp(payload.requestedAt)
    const freshRequest = time => Number.isFinite(requested) && requested <= time && requested >= time - tenMinutes
    if (!freshRequest(now())) return { code: null }
    return withSource(provider, Symbol('verification'), async ({ connected, read }) => {
      const jobs = trackedJobs(await getJobs())
      const job = jobs.find(row => row.id === jobId && row.stage !== 'Closed')
      if (!job) return { code: null }
      const mailbox = await connected()
      const rows = await read(job.company)
      if (await connected() !== mailbox) return { code: null }
      const latest = trackedJobs(await getJobs())
      const current = latest.find(row => row.id === job.id)
      const time = now()
      if (!freshRequest(time) || !current || current.stage === 'Closed' || current.company !== job.company ||
          current.url !== job.url || current.title !== job.title) return { code: null }
      const found = []
      for (const row of rows) {
        const message = publicMessage(row, provider)
        if (!message || message.account !== mailbox) continue
        const received = timestamp(message.receivedAt)
        if (!Number.isFinite(received) || received < time - tenMinutes || received > time) continue
        const code = applicationCode(message, current, latest)
        if (code) found.push({ code, received, receivedAt: message.receivedAt })
      }
      found.sort((a, b) => b.received - a.received)
      const newest = found[0]
      if (!newest || found.some(match => match.received === newest.received && match.code !== newest.code)) return { code: null }
      return { code: newest.code, receivedAt: newest.receivedAt }
    })
  }

  return { scan, verificationCode, close: () => Promise.allSettled([...active.values()].map(cancel)) }
}
