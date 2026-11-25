// Run after building the renderer. Use a disposable Electron window and a public-settings fixture.
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { _electron as electron } from 'playwright'
import { budgetDefaults } from '../ui/budget-estimate.mjs'

const temp = await mkdtemp(path.join(tmpdir(), 'pluto-budget-initial-'))
const index = pathToFileURL(path.resolve(process.argv[2] || 'dist', 'index.html')).href
let app
try {
  const entry = path.join(temp, 'main.cjs')
  await writeFile(entry, `const {app,BrowserWindow}=require('electron'); let win;
    app.whenReady().then(()=>{win=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true}});win.loadURL('about:blank')})`)
  app = await electron.launch({ args: ['--user-data-dir=' + temp, entry] })
  const page = await app.firstWindow()
  let budget, getSettings
  const calls = []
  await page.exposeFunction('budgetTestCall', (action, payload) => {
    calls.push(action)
    if (action === 'workspace.snapshot') return { profile: budget ? { budget } : {}, jobs: [], notes: [], schedule: {} }
    if (action === 'workspace.saveProfile') { budget = payload.budget; return }
    if (action === 'providers.settings') return getSettings()
    throw new Error('Unexpected IPC action ' + action)
  })
  await page.addInitScript(() => { window.pluto = { call: window.budgetTestCall } })
  const scenario = page.getByLabel('Pricing scenario', { exact: true })
  async function open(saved, settings) {
    calls.length = 0
    budget = saved
    getSettings = settings
    await page.goto(index)
    await page.getByRole('navigation').getByRole('button', { name: 'Daily budget', exact: true }).click()
    await scenario.waitFor()
  }
  const codex = () => ({ activeProvider: 'codex' })
  const waitForValue = value => page.waitForFunction(expected => document.querySelector('#budget-provider')?.value === expected, value)
  await open(null, codex)
  await waitForValue('subscription')
  assert.equal(budget, null)
  assert.deepEqual(calls.filter(name => name.startsWith('providers.')), ['providers.settings'])

  for (const saved of ['custom', 'subscription']) {
    await open({ ...budgetDefaults(), provider: saved }, codex)
    assert.equal(await scenario.inputValue(), saved)
    assert.ok(!calls.includes('providers.settings'))
    assert.ok(!calls.includes('workspace.saveProfile'))
  }
  for (const settings of [
    () => ({ activeProvider: 'openai', providers: { codex: { configured: true } } }),
    () => ({ activeProvider: null }),
    () => { throw new Error('Unavailable') },
  ]) {
    await open(null, settings)
    assert.equal(await scenario.inputValue(), 'openai')
    assert.equal(budget, null)
  }

  for (const action of ['edit', 'save', 'navigate']) {
    const pending = Promise.withResolvers()
    const started = Promise.withResolvers()
    await open(null, () => { started.resolve(); return pending.promise })
    await started.promise
    if (action === 'edit') await scenario.selectOption('ollama')
    if (action === 'save') await page.getByRole('button', { name: 'Save budget', exact: true }).click()
    if (action === 'navigate') await page.getByRole('navigation').getByRole('button', { name: 'Today', exact: true }).click()
    pending.resolve(codex())
    // Flush the IPC delivery and React render before checking the late reply.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    if (action === 'edit') assert.equal(await scenario.inputValue(), 'ollama')
    if (action === 'save') assert.equal(budget.provider, 'openai')
    if (action !== 'save') assert.equal(budget, null)
  }
  console.log('Passed budget initialization, saved scenarios, unavailable settings and late-reply checks.')
} finally {
  await app?.close()
  await rm(temp, { recursive: true, force: true })
}
