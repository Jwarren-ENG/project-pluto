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
const budget = { ...budgetDefaults(), provider: 'custom', jobsPerDay: 2,
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
  await page.exposeFunction('chartFixture', action => {
    calls.push(action)
    if (action === 'workspace.snapshot') return { profile: { budget }, jobs: [], notes: [], schedule: {} }
    if (action === 'providers.settings') return { activeProvider: null }
    throw new Error('Unexpected chart action ' + action)
  })
  await page.addInitScript(() => { window.pluto = { call: window.chartFixture } })
  await page.goto(index)
  await page.getByRole('navigation').getByRole('button', { name: 'Daily budget', exact: true }).click()
  const plot = page.getByRole('slider', { name: 'Forecast day', exact: true })
  const table = page.getByRole('table', { name: 'Daily and cumulative budget forecast' })
  const lastCell = label => table.getByRole('row').filter({ has: page.getByRole('rowheader', { name: label, exact: true }) }).getByRole('cell').last()
  const daily = page.locator('#budget-daily-estimate')
  async function check(day, jobs, readout, subscription = false) {
    await table.getByRole('columnheader', { name: 'Through day ' + day, exact: true }).waitFor()
    assert.equal(await plot.inputValue(), String(day))
    assert.equal(await page.locator('.budget-month figcaption span').innerText(), 'Day ' + day)
    assert.equal(await page.locator('.budget-chart-value').innerText(), readout)
    assert.equal(await lastCell('Jobs').innerText(), String(day * jobs))
    assert.equal(await lastCell(subscription ? 'Estimated tokens' : 'Estimated total').innerText(), readout.replace(/ tokens$/, ''))
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

  await page.getByLabel('Pricing scenario', { exact: true }).selectOption('subscription')
  await check(21, 2, '46,200 to 92,400 tokens', true)
  assert.equal(await lastCell('Estimated total').innerText(), 'Fee unspecified')
  await page.getByLabel('Jobs per day', { exact: true }).fill('')
  assert.equal(await plot.count(), 0)
  await page.getByLabel('Jobs per day', { exact: true }).fill('0')
  await check(21, 0, '0 tokens', true)
  assert.deepEqual(calls, ['workspace.snapshot', 'providers.settings'])
  console.log('Passed forecast hover, click, drag, keyboard, touch, cumulative totals and scenario changes.')
} finally {
  await app?.close()
  await rm(temp, { recursive: true, force: true })
}
