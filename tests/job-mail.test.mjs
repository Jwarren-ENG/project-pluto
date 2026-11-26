import test from 'node:test'
import assert from 'node:assert/strict'
import { createJobMail } from '../desktop/job-mail.mjs'

const first = { id: 'one', company: 'Example Bank', title: 'Product Analyst', url: 'https://example.test/jobs/R12345' }
const second = { ...first, id: 'two', title: 'Product Manager', url: 'https://example.test/jobs/R23456' }
const account = { gmail: 'inbox@example.test', apple: 'Apple Mail on this Mac', outlook: 'outlook@example.test' }
const reply = (key, subject, preview = '', from = 'Careers at Example Bank') =>
  ({ key, from, subject, preview, receivedAt: '2026-01-01T12:00:00Z', body: 'never return a full body', attachments: ['private'] })

function fixture(jobs, rows, options = {}) {
  const calls = []
  const mail = {
    settings: () => Object.entries(account).map(([provider, email]) => ({ provider, email })),
    scan: async payload => {
      calls.push(payload)
      return rows.map(row => ({ provider: payload.provider, account: account[payload.provider], ...row }))
    },
    ...options.mail,
  }
  return { service: createJobMail({ mail, getJobs: () => jobs, ...options }), calls, mail }
}
const request = { provider: 'gmail', scanId: 'fixture-scan' }

test('only returns employer and role specific recruiting evidence, before IPC serialization', async () => {
  const row = reply('interview', 'Interview invitation for Product Analyst at Example Bank')
  const messages = [
    row, row,
    reply('receipt', 'Application confirmation', 'Thank you for applying for the Product Analyst position at Example Bank.'),
    reply('ref', 'Update on your application · requisition R12345'),
    reply('wrong', 'Your application for Software Engineer'),
    reply('senior', 'Your application for Senior Product Analyst'),
    reply('level', 'Your application for Product Analyst II'),
    reply('alert', 'Job alert for Product Analyst', 'Your application profile has two recommended jobs.'),
    reply('marketing', 'Product Analyst interview tips', 'Your interview matters. Apply today.'),
    reply('bank', 'Bank statement for Product Analyst', 'We received your application.'),
    reply('card', 'Your application', 'Your credit card application is approved. From your Product Analyst at Example Bank.'),
    reply('signature', 'Your application update', 'We received your application for Designer. Best, Sample Person, Product Analyst.'),
    reply('other', 'Your application for Product Analyst at Another Company', '', 'Recruiter at Another Company'),
    reply('generic', 'Your application was received', 'Thank you for applying.'),
    reply('reused-title', 'Your application for Product Analyst', 'Req R99999'),
    reply('other-job', 'Your application for Product Manager at Example Bank'),
    reply('extra', 'Your application for Product Analyst'), // outside the adapter page limit
  ]
  const { service, calls } = fixture([first, second], messages)
  const result = await service.scan({ ...request, jobId: first.id })
  assert.deepEqual(result.matches.map(row => row.message.key), ['interview', 'receipt'])
  assert.deepEqual(result.matches.map(row => row.jobId), [first.id, first.id])
  assert.deepEqual(result.matches.map(row => row.purpose), ['interview-invite', 'receipt'])
  assert.deepEqual(calls, [{ provider: 'gmail', company: 'Example Bank' }])
  assert.equal(result.nextOffset, null)
  assert.equal(result.checked, 1)
  assert.doesNotMatch(JSON.stringify(result), /attachments|never return|R99999|credit card|your Product Manager/)
})

test('resolves role ambiguity only with identifying evidence, including for a single-job scan', async () => {
  const same = { ...first, id: 'similar', url: 'https://example.test/apply?gh_jid=778899' }
  const messages = [reply('ambiguous', 'Application received for Product Analyst'),
    reply('exact', 'Application received for Product Analyst · job ID 778899'),
    reply('different-role', 'Application received for Product Manager')]
  const { service } = fixture([first, same, second], messages)
  const all = await service.scan(request)
  assert.deepEqual(all.matches.map(m => [m.jobId, m.message.key]), [['similar', 'exact'], ['two', 'different-role']])
  assert.deepEqual((await service.scan({ ...request, jobId: 'one' })).matches, [])
})

