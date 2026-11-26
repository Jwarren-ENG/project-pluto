// Run with node tests/optional-workflows-desktop.mjs after building the renderer.
// Set PLUTO_WORKFLOWS_SCREENSHOT to a PNG path to capture the Interview prep requirements.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import { createConfig } from '../desktop/config.mjs'
import { enterFixtureWorkspace } from './setup-fixture.mjs'

const checkout = fileURLToPath(new URL('..', import.meta.url))
const executablePath = process.env.PLUTO_SMOKE_EXECUTABLE && path.resolve(process.env.PLUTO_SMOKE_EXECUTABLE)
const root = await mkdtemp(path.join(os.tmpdir(), 'pluto-optional-workflows-'))
const profile = path.join(root, 'profile')
const labels = { studyGuides: 'Study guides', interviewPrep: 'Interview prep', emailCheck: 'Email checker', autoApply: 'Auto apply' }
const off = { studyGuides: false, interviewPrep: false, emailCheck: false, autoApply: false }
const on = { studyGuides: true, interviewPrep: true, emailCheck: true, autoApply: true }
const mixed = { studyGuides: false, interviewPrep: true, emailCheck: false, autoApply: true }

const button = (scope, name) => scope.getByRole('button', { name, exact: true })
const nav = (page, name) => button(page.getByRole('navigation', { name: 'Workspace' }), name).click()
const region = page => page.getByRole('region', { name: 'Optional workflows', exact: true })
const toggle = (page, key) => region(page).getByRole('switch', { name: labels[key], exact: true })
const call = (page, action, payload = {}) => page.evaluate(([name, data]) => window.pluto.call(name, data), [action, payload])
const focused = element => element.evaluate(node => node === node.ownerDocument.activeElement)

async function desktop(run) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(PATH|SystemRoot|WINDIR|LANG|LC_ALL|DISPLAY|WAYLAND_DISPLAY|XAUTHORITY|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS)$/i.test(key)))
  const app = await electron.launch({ executablePath, env, cwd: root, args: [
    '--user-data-dir=' + profile, '--disable-background-networking', '--disable-sync',
    '--disable-component-update', '--host-resolver-rules=MAP * ~NOTFOUND', ...(executablePath ? [] : [checkout]),
  ] })
  try {
    assert.equal(await realpath(await app.evaluate(({ app }) => app.getPath('userData'))), await realpath(profile))
    if (executablePath) assert.equal(await realpath(await app.evaluate(() => process.execPath)), await realpath(executablePath))
    const unexpected = []
    await app.context().route(/^https?:\/\//, route => {
      unexpected.push('Renderer network request')
      return route.abort()
    })
    await app.evaluate(({ shell, clipboard }) => {
      globalThis.workflowEffects = []
      const reject = name => async () => {
        globalThis.workflowEffects.push(name)
        throw new Error('Unexpected external action: ' + name)
      }
      globalThis.fetch = reject('Main process network request')
      shell.openExternal = reject('External app')
      shell.openPath = reject('External file')
      // Inspect the real handoff text without opening an assistant or using the system clipboard.
      clipboard.writeText = text => { globalThis.workflowCopy = text }
    })
    const page = await app.firstWindow()
    page.on('pageerror', error => unexpected.push(error.message))
    page.setDefaultTimeout(8000)
    await enterFixtureWorkspace(page)
    await run(page, app)
    assert.deepEqual(unexpected, [])
    assert.deepEqual(await app.evaluate(() => globalThis.workflowEffects), [])
    const snapshot = await call(page, 'workspace.snapshot')
    assert.equal(snapshot.jobs.length, 0)
    assert.equal(snapshot.notes.length, 0)
    assert.equal(snapshot.schedule.enabled, false)
  } finally {
    await app.close()
  }
}

async function controls(page, key) {
  const control = toggle(page, key)
  const id = await control.getAttribute('aria-controls')
  assert.ok(id, labels[key] + ' must identify its requirements panel')
  const panel = region(page).locator('[id="' + id + '"]')
  assert.equal(await panel.count(), 1)
  const disclosure = button(region(page), 'Requirements').and(region(page).locator('[aria-controls="' + id + '"]'))
  return { control, panel, disclosure }
}

async function checkPreferences(page, expected) {
  assert.deepEqual((await call(page, 'workspace.snapshot')).features, expected)
  await region(page).waitFor()
  assert.equal(await region(page).getByRole('switch').count(), 4)
  for (const [key, enabled] of Object.entries(expected)) {
    const { control, panel, disclosure } = await controls(page, key)
    assert.equal(await control.getAttribute('aria-checked'), String(enabled), labels[key])
    assert.equal(await disclosure.isEnabled(), enabled)
    assert.equal(await disclosure.getAttribute('aria-expanded'), String(enabled))
    assert.equal(await panel.isVisible(), enabled)
  }
}

