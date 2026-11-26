// Run against a built checkout: node tests/onboarding-desktop.mjs
// PLUTO_ONBOARDING_APP can point to an isolated test build with the same Electron entry.
// PLUTO_SETUP_SCREENSHOT=docs/images/setup-welcome.png captures the fresh welcome screen.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright'
import { createWorkspace } from '../desktop/workspace.mjs'

const root = await mkdtemp(path.join(tmpdir(), 'pluto-onboarding-'))
const source = path.join(root, 'Morgan Rowan.txt')
const resume = 'Morgan Rowan\nExperience\nTracked weekly stock levels for a campus bookshop.'
const appPath = path.resolve(process.env.PLUTO_ONBOARDING_APP || '.')
const executablePath = process.env.PLUTO_SMOKE_EXECUTABLE && path.resolve(process.env.PLUTO_SMOKE_EXECUTABLE)
const button = (page, name) => page.getByRole('button', { name, exact: true })
const input = (page, name) => page.getByLabel(name, { exact: true })
const snapshot = page => page.evaluate(() => window.pluto.call('workspace.snapshot'))
const step = async (page, name) => {
  const heading = page.getByRole('heading', { name, level: 1, exact: true })
  await heading.waitFor()
  assert.equal(await heading.evaluate(el => document.activeElement === el), true, 'Focus follows the current step')
}

async function desktop(folder, run) {
  const data = path.join(root, folder)
  const home = path.join(data, 'home')
  await mkdir(home, { recursive: true })
  const system = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(PATH|SystemRoot|WINDIR|LANG|LC_ALL|DISPLAY|WAYLAND_DISPLAY|XAUTHORITY|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS)$/i.test(key)))
  const app = await electron.launch({
    executablePath,
    args: ['--user-data-dir=' + data, '--disable-background-networking', '--disable-sync',
      '--disable-component-update', '--host-resolver-rules=MAP * ~NOTFOUND', ...(executablePath ? [] : [appPath])],
    env: { ...system, HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
      XDG_CONFIG_HOME: home, XDG_DATA_HOME: home, XDG_CACHE_HOME: home, CODEX_HOME: home,
      TEMP: home, TMP: home, TMPDIR: home },
  })
  try {
    assert.equal(await realpath(await app.evaluate(({ app }) => app.getPath('userData'))), await realpath(data))
    if (executablePath) assert.equal(await realpath(await app.evaluate(() => process.execPath)), await realpath(executablePath))
    const rejected = []
    await app.context().route(/^https?:\/\//, route => {
      rejected.push('renderer network')
      return route.abort()
    })
    await app.evaluate(({ shell }) => {
      globalThis.onboardingExternalCalls = []
      const reject = name => async () => {
        globalThis.onboardingExternalCalls.push(name)
        throw new Error('External operation in offline setup test')
      }
      globalThis.fetch = reject('main network')
      shell.openExternal = reject('open browser')
    })
    const page = await app.firstWindow()
    page.setDefaultTimeout(9000)
    page.on('pageerror', err => rejected.push(err.message))
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await run(page, app)
    assert.deepEqual(rejected, [])
    assert.deepEqual(await app.evaluate(() => globalThis.onboardingExternalCalls), [])
  } finally { await app.close() }
}

async function chooseLocal(page, app, trigger, title, file) {
  await app.evaluate(({ dialog }, { title, file }) => {
    dialog.showOpenDialog = async (_window, options) => {
      if (options.title !== title) throw new Error('Unexpected native picker')
      return { canceled: !file, filePaths: file ? [file] : [] }
    }
  }, { title, file })
  await button(page, trigger).click()
  await page.waitForFunction(() => !document.querySelector('.setup-fields').disabled)
}
const chooseResume = (page, app, file) => chooseLocal(page, app, 'Choose résumé file', 'Choose your résumé', file)

