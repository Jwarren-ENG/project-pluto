import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import path from 'node:path'
import { Unzip, UnzipInflate } from 'fflate'

const MAX_BYTES = 5 * 1024 * 1024
const MAX_XML = 2 * 1024 * 1024
const MAX_TEXT = 80_000
const formats = ['pdf', 'docx', 'txt']

class ImportError extends Error {}
const fail = message => { throw new ImportError(message) }

function checkedText(text) {
  if (text.length > MAX_TEXT) fail('The résumé exceeds 80,000 characters. Paste a shorter selection.')
  if (/[\x00-\x08\x0b\x0e-\x1f]/.test(text)) fail('This file contains binary text. Paste the readable résumé text instead.')
  const result = text.replace(/\r\n?/g, '\n').trim()
  if (!result) fail('No readable text was found. For a scanned résumé, paste a text copy.')
  return result
}

function decode(bytes) {
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le'
    : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8'
  return new TextDecoder(encoding, { fatal: true }).decode(bytes)
}

// Read only the main Word body. No archive member is written to disk or used as a path.
function docxText(bytes) {
  if (bytes.readUInt32LE(0) !== 0x04034b50) fail('This file is not a readable DOCX document.')
  const pieces = []
  let entries = 0, length = 0, found = false, complete = false
  const zip = new Unzip(entry => {
    if (++entries > 2048) fail('This DOCX contains too many entries. Paste the résumé text.')
    if (entry.name !== 'word/document.xml') return
    if (found || entry.originalSize > MAX_XML) fail('The Word document body is invalid or too large.')
    found = true
    entry.ondata = (error, data, final) => {
      if (error) throw error
      length += data.length
      if (length > MAX_XML) fail('The Word document body exceeds 2 MiB. Paste the résumé text.')
      pieces.push(data)
      complete = final
    }
    entry.start()
  })
  zip.register(UnzipInflate)
  // Bounded input chunks also bound transient output from a single inflate call.
  for (let i = 0; i < bytes.length; i += 4096) {
    zip.push(bytes.subarray(i, i + 4096), i + 4096 >= bytes.length)
  }
  if (!complete) fail('The DOCX does not contain a complete Word document body.')
  const xml = decode(Buffer.concat(pieces))
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) fail('This Word document uses unsupported XML declarations.')
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
  function unescape(value) {
    return value.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi, (all, entity) => {
      if (Object.hasOwn(entities, entity)) return entities[entity]
      if (!entity.startsWith('#')) return all
      const code = entity[1] === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1))
      return String.fromCodePoint(code)
    })
  }
  // Word may use the default namespace or choose a prefix other than "w".
  const root = xml.match(/<((?:[\w.-]+:)?)document(?=[\s>])([^>]*)>/)
  const ns = root?.[1] || ''
  const xmlns = ns ? 'xmlns:' + ns.slice(0, -1) : 'xmlns'
  const hasWordNamespace = root && Array.from(root[2].matchAll(/\s(xmlns(?:\:[\w.-]+)?)\s*=\s*(["'])(.*?)\2/g))
    .some(([, key, , uri]) => key === xmlns && [
      'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
      'http://purl.oclc.org/ooxml/wordprocessingml/main',
    ].includes(uri))
  if (!hasWordNamespace) fail('The DOCX body is not a recognized Word document.')
  let text = '', inBody = false, inText = false, deleted = 0
  for (const [token] of xml.matchAll(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<[^>]*>|[^<]+/g)) {
    const tag = /^<(\/?)([\w.:-]+)(?=[\s/>])/.exec(token)
    if (tag && tag[2].startsWith(ns)) {
      const local = tag[2].slice(ns.length)
      const opening = !tag[1] && !token.endsWith('/>')
      if (local === 'body') inBody = opening
      else if (inBody) {
        if (local === 'del' && !token.endsWith('/>')) deleted += opening ? 1 : -1
        if (local === 't') inText = opening && !deleted
        else if (!deleted && (tag[1] && local === 'p' || !tag[1] && ['br', 'cr'].includes(local))) text += '\n'
        else if (!deleted && !tag[1] && local === 'tab') text += '\t'
      }
    } else if (inBody && inText) {
      if (token.startsWith('<![CDATA[')) text += token.slice(9, -3)
      else if (!token.startsWith('<')) text += unescape(token)
    }
    if (text.length > MAX_TEXT) fail('The résumé exceeds 80,000 characters. Paste a shorter selection.')
  }
  return text
}

async function pdfText(bytes) {
  if (!bytes.subarray(0, 1024).includes('%PDF-')) fail('This file is not a readable PDF.')
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const task = getDocument({ data: Uint8Array.from(bytes), useSystemFonts: false,
    disableFontFace: true, useWorkerFetch: false, useWasm: false, enableXfa: false, verbosity: 0 })
  try {
    const doc = await task.promise
    if (doc.numPages > 40) fail('Choose a PDF of up to 40 pages, or paste a shorter selection.')
    let text = ''
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      const page = await doc.getPage(pageNumber)
      const reader = page.streamTextContent().getReader()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          for (const item of value.items) {
            if (typeof item.str !== 'string') continue
            text += item.str + (item.hasEOL ? '\n' : ' ')
            if (text.length > MAX_TEXT) fail('The résumé exceeds 80,000 characters. Paste a shorter selection.')
          }
        }
      } finally {
        reader.releaseLock()
        page.cleanup()
      }
      text += '\n'
    }
    return text
  } finally {
    await task.destroy()
  }
}

