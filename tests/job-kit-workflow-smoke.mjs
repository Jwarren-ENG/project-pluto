// A synthetic Today workspace and native bridge. Run against a built renderer.
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { _electron as electron } from 'playwright'

const root = await mkdtemp(path.join(tmpdir(), 'pluto-job-kit-'))
const index = pathToFileURL(path.resolve(process.argv[2] || 'dist', 'index.html')).href
const workspace = { existingWorkspace: true, jobs: [], notes: [], profile: {}, schedule: {} }
let app
try {
  const entry = path.join(root, 'main.cjs')
  await writeFile(entry, `const {app,BrowserWindow}=require('electron');let window;
    app.whenReady().then(()=>{window=new BrowserWindow({show:false});window.loadURL('about:blank')});`)
  app = await electron.launch({ args: ['--user-data-dir=' + root, entry] })
  const page = await app.firstWindow()
  page.setDefaultTimeout(6000)
  const calls = []
  const errors = []
  page.on('pageerror', err => errors.push(err.message))
  let status = { codexAvailable: true }
  let offline = false
  let denyCopy = false
  let refreshes = 0
  await page.exposeFunction('kitFixture', (action, payload) => {
    if (action === 'workspace.snapshot') { refreshes++; return workspace }
    if (action === 'workspace.dataVersion') return 0
    calls.push({ action, payload })
    if (action === 'jobkit.status') {
      if (offline) throw new Error('Unsupported workspace action.')
      return status
    }
    if (action === 'jobkit.choose') {
      assert.ok(['kit','vault'].includes(payload.kind))
      status = { ...status, [payload.kind]: { connected: true, name: 'Example ' + payload.kind, stats: { applications: 2, interviews: 1, notes: 0 } } }
      return status
    }
    if (action === 'jobkit.sync') return { ...status, managedRequest: Boolean(status.managed?.configured) }
    if (action === 'jobkit.copyTask') return { copied: !denyCopy }
    if (action === 'jobkit.openTask') return true
    if (action === 'jobkit.openVault') return { ok: true }
    throw new Error('Unexpected action ' + action)
  })
  await page.addInitScript(() => { window.pluto = { call: window.kitFixture } })
  await page.goto(index)
  const region = page.getByRole('region', { name: 'Job Kit workflow' })
  const button = name => region.getByRole('button', { name, exact: true })
  await region.getByRole('heading', { name: 'Job Kit workflow' }).waitFor()
  assert.deepEqual(calls, [])
  await button('Show workflow').press('Enter')
  await region.getByText('No sources connected').waitFor()
  assert.ok(await button('Sync from sources').isDisabled())
  assert.ok(await button('Copy task').isDisabled())
  const openTask = button('Open task in Codex')
  assert.equal(await openTask.count(), 0)
  await button('Connect vault').click()
  await region.getByText('Example vault').waitFor()
  await button('Open in Obsidian').click()
  assert.ok(await button('Copy task').isDisabled())
  await button('Connect kit').click()
  await region.getByText('Example kit', { exact: false }).waitFor()
  assert.equal(await region.getByText('2 applications · 1 interview', { exact: true }).count(), 2)
  const skills = ['run','status','interview-prep']
  assert.ok(await openTask.isEnabled())
  assert.equal(await button('Copy task').getAttribute('data-variant'), 'outline')
  for (const skill of skills) {
    await region.getByLabel('Task for your assistant').selectOption(skill)
    await button('Copy task').click()
    await region.getByRole('status').getByText(/Task copied/).waitFor()
  }
  const openedTasks = () => calls.filter(c => c.action === 'jobkit.openTask').map(c => c.payload)
  assert.deepEqual(openedTasks(), [])
  await openTask.press('Enter')
  await region.getByRole('status').getByText('Task sent to Codex for review.').waitFor()
  assert.deepEqual(openedTasks(), [{skill:'interview-prep'}])
  status.codexAvailable = false
  await button('Check status').click()
  await openTask.waitFor({state:'detached'})
  assert.ok(await button('Copy task').isEnabled())
  assert.deepEqual(calls.filter(c => c.action === 'jobkit.copyTask').map(c => c.payload), skills.map(skill => ({ skill })))
  assert.deepEqual(calls.filter(c => c.action === 'jobkit.choose').map(c => c.payload), [{kind:'vault'},{kind:'kit'}])
  assert.equal(calls.filter(c => c.action === 'jobkit.openVault').length, 1)
  assert.equal(calls.filter(c => c.action === 'jobkit.sync').length, 0)
  await button('Sync from sources').click()
  await region.getByText('Refresh completed.').waitFor()
  denyCopy = true
  await button('Copy task').click()
  await region.getByRole('alert').getByText('The task could not be copied.').waitFor()
  assert.equal(await region.getByRole('status').innerText(), '')
  denyCopy = false
  status.lastSync = { at: '2026-01-31T10:00:00Z', imported: 0, updated: 0, unchanged: 0, preserved: 1, issues: ['Example folder is unavailable.'] }
  await button('Sync from sources').click()
  await region.getByRole('status').getByText('Sync finished with source issues.').waitFor()
  await region.getByRole('list', { name: 'Source issues' }).getByText('Example folder is unavailable.').waitFor()
  for (const [receipts, wording] of [[1, '1 receipt added'], [2, '2 receipts added'], [0, '0 receipts added']]) {
    status.lastSync.jobs = { inserted: 0, updated: 0, receipts }
    await button('Check status').click()
    await region.getByText('Applications · 0 added · 0 updated · ' + wording, { exact: true }).waitFor()
  }
  delete status.lastSync
  const baseline = refreshes
  status = { kit: {connected:false}, vault: {connected:false}, managed: { configured: true, tracker: 'Example tracker', vault: 'Example archive',
    lastCompleted: '2026-02-01T10:00:00Z', ok: true } }
  await button('Check status').click()
  await region.locator('time[datetime="2026-02-01T10:00:00Z"]').waitFor()
  const sourceRow = label => region.locator('dl > div').filter({ has: page.locator('dt').filter({hasText: label}) })
  for (const [rowLabel, sourceName, kind] of [['Job Kit', 'Example tracker', 'kit'], ['Obsidian vault', 'Example archive', 'vault']]) {
    const row = sourceRow(rowLabel)
    assert.ok((await row.innerText()).includes(sourceName))
    await row.getByText('Managed locally', {exact:true}).waitFor()
    assert.ok(await button('Add additional ' + kind).isEnabled())
  }
  assert.equal(await region.getByText('Optional · Not connected', {exact:true}).count(), 0)
  assert.ok(await button('Copy task').isEnabled())
  assert.ok(await button('Open in Obsidian').isEnabled())
  await button('Sync from sources').click()
  await region.getByText('Refresh requested', { exact: true }).waitFor()
  assert.equal(refreshes, baseline)
  status.managed.lastCompleted = '2026-02-02T10:00:00Z'
  await region.locator('time[datetime="2026-02-02T10:00:00Z"]').waitFor()
  assert.equal(refreshes, baseline + 1)
  for (const [label, kind] of [['Job Kit', 'kit'], ['Obsidian vault', 'vault']]) {
    await button('Add additional ' + kind).click()
    await sourceRow(label).getByText('Additional ' + kind + ' · Example ' + kind, {exact:false}).waitFor()
    await sourceRow(label).getByText('Managed locally', {exact:true}).waitFor()
    await button('Change additional ' + kind).click()
    assert.deepEqual(calls.filter(c => c.action === 'jobkit.choose').at(-1).payload, {kind})
  }
  offline = true
  await button('Check status').click()
  await region.getByRole('alert').getByText(/does not support/).waitFor()
  assert.equal(await button('Copy task').count(), 0)
  offline = false
  await button('Check status').click()
  await button('Copy task').waitFor()
  await page.setViewportSize({ width: 390, height: 844 })
  assert.ok(await region.evaluate(el => el.scrollWidth <= el.clientWidth))
  await button('Open notebook').click()
  await page.getByRole('heading', { name: 'Notebook', exact: true }).waitFor()
  await page.getByRole('navigation').getByRole('button', {name:'Today', exact:true}).click()
  await button('Open applications').click()
  await page.getByRole('heading', { name:'Applications', exact:true }).waitFor()
  assert.deepEqual(errors, [])
  console.log('Passed Job Kit navigation, separate sources, task dispatch, refresh, vault opening and unavailable service checks.')
} finally {
  await app?.close()
  await rm(root, { recursive: true, force: true })
}