try {
  await writeFile(source, resume)
  await desktop('complete', async (page, app) => {
    await step(page, 'Your name and résumé')
    assert.equal(await page.getByRole('navigation', { name: 'Workspace' }).count(), 0)
    const first = await snapshot(page)
    if (process.env.PLUTO_SETUP_SCREENSHOT) {
      await page.evaluate(() => document.fonts.ready)
      await page.screenshot({ path: process.env.PLUTO_SETUP_SCREENSHOT, animations: 'disabled', scale: 'css' })
    }
    assert.equal(await page.locator('.setup-step').evaluate(el => getComputedStyle(el).animationName), 'none')
    for (const width of [740, 390]) {
      await page.setViewportSize({ width, height: 570 })
      assert.ok(await page.locator('.first-run').evaluate(el => el.scrollWidth <= el.clientWidth), 'Setup fits at ' + width)
    }
    await chooseResume(page, app, source)
    assert.equal(await input(page, 'Name').inputValue(), 'Morgan Rowan')
    assert.equal(await input(page, 'Review résumé text').inputValue(), resume)
    await chooseResume(page, app, null)
    assert.equal(await input(page, 'Review résumé text').inputValue(), resume)
    assert.equal((await snapshot(page)).profile, null, 'Choosing and canceling a file only changes the setup draft')
    assert.equal(first.schedule.enabled, false)
  })
  await desktop('complete', async page => {
    await step(page, 'Your name and résumé')
    assert.equal(await input(page, 'Review résumé text').inputValue(), resume)
    const reviewed = resume.replace('weekly', 'monthly')
    await input(page, 'Review résumé text').fill(reviewed)
    await button(page, 'Save and continue').click()
    await step(page, 'What are you looking for?')
    assert.equal((await snapshot(page)).profile.resumeText, reviewed)
    await input(page, 'Target roles').fill('Inventory Analyst')
    await input(page, 'Preferred work locations').fill('Chicago')
    await input(page, 'Preferred work arrangement').selectOption('Hybrid')
    await input(page, 'Earliest start date').fill('2027-06-01')
    await input(page, 'Notice period').fill('Two weeks')
    await button(page, 'Back').click()
    await step(page, 'Your name and résumé')
    await button(page, 'Save and continue').click()
    await step(page, 'What are you looking for?')
    assert.equal(await input(page, 'Target roles').inputValue(), 'Inventory Analyst')
  })
  await desktop('complete', async page => {
    await step(page, 'What are you looking for?')
    assert.equal((await snapshot(page)).profile.location, undefined)
    await page.evaluate(() => window.pluto.call('workspace.saveProfile', {
      applicationAnswers: { relocation: false }, summary: 'Independent profile edit',
    }))
    await button(page, 'Save and continue').click()
    await step(page, 'Choose an inbox')
    await button(page, 'Connect Gmail').waitFor()
    await button(page, 'Connect Outlook').waitFor()
    const profile = (await snapshot(page)).profile
    assert.equal(profile.summary, 'Independent profile edit')
    assert.equal(profile.location, 'Chicago')
    assert.deepEqual(profile.applicationAnswers, { relocation: false, startDate: '2027-06-01', workArrangement: 'Hybrid', notice: 'Two weeks' })
    await button(page, 'Skip this step').click()
    await step(page, 'Choose your drafting provider')
    await button(page, 'ChatGPT').waitFor()
    await button(page, 'API or local model').click()
    await input(page, 'Provider').selectOption('ollama')
    await input(page, 'Model').selectOption('manual')
    await input(page, 'Model ID').fill('synthetic-local')
    await button(page, 'Use for drafts').click()
    await page.getByText('Current provider: Ollama', { exact: false }).waitFor()
    await button(page, 'Continue').click()
    await step(page, 'Plan your daily budget')
    await page.waitForFunction(() => document.querySelector('#budget-provider')?.value === 'ollama')
    await input(page, 'Pricing scenario').selectOption('subscription')
    await input(page, 'Jobs per day').fill('-1')
    assert.ok(await button(page, 'Save budget and open Today').isDisabled())
    await input(page, 'Jobs per day').fill('8')
    assert.match(await page.locator('#budget-daily-estimate').innerText(), /8 jobs per day/)
    assert.equal((await snapshot(page)).profile.budget, undefined)
  })
  await desktop('complete', async page => {
    await step(page, 'Plan your daily budget')
    assert.equal(await input(page, 'Jobs per day').inputValue(), '8')
    assert.equal(await input(page, 'Pricing scenario').inputValue(), 'subscription')
    await button(page, 'Save budget and open Today').click()
    await page.getByRole('heading', { name: 'Today', exact: true }).waitFor()
    const state = await snapshot(page)
    assert.equal(state.profile.budget.jobsPerDay, 8)
    assert.equal(state.profile.budget.provider, 'subscription')
    assert.deepEqual(state.jobs, [])
    assert.equal(state.schedule.enabled, false)
  })
  await desktop('complete', async page => {
    await page.getByRole('heading', { name: 'Today', exact: true }).waitFor()
    const before = (await snapshot(page)).profile
    await button(page, 'Open setup').click()
    await step(page, 'Your name and résumé')
    assert.equal(await input(page, 'Name').inputValue(), 'Morgan Rowan')
    await input(page, 'Name').fill('Discard this edit')
    await button(page, 'Skip this step').click()
    for (const title of ['What are you looking for?', 'Choose an inbox', 'Choose your drafting provider', 'Plan your daily budget']) {
      await step(page, title)
      if (title === 'Plan your daily budget') await input(page, 'Jobs per day').fill('27')
      await button(page, 'Skip this step').click()
    }
    await page.getByRole('heading', { name: 'Today', exact: true }).waitFor()
    assert.deepEqual((await snapshot(page)).profile, before)
  })
  await desktop('skip', async page => {
    await step(page, 'Your name and résumé')
    await input(page, 'Name').fill('Unsaved name')
    await button(page, 'Skip setup').click()
    await page.getByRole('heading', { name: 'Today', exact: true }).waitFor()
    assert.equal((await snapshot(page)).profile, null)
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('pluto.setup.v1'))), { status: 'closed' })
  })
  await desktop('skip', async page => {
    await page.getByRole('heading', { name: 'Today', exact: true }).waitFor()
    assert.equal((await snapshot(page)).profile, null)
  })
  await desktop('kit', async (page, app) => {
    await step(page, 'Your name and résumé')
    const kit = path.join(root, 'fictional-job-kit')
    const exportsDir = path.join(kit, 'exports')
    await mkdir(exportsDir, { recursive: true })
    await writeFile(path.join(exportsDir, 'applications.json'), JSON.stringify([{
      id: 'bookshop', company: 'Harborline Books', role: 'Inventory Analyst',
      url: 'https://example.test/jobs/bookshop', status: 'Shortlisted',
    }]))
    const pickKit = file => chooseLocal(page, app, 'Connect existing job kit', 'Choose your private Job Kit workspace', file)
    await input(page, 'Name').fill('Keep this draft')
    await pickKit(kit)
    await page.getByText('Job kit connected.', { exact: true }).waitFor()
    await pickKit(null)
    await pickKit(exportsDir)
    await page.getByRole('alert').filter({ hasText: /Job Kit workspace/ }).waitFor()
    assert.equal(await input(page, 'Name').inputValue(), 'Keep this draft')
    const status = await page.evaluate(() => window.pluto.call('jobkit.status'))
    assert.equal(status.kit.name, 'fictional-job-kit')
    assert.equal(status.kit.stats.applications, 1)
    await button(page, 'Skip setup').click()
    await button(page, 'Inventory Analyst').waitFor()
    await button(page.getByRole('navigation'), 'Notebook').click()
    await page.getByText(/Kit application · Harborline Books/).first().waitFor()
  })
  for (const kind of ['profile', 'jobs', 'empty']) {
    const dir = 'legacy-' + kind
    const workspace = createWorkspace(path.join(root, dir))
    if (kind === 'profile') workspace.saveProfile({ targetRoles: 'Archivist' })
    if (kind === 'jobs') workspace.saveJob({ company: 'Example Press', title: 'Editor' })
    workspace.close()
    await desktop(dir, async page => {
      await page.getByRole('heading', { name: 'Today', exact: true }).waitFor()
      await button(page, 'Open setup').waitFor()
    })
  }
  await desktop('conflict', async page => {
    await step(page, 'Your name and résumé')
    await input(page, 'Name').fill('Setup edit')
    await page.evaluate(() => window.pluto.call('workspace.saveProfile', { name: 'Imported name' }))
    await button(page, 'Save and continue').click()
    await page.getByRole('alert').filter({ hasText: /profile changed/ }).waitFor()
    await button(page, 'Reload this step').click()
    await page.getByRole('alert').waitFor({ state: 'hidden' })
    await page.waitForFunction(() => document.querySelector('input[autocomplete="name"]')?.value === 'Imported name')
    for (let index = 0; index < 4; index++) await button(page, 'Skip this step').click()
    await step(page, 'Plan your daily budget')
    await input(page, 'Jobs per day').fill('19')
    await page.evaluate(() => window.pluto.call('workspace.saveProfile', { budget: { jobsPerDay: 3 } }))
    await button(page, 'Save budget and open Today').click()
    await page.getByRole('alert').filter({ hasText: /profile changed/ }).waitFor()
    await button(page, 'Reload this step').click()
    await page.waitForFunction(() => document.querySelector('#budget-jobs-count')?.value === '3')
    assert.equal(await input(page, 'Jobs per day').inputValue(), '3')
    await button(page, 'Skip setup').click()
    assert.equal((await snapshot(page)).profile.budget.jobsPerDay, 3)
  })
  await desktop('account-fixture', async (page, app) => {
    await step(page, 'Your name and résumé')
    const settings = await page.evaluate(() => window.pluto.call('providers.settings'))
    // The account picker and sign-in prompts use synthetic replies. This test never opens
    // Apple Mail, a system browser or the computer's actual subscription session.
    const requests = await app.evaluateHandle(({ ipcMain }, settings) => {
      const calls = []
      let email = ''
      ipcMain.removeHandler('pluto:action')
      ipcMain.handle('pluto:action', (_event, key, payload) => {
        calls.push([key, payload])
        switch (key) {
          case 'workspace.dataVersion': return 0
          case 'mail.settings': return [
            { provider: 'apple', available: true }, { provider: 'gmail', direct: false, email },
          ]
          case 'mail.appleAccounts': return [{ id: 'demo', email: 'morgan@example.test', label: 'Bookshop' }]
          case 'mail.connect':
            if (payload.appleAccountId !== 'demo') throw new Error('Expected selected demo inbox')
            email = 'morgan@example.test'
            return
          case 'providers.settings': return settings
          case 'providers.subscriptionStatus': return { state: 'chatgpt' }
          case 'providers.configure':
            if (payload.provider !== 'codex') throw new Error('Unexpected provider')
            settings.activeProvider = 'codex'
            settings.providers.codex.configured = true
            return settings
          default: throw new Error('Unexpected setup action ' + key)
        }
      })
      return calls
    }, settings)
    await button(page, 'Skip this step').click()
    await button(page, 'Skip this step').click()
    await button(page, 'Connect Gmail').click()
    await button(page, 'morgan@example.test').waitFor()
    await button(page, 'Cancel').click()
    await button(page, 'Connect Gmail').click()
    await button(page, 'morgan@example.test').click()
    await button(page, 'Disconnect Gmail').waitFor()
    await button(page, 'Continue').click()
    await button(page, 'ChatGPT').click()
    await button(page, 'Use subscription for drafts').click()
    await button(page, 'Unlink from Pluto').waitFor()
    await button(page, 'Continue').click()
    await step(page, 'Plan your daily budget')
    await page.waitForFunction(() => document.querySelector('#budget-provider')?.value === 'subscription')
    const calls = await requests.jsonValue()
    assert.deepEqual(calls.filter(([key]) => key === 'mail.connect'), [['mail.connect', { provider: 'gmail', appleAccountId: 'demo' }]])
    assert.equal(calls.filter(([key]) => key === 'providers.configure').length, 1)
    const allowed = new Set(['workspace.dataVersion', 'mail.settings', 'mail.appleAccounts', 'mail.connect',
      'providers.settings', 'providers.subscriptionStatus', 'providers.configure'])
    assert.deepEqual(calls.filter(([key]) => !allowed.has(key)), [])
  })
  console.log('Desktop onboarding passed: welcome, reviewed résumé, job kit, relaunch, account choices, budget, conflicts, skips, replay and legacy workspaces.')
} finally { await rm(root, { recursive: true, force: true }) }
