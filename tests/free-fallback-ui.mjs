// Run with node tests/free-fallback-ui.mjs. All provider calls use the local fixture.
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { _electron as electron } from 'playwright'
import { build } from 'vite'

const directory = await mkdtemp(path.join(tmpdir(), 'pluto-free-fallback-'))
const automatic = 'openrouter/free'
const models = [
  { id: 'fixture/new:free', label: 'New example' },
  { id: 'fixture/older:free', label: 'Older example' },
]
let status = { enabled: false, phase: 'off', hasKey: false, models: [], selectedModel: automatic, modelCount: 0 }
const commands = []
let app, failRead, failSelection, delayedPoll
try {
  const ui = fileURLToPath(new URL('../ui', import.meta.url))
  const require = createRequire(import.meta.url)
  await writeFile(path.join(directory, 'index.html'), '<div id="root"></div><script type="module" src="./fixture.jsx"></script>')
  await writeFile(path.join(directory, 'fixture.jsx'), [
    "import React, {useState} from 'react'",
    "import {createRoot} from 'react-dom/client'",
    "import FreeFallback from '@/FreeFallback.jsx'",
    "function App() { const [view, show] = useState('Today');",
    "return <><nav>{['Today','Connections'].map(v => <button key={v} onClick={() => show(v)}>{v}</button>)}</nav>",
    "{view === 'Connections' && <FreeFallback />}</> }",
    "createRoot(document.getElementById('root')).render(<App />)",
  ].join('\n'))
  await build({ root: directory, base: './', configFile: false, envDir: false, logLevel: 'error',
    resolve: { alias: { '@': ui, react: path.dirname(require.resolve('react')), 'react-dom/client': require.resolve('react-dom/client') } } })
  const entry = path.join(directory, 'main.cjs')
  await writeFile(entry, "const {app,BrowserWindow}=require('electron'); let win; app.whenReady().then(()=>{win=new BrowserWindow({show:false});win.loadURL('about:blank')})")
  app = await electron.launch({ args: ['--user-data-dir=' + directory, entry] })
  const page = await app.firstWindow()
  page.setDefaultTimeout(7000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.exposeFunction('fixtureCall', async (action, payload) => {
    if (action === 'providers.fallbackStatus') {
      if (failRead) { failRead = false; throw new Error('Fixture read failure') }
      if (delayedPoll) {
        const gate = delayedPoll
        delayedPoll = null
        gate.started.resolve()
        return gate.reply.promise
      }
      return status
    }
    commands.push([action, payload])
    if (action === 'providers.enableFallback') status = { ...status, hasKey: true, enabled: true, phase: 'starting', error: '' }
    else if (action === 'providers.disableFallback') status = { ...status, enabled: false, phase: 'off' }
    else if (action === 'providers.setFallbackModel') {
      if (failSelection) { failSelection = false; throw new Error('Fixture save failure') }
      status = { ...status, selectedModel: payload.model }
    } else throw new Error('Unexpected fixture action ' + action)
    return status
  })
  await page.addInitScript(() => { window.pluto = { call: window.fixtureCall } })
  await page.goto(pathToFileURL(path.join(directory, 'dist', 'index.html')).href)
  const navigate = name => page.getByRole('navigation').getByRole('button', { name, exact: true }).click()
  const panel = page.getByRole('region', { name: 'Free drafting fallback' })
  const toggle = panel.getByRole('switch')
  const dialog = page.getByRole('dialog', { name: 'Enable OmniRoute for drafts?' })
  const confirm = dialog.getByRole('button', { name: 'Enable fallback', exact: true })
  const picker = panel.getByLabel('Fallback model', { exact: true })
  const phase = text => panel.getByRole('status').filter({ hasText: text }).waitFor()

  failRead = true
  await navigate('Connections')
  await panel.getByRole('button', { name: 'Retry status' }).click()
  await phase('Off')
  assert.equal(await picker.inputValue(), automatic)
  await toggle.focus()
  await page.keyboard.press('Space')
  await dialog.getByText(/reviewed profile and job details to OpenRouter and its free serving provider/).waitFor()
  assert.equal(await confirm.isDisabled(), true)
  const input = dialog.getByLabel('Dedicated OpenRouter API key')
  assert.equal(await input.getAttribute('type'), 'password')
  await input.fill('discarded-example')
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'hidden' })
  assert.deepEqual(commands, [])
  assert.equal(await toggle.evaluate(el => el === document.activeElement && !el.checked), true)
  await toggle.click()
  assert.equal(await input.inputValue(), '')
  await input.fill('  fixture-key  ')
  await confirm.click()
  await phase('Starting OmniRoute')
  assert.deepEqual(commands, [['providers.enableFallback', { apiKey: 'fixture-key' }]])
  status = { ...status, phase: 'downloading', stage: 'catalog', bytes: 17, totalBytes: null }
  await phase('Downloading the free model list')
  await panel.getByText('17 bytes', { exact: true }).waitFor()
  assert.equal(await panel.getByRole('progressbar').getAttribute('value'), null)
  status = { ...status, phase: 'installing', bytes: 32, totalBytes: 64 }
  await panel.getByText('32 of 64 bytes').waitFor()
  assert.equal(await panel.getByRole('progressbar').evaluate(el => el.position), 0.5)

  await navigate('Today')
  status = { ...status, phase: 'checking' }
  await navigate('Connections')
  await phase('Checking')
  status = { ...status, phase: 'ready', models: [{ id: automatic, label: 'Router' }, ...models], modelCount: 2 }
  await phase('Ready for drafting')
  assert.deepEqual(await picker.locator('option').allTextContents(), ['Automatic (free models)', 'New example', 'Older example'])
  await picker.selectOption(models[0].id)
  await navigate('Today')
  await navigate('Connections')
  await phase('Ready for drafting')
  assert.equal(await picker.inputValue(), models[0].id)
  assert.deepEqual(commands.slice(1), [['providers.setFallbackModel', { model: models[0].id }]])
  failSelection = true
  await picker.selectOption(automatic)
  await panel.getByRole('alert').filter({ hasText: 'Couldn’t save' }).waitFor()
  await phase('Ready for drafting')
  assert.equal(await picker.inputValue(), models[0].id)

  await navigate('Today')
  status = { ...status, models: [] }
  await navigate('Connections')
  assert.equal(await picker.inputValue(), models[0].id)
  await picker.selectOption(automatic)
  await navigate('Today')
  status = { ...status, phase: 'error', error: 'Fixture installer unavailable.' }
  await navigate('Connections')
  await panel.getByText(status.error, { exact: true }).waitFor()
  await panel.getByRole('button', { name: 'Retry setup' }).click()
  assert.equal(await dialog.getByRole('radio', { name: 'Use saved OpenRouter key' }).isChecked(), true)
  assert.deepEqual(commands.at(-1), ['providers.setFallbackModel', { model: automatic }])
  await dialog.getByRole('radio', { name: 'Use a dedicated key' }).check()
  assert.equal(await confirm.isDisabled(), true)
  await dialog.getByRole('radio', { name: 'Use saved OpenRouter key' }).check()
  const gate = { started: Promise.withResolvers(), reply: Promise.withResolvers() }
  delayedPoll = gate
  await confirm.click()
  await phase('Starting OmniRoute')
  assert.deepEqual(commands.at(-1), ['providers.enableFallback', {}])
  await gate.started.promise
  await toggle.click()
  await phase('Off')
  const stale = { ...status, enabled: true, phase: 'ready' }
  gate.reply.resolve(stale)
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  assert.equal(await toggle.isChecked(), false)
  assert.deepEqual(commands.at(-1), ['providers.disableFallback', {}])

  // A key saved in the adjacent connection form is immediately available for enrollment.
  await navigate('Today')
  status = { ...status, hasKey: false }
  await navigate('Connections')
  await phase('Off')
  status = { ...status, hasKey: true }
  const previousCommands = commands.length
  await toggle.click()
  await dialog.getByRole('radio', { name: 'Use saved OpenRouter key' }).waitFor()
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  assert.equal(commands.length, previousCommands)
  assert.deepEqual(errors, [])
  console.log('Passed fallback consent, keyboard cancellation, key choices, background phases, model selection, retries, and stale status checks.')
} finally {
  await app?.close()
  await rm(directory, { recursive: true, force: true })
}
