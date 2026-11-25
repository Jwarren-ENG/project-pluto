// Run after building the renderer: node tests/activity-smoke.mjs [renderer directory]
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { _electron as electron } from 'playwright'

const directory = await mkdtemp(path.join(tmpdir(), 'pluto-activity-'))
const entry = path.join(directory, 'main.cjs')
const index = pathToFileURL(path.resolve(process.argv[2] || 'dist', 'index.html')).href
const url = 'https://employer.example/jobs/42?source=list#details'
let app
try {
  await writeFile(entry, "const {app,BrowserWindow}=require('electron');let win;app.whenReady().then(()=>{win=new BrowserWindow({show:false,width:1024,height:768});win.loadURL('about:blank')})")
  app = await electron.launch({ args: ['--user-data-dir=' + directory, entry] })
  const page = await app.firstWindow()
  page.setDefaultTimeout(6000)
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(error.message))
  // Construct fixtures in the renderer's local time. Tuesday's final receipt
  // is one minute before midnight and every record was edited on Wednesday.
  const { jobs, now } = await page.evaluate(() => {
    const at = (day, hour = 12, minute = 0) => new Date(2026, 10, day, hour, minute).toISOString()
    function record(id, day, stage = 'Applied', hour = 12, minute = 0) {
      const row = { id, title: id, company: 'Example Company', stage, updatedAt: at(25), history: [] }
      if (day) row.submittedSnapshot = { submittedAt: at(day, hour, minute), evidence: 'Fixture portal receipt' }
      return row
    }
    return { now: at(25), jobs: [record('Draft only', null, 'Preparing'), record('Interview only', null, 'Interview'),
      record('Prior week', 17), record('Monday offer', 23, 'Offer'),
      ...Array.from({ length: 9 }, (_, i) => record('Tuesday role ' + i, 24)),
      record('Late receipt', 24, 'Closed', 23, 59), record('Midnight receipt', 25, 'Applied', 0)] }
  })
  const results = [{ title: 'Example analyst', source: 'Example list', url },
    { title: 'Old result', url: 'relative/path' }, { title: 'Unsupported address', url: 'http://jobs.example/42' }]
  const opened = []
  let rejectOpen = false
  await page.exposeFunction('activityFixture', (action, payload) => {
    if (action === 'workspace.snapshot') return { jobs, profile: {}, notes: [], schedule: { hour: 9, minute: 0, query: 'Analyst' } }
    if (action === 'sources.list') return []
    if (action === 'discovery.status') return { latest: { query: 'Analyst', results } }
    if (action === 'app.openExternal') {
      opened.push(payload)
      if (rejectOpen) throw new Error('Fixture browser unavailable')
      return
    }
    throw new Error('Unexpected action: ' + action)
  })
  await page.addInitScript(() => { window.pluto = { call: window.activityFixture } })
  await page.clock.setFixedTime(new Date(now))
  await page.goto(index)
  const nav = name => page.getByRole('navigation').getByRole('button', { name, exact: true }).click()
  const group = page.getByRole('group', { name: 'Filter applications by receipt date' })
  const day = (index, count) => group.getByRole('button', { name: new RegExp(', ' + count + ' receipts?$') }).and(group.getByRole('button').nth(index))
  const tuesday = day(1, 10)
  const wednesday = day(2, 1)
  const queue = page.locator('#today-application-queue')
  const title = name => queue.getByRole('button', { name, exact: true })
  await title('Draft only').waitFor()
  assert.equal(await group.getByRole('button').count(), 7)
  await tuesday.focus()
  await page.keyboard.press('Enter')
  await queue.getByRole('columnheader', { name: 'Receipt recorded' }).waitFor()
  assert.equal(await tuesday.getAttribute('aria-pressed'), 'true')
  assert.equal(await queue.getByRole('row').count(), 11)
  assert.equal(await title('Late receipt').count(), 1)
  assert.equal(await title('Midnight receipt').count(), 0)
  assert.equal(await title('Draft only').count(), 0)
  assert.equal(await title('Interview only').count(), 0)
  assert.equal(await title('Prior week').count(), 0)
  await day(4, 0).click()
  await queue.getByText('No application receipts on this day.').waitFor()
  const clear = queue.getByRole('button', { name: 'Clear day filter' })
  await clear.press('Enter')
  await title('Draft only').waitFor()
  assert.equal(await day(4, 0).evaluate(el => el === document.activeElement && el.getAttribute('aria-pressed') === 'false'), true)
  await queue.getByRole('tab', { name: /All roles/ }).click()
  await wednesday.press('Space')
  await title('Midnight receipt').waitFor()
  assert.equal(await queue.getByRole('row').count(), 2)
  await wednesday.press('Space')
  assert.equal(await queue.getByRole('tab', { name: /All roles/ }).getAttribute('aria-selected'), 'true')
  await tuesday.click()
  await queue.getByRole('tab', { name: /In progress/ }).click()
  assert.equal(await clear.count(), 0)
  await day(0, 1).click()
  await title('Monday offer').click()
  await page.getByText('Submitted copy', { exact: true }).click()
  await page.getByText('Fixture portal receipt', { exact: true }).waitFor()

  await nav('Discover')
  const link = page.getByRole('link', { name: url, exact: true })
  await link.waitFor()
  assert.equal(await link.getAttribute('href'), url)
  assert.equal(await page.locator('article.result a').count(), 1)
  await link.press('Enter')
  await link.click({ button: 'middle' })
  rejectOpen = true
  await link.click()
  await page.getByText(/Fixture browser unavailable/).waitFor()
  assert.deepEqual(opened, Array.from({ length: 3 }, () => ({ url })))
  assert.equal(page.url(), index)
  await page.locator('article.result').first().getByRole('button', { name: 'Review role' }).click()
  await page.getByRole('heading', { name: 'New application' }).waitFor()
  assert.deepEqual(pageErrors, [])
  console.log('Passed receipt-day filtering, clear and keyboard behavior, record review, and system-browser link dispatch.')
} finally {
  await app?.close()
  await rm(directory, { recursive: true, force: true })
}
