// Run after building the renderer. Use a disposable Electron window and a public-settings fixture.
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { _electron as electron } from 'playwright'
import { budgetDefaults, creditCards, rateCards } from '../ui/budget-estimate.mjs'

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
  const sourceUrls = []
  await page.exposeFunction('budgetTestCall', (action, payload) => {
    calls.push(action)
    if (action === 'workspace.snapshot') return { profile: budget ? { budget } : {}, jobs: [], notes: [], schedule: {} }
    if (action === 'workspace.saveProfile') { budget = payload.budget; return }
    if (action === 'app.openExternal') { sourceUrls.push(payload.url); return }
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

  for (const saved of ['custom', 'subscription', 'codex-sol-credits']) {
    await open({ ...budgetDefaults(), provider: saved }, codex)
    assert.equal(await scenario.inputValue(), saved)
    assert.ok(calls.includes('providers.settings'))
    assert.ok(!calls.includes('workspace.saveProfile'))
  }
  for (const settings of [
    () => ({ activeProvider: null, providers: { openai: { model: 'gpt-4.1-mini', configured: false } } }),
    () => { throw new Error('Unavailable') },
  ]) {
    await open(null, settings)
    assert.equal(await scenario.inputValue(), 'gpt-6.2-sol')
    assert.equal(budget, null)
  }

  const help = page.locator('#budget-scenario-help')
  const available = Object.entries(rateCards).filter(([, card]) => !card.legacy)
  const options = await scenario.locator('option').evaluateAll(nodes => nodes.map(node => node.value))
  assert.deepEqual(options.sort(), [...available.map(([id]) => id), ...Object.keys(creditCards), 'ollama', 'subscription'].sort())
  for (const [id, card] of [...available, ...Object.entries(creditCards)]) {
    await scenario.selectOption(id)
    if (!card.source) continue
    const sourceLink = help.getByRole('link', { name: card.label + ' pricing', exact: true })
    assert.equal(await sourceLink.getAttribute('href'), card.source)
    assert.equal(await help.locator('time').innerText(), card.verified)
    assert.ok((await help.innerText()).includes('million tokens'))
    if (card.note) assert.ok((await help.innerText()).includes(card.note))
  }
  await scenario.selectOption('gpt-6.2-astra')
  await help.getByRole('link').press('Enter')
  assert.equal(sourceUrls.at(-1), rateCards['gpt-6.2-astra'].source)
  assert.match(await page.locator('#budget-daily-estimate').innerText(), /\$0.28 to \$0.80/)
  await open(null, () => ({ activeProvider: 'openai', providers: { openai: { model: 'gpt-4.1-mini' } } }))
  await waitForValue('openai')
  assert.equal(await scenario.locator('option:checked').innerText(), rateCards.openai.label)
  await scenario.selectOption('gpt-6.2-sol')
  assert.equal(await scenario.locator('option[value="openai"]').count(), 0)
  await open({ version: 2, provider: 'openai', rates: { openai: { input: 1, output: 3 } } }, codex)
  await waitForValue('openai')
  assert.match(await help.innerText(), /edited model prices/)
  await open({ version: 2, provider: 'openai', rates: { openai: { input: 0.4, output: 1.6 } } }, codex)
  await waitForValue('gpt-6.2-sol')
  assert.equal(await scenario.locator('option[value="openai"]').count(), 0)

  const storedCarbon = { ...budgetDefaults('2026-11-25'), provider: 'gemini-4-carbon' }
  await page.clock.setFixedTime(new Date(2026, 10, 30, 22))
  await open(storedCarbon, codex)
  await page.getByLabel('Jobs per day', { exact: true }).fill('100')
  await page.clock.setFixedTime(new Date(2026, 11, 1, 8))
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  assert.equal(await page.locator('.budget-amount').innerText(), '$1.40 to $4.00')
  assert.doesNotMatch(await help.innerText(), /edited model prices/)
  assert.ok(!calls.includes('workspace.saveProfile'))

  await page.clock.setFixedTime(new Date(2026, 11, 2, 12))
  await open(storedCarbon, codex)
  assert.match(await help.innerText(), /\$4\.00 USD for input and \$20\.00 USD for output/)
  assert.doesNotMatch(await help.innerText(), /edited model prices/)
  assert.equal(await page.locator('.budget-amount').innerText(), '$0.14 to $0.40')
  await page.getByText('Token and pricing assumptions', { exact: true }).click()
  assert.equal(await page.getByLabel('Input USD per million tokens', { exact: true }).inputValue(), '4')

  await open(null, () => ({ activeProvider: 'anthropic', providers: {anthropic:{model:'claude-sonnet-4-6'}} }))
  await waitForValue('anthropic')
  await page.getByText('Draft connection:', {exact:false}).waitFor()
  assert.match(await page.locator('#budget-daily-estimate').innerText(), /\$0.105 to \$0.30/)
  await open(null, () => ({ activeProvider:'gemini', providers:{gemini:{model:'fixture-model'}} }))
  await waitForValue('custom')
  assert.match(await page.locator('#budget-daily-estimate').innerText(), /Price needed/)
  assert.match(await page.locator('.budget-month figcaption').innerText(), /Cumulative token usage/)
  await page.getByText('Token and pricing assumptions', {exact:true}).click()
  const inputPrice = page.getByLabel('Input USD per million tokens', {exact:true})
  const outputPrice = page.getByLabel('Output USD per million tokens', {exact:true})
  await inputPrice.fill('0')
  assert.match(await page.locator('#budget-daily-estimate').innerText(), /Price needed/)
  await outputPrice.fill('2')
  assert.match(await page.locator('#budget-daily-estimate').innerText(), /\$0.006 to \$0.016/)
  await open({ version:1, provider:'openrouter', rates:{openrouter:{input:1,output:4}} }, codex)
  await page.getByText('Token and pricing assumptions', {exact:true}).click()
  assert.match(await page.locator('#budget-daily-estimate').innerText(), /Price needed/)
  await page.getByRole('button',{name:'Use these prices'}).click()
  assert.match(await page.locator('#budget-daily-estimate').innerText(), /\$0.032 to \$0.092/)

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
    if (action === 'save') assert.equal(budget.provider, 'gpt-6.2-sol')
    if (action !== 'save') assert.equal(budget, null)
  }
  console.log('Passed budget defaults, model and credit choices, pricing sources, legacy selections and delayed settings.')
} finally {
  await app?.close()
  await rm(temp, { recursive: true, force: true })
}
