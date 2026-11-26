// Run after building the renderer: node tests/notebook-desktop.mjs
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright'
import { createConfig } from '../desktop/config.mjs'
import { createWorkspace } from '../desktop/workspace.mjs'

const root = await mkdtemp(path.join(tmpdir(), 'pluto-notebook-desktop-'))
const data = path.join(root, 'user-data')
const home = path.join(root, 'home')
const vault = path.join(root, 'Synthetic vault')
const button = (scope, name) => scope.getByRole('button', { name, exact: true })
const field = (scope, name) => scope.getByLabel(name, { exact: true })
const snapshot = page => page.evaluate(() => window.pluto.call('workspace.snapshot'))
const appPath = path.resolve(process.env.PLUTO_NOTEBOOK_APP || '.')
const executablePath = process.env.PLUTO_SMOKE_EXECUTABLE && path.resolve(process.env.PLUTO_SMOKE_EXECUTABLE)
let app, writer, config
const modelCalls = []
let draftReply = 'A synthetic Markdown draft.'
const model = createServer(async (request, response) => {
  let raw = ''
  for await (const chunk of request) raw += chunk
  response.setHeader('Content-Type', 'application/json')
  if (request.url === '/api/tags') response.end(JSON.stringify({ models: [{ name: 'fixture' }] }))
  else if (request.url === '/api/show') response.end(JSON.stringify({ model_info: {} }))
  else if (request.url === '/api/chat') {
    modelCalls.push(JSON.parse(raw))
    response.end(JSON.stringify({ message: { content: draftReply } }))
  } else response.writeHead(404).end()
})
const refreshFromTracker = page => page.evaluate(() => window.dispatchEvent(new Event('focus')))
const waitForBody = (page, expected) => page.waitForFunction(body => document.querySelector('textarea')?.value === body, expected)

async function checkEditing(page, app, job, note) {
  const nav = page.getByRole('navigation', { name: 'Workspace' })
  const markdown = field(page, 'Markdown')
  const discard = page.getByRole('alertdialog')
  await markdown.fill('Unsaved local changes')
  writer.saveNote({ id: note.id, body: 'A newer source revision.' })
  await refreshFromTracker(page)
  const reload = button(page, 'Discard edits and load saved version')
  await reload.waitFor()
  assert.equal(await markdown.inputValue(), 'Unsaved local changes')
  assert.ok(await button(page, 'Save note').isDisabled())
  await button(nav, 'Today').click()
  await button(discard, 'Keep editing').click()
  assert.equal(await markdown.inputValue(), 'Unsaved local changes')
  await reload.click()
  await button(discard, 'Discard changes').click()
  await waitForBody(page, 'A newer source revision.')
  await markdown.fill('Reviewed locally.')
  await button(page, 'Save note').click()
  await button(page, 'Close').click()
  const search = field(page, 'Find a note')
  await search.fill('Reviewed locally.')
  await button(page, 'Edit Interview preparation').click()
  assert.equal(await markdown.inputValue(), 'Reviewed locally.')
  await button(page, 'Close').click()
  await button(page, 'New note').click()
  await field(page, 'Title').fill('Print run checklist')
  await field(page, 'Linked application').selectOption(job.id)
  await markdown.fill('Original checklist.')
  await button(page, 'Save note').click()
  await button(page, 'Close').click()
  const saved = (await snapshot(page)).notes.find(row => row.title === 'Print run checklist')
  assert.equal(saved.jobId, job.id)
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] })
  }, vault)
  await button(page, 'Export to vault').click()
  await page.getByText(/3 written · 0 imported/).waitFor()
  const folder = path.join(vault, 'Project Pluto')
  const file = path.join(folder, (await readdir(folder)).find(name => name.endsWith(saved.id + '.md')))
  await writeFile(file, (await readFile(file, 'utf8')).replace('Original checklist.', 'Edited in the synthetic vault.'))
  await button(page, 'Import vault edits').click()
  await page.getByText(/0 written · 1 imported/).waitFor()
  await search.fill('synthetic vault')
  await button(page, 'Edit Print run checklist').click()
  assert.equal(await markdown.inputValue(), 'Edited in the synthetic vault.')
  await button(page, 'Close').click()
  await search.fill('')
}