async function readSelection(selected) {
  if (typeof selected !== 'string' || !path.isAbsolute(selected) ||
      /^[\\/]{2}/.test(selected) || selected.includes('\0') || selected.split(/[\\/]/).includes('..') ||
      (process.platform === 'win32' && (!/^[A-Za-z]:[\\/]/.test(selected) ||
        selected.slice(2).includes(':') || /(?:^|[\\/])(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|[\\/]|$)/i.test(selected)))) {
    fail('Choose one local file from the file picker.')
  }
  const extension = path.extname(selected).slice(1).toLowerCase()
  if (!formats.includes(extension)) fail('Choose a PDF, DOCX or TXT file.')
  const before = await lstat(selected)
  if (!before.isFile()) fail('Choose a regular file. Folders and file links cannot be imported.')
  const fd = await open(selected, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  let bytes
  try {
    const stat = await fd.stat()
    if (!stat.isFile() || before.dev !== stat.dev || before.ino !== stat.ino) fail('The selected file changed. Choose it again.')
    if (stat.size > MAX_BYTES) fail('Choose a file of 5 MiB or less, or paste the résumé text.')
    bytes = Buffer.alloc(stat.size + 1)
    let count = 0
    while (count < bytes.length) {
      const { bytesRead } = await fd.read(bytes, count, bytes.length - count, null)
      if (!bytesRead) break
      count += bytesRead
    }
    if (count !== stat.size) fail('The selected file changed. Choose it again.')
    bytes = bytes.subarray(0, count)
  } finally {
    await fd.close()
  }
  const raw = extension === 'pdf' ? await pdfText(bytes)
    : extension === 'docx' ? docxText(bytes) : decode(bytes)
  return { name: path.basename(selected), text: checkedText(raw) }
}

export function createResume({ dialog, window: getWindow }) {
  return {
    async pick() {
      const options = { title: 'Choose your résumé', properties: ['openFile'],
        filters: [{ name: 'Résumés', extensions: formats }] }
      const parent = getWindow()
      const result = await (parent ? dialog.showOpenDialog(parent, options) : dialog.showOpenDialog(options))
      if (result.canceled) return null
      if (result.filePaths?.length !== 1) fail('Choose one résumé at a time.')
      try {
        return await readSelection(result.filePaths[0])
      } catch (error) {
        if (error instanceof ImportError) throw error
        if (error.name === 'PasswordException') fail('This PDF requires a password. Choose an unlocked copy or paste the text.')
        fail('PLUTO could not read this file. Choose another copy or paste the résumé text.')
      }
    }
  }
}
