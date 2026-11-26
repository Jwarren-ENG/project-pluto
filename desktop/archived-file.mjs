import { createHash } from 'node:crypto'
import { constants, createWriteStream, rmSync } from 'node:fs'
import { lstat, mkdtemp, open, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { isRecordedPdf } from './recorded-material.mjs'

const copies = new Set()
function removeCopies() {
  for (const directory of copies) {
    try { rmSync(directory, { recursive: true, force: true }) } catch { /* The system viewer may still hold the file. */ }
  }
}

async function systemOpen(file) {
  const { shell } = await import('electron')
  return shell.openPath(file)
}

function within(root, file) {
  const relative = path.relative(root, file)
  return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
}

async function openSource(workspacePath, recordedPath) {
  const root = await realpath(workspacePath)
  // Accept the importer's absolute paths and paths stored relative to the managed workspace.
  // The workspace itself can have a platform alias such as /var on macOS.
  const absolute = path.resolve(workspacePath, recordedPath)
  const candidate = within(workspacePath, absolute)
    ? path.join(root, path.relative(workspacePath, absolute)) : absolute
  if (!within(root, candidate) || path.relative(candidate, await realpath(candidate)) !== '') throw new Error()
  const before = await lstat(candidate)
  if (!before.isFile()) throw new Error()
  const file = await open(candidate, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const stat = await file.stat()
    const resolved = await realpath(candidate)
    if (path.relative(candidate, resolved) !== '') throw new Error()
    const after = await lstat(resolved)
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino ||
        stat.dev !== after.dev || stat.ino !== after.ino) throw new Error()
    return file
  } catch (error) {
    await file.close()
    throw error
  }
}

export async function openArchivedMaterial(request, { getJob, managed, openPath = systemOpen, tempDirectory = tmpdir() }) {
  if (!request || Object.keys(request).some(key => key !== 'id' && key !== 'materialIndex') ||
      typeof request.id !== 'string' || !request.id || !Number.isSafeInteger(request.materialIndex) || request.materialIndex < 0) {
    throw new Error('Choose a recorded submission attachment.')
  }
  const job = await getJob(request.id)
  const materials = job?.submittedSnapshot?.materials
  const material = Array.isArray(materials) && materials[request.materialIndex]
  if (job?.id !== request.id || !isRecordedPdf(material)) throw new Error('No confirmed PDF is recorded for this attachment.')
  const workspacePath = managed?.workspacePath
  if (typeof workspacePath !== 'string' || !path.isAbsolute(workspacePath)) throw new Error('Connect the private job workspace to view this PDF.')

  let file, directory
  try {
    file = await openSource(workspacePath, material.path)
    directory = await mkdtemp(path.join(tempDirectory, 'pluto-submission-'))
    copies.add(directory)
    if (!process.listeners('exit').includes(removeCopies)) process.once('exit', removeCopies)
    const copy = path.join(directory, 'Submitted material.pdf')
    const digest = createHash('sha256')
    const signature = Buffer.from('%PDF-')
    let checked = 0
    const hashBytes = new Transform({
      transform(chunk, encoding, done) {
        const prefix = chunk.subarray(0, signature.length - checked)
        if (!prefix.equals(signature.subarray(checked, checked + prefix.length))) return done(new Error())
        checked += prefix.length
        digest.update(chunk)
        done(null, chunk)
      },
    })
    await pipeline(file.createReadStream({ start: 0 }), hashBytes,
      createWriteStream(copy, { flags: 'wx', mode: 0o600 }))
    if (checked !== signature.length || digest.digest('hex') !== material.sha256.toLowerCase()) throw new Error()
    if (await openPath(copy) !== '') throw new Error()
    return true
  } catch {
    if (directory) {
      copies.delete(directory)
      await rm(directory, { recursive: true, force: true }).catch(() => {})
    }
    throw new Error('The recorded PDF could not be verified or opened. Check the file in your private workspace.')
  } finally {
    await file?.close()
  }
}