async function checkGeneration(page, job) {
  const nav = page.getByRole('navigation', { name: 'Workspace' })
  const study = button(page, 'Draft study guide')
  const prep = button(page, 'Draft interview prep')
  const role = field(page, 'Tracked role')
  const settings = button(page, 'Manage in Connections')
  const baseline = (await snapshot(page)).notes
  assert.equal(await study.count() + await prep.count(), 0)
  await settings.click()
  const heading = page.getByRole('heading', { name: 'Optional workflows', exact: true })
  assert.ok(await heading.evaluate(el => el === document.activeElement))
  async function toggle(name, enabled) {
    const control = page.getByRole('switch', { name, exact: true })
    assert.equal(await control.getAttribute('aria-checked'), String(!enabled))
    await control.click()
    await page.getByRole('switch', { name, exact: true, checked: enabled }).waitFor()
  }
  await toggle('Study guides', true)
  await button(nav, 'Notebook').click()
  assert.equal(await prep.count(), 0)
  await role.selectOption(job.id)
  assert.ok(await study.isDisabled(), 'Drafts require reviewed material')
  writer.saveProfile({
    confirmedFacts: [{ text: 'Reviewed the print queue each morning.' }],
    resumeText: 'PRIVATE unselected raw résumé', applicationAnswers: { notice: 'PRIVATE notice' },
    experienceStories: [{ action: 'PRIVATE story', useInDrafts: false }],
  })
  await refreshFromTracker(page)
  await study.click()
  await page.getByRole('alert').filter({ hasText: /provider.*Connections/i }).waitFor()
  assert.deepEqual((await snapshot(page)).notes, baseline)
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve))
  await page.evaluate(endpoint => window.pluto.call('providers.configure', { provider: 'ollama', model: 'fixture', endpoint }),
    'http://127.0.0.1:' + model.address().port)
  assert.equal(modelCalls.length, 0)
  await study.click()
  await waitForBody(page, draftReply)
  assert.equal(modelCalls.length, 1)
  assert.match(modelCalls[0].messages[0].content, /study guide/i)
  const context = JSON.parse(modelCalls[0].messages[1].content)
  assert.equal(context.job.title, job.title)
  assert.deepEqual(context.profile.confirmedFacts, ['Reviewed the print queue each morning.'])
  assert.doesNotMatch(JSON.stringify(context), /PRIVATE/)
  assert.deepEqual((await snapshot(page)).notes, baseline, 'Generation alone must not save a note')
  await field(page, 'Markdown').fill('Reviewed study guide.')
  await button(nav, 'Today').click()
  await button(page.getByRole('alertdialog'), 'Keep editing').click()
  await button(page, 'Save note').click()
  await button(page, 'Close').click()
  assert.equal((await snapshot(page)).notes.filter(row => row.body === 'Reviewed study guide.' && row.jobId === job.id).length, 1)
  await settings.click()
  await toggle('Study guides', false)
  await toggle('Interview prep', true)
  await button(nav, 'Notebook').click()
  assert.equal(await study.count(), 0)
  assert.ok(await prep.isDisabled(), 'Opening Notebook leaves the role unselected')
  await role.selectOption(job.id)
  draftReply = 'A fictional practice question.'
  await prep.click()
  await waitForBody(page, draftReply)
  assert.equal(modelCalls.length, 2)
  assert.match(modelCalls[1].messages[0].content, /practice interview/i)
  await button(page, 'Close').click()
  await button(page.getByRole('alertdialog'), 'Discard changes').click()
  await settings.click()
  await toggle('Interview prep', false)
  await button(nav, 'Notebook').click()
  assert.equal(await study.count() + await prep.count(), 0)
  await button(page, 'Edit Study guide · Example Press · Production Analyst').click()
  assert.equal(await field(page, 'Markdown').inputValue(), 'Reviewed study guide.')
  assert.equal((await snapshot(page)).notes.length, baseline.length + 1)
  assert.equal(modelCalls.length, 2)
}

