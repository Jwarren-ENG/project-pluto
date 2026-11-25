import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import path from 'node:path'

const maxBytes = 64 * 1024

export async function pickGoogleSetupFile(dialog, parent) {
  const options = { title: 'Import Google setup file', properties: ['openFile'],
    filters: [{ name: 'Google desktop setup', extensions: ['json'] }] }
  const { canceled, filePaths } = await (parent ? dialog.showOpenDialog(parent, options) : dialog.showOpenDialog(options))
  if (canceled) return null
  const selected = filePaths?.[0]
  if (filePaths?.length !== 1 || typeof selected !== 'string' || !path.isAbsolute(selected) ||
      /^[\\/]{2}/.test(selected) || path.extname(selected).toLowerCase() !== '.json') {
    throw new Error('Choose one local Google desktop setup JSON file.')
  }
  let file
  try {
    const before = await lstat(selected)
    if (!before.isFile()) throw new Error()
    file = await open(selected, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    const stat = await file.stat()
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino || stat.size > maxBytes) throw new Error()
    const buffer = Buffer.alloc(stat.size + 1)
    let count = 0
    while (count < buffer.length) {
      const { bytesRead } = await file.read(buffer, count, buffer.length - count)
      if (!bytesRead) break
      count += bytesRead
    }
    if (count !== stat.size) throw new Error()
    return JSON.parse(buffer.toString('utf8', 0, count))
  } catch { throw new Error('Could not read that setup file. Choose the desktop client JSON downloaded from Google Cloud.') }
  finally { await file?.close() }
}
