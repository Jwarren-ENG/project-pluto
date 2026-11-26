import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { upcomingInterviews } from '../desktop/record-dates.mjs'
import { createWorkspace } from '../desktop/workspace.mjs'

function fixture(t, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pluto-employer-update-'))
  const ws = createWorkspace(dir)
  t.after(() => { ws.close(); rmSync(dir, { recursive: true, force: true }) })
  const job = ws.saveJob({ company: 'Example Works', title: 'Analyst', url: 'https://example.test/jobs/7',
    stage: 'Preparing', resumeText: 'Working résumé', draft: 'Unsent letter', ...extra })
  const send = (purpose, message = {}, interviewAt) => ws.recordEmployerUpdate({
    jobId: job.id, purpose, message: { provider: 'gmail', key: purpose, subject: 'Employer correspondence',
      preview: 'Synthetic recruiter excerpt', receivedAt: '2026-02-10T12:00:00Z', ...message }, interviewAt,
  })
  return { ws, dir, job, send, latest: () => ws.snapshot().jobs.find(j => j.id === job.id) }
}

test('receipt is immutable, keeps drafts out of submitted materials, and replays across handles', t => {
  const { dir, job, send, latest } = fixture(t)
  const result = send('receipt')
  assert.deepEqual(result, { recorded: true, duplicate: false, jobId: job.id, stage: 'Applied', purpose: 'receipt',
    interviewAt: null, appointmentChanged: false })
  const saved = latest()
  const sent = saved.submittedSnapshot
  assert.equal(sent.submittedAt, '2026-02-10T12:00:00.000Z')
  assert.equal(sent.resumeText, '')
  assert.equal(sent.draft, '')
  assert.equal(saved.resumeText, job.resumeText)
  assert.equal(saved.draft, job.draft)
  assert.equal(sent.evidence.source, 'Gmail')
  assert.ok(sent.evidence.messageId)
  assert.equal(saved.history.at(-1).evidence.messageId, sent.evidence.messageId)
  assert.equal(saved.history.at(-1).purpose, 'receipt')
  assert.equal(JSON.stringify(saved).includes('Synthetic recruiter excerpt'), false)
  const other = createWorkspace(dir)
  try {
    const message = { provider: 'gmail', key: 'receipt', subject: 'Employer correspondence', receivedAt: '2026-02-10T12:00:00Z' }
    const again = other.recordEmployerUpdate({ jobId: job.id, purpose: 'receipt', message })
    assert.equal(again.duplicate, true)
    assert.equal(again.recorded, false)
    assert.deepEqual(latest(), saved)
    assert.throws(() => other.recordEmployerUpdate({ jobId: job.id, purpose: 'interview-invite', message }), /already recorded/)
    const another = other.saveJob({ company: 'Different Employer', title: 'Buyer' })
    assert.throws(() => other.recordEmployerUpdate({ jobId: another.id, purpose: 'receipt', message }), /already recorded/)
    assert.equal(send('receipt', { provider: 'outlook' }).recorded, true)
    assert.deepEqual(latest().submittedSnapshot, sent)
  } finally { other.close() }
})

test('late receipts and interviews retain later stages, dated rounds and prior submission evidence', t => {
  const { ws, job, send, latest } = fixture(t)
  const applied = ws.saveJob({ id: job.id, stage: 'Applied', evidence: 'Verified portal receipt' })
  ws.saveJob({ id: job.id, stage: 'Offer', evidence: 'Written offer' })
  send('receipt')
  send('interview-scheduled', {}, '2099-06-01')
  let current = latest()
  assert.equal(current.stage, 'Offer')
  assert.equal(current.evidence, 'Written offer')
  assert.equal(current.interviewAt, null)
  assert.deepEqual(current.submittedSnapshot, applied.submittedSnapshot)
  ws.saveJob({ id: job.id, stage: 'Closed', evidence: 'Employer closed role' })
  send('interview-invite')
  current = latest()
  assert.equal(current.stage, 'Closed')
  assert.equal(current.evidence, 'Employer closed role')
})

