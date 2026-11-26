import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { openArchivedMaterial } from '../desktop/archived-file.mjs'

const pdf = Buffer.from('%PDF-1.4\nSynthetic attachment\n%%EOF\n')
const digest = bytes => createHash('sha256').update(bytes).digest('hex')

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'pluto-archive-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const workspacePath = path.join(root, 'workspace')
  const tempDirectory = path.join(root, 'copies')
  await mkdir(path.join(workspacePath, 'materials'), { recursive: true })
  await mkdir(tempDirectory)
  const material = { path: 'materials/example.pdf', sha256: digest(pdf), attachmentConfirmed: true, kind: 'resume' }
  const source = path.join(workspacePath, material.path)
  await writeFile(source, pdf)
  const id = 'example-role'
  const job = { id, submittedSnapshot: { materials: [null, material] } }
  const opened = []
  const options = { managed: { workspacePath }, tempDirectory, getJob: key => key === id ? job : null,
    openPath: async file => { opened.push(file); return '' } }
  const view = (request = { id, materialIndex: 1 }) => openArchivedMaterial(request, options)
  return { root, source, workspacePath, tempDirectory, material, job, opened, options, view }
}

test('opens verified bytes from relative and absolute snapshot paths in private PDF copies', async t => {
  const { source, material, tempDirectory, opened, view } = await fixture(t)
  assert.equal(await view(), true)
  material.path = source
  material.sha256 = material.sha256.toUpperCase()
  assert.equal(await view(), true)
  await writeFile(source, 'replacement')
  assert.equal(new Set(opened).size, 2)
  for (const file of opened) {
    assert.equal(path.dirname(path.dirname(file)), tempDirectory)
    assert.equal(path.basename(file), 'Submitted material.pdf')
    assert.deepEqual(await readFile(file), pdf)
    if (process.platform !== 'win32') {
      assert.equal((await stat(file)).mode & 0o077, 0)
      assert.equal((await stat(path.dirname(file))).mode & 0o077, 0)
    }
  }
})

test('rejects unconfirmed, unmatched, non-PDF and missing material before opening', async t => {
  const { source, material, view, opened, tempDirectory } = await fixture(t)
  const original = { ...material }
  for (const change of [{ attachmentConfirmed: false }, { attachmentConfirmed: 1 }, { sha256: '' },
    { sha256: '0'.repeat(64) }, { path: 'materials/example.txt' }, { path: 'missing.pdf' }]) {
    Object.assign(material, original, change)
    await assert.rejects(view())
  }
  const text = Buffer.from('ordinary text in a file with a PDF extension')
  Object.assign(material, original, { sha256: digest(text) })
  await writeFile(source, text)
  await assert.rejects(view(), /could not be verified/)
  assert.deepEqual(opened, [])
  assert.deepEqual(await readdir(tempDirectory), [])
})

test('only accepts an id and immutable snapshot index, including when tracker metadata exists', async t => {
  const { job, material, view, opened } = await fixture(t)
  job.localJobTracker = { materials: [material] }
  for (const request of [null, { id: job.id, materialIndex: 0 }, { id: job.id, materialIndex: 2 },
    { id: job.id, materialIndex: -1 }, { id: job.id, materialIndex: '1' }, { id: 'missing', materialIndex: 1 },
    { id: job.id, materialIndex: 1, path: material.path }]) {
    await assert.rejects(view(request))
  }
  delete job.submittedSnapshot
  await assert.rejects(view())
  assert.deepEqual(opened, [])
})

test('refuses outside files and symlink paths even when the recorded digest matches', async t => {
  const { root, workspacePath, source, material, opened, view } = await fixture(t)
  const sibling = path.join(root, 'workspace-other')
  await mkdir(sibling)
  const outside = path.join(sibling, 'example.pdf')
  await writeFile(outside, pdf)
  const paths = [outside, path.relative(workspacePath, outside)]
  const folderLink = path.join(workspacePath, 'redirect')
  await symlink(sibling, folderLink, process.platform === 'win32' ? 'junction' : 'dir')
  paths.push(path.join(folderLink, 'example.pdf'))
  if (process.platform !== 'win32') {
    const fileLink = path.join(workspacePath, 'link.pdf')
    await symlink(source, fileLink)
    paths.push(fileLink)
  }
  for (const entry of paths) {
    material.path = entry
    await assert.rejects(view(), error => /could not be verified/.test(error.message) && !error.message.includes(root))
  }
  assert.deepEqual(opened, [])
})

test('removes an unopenable viewer copy and requires the managed workspace', async t => {
  const { view, options, tempDirectory } = await fixture(t)
  options.openPath = async () => 'system viewer failed'
  await assert.rejects(view(), /could not be verified or opened/)
  assert.deepEqual(await readdir(tempDirectory), [])
  options.workspacePath = options.managed.workspacePath
  options.managed = null
  await assert.rejects(view(), /Connect the private job workspace/)
})
