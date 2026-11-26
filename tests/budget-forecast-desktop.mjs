// Run after building the renderer: node tests/budget-forecast-desktop.mjs
// PLUTO_SMOKE_EXECUTABLE selects a packaged app. PLUTO_BUDGET_SCREENSHOT saves a day 15 PNG.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import { enterFixtureWorkspace, fixtureEnvironment } from './setup-fixture.mjs'

const checkout = fileURLToPath(new URL('..', import.meta.url))
const executablePath = process.env.PLUTO_SMOKE_EXECUTABLE && path.resolve(process.env.PLUTO_SMOKE_EXECUTABLE)
const root = await mkdtemp(path.join(tmpdir(), 'pluto-budget-forecast-'))
const profile = path.join(root, 'profile')
const button = (scope, name) => scope.getByRole('button', { name, exact: true })
const snapshot = page => page.evaluate(() => window.pluto.call('workspace.snapshot'))

// Use the displayed height of the plot as the unit, so resizing or scrolling the window
// cannot masquerade as a change in the forecast. Sample the actual rendered SVG curve.
async function curve(plot, selector) {
  return plot.locator(selector).evaluate(node => {
    const rect = node.closest('.budget-plot').getBoundingClientRect()
    const matrix = node.getScreenCTM()
    const length = node.getTotalLength()
    return [0, 0.25, 0.5, 0.75, 1].map(fraction => {
      const point = node.getPointAtLength(fraction * length).matrixTransform(matrix)
      return { x: (point.x - rect.left) / rect.width, y: (point.y - rect.top) / rect.height }
    })
  })
}

// The synthetic custom rate is $1 per million input tokens. Each job uses 10k to
// 20k input tokens, so the independently calculated cost is exactly 1 to 2 cents.
function cost(jobs) {
  return jobs ? '$' + (jobs / 100).toFixed(2) + ' to $' + (jobs / 50).toFixed(2) : '$0.00'
}

