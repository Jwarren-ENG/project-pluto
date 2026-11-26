// Run with node tests/employer-updates-ui.mjs [built renderer directory].
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { _electron as electron } from 'playwright'
import { createWorkspace } from '../desktop/workspace.mjs'
import { createJobMail } from '../desktop/job-mail.mjs'
import { createEmployerReview } from '../desktop/employer-review.mjs'

const root = await mkdtemp(path.join(tmpdir(), 'pluto-employer-ui-'))
const workspace = createWorkspace(path.join(root, 'workspace'))
let app
try {
  const job = workspace.saveJob({ company: 'Example Bank', title: 'Product Analyst', url: 'https://example.test/jobs/R12345',
    stage: 'Preparing', draft: 'Working letter', resumeText: 'Working résumé' })
  const other = workspace.saveJob({ company: 'Example Press', title: 'Editor', url: 'https://press.example.test/jobs/54321',
    stage: 'Closed', evidence: 'Position filled' })
  const jobs = () => workspace.snapshot().jobs
  const saved = id => jobs().find(row => row.id === id)
  const subjects = {
    receipt: 'Application received for Product Analyst',
    invite: 'Interview invitation for Product Analyst',
    booked: 'Interview confirmed for Product Analyst',
    moved: 'Updated invitation: Product Analyst interview',
    canceled: 'Canceled: Product Analyst interview',
  }
  const rows = Object.entries(subjects).map(([key, subject], i) => ({
    key, subject, from: 'Careers at Example Bank', receivedAt: '2026-02-0' + (i + 1) + 'T12:00:00Z',
    preview: key === 'moved' ? 'Your interview has been rescheduled from 2099-03-10.' : '',
  }))
  rows.push({ key: 'other', subject: 'Interview invitation for Editor', from: 'Careers at Example Press' })
  const token = '018527'
  const codeAge = 1000
  let mailboxTime = Date.now()
  let accounts = [{ provider: 'gmail', email: 'fixture@example.test' }, { provider: 'outlook', email: 'other@example.test' }]
  const mail = {
    settings: () => accounts,
    scan: ({provider}) => [...rows, {
      key: 'portal', from: 'Recruiting <no-reply@example.test>', subject: 'Example Bank candidate portal verification code',
      preview: 'Your verification code is ' + token, receivedAt: new Date(mailboxTime - codeAge).toISOString(),
    }].map(row => ({ ...row, provider, account: accounts.find(a => a.provider === provider).email })),
  }
  const jobMail = createJobMail({ mail, getJobs: jobs, now: () => mailboxTime })
  const service = createEmployerReview({ mail, jobMail, getJob: saved, recordUpdate: input => workspace.recordEmployerUpdate(input) })
  const entry = path.join(root, 'main.cjs')
  await writeFile(entry, "const {app,BrowserWindow}=require('electron');let w;app.whenReady().then(()=>{w=new BrowserWindow({show:false});w.loadURL('about:blank')})")
  app = await electron.launch({ args: ['--user-data-dir=' + path.join(root, 'user'), entry] })
  const page = await app.firstWindow()
  page.setDefaultTimeout(6000)
  await page.route(/^https?:/, route => route.abort())
  const errors = []
  page.on('pageerror', err => errors.push(err.message))
  const calls = []
  const payloads = name => calls.filter(c => c.action === name).map(c => c.payload)
  let features
  let version = 0
  await page.exposeFunction('fixture', async (action, payload) => {
    if (action === 'workspace.snapshot') return { ...workspace.snapshot(), features, existingWorkspace: true, dataVersion: version }
    if (action === 'workspace.dataVersion') return version
    calls.push({action, payload})
    if (action === 'mail.settings') return mail.settings()
    if (action === 'mail.scan') return service.scan(payload)
    if (action === 'mail.recordUpdate') return service.review(payload)
    if (action === 'mail.verificationCode') return jobMail.verificationCode(payload)
    throw new Error('Unexpected action ' + action)
  })
  await page.addInitScript(() => { window.pluto = { call: window.fixture } })
  await page.goto(pathToFileURL(path.resolve(process.argv[2] || 'dist', 'index.html')).href)
  const button = name => page.getByRole('button', {name, exact: true})
  const expand = () => page.locator('summary').filter({hasText: /^Employer updates$/}).press('Enter')
  const codeAction = button('Find verification code')
  const check = button('Check for updates')
  const lookup = async () => {
    await codeAction.click()
    await page.getByText(token, {exact:true}).waitFor()
  }
  const openRole = row => button('Open ' + row.title + ' at ' + row.company).click()
  await button('Applications').click()
  const refreshFeature = async value => {
    features = value
    version++
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  }
  for (const value of [undefined, {emailCheck:false}]) {
    await refreshFeature(value)
    await button('Optional workflow settings').waitFor()
    assert.equal(await check.count(), 0)
    await openRole(job)
    await page.getByLabel('Application draft', {exact:true}).waitFor()
    assert.equal(await codeAction.count(), 0)
    assert.equal(await page.locator('summary').getByText('Employer updates').count(), 0)
    await button('Close').click()
  }
  assert.deepEqual(calls, [])
  await refreshFeature({ emailCheck: true })
  await page.getByText('Employer updates', {exact:true}).waitFor()
  assert.deepEqual(calls, [])
  await expand()
  const role = page.getByLabel('Tracked role', {exact:true})
  await role.waitFor()
  assert.deepEqual(calls.map(c => c.action), ['mail.settings'])
  assert.equal(await check.count(), 0)
  await role.selectOption(job.id)
  await check.click()
  await page.getByText('5 matching updates.').waitFor()
  assert.deepEqual(payloads('mail.scan'), [{ provider:'gmail', jobId:job.id, scanId:payloads('mail.scan')[0].scanId }])
  assert.ok(payloads('mail.scan')[0].scanId)
  assert.equal(await codeAction.count(), 0)
  assert.equal(await page.getByText(/invitation for Editor|018527/).count(), 0)
  await button(subjects.receipt).click()
  await button('Cancel review').click()
  assert.deepEqual(payloads('mail.recordUpdate'), [])
  await role.selectOption(other.id)
  assert.equal(await button(subjects.receipt).count(), 0)
  await openRole(job)
  await expand()
  await check.click()
  await button(subjects.receipt).click()
  await page.getByLabel('Application draft', {exact:true}).fill('An unsaved edit')
  const record = button('Link update to role')
  await record.click()
  await page.getByText('Update linked to this role.').waitFor()
  assert.deepEqual(payloads('mail.recordUpdate'), [{provider:'gmail', jobId:job.id, messageKey:'receipt'}])
  const received = saved(job.id)
  assert.equal(received.stage, 'Applied')
  assert.equal(received.submittedSnapshot.draft, '')
  assert.equal(received.submittedSnapshot.resumeText, '')
  assert.equal(received.draft, 'Working letter')
  assert.equal(received.resumeText, 'Working résumé')
  assert.equal(await page.getByLabel('Application draft', {exact:true}).inputValue(), 'An unsaved edit')
  await page.getByText(/Your edits are still in the form/).waitFor()
  for (const [key, day] of [['invite', null], ['booked', '2099-03-10'], ['moved', '2099-03-12'], ['canceled', '2099-03-12']]) {
    await button(subjects[key]).click()
    if (day) await page.getByLabel(/interview date, if known/).fill(day)
    await record.click()
    await page.getByText('Update linked to this role.').waitFor()
    assert.deepEqual(payloads('mail.recordUpdate').at(-1), {
      provider:'gmail', jobId:job.id, messageKey:key, ...(day ? {interviewAt:day} : {}),
    })
    assert.equal(saved(job.id).interviewAt, key === 'canceled' ? null : day)
  }
  assert.equal(workspace.snapshot().upcomingInterviews.length, 0)
  assert.deepEqual(saved(other.id), other)
  assert.equal(workspace.snapshot().notes.length, 0)
  const history = saved(job.id).history
  await check.click()
  await button(subjects.receipt).click()
  await record.click()
  await page.getByText('Already linked to this role.').waitFor()
  assert.deepEqual(saved(job.id).history, history)
  assert.deepEqual(payloads('mail.verificationCode'), [])
  mailboxTime = Date.now()
  await page.clock.setFixedTime(new Date(mailboxTime))
  await lookup()
  const request = payloads('mail.verificationCode')[0]
  assert.deepEqual(request, { provider:'gmail', jobId:job.id, requestedAt:request.requestedAt })
  assert.equal(Date.parse(request.requestedAt), mailboxTime)
  await page.getByLabel('Update source').selectOption('outlook')
  assert.equal(await page.getByText(token, {exact:true}).count(), 0)
  await lookup()
  mailboxTime += 10 * 60_000
  await page.clock.setFixedTime(new Date(mailboxTime))
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await page.getByText('Verification code expired.').waitFor()
  assert.equal(await page.getByText(token, {exact:true}).count(), 0)
  await lookup()
  await refreshFeature({emailCheck:false})
  await codeAction.waitFor({state:'detached'})
  assert.equal(await page.getByText(token, {exact:true}).count(), 0)
  assert.equal(await page.getByLabel('Application draft', {exact:true}).inputValue(), 'An unsaved edit')
  await button('Close').click()
  await button('Discard changes').click()
  await refreshFeature({emailCheck:true})
  await openRole(other)
  await expand()
  await check.waitFor()
  assert.equal(await codeAction.count(), 0)
  await expand()
  await check.waitFor({state:'detached'})
  accounts = []
  await expand()
  await page.getByText('No mail source configured for employer updates.').waitFor()
  assert.equal(await check.count(), 0)
  assert.equal(await page.getByRole('button', {name:/connect .*mail/i}).count(), 0)
  assert.ok(!JSON.stringify(workspace.snapshot()).includes(token))
  assert.ok(!(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]))).includes(token))
  await button('Close').click()
  await refreshFeature({emailCheck:false})
  await button('Optional workflow settings').click()
  await page.getByRole('heading', {name:'Optional workflows', exact:true}).waitFor()
  assert.equal(await page.evaluate(() => document.activeElement.id), 'optional-workflows-heading')
  assert.deepEqual(errors, [])
  console.log('Passed optional Applications workflows, scoped review, five employer outcomes, draft preservation and transient code checks.')
} finally {
  await app?.close()
  workspace.close()
  await rm(root, {recursive:true, force:true})
}