test('a title fragment, sender signature, different named employer or invitation to apply is insufficient', async () => {
  const { service } = fixture([first, { ...second, id: 'generic', title: 'Engineer' }], [
    reply('specialty', 'Your application for Product Analyst, Growth'),
    reply('specific', 'Your application for Mechanical Engineer'),
    reply('promotion', 'Product Analyst at Example Bank', 'Start your application for our new career opportunities.'),
    reply('different', 'Interview invitation for Product Analyst at Another Bank'),
    reply('signature', 'Your application', 'Your application is under review. Signed by our Product Analyst.'),
  ])
  assert.deepEqual((await service.scan(request)).matches, [])
})

test('all jobs are covered in bounded employer batches and every query comes from the saved workspace', async () => {
  const jobs = Array.from({ length: 7 }, (_, i) => ({ ...first, company: 'Example ' + i, id: String(i) }))
  jobs.push({ ...jobs[1], id: 'also-one', title: 'Another Role' })
  const { service, calls } = fixture(jobs, [])
  const one = await service.scan(request)
  assert.deepEqual(one, { matches: [], checked: 4, totalCompanies: 7, nextOffset: 4 })
  const two = await service.scan({ ...request, offset: one.nextOffset })
  assert.equal(two.nextOffset, null)
  assert.equal(two.checked, 7)
  assert.deepEqual(calls.map(c => c.company), jobs.slice(0, 7).map(j => j.company))
  for (const input of [{ company: 'private' }, { query: '*' }, { jobId: 'unknown' }, { offset: -1 }, { provider: 'other' }]) {
    await assert.rejects(service.scan({ ...request, ...input }))
  }
  assert.equal(calls.length, 7)
  const empty = fixture([], [])
  assert.deepEqual((await empty.service.scan(request)).matches, [])
  assert.deepEqual(empty.calls, [])
})

test('Apple Mail local identity and Outlook use the same constrained service', async () => {
  for (const provider of ['apple', 'outlook']) {
    const { service, calls } = fixture([first], [reply('match', 'Interview invitation for Product Analyst')])
    const { matches } = await service.scan({ ...request, provider })
    assert.equal(matches[0].message.account, account[provider])
    assert.deepEqual(calls, [{ provider, company: first.company }])
  }
  const { service } = fixture([first], [], { mail: { settings: () => [] } })
  await assert.rejects(service.scan({ ...request, provider: 'apple' }), /Connect this mail source/)
})

test('revalidates against current workspace roles before releasing a result', async () => {
  let jobs = [first]
  const { service } = fixture(jobs, [], { getJobs: () => jobs, mail: {
    settings: () => [{ provider: 'gmail', email: account.gmail }],
    scan: async () => {
      jobs = [{ ...first, title: 'Different Role' }]
      return [{ ...reply('old', 'Application received for Product Analyst'), provider: 'gmail' }]
    },
  } })
  assert.deepEqual((await service.scan(request)).matches, [])
})

test('only the owner can cancel an active batch and cancellation stops subsequent reads', async () => {
  const entered = Promise.withResolvers(), delayed = Promise.withResolvers()
  const calls = []
  const { service } = fixture([first, { ...first, company: 'Zebra', id: 'z' }], [], { mail: {
    settings: () => [{ provider: 'gmail', email: account.gmail }],
    scan: async payload => {
      calls.push(payload)
      if (payload.cancel) { delayed.resolve([]); return }
      entered.resolve()
      return delayed.promise
    },
  } })
  const result = service.scan(request)
  await entered.promise
  await service.scan({ ...request, scanId: 'stale', cancel: true })
  await assert.rejects(service.scan({ ...request, scanId: 'other' }), /already running/)
  await service.scan({ ...request, cancel: true })
  await assert.rejects(result, /cancelled/)
  assert.deepEqual(calls, [{ provider: 'gmail', company: first.company }, { provider: 'gmail', cancel: true }])
})

test('batch deadline cancels the owned source search', async () => {
  const delay = Promise.withResolvers()
  const { service } = fixture([first], [], { timeoutMs: 20, mail: {
    settings: () => [{ provider: 'gmail', email: account.gmail }],
    scan: async ({ cancel }) => { if (cancel) delay.reject(new Error('Adapter cancelled')); else return delay.promise },
  } })
  await assert.rejects(service.scan(request), /timed out/)
})