try {
  await mkdir(home)
  await mkdir(vault)
  writer = createWorkspace(data)
  config = createConfig(data, {})
  const job = writer.saveJob({ company: 'Example Press', title: 'Production Analyst' })
  const firstBody = '## Interview questions\n\n' + Array.from({ length: 250 }, (_, i) =>
    (i + 1) + '. Review the sample delivery schedule for a fictional print run.').join('\n')
  const note = writer.saveNote({ id: 'managed-prep', jobId: job.id, title: 'Interview preparation', body: firstBody })
  config.prefs.set('jobkit.noteFiles', { [note.id]: 'Interviews/Print schedule.md' })
  config.prefs.set('jobkit.managed', { configured: true, vaultPath: vault })
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(PATH|SystemRoot|WINDIR|LANG|LC_ALL|DISPLAY|WAYLAND_DISPLAY|XAUTHORITY|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS)$/i.test(key)))
  app = await electron.launch({ executablePath,
    args: ['--user-data-dir=' + data, '--disable-background-networking', '--disable-sync',
      '--disable-component-update', '--host-resolver-rules=MAP * ~NOTFOUND', ...(executablePath ? [] : [appPath])],
    env: { ...env, HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
      XDG_CONFIG_HOME: home, XDG_DATA_HOME: home, XDG_CACHE_HOME: home, CODEX_HOME: home,
      TEMP: home, TMP: home, TMPDIR: home },
  })
  assert.equal(await realpath(await app.evaluate(({ app }) => app.getPath('userData'))), await realpath(data))
  if (executablePath) assert.equal(await realpath(await app.evaluate(() => process.execPath)), await realpath(executablePath))
  const page = await app.firstWindow()
  page.setDefaultTimeout(6000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await app.evaluate(({ shell }) => {
    globalThis.notebookOpened = []
    shell.openExternal = async url => { globalThis.notebookOpened.push(url) }
  })
  const nav = page.getByRole('navigation', { name: 'Workspace' })
  await button(nav, 'Applications').click()
  await button(page, 'Open Production Analyst at Example Press').click()
  await button(nav, 'Notebook').click()
  const search = field(page, 'Find a note')
  await search.fill('sample delivery')
  await button(page, 'Edit Interview preparation').click()
  const markdown = field(page, 'Markdown')
  assert.equal(await markdown.inputValue(), firstBody)
  await button(page, 'Open original note in Obsidian').click()
  assert.deepEqual(await app.evaluate(() => globalThis.notebookOpened), [
    'obsidian://open?path=' + encodeURIComponent(path.join(vault, 'Interviews', 'Print schedule.md')),
  ])

  // A managed tracker can update a note while the user is reading it in Pluto.
  const nextBody = firstBody + '\n\nUpdated by the synthetic tracker.'
  writer.saveNote({ ...note, body: nextBody })
  await refreshFromTracker(page)
  await waitForBody(page, nextBody)
  assert.ok(await button(page, 'Save note').isEnabled())
  assert.ok(await markdown.evaluate(el => el.clientHeight < innerHeight && el.scrollHeight > el.clientHeight),
    'Long Markdown scrolls inside the editor')
  await checkEditing(page, app, job, note)
  await checkGeneration(page, job)
  assert.deepEqual(errors, [])
  console.log('Desktop Notebook passed: managed note refresh, conflict handling, navigation, vault round trip and both optional drafts.')
} finally {
  await app?.close()
  if (model.listening) await new Promise(resolve => model.close(resolve))
  config?.close()
  writer?.close()
  await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 })
}