test('an interview can precede a receipt and a missing arrival date stays unknown', t => {
  const { send, latest } = fixture(t)
  const invite = send('interview-invite')
  assert.equal(invite.stage, 'Interview')
  assert.equal(invite.interviewAt, null)
  assert.equal(latest().submittedSnapshot, null)
  const interviewEvidence = latest().evidence
  send('receipt', { receivedAt: '' })
  assert.equal(latest().stage, 'Interview')
  assert.equal(latest().submittedSnapshot.submittedAt, '')
  assert.equal(latest().submittedSnapshot.resumeText, '')
  assert.deepEqual(latest().evidence, interviewEvidence)
})

test('reviewed dates, cancellations, ambiguity and older messages protect the active round', t => {
  const { ws, send, latest } = fixture(t)
  const first = '2099-06-01T10:00:00-04:00', next = '2099-06-05', unrelated = '2099-07-03'
  const message = (key, day, subject = 'Interview update') => ({ key, receivedAt: '2026-02-' + day + 'T12:00:00Z', subject })
  send('interview-scheduled', message('first', 12), first)
  const at = latest().interviewAt
  assert.equal(at, '2099-06-01T14:00:00.000Z')
  send('interview-invite', message('late-invite', 11))
  send('interview-rescheduled', message('different-round', 13), unrelated)
  send('interview-canceled', message('other-cancel', 14), unrelated)
  send('interview-canceled', message('unclear-cancel', 14))
  assert.equal(latest().interviewAt, at)
  assert.equal(latest().evidence.receivedAt, '2026-02-12T12:00:00.000Z')
  const move = send('interview-rescheduled', message('move', 15, 'Interview moved from ' + first), next)
  assert.equal(move.appointmentChanged, true)
  assert.equal(latest().interviewAt, next)
  assert.equal(ws.snapshot().upcomingInterviews.length, 1)
  send('interview-canceled', message('old-cancel', 13), next)
  assert.equal(latest().interviewAt, next)
  const cancel = send('interview-canceled', message('cancel', 16), next)
  assert.equal(cancel.appointmentChanged, true)
  assert.equal(cancel.interviewAt, null)
  assert.equal(latest().interviewStatus, 'canceled')
  assert.equal(latest().stage, 'Interview')
  assert.deepEqual(ws.snapshot().upcomingInterviews, [])
  assert.deepEqual(upcomingInterviews(ws.snapshot().jobs, { includePending: true }), [], 'Today must exclude canceled rounds')
  send('interview-invite', message('old', 15))
  assert.equal(latest().interviewStatus, 'canceled')
  send('interview-invite', message('new-round', 17))
  assert.equal(latest().interviewStatus, 'pending')
  assert.equal(latest().interviewAt, null)
  assert.equal(latest().submittedSnapshot, null)
})

test('older mail cannot cancel a manually confirmed appointment in an existing workspace', t => {
  const { ws, job, dir, latest, send } = fixture(t, { stage: 'Interview', interviewAt: '2099-06-06', evidence: 'Manual confirmation' })
  const db = new DatabaseSync(join(dir, 'workspace.sqlite3'))
  try {
    db.prepare("UPDATE jobs SET data=json_remove(data, '$.interviewMailAt', '$.interviewStatus') WHERE id=?").run(job.id)
  } finally { db.close() }
  const result = send('interview-canceled', { receivedAt: '2001-03-01T12:00:00Z' }, job.interviewAt)
  assert.equal(result.appointmentChanged, false)
  assert.equal(latest().interviewAt, job.interviewAt)
  assert.equal(latest().evidence, 'Manual confirmation')
  assert.equal(ws.snapshot().upcomingInterviews.length, 1)
})