test('mail source failures cannot expose unrelated message text through IPC errors', async () => {
  const { service } = fixture([first], [], { mail: {
    settings: () => [{ provider: 'apple', email: account.apple }],
    scan: async () => { throw new Error('Private fixture bank statement') },
  } })
  await assert.rejects(service.scan({ ...request, provider: 'apple' }), error =>
    /Connections/.test(error.message) && !error.message.includes('bank statement'))
})

test('adds top-level recruiting purposes without deriving an appointment from the message date', async () => {
  const messages = [
    reply('invite', 'Interview invitation for Product Analyst'),
    reply('booked', 'Interview confirmed for Product Analyst', 'If you need a rescheduled interview, please contact recruiting.'),
    reply('moved', 'Updated invitation: Product Analyst interview', 'Your interview has been rescheduled.'),
    reply('cancel', 'Canceled: Product Analyst interview'),
    reply('receipt', 'Application received for Product Analyst'),
    reply('update', 'Update on your application for Product Analyst'),
    reply('rejected', 'Application decision for Product Analyst', 'Thank you for applying. We are moving forward with other candidates.'),
    reply('with-code', 'Interview confirmation for Product Analyst', 'Your candidate portal verification code is 001285.'),
    reply('unrelated', 'Interview confirmation for Product Manager'),
    reply('bare-code', 'Application received for Product Analyst', 'Your code is 001285.'),
    reply('not-booked', 'Interview for Product Analyst not yet scheduled'),
    reply('updated', 'Interview invitation for Product Analyst', 'Your interview has been canceled.'),
    reply('survey', 'Interview for Product Analyst at Example Bank', 'Please complete our interview feedback survey.'),
    reply('declined', 'Thank you for applying for Product Analyst', 'You have not been selected.'),
  ]
  const { service } = fixture([first], messages)
  const { matches } = await service.scan(request)
  assert.deepEqual(matches.map(row => [row.message.key, row.purpose]), [
    ['invite', 'interview-invite'], ['booked', 'interview-scheduled'], ['moved', 'interview-rescheduled'],
    ['cancel', 'interview-canceled'], ['receipt', 'receipt'], ['updated', 'interview-canceled'],
  ])
  for (const row of matches) assert.deepEqual(Object.keys(row).sort(), ['company', 'jobId', 'jobUrl', 'message', 'purpose', 'title'])
  assert.doesNotMatch(JSON.stringify(matches), /001285|interviewAt/)
})

const clickTime = Date.parse('2026-01-01T12:09:00Z')
const codeRequest = { provider: 'gmail', jobId: first.id, requestedAt: clickTime }
const codeMail = (key, code, changes = {}) => ({
  ...reply(key, 'Example Bank candidate portal verification code', 'Your verification code is ' + code, 'Hiring <no-reply@example.test>'),
  ...changes,
})

test('an on-demand code uses the saved employer, a real timestamp and only the newest eligible result', async () => {
  const latest = '2026-01-01T12:08:30Z'
  const rows = [codeMail('new', '001234', { receivedAt: latest }), codeMail('old', '721033'),
    codeMail('stale', '901785', { receivedAt: '2026-01-01T11:58:59Z' }),
    codeMail('future', '120034', { receivedAt: '2026-01-01T13:00:00Z' })]
  for (const provider of Object.keys(account)) {
    const { service, calls } = fixture([first], rows, { now: () => clickTime })
    assert.deepEqual(await service.verificationCode({ ...codeRequest, provider, requestedAt: new Date(clickTime).toISOString() }),
      { code: '001234', receivedAt: latest })
    assert.deepEqual(calls, [{ provider, company: first.company }])
    assert.deepEqual((await service.scan({ ...request, provider })).matches, [])
  }
})

test('verification filters sender addresses, portal purpose, financial OTPs and ambiguous messages', async () => {
  const rejected = [
    { from: 'Example Bank <mail@elsewhere.test>' }, { from: 'Candidate team at Example Bank' },
    { account: 'wrong@example.test' }, { from: 'no-reply@example.test.unrelated.test' }, { from: 'no-reply@example.test, attacker@other.test' },
    { subject: 'Online banking verification code' }, { preview: 'Approval of wire transfer. Security code: 098876' },
    { subject: 'Reset your password', preview: 'Candidate portal verification code: 013456' },
    { subject: 'Your verification code' }, { preview: 'Application for Software Engineer. Verification code: 123456' },
    { subject: 'Senior Designer candidate portal verification code' },
    { preview: 'Job ID R99999. Verification code: 123456' }, { preview: 'Your code is somewhere in your inbox.' },
    { preview: 'Verification code: 123456. OTP: 234567.' }, { receivedAt: '' }, { receivedAt: '2026-01-01' },
    { receivedAt: '2026-01-01T11:58:59Z' }, { receivedAt: '2026-01-01T12:09:01Z' },
  ]
  for (const change of rejected) {
    const { service } = fixture([first], [codeMail('bad', '123456', change)], { now: () => clickTime })
    assert.deepEqual(await service.verificationCode(codeRequest), { code: null }, JSON.stringify(change))
  }
  for (const jobs of [[first, second], [{ ...first, stage: 'Closed' }]]) {
    const { service } = fixture(jobs, [codeMail('vague', '123456')], { now: () => clickTime })
    assert.deepEqual(await service.verificationCode(codeRequest), { code: null })
  }
})