async function setSwitch(page, key, enabled) {
  const control = toggle(page, key)
  assert.equal(await control.getAttribute('aria-checked'), String(!enabled))
  await control.press('Space')
  await region(page).getByRole('switch', { name: labels[key], exact: true, checked: enabled })
    .and(region(page).locator(':enabled')).waitFor()
}

async function checkHandoff(page, app, features) {
  await app.evaluate(() => { globalThis.workflowCopy = null })
  await call(page, 'jobkit.copyTask', { skill: 'run' })
  const text = await app.evaluate(() => globalThis.workflowCopy)
  assert.match(text, features.autoApply ? /verify autoApply is still true/i : /do not submit any applications/i)
  assert.match(text, features.emailCheck ? /verify optionalWorkflows\.emailCheck is still true/i : /do not access any mailbox/i)
}

async function checkGates(page, features) {
  for (const kind of ['studyGuides', 'interviewPrep']) {
    if (!features[kind]) await assert.rejects(call(page, 'learning.draft', { kind, jobId: 'fictional-role' }), new RegExp('Turn on ' + labels[kind]))
  }
  if (!features.interviewPrep) await assert.rejects(call(page, 'jobkit.copyTask', { skill: 'interview-prep' }), /Turn on Interview prep/)
  if (!features.emailCheck) {
    for (const action of ['mail.scan', 'mail.recordUpdate', 'mail.verificationCode']) {
      await assert.rejects(call(page, action, { provider: 'gmail', jobId: 'fictional-role' }), /Turn on Email checker/)
    }
  }
}

try {
  await mkdir(profile)
  const kit = path.join(root, 'fictional-kit')
  await mkdir(kit)
  const config = createConfig(profile, {})
  try { config.prefs.set('jobkit.managed', { configured: true, workspacePath: kit }) }
  finally { config.close() }

  await desktop(async (page, app) => {
    await nav(page, 'Applications')
    await button(page, 'Optional workflow settings').press('Enter')
    assert.ok(await focused(region(page).getByRole('heading', { name: 'Optional workflows' })))
    await checkPreferences(page, off)
    await checkGates(page, off)
    await checkHandoff(page, app, off)

    const expected = { ...off }
    for (const key of ['interviewPrep', 'studyGuides', 'emailCheck', 'autoApply']) {
      await setSwitch(page, key, true)
      expected[key] = true
      await checkPreferences(page, expected)
      if (key === 'interviewPrep' && process.env.PLUTO_WORKFLOWS_SCREENSHOT) {
        await toggle(page, key).blur()
        await page.evaluate(() => document.fonts.ready)
        await region(page).screenshot({ path: process.env.PLUTO_WORKFLOWS_SCREENSHOT, type: 'png', animations: 'disabled', scale: 'css' })
      }
      const { disclosure, panel } = await controls(page, key)
      await disclosure.press('Enter')
      assert.equal(await disclosure.getAttribute('aria-expanded'), 'false')
      assert.equal(await panel.isVisible(), false)
      assert.ok(await focused(disclosure))
      await disclosure.press('Space')
      assert.equal(await disclosure.getAttribute('aria-expanded'), 'true')
      assert.equal(await panel.isVisible(), true)
      assert.ok(await focused(disclosure))
    }
    for (const [key, action, heading] of [['studyGuides', 'AI connection', 'AI for drafts'], ['emailCheck', 'Email connection', 'Email']]) {
      const { panel } = await controls(page, key)
      await button(panel, action).press('Enter')
      assert.ok(await focused(page.getByRole('heading', { name: heading, exact: true })))
    }
    await checkHandoff(page, app, on)
  })

  await desktop(async page => {
    await nav(page, 'Connections')
    await checkPreferences(page, on)
    await setSwitch(page, 'studyGuides', false)
    await setSwitch(page, 'emailCheck', false)
    await checkPreferences(page, mixed)
  })
  await desktop(async (page, app) => {
    await nav(page, 'Connections')
    await checkPreferences(page, mixed)
    await checkGates(page, mixed)
    await checkHandoff(page, app, mixed)
    await nav(page, 'Notebook')
    assert.equal(await button(page, 'Draft study guide').count(), 0)
    assert.ok(await button(page, 'Draft interview prep').isDisabled())
  })
  console.log('Passed native optional workflow switches, disclosures, focus, service gates and relaunch persistence.')
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 })
}
