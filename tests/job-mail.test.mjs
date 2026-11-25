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
  assert.deepEqual(result.matches.map(row => row.message.key), ['interview', 'receipt', 'ref'])
  assert.deepEqual(result.matches.map(row => row.jobId), [first.id, first.id, first.id])
  assert.deepEqual(calls, [{ provider: 'gmail', company: 'Example Bank' }])
  assert.equal(result.nextOffset, null)
  assert.equal(result.checked, 1)
  assert.doesNotMatch(JSON.stringify(result), /attachments|never return|R99999|credit card|your Product Manager/)
})

test('resolves role ambiguity only with identifying evidence, including for a single-job scan', async () => {
  const same = { ...first, id: 'similar', url: 'https://example.test/apply?gh_jid=778899' }
  const messages = [reply('ambiguous', 'Your application for Product Analyst'),
    reply('exact', 'Your application for Product Analyst · job ID 778899'),
    reply('different-role', 'Your application for Product Manager')]
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
      return [{ ...reply('old', 'Your application for Product Analyst'), provider: 'gmail' }]
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