test('invalid input and verification codes never reach workspace storage', t => {
  const { ws, job, send, latest } = fixture(t)
  for (const purpose of ['verification-code', 'offer', null, 'constructor']) assert.throws(() => send(purpose))
  for (const message of [
    { provider: 'local' }, { key: '' }, { key: '512904' }, { key: 'bad\nkey' }, { key: 'x'.repeat(257) },
    { code: '512904' }, { otp: '512904' }, { subject: 'Your one-time verification code' },
    { preview: 'Interview invitation. Sign-in code 512904' }, { receivedAt: '2026-02-30T12:00:00Z' },
    { subject: { text: 'receipt' } }, { body: 'Private message body' },
  ]) assert.throws(() => send('receipt', message))
  for (const date of ['2099-02-30', '2099-03-01T11:00', '2099-03-01T24:00:00Z', 0, {}]) {
    assert.throws(() => send('interview-scheduled', {}, date))
  }
  assert.throws(() => send('receipt', {}, '2099-03-01'))
  assert.throws(() => send('interview-invite', {}, '2099-03-01'))
  assert.throws(() => ws.recordEmployerUpdate({ jobId:job.id, message:{}, purpose:'receipt', code:'512904' }))
  assert.deepEqual(latest(), job)
  assert.equal(JSON.stringify(ws.snapshot()).includes('512904'), false)
})

test('an event insertion failure rolls back the receipt, job update and replay identity', t => {
  const { send, job, dir, latest } = fixture(t)
  const db = new DatabaseSync(join(dir, 'workspace.sqlite3'))
  try {
    db.exec("CREATE TRIGGER stop_mail BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'interrupt'); END")
    assert.throws(() => send('receipt'), /interrupt/)
    assert.deepEqual(latest(), job)
    db.exec('DROP TRIGGER stop_mail')
    assert.equal(send('receipt').recorded, true)
    assert.equal(send('receipt').duplicate, true)
    assert.equal(latest().history.length, 2)
  } finally { db.close() }
})

test('review resolves cached employer mail while the ephemeral verification result stays outside the workspace', async t => {
  const { createJobMail } = await import('../desktop/job-mail.mjs')
  const { createEmployerReview } = await import('../desktop/employer-review.mjs')
  const { ws, job, latest } = fixture(t)
  const now = new Date('2026-03-01T12:00:00Z').valueOf()
  const common = { provider:'gmail', account:'fixture@example.test', from:'Example Works <careers@example.test>',
    receivedAt: new Date(now).toISOString(), url:'' }
  const rows = [
    { ...common, key:'fixture-receipt', subject:'Application received for Analyst at Example Works', preview:'Thank you for applying.' },
    { ...common, key:'fixture-authentication', subject:'Example Works candidate portal verification code',
      preview:'Use verification code 572816 for the candidate portal.' },
  ]
  const mail = { settings: async () => [{ provider:'gmail', email:common.account }], scan:async () => rows }
  const jobMail = createJobMail({ mail, getJobs: () => ws.snapshot().jobs, now: () => now })
  t.after(() => jobMail.close())
  const service = createEmployerReview({ jobMail, mail, getJob:id => ws.snapshot().jobs.find(item => item.id === id),
    recordUpdate: ws.recordEmployerUpdate, now: () => now })
  const scope = { provider:'gmail', jobId:job.id }
  const verified = await jobMail.verificationCode({ ...scope, requestedAt: new Date(now).toISOString() })
  assert.equal(verified.code, '572816')
  const page = await service.scan({ ...scope, scanId:'synthetic' })
  assert.deepEqual(page.matches.map(row => row.message.key), ['fixture-receipt'])
  const selection = { ...scope, messageKey:page.matches[0].message.key }
  await assert.rejects(service.review({ ...scope, messageKey:rows[1].key }))
  assert.equal(latest().submittedSnapshot, null)
  assert.equal((await service.review(selection)).stage, 'Applied')
  assert.equal((await service.review(selection)).duplicate, true)
  assert.equal(JSON.stringify(ws.snapshot()).includes(verified.code), false)
})
