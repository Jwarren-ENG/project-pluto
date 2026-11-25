// Launch the built executable, exercise its ordinary renderer IPC, and import a
// synthetic PDF. Run on the same OS and CPU as the package under test.
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, access, realpath } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright'

const platform = process.platform
assert.ok(['darwin', 'win32'].includes(platform), 'Run this check on a macOS or Windows build host.')
const appName = 'Project Pluto'
const binary = platform === 'darwin'
  ? path.join(process.arch === 'arm64' ? 'mac-arm64' : 'mac', appName + '.app', 'Contents', 'MacOS', appName)
  : path.join('win-unpacked', appName + '.exe')
const executablePath = process.env.PLUTO_SMOKE_EXECUTABLE || path.resolve('release', binary)
await access(executablePath)

function pdfFixture() {
  const stream = 'BT /F1 12 Tf 40 700 Td (Packaged Pluto PDF fixture) Tj ET'
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', '<< /Length ' + stream.length + ' >>\nstream\n' + stream + '\nendstream']
  let pdf = '%PDF-1.4\n'
  const offsets = []
  objects.forEach((object, i) => {
    offsets.push(pdf.length)
    pdf += (i + 1) + ' 0 obj\n' + object + '\nendobj\n'
  })
  const xref = pdf.length
  return pdf + 'xref\n0 6\n0000000000 65535 f \n' + offsets.map(n => String(n).padStart(10, '0') + ' 00000 n \n').join('') +
    'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n'
}

const directory = await mkdtemp(path.join(os.tmpdir(), 'pluto-packaged-'))
const userData = path.join(directory, 'workspace')
const fixture = path.join(directory, 'sample.pdf')
let application
try {
  await writeFile(fixture, pdfFixture(), 'ascii')
  application = await electron.launch({ executablePath, args: ['--user-data-dir=' + userData], timeout: 45000 })
  application.on('console', msg => { if (msg.type() === 'error') console.error(msg.text()) })
  console.log('Started packaged executable.')
  const identity = await application.evaluate(({ app, Menu }) => ({
    menuName: Menu.getApplicationMenu()?.items[0]?.label, name: app.getName(), packaged: app.isPackaged, archive: app.getAppPath(), profile: app.getPath('userData'), arch: process.arch,
  }))
  assert.equal(identity.name, appName)
  if (platform === 'darwin') assert.equal(identity.menuName, appName)
  assert.equal(identity.packaged, true)
  assert.match(identity.archive, /app\.asar$/)
  assert.equal(await realpath(identity.profile), await realpath(userData))
  assert.equal(identity.arch, process.arch)
  const locked = await application.evaluate(({app}) => {
    const require = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json')
    return require('./desktop/omniroute-runtime/dependency-lock.json').packages['node_modules/omniroute']?.integrity
  })
  assert.match(locked, /^sha512-/)
  const window = await application.firstWindow({ timeout: 30000 })
  window.on('pageerror', error => console.error('Renderer error:', error.message))
  await window.waitForFunction(() => Boolean(document.querySelector('#root')?.firstElementChild), undefined, { timeout: 20000 })
  assert.equal(await window.title(), appName)
  console.log('Loaded packaged renderer.')
  assert.deepEqual(await window.evaluate(async () => (await window.pluto.call('workspace.snapshot', {})).jobs), [])

  // Resolve the native dependency from inside app.asar and invoke the binary.
  const nativeWidth = await application.evaluate(({ app }) => {
    const path = process.getBuiltinModule('path')
    const localRequire = process.getBuiltinModule('module').createRequire(path.join(app.getAppPath(), 'package.json'))
    const canvas = localRequire('@napi-rs/canvas')
    return canvas.createCanvas(2, 2).width
  })
  assert.equal(nativeWidth, 2)
  console.log('Loaded packaged native canvas.')
  await application.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  }, fixture)
  const imported = await window.evaluate(() => window.pluto.call('resume.pick', {}))
  assert.equal(imported.name, 'sample.pdf')
  assert.match(imported.text, /Packaged Pluto PDF fixture/)
  const accounts = await window.evaluate(() => window.pluto.call('mail.settings', {}))
  assert.deepEqual(accounts.map(a => a.provider).sort(), (platform === 'darwin' ? ['apple','gmail','outlook'] : ['gmail','outlook']))
  assert.ok(accounts.every(a => !a.email && !a.error))
  console.log('Verified packaged renderer, native canvas, PDF import and empty workspace on ' + platform + ' ' + identity.arch + '.')
} finally {
  try { await application?.close() }
  finally { await rm(directory, { force: true, recursive: true, maxRetries: 5, retryDelay: 200 }) }
}
