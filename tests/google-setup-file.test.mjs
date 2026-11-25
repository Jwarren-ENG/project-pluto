import assert from 'node:assert/strict'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { pickGoogleSetupFile } from '../desktop/google-setup-file.mjs'

test('native picker accepts one small local JSON file and keeps errors free of file contents and paths', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pluto-google-setup-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const selected = path.join(dir, 'setup.json')
  let choice = { canceled: true }
  const dialog = { showOpenDialog: async (parent, options) => {
    assert.equal(parent, 'main-window')
    assert.deepEqual(options.properties, ['openFile'])
    assert.deepEqual(options.filters[0].extensions, ['json'])
    return choice
  } }
  const pick = () => pickGoogleSetupFile(dialog, 'main-window')
  assert.equal(await pick(), null)
  choice = { canceled: false, filePaths: [selected] }
  const sample = { installed: { client_id: 'example.apps.googleusercontent.com' } }
  await writeFile(selected, JSON.stringify(sample))
  assert.deepEqual(await pick(), sample)
  for (const invalid of ['private-invalid-contents', ' '.repeat(65537)]) {
    await writeFile(selected, invalid)
    await assert.rejects(pick(), err => /Could not read/.test(err.message) && !err.message.includes(dir) && !err.message.includes('private-invalid'))
  }
  if (process.platform !== 'win32') {
    const link = path.join(dir, 'link.json')
    await symlink(selected, link)
    choice.filePaths = [link]
    await assert.rejects(pick(), /Could not read/)
  }
  choice.filePaths = ['setup.json']
  await assert.rejects(pick(), /Choose one local/)
})