test('only an explicit requisition or matching title selects between same-employer roles', async () => {
  const job = { ...first, url: 'https://example.test/jobs/123456' }
  const jobs = [job, second]
  for (const [subject, code] of [
    ['Example Bank candidate portal verification code', null],
    ['Example Bank candidate portal verification code for Product Manager', null],
    ['Example Bank candidate portal verification code for Product Analyst', '123456'],
    ['Example Bank candidate portal verification code for Job ID 123456', '123456'],
  ]) {
    const { service } = fixture(jobs, [codeMail('role', '123456', { subject })], { now: () => clickTime })
    assert.equal((await service.verificationCode(codeRequest)).code, code, subject)
  }
})

test('shared ATS mail requires both the posting platform and an explicit employer in the message', async () => {
  const job = { ...first, url: 'https://job-boards.greenhouse.io/examplebank/jobs/12345' }
  const from = 'Example Bank <no-reply@greenhouse.io>'
  const row = codeMail('ats', '123456', { from })
  for (const [candidate, message, code] of [[job, row, '123456'], [first, row, null],
    [job, { ...row, subject: 'Candidate portal verification code' }, null],
    [job, { ...row, from: 'mail@greenhouse.io.unrelated.test' }, null]]) {
    const { service } = fixture([candidate], [message], { now: () => clickTime })
    assert.equal((await service.verificationCode(codeRequest)).code, code)
  }
})

test('stale requests and unknown jobs never search mail; removal during a read suppresses the code', async () => {
  let jobs = [first]
  const { service, calls } = fixture(jobs, [], { now: () => clickTime })
  for (const requestedAt of [clickTime - 600001, clickTime + 1, 'unknown', null]) {
    assert.deepEqual(await service.verificationCode({ ...codeRequest, requestedAt }), { code: null })
  }
  assert.deepEqual(await service.verificationCode({ ...codeRequest, jobId: 'missing' }), { code: null })
  await assert.rejects(service.verificationCode({ ...codeRequest, query: 'code' }))
  assert.deepEqual(calls, [])
  const changing = fixture(jobs, [], { now: () => clickTime, getJobs: () => jobs, mail: {
    settings: () => [{ provider: 'gmail', email: account.gmail }],
    scan: () => { jobs = []; return [{ ...codeMail('gone', '123456'), provider: 'gmail', account: account.gmail }] },
  } })
  assert.deepEqual(await changing.service.verificationCode(codeRequest), { code: null })
})

test('a mailbox change while the lookup is pending suppresses the original account code', async () => {
  let email = account.gmail
  const { service } = fixture([first], [], { now: () => clickTime, mail: {
    settings: () => [{ provider: 'gmail', email }],
    scan: () => {
      email = 'other@example.test'
      return [{ ...codeMail('original', '101234'), provider: 'gmail', account: account.gmail }]
    },
  } })
  assert.deepEqual(await service.verificationCode(codeRequest), { code: null })
})

test('Apple Mail subject-only codes work and conflicting codes at the same time stay private', async () => {
  const provider = 'apple'
  const onlySubject = codeMail('a', '', { subject: 'Example Bank candidate portal verification code: 0AbC71', preview: '' })
  const rows = [onlySubject]
  const { service } = fixture([first], rows, { now: () => clickTime })
  assert.deepEqual(await service.verificationCode({ ...codeRequest, provider }), { code: '0AbC71', receivedAt: onlySubject.receivedAt })
  rows.push(codeMail('b', '660121'))
  assert.deepEqual(await service.verificationCode({ ...codeRequest, provider }), { code: null })
})
