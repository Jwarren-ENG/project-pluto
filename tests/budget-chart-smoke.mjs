// Exercise the built renderer with fictional assumptions and a disposable Electron profile.
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { _electron as electron } from 'playwright'
import { budgetDefaults } from '../ui/budget-estimate.mjs'

const temp = await mkdtemp(path.join(tmpdir(), 'pluto-budget-chart-'))
const index = pathToFileURL(path.resolve(process.argv[2] || 'dist', 'index.html')).href
let budget = { ...budgetDefaults('2026-11-25'), provider: 'custom', jobsPerDay: 2,
  inputLow: 1000, inputHigh: 2000, outputLow: 100, outputHigh: 200, toolCostPerRole: 0.5 }
budget.rates.custom = { input: 1000, output: 0 }
let app
try {
  const entry = path.join(temp, 'main.cjs')
  await writeFile(entry, `const { app, BrowserWindow } = require('electron'); let win;
    app.whenReady().then(() => {win = new BrowserWindow({show:false, width:1152, height:800,
      webPreferences:{sandbox:true,contextIsolation:true}}); win.loadURL('about:blank')})`)
  app = await electron.launch({ args: ['--user-data-dir=' + temp, entry] })
  const page = await app.firstWindow()
  const calls = []
  await page.exposeFunction('chartFixture', (action, payload) => {
    calls.push(action)
    if (action === 'workspace.snapshot') return { profile: { budget }, jobs: [], notes: [], schedule: {} }
    if (action === 'providers.settings') return { activeProvider: null }
    if (action === 'workspace.saveProfile') { budget = payload.budget; return }
    if (action === 'app.openExternal') {
      assert.equal(payload.url, 'https://www.eia.gov/electricity/monthly/epm_table_grapher.php?t=epmt_5_6_a')
      return
    }
    throw new Error('Unexpected chart action ' + action)
  })
  await page.addInitScript(() => { window.pluto = { call: window.chartFixture } })
  await page.clock.setFixedTime(new Date(2026, 10, 25, 12))
  await page.goto(index)
  await page.getByRole('navigation').getByRole('button', { name: 'Daily budget', exact: true }).click()
  const plot = page.getByRole('slider', { name: 'Forecast day', exact: true })
  const table = page.getByRole('table', { name: 'Daily and cumulative budget forecast' })
  const cells = label => table.getByRole('row').filter({ has: page.getByRole('rowheader', { name: label, exact: true }) }).getByRole('cell')
  const lastCell = label => cells(label).last()
  const daily = page.locator('#budget-daily-estimate')
  async function check(day, jobs, readout, row = 'Estimated total') {
    await table.getByRole('columnheader', { name: 'Through day ' + day, exact: true }).waitFor()
    assert.equal(await plot.inputValue(), String(day))
    assert.equal(await page.locator('.budget-month figcaption span').innerText(), 'Day ' + day)
    assert.equal(await page.locator('.budget-chart-value').innerText(), readout)
    assert.equal(await lastCell('Jobs').innerText(), (day * jobs).toLocaleString('en-US'))
    assert.equal(await lastCell(row).innerText(), readout.replace(/ tokens$/, ''))
    assert.ok((await plot.getAttribute('aria-valuetext')).includes(readout))
    assert.ok(Math.abs(parseFloat(await page.locator('.budget-cursor').getAttribute('x1')) - day / 30 * 100) < 0.001)
  }
  await plot.scrollIntoViewIfNeeded()
  await check(30, 2, '$90.00 to $150.00')
  async function point(day) {
    const box = await plot.boundingBox()
    return { x: box.x + day / 30 * box.width, y: box.y + box.height / 2 }
  }
  async function moveMouse(day, steps = 1) {
    const { x, y } = await point(day)
    await page.mouse.move(x, y, { steps })
  }
  await moveMouse(15)
  await check(15, 2, '$45.00 to $75.00')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(980, 720))
  await page.waitForFunction(() => window.innerWidth === 980)
  await plot.scrollIntoViewIfNeeded()
  await moveMouse(15)
  await page.mouse.down()
  await moveMouse(24, 6)
  await page.mouse.up()
  await check(24, 2, '$72.00 to $120.00')
  await plot.click({ position: { x: 1, y: 5 } })
  await check(0, 2, '$0.00')
  await page.keyboard.press('Tab')
  await page.keyboard.press('Shift+Tab')
  await plot.press('ArrowRight')
  await check(1, 2, '$3.00 to $5.00')
  assert.ok(await plot.evaluate(el => el.matches(':focus-visible')))
  await plot.press('End')
  await check(30, 2, '$90.00 to $150.00')
  await plot.press('ArrowLeft')
  await check(29, 2, '$87.00 to $145.00')
  await plot.press('Home')
  await check(0, 2, '$0.00')

  // Chromium's touch events exercise native range interaction, including dragging while held.
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 })
  async function touch(type, day) {
    await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [await point(day)] })
  }
  await touch('touchStart', 10)
  await touch('touchEnd')
  await check(10, 2, '$30.00 to $50.00')
  await touch('touchStart', 10)
  await touch('touchMove', 17)
  await check(17, 2, '$51.00 to $85.00')
  await touch('touchMove', 21)
  await touch('touchEnd')
  await check(21, 2, '$63.00 to $105.00')
  await cdp.detach()
  assert.match(await daily.innerText(), /\$3\.00 to \$5\.00/)

  const scenario = page.getByLabel('Pricing scenario', { exact: true })
  const jobs = page.getByLabel('Jobs per day', { exact: true })
  const assumptions = page.getByText('Token and pricing assumptions', { exact: true })
  const toolCost = page.getByLabel('Separate tool charges in USD per role')
  await scenario.selectOption('subscription')
  await check(21, 2, '46,200 to 92,400 tokens', 'Estimated tokens')
  assert.equal(await lastCell('Estimated total').innerText(), 'Fee unspecified')
  await jobs.fill('')
  assert.equal(await plot.count(), 0)
  await jobs.fill('0')
  await check(21, 0, '0 tokens', 'Estimated tokens')
  assert.deepEqual(calls, ['workspace.snapshot', 'providers.settings'])
  await jobs.fill('2')
  for (const [id, dailyCredits, cumulative] of [
    ['codex-sol-credits', '0.15 to 0.3 credits', '3.15 to 6.3 credits'],
    ['codex-astra-credits', '0.6 to 1.2 credits', '12.6 to 25.2 credits'],
  ]) {
    await scenario.selectOption(id)
    assert.equal(await daily.locator('strong').innerText(), dailyCredits)
    assert.equal(await cells('Purchased credits').first().innerText(), dailyCredits)
    await check(21, 2, cumulative, 'Purchased credits')
    assert.equal(await lastCell('Tool charges').innerText(), '$21.00')
    assert.equal(await cells('Estimated total').count(), 0)
    assert.match(await page.locator('#budget-scenario-help').innerText(), /allowance.*uncached.*Standard/)
  }

  await scenario.selectOption('ollama')
  const electricity = page.getByRole('group', { name: 'Local electricity' })
  const watts = electricity.getByLabel('Average power (W)', { exact: true })
  const low = electricity.getByLabel('Low minutes per job', { exact: true })
  const high = electricity.getByLabel('High minutes per job', { exact: true })
  const rate = electricity.getByLabel('Electricity rate (USD/kWh)', { exact: true })
  assert.deepEqual(await Promise.all([watts, low, high, rate].map(field => field.inputValue())), ['60', '2', '6', '0.1817'])
  await electricity.getByRole('link', { name: 'EIA electricity prices, Table 5.6.A' }).press('Enter')
  assert.ok(calls.includes('app.openExternal'))
  await assumptions.click()
  await toolCost.fill('0')
  await assumptions.click()
  await jobs.fill('100')
  await watts.fill('60')
  await low.fill('2')
  await high.fill('6')
  assert.equal(await daily.locator('strong').innerText(), '$0.0363 to $0.109')
  await rate.fill('0.20')
  assert.equal(await daily.locator('strong').innerText(), '$0.04 to $0.12')
  await plot.press('End')
  await check(30, 100, '$1.20 to $3.60')
  assert.deepEqual(await cells('Model fees').allTextContents(), ['$0.00', '$0.00'])
  assert.deepEqual(await cells('Energy use').allTextContents(), ['0.2 to 0.6 kWh', '6 to 18 kWh'])
  assert.deepEqual(await cells('Electricity').allTextContents(), ['$0.04 to $0.12', '$1.20 to $3.60'])
  await high.fill('1')
  assert.equal(await table.count(), 0)
  assert.equal(await page.getByRole('button', { name: 'Save budget' }).isDisabled(), true)
  await high.fill('6')
  await page.getByRole('button', { name: 'Save budget' }).click()
  await page.getByText('Budget assumptions saved.', { exact: true }).waitFor()
  assert.equal(budget.electricityRate, 0.2)
  await page.getByRole('navigation').getByRole('button', { name: 'Today', exact: true }).click()
  await page.getByRole('navigation').getByRole('button', { name: 'Daily budget', exact: true }).click()
  assert.equal(await rate.inputValue(), '0.2')
  assert.equal(await daily.locator('strong').innerText(), '$0.04 to $0.12')

  // Six launch-price days starting November 25, then 24 days at the December 1 rates.
  for (const id of ['gemini-4-carbon', 'gemini-4-argon']) {
    await scenario.selectOption(id)
    assert.equal(await daily.locator('strong').innerText(), '$0.30 to $0.60')
    await plot.press('End')
    await check(30, 100, '$16.20 to $32.40')
    await plot.press('Home')
    for (let i = 0; i < 6; i++) await plot.press('ArrowRight')
    await check(6, 100, '$1.80 to $3.60')
    // Sample the rendered SVG in its own coordinate system at the change of slope.
    const geometry = await page.locator('.budget-plot').evaluate(node => {
      function heightAt(path, x) {
        let left = 0, right = path.getTotalLength()
        for (let i = 0; i < 24; i++) {
          const middle = (left + right) / 2
          if (path.getPointAtLength(middle).x < x) left = middle
          else right = middle
        }
        return path.getPointAtLength(right).y
      }
      const band = node.querySelector('.budget-band')
      const inside = y => band.isPointInFill(new DOMPoint(20, y))
      return {
        lower: heightAt(node.querySelector('.budget-low'), 20), upper: heightAt(node.querySelector('.budget-high'), 20),
        inside: inside(87), above: inside(82), below: inside(92),
      }
    })
    assert.ok(Math.abs(geometry.lower - 90) < 0.001)
    assert.ok(Math.abs(geometry.upper - 85) < 0.001)
    assert.deepEqual([geometry.inside, geometry.above, geometry.below], [true, false, false])
    await plot.press('ArrowRight')
    await check(7, 100, '$2.40 to $4.80')
  }
  await assumptions.click()
  await page.getByLabel('Input USD per million tokens', { exact: true }).fill('3')
  assert.match(await page.locator('#budget-scenario-help').innerText(), /edited model prices/)
  await plot.press('End')
  await check(30, 100, '$12.00 to $24.00')
  console.log('Passed chart interaction, credits, local electricity, saved overrides and scheduled daily price curves.')
} finally {
  await app?.close()
  await rm(temp, { recursive: true, force: true })
}