async function exercise(page) {
  const nav = page.getByRole('navigation', { name: 'Workspace' })
  await button(nav, 'Daily budget').click()
  const target = page.getByRole('spinbutton', { name: 'Jobs per day', exact: true })
  const assumptions = page.getByText('Token and pricing assumptions', { exact: true })
  await page.getByLabel('Pricing scenario', { exact: true }).selectOption('custom')
  await assumptions.click()
  for (const [label, value] of [
    ['High input tokens per role', '20000'], ['Low input tokens per role', '10000'],
    ['Low output tokens per role', '0'], ['High output tokens per role', '0'],
    ['Input USD per million tokens', '1'], ['Output USD per million tokens', '0'],
    ['Separate tool charges in USD per role', '0'],
  ]) await page.getByLabel(label, { exact: true }).fill(value)
  await assumptions.click()
  await target.fill('40')
  await button(page, 'Save budget').click()
  await page.getByText('Budget assumptions saved.', { exact: true }).waitFor()
  const saved = (await snapshot(page)).profile.budget
  assert.equal(saved.jobsPerDay, 40)
  await button(nav, 'Today').click()
  await button(nav, 'Daily budget').click()
  assert.equal(await target.inputValue(), '40')

  const forecast = page.locator('.budget-forecast')
  const plot = forecast.locator('.budget-plot')
  const pathData = () => plot.locator('.budget-low, .budget-high').evaluateAll(
    paths => paths.map(path => path.getAttribute('d')))
  const slider = forecast.getByRole('slider', { name: 'Forecast day', exact: true })
  const table = forecast.getByRole('table', { name: 'Daily and cumulative budget forecast' })
  const cells = label => table.getByRole('row').filter({
    has: page.getByRole('rowheader', { name: label, exact: true }),
  }).getByRole('cell')

  async function checkDay(day, jobs) {
    await table.getByRole('columnheader', { name: 'Through day ' + day, exact: true }).waitFor()
    assert.equal(await slider.inputValue(), String(day))
    await forecast.locator('figcaption').getByText('Day ' + day, { exact: true }).waitFor()
    assert.equal(await forecast.locator('.budget-chart-value').innerText(), cost(day * jobs))
    assert.deepEqual(await cells('Jobs').allInnerTexts(), [jobs, day * jobs].map(n => n.toLocaleString('en-US')))
    assert.deepEqual(await cells('Estimated total').allInnerTexts(), [cost(jobs), cost(day * jobs)])
  }

  await slider.press('End')
  await checkDay(30, 40)
  const baseline = await curve(plot, '.budget-high')
  const savedPaths = await pathData()
  await target.fill('20')
  await checkDay(30, 20)
  const draft = await curve(plot, '.budget-high')
  const draftPaths = await pathData()
  const sameShape = (a, b) => a.every((p, i) =>
    Math.abs(p.x - b[i].x) < 0.001 && Math.abs(p.y - b[i].y) < 0.001)
  console.log('40 → 20 jobs/day, day 30:', cost(1200), '→', cost(600),
    '| normalized high endpoint y:', baseline.at(-1).y.toFixed(4), '→', draft.at(-1).y.toFixed(4),
    '| both SVG paths identical:', savedPaths.length === 2 && savedPaths.every((d, i) => d === draftPaths[i]))
  const origin = baseline[0].y
  const savedRise = origin - baseline.at(-1).y
  assert.ok(savedRise > 0.05, 'Saved high must span a measurable height')
  assert.ok(draft.at(-1).y - baseline.at(-1).y > savedRise * 0.1,
    'Halving the target must move the high endpoint visibly below the saved 40 jobs/day endpoint')

  async function checkAgainstSaved(fraction) {
    await forecast.getByText('Saved plan high', { exact: true }).waitFor()
    const reference = await curve(plot, '.budget-comparison')
    const current = await curve(plot, '.budget-high')
    const low = await curve(plot, '.budget-low')
    const base = reference[0].y
    const rise = base - reference.at(-1).y
    assert.ok(rise > 0.05, 'Saved high must remain visible')
    for (const [i, point] of current.entries()) {
      assert.ok(Math.abs(point.x - reference[i].x) < 0.01, 'Compare the same position on the time axis')
      assert.ok(Math.abs((base - point.y) - fraction * (base - reference[i].y)) < 0.02 * rise,
        'Draft heights must scale with the target relative to the saved high')
      assert.ok(Math.abs((base - low[i].y) - (base - reference[i].y) * fraction / 2) < 0.02 * rise,
        'The draft low must track its fixed 1:2 ratio on the same axis')
    }
    return reference
  }
  const reference = await checkAgainstSaved(0.5)
  assert.ok(sameShape(reference, baseline), 'The saved 40 jobs/day curve must stay in place during the edit')

  const compare = button(forecast, 'Saved plan high')
  await compare.click()
  assert.equal(await compare.getAttribute('aria-pressed'), 'false')
  assert.equal(await plot.locator('.budget-comparison').count(), 0)
  assert.ok((await curve(plot, '.budget-high')).at(-1).y < draft.at(-1).y, 'Hiding the reference fits the draft')
  await compare.click()
  await target.fill('50')
  await checkDay(30, 50)
  assert.ok(sameShape(baseline, await checkAgainstSaved(1.25)), 'A higher target should rise above the saved curve')

  // Set the draft back to 20 using the same target slider a user sees.
  const jobsSlider = page.getByRole('slider', { name: 'Adjust jobs per day' })
  await jobsSlider.press('Home')
  for (let i = 0; i < 20; i++) await jobsSlider.press('ArrowRight')
  await checkDay(30, 20)
  async function selectHorizon(days) {
    const period = button(forecast, days + ' days')
    await period.click()
    assert.equal(await period.getAttribute('aria-pressed'), 'true')
    assert.equal(await slider.getAttribute('max'), String(days))
    await slider.press('End')
    await checkDay(days, 20)
    await checkAgainstSaved(0.5)
  }
  await selectHorizon(7)
  await slider.press('ArrowLeft')
  await checkDay(6, 20)
  await slider.press('ArrowRight')
  await checkDay(7, 20)
  await selectHorizon(30)
  await slider.scrollIntoViewIfNeeded()
  const box = await slider.boundingBox()
  await slider.hover({ position: { x: box.width / 2, y: box.height / 2 } })
  await checkDay(15, 20)
  if (process.env.PLUTO_BUDGET_SCREENSHOT) {
    await slider.blur()
    await page.evaluate(() => document.fonts.ready)
    await forecast.screenshot({ path: process.env.PLUTO_BUDGET_SCREENSHOT, type: 'png', animations: 'disabled', scale: 'css' })
  }
  await target.fill('0')
  await slider.press('End')
  await checkDay(30, 0)
  const zeroReference = await checkAgainstSaved(0)
  assert.ok(sameShape(zeroReference, baseline), 'Zero jobs must preserve the saved reference')
  assert.deepEqual((await snapshot(page)).profile.budget, saved, 'Previewing 20 or 0 jobs must preserve the saved budget')
}

let app
try {
  await mkdir(profile)
  app = await electron.launch({ executablePath, cwd: root, env: fixtureEnvironment(root), args: [
    '--user-data-dir=' + profile, '--disable-background-networking', '--disable-component-update',
    '--disable-sync', '--host-resolver-rules=MAP * ~NOTFOUND', ...(executablePath ? [] : [checkout]),
  ] })
  const identity = await app.evaluate(({ app }) => ({
    profile: app.getPath('userData'), executable: process.execPath, version: app.getVersion(),
  }))
  assert.equal(await realpath(identity.profile), await realpath(profile))
  if (executablePath) assert.equal(await realpath(identity.executable), await realpath(executablePath))
  console.log('Testing Project Pluto', identity.version, 'at', identity.executable)
  const page = await app.firstWindow()
  page.setDefaultTimeout(8000)
  await enterFixtureWorkspace(page)
  const initial = await snapshot(page)
  assert.equal(initial.jobs.length, 0)
  assert.equal(initial.schedule.enabled, false)
  await exercise(page)
  console.log('Passed native forecast geometry, saved comparison, horizons, keyboard, hover and zero jobs.')
} finally {
  try { await app?.close() }
  finally { await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }) }
}
