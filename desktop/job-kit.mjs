import { createHash } from 'node:crypto'
import { constants, lstatSync, realpathSync } from 'node:fs'
import { lstat, open, opendir, realpath } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import { recordDate } from './record-dates.mjs'

const kinds = ['kit', 'vault']
const handoff = {
  url: 'https://github.com/Jwarren-ENG/lockedin-job-kit/blob/main/skills/job-application-autofill/SKILL.md',
  prompt: 'Use the #LOCKEDIN Job Kit job-application-autofill skill to prepare a draft for the role I choose. Check my existing tracker and confirmed facts first. Preserve prior submissions and stop at review.',
}
const maxRecords = 5000
const maxBody = 2_000_000 // workspace.saveNote limit
const maxBytes = 32 * 1024 * 1024
const startMarker = '<!-- jobkit:managed:start -->'
const endMarker = '<!-- jobkit:managed:end -->'
const hash = value => createHash('sha256').update(value).digest('hex')
const noteHash = note => hash(JSON.stringify([note.title, note.body, note.jobId ?? null]))
const preference = kind => 'jobKit.source.' + kind

class SourceError extends Error {}
function fail(message) { throw new SourceError(message) }
function reason(error) {
  if (error instanceof SourceError) return error.message
  if (error.code === 'ENOENT') return 'A source file or folder is missing. Check the folder and try again.'
  return 'Could not read this source. Check the folder and its permissions, then try again.'
}

function sameDirectory(source, stat, resolvedPath) {
  return stat.isDirectory() && stat.dev.toString() === source.dev && stat.ino.toString() === source.ino &&
    resolvedPath === source.path
}

async function checkRoot(source) {
  const stat = await lstat(source.path, { bigint: true })
  if (!sameDirectory(source, stat, await realpath(source.path))) {
    fail('The selected folder moved or was replaced. Choose it again.')
  }
}

async function pickedFolder(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || !(await lstat(path)).isDirectory()) {
    fail('Choose a local folder directly.')
  }
  const root = await realpath(path)
  const stat = await lstat(root, { bigint: true })
  return { path: root, dev: String(stat.dev), ino: String(stat.ino) }
}

// Callers provide only fixed relative names or direct regular-file entries from a scoped directory.
async function readText(root, relative, budget, limit = maxBody) {
  const path = join(root, relative)
  const before = await lstat(path)
  if (!before.isFile() || before.nlink !== 1 || await realpath(path) !== path) {
    fail('A source file is linked or is not a regular file. Select the original folder.')
  }
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const stat = await file.stat()
    if (before.dev !== stat.dev || before.ino !== stat.ino || stat.nlink !== 1 || !stat.isFile() || await realpath(path) !== path) {
      fail('A source file changed during the scan. Try again.')
    }
    budget.bytes += stat.size
    if (stat.size > limit || budget.bytes > maxBytes) fail('This source exceeds the supported import size.')
    const bytes = Buffer.alloc(stat.size + 1)
    let used = 0
    while (used < bytes.length) {
      const { bytesRead } = await file.read(bytes, used, bytes.length - used)
      if (!bytesRead) break
      used += bytesRead
    }
    const after = await file.stat()
    const current = await lstat(path)
    if (used !== stat.size || stat.mtimeMs !== after.mtimeMs || stat.dev !== current.dev ||
        stat.ino !== current.ino || current.nlink !== 1 || !current.isFile() || await realpath(path) !== path) {
      fail('A source file changed during the scan. Try again.')
    }
    let text
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, used)) }
    catch { fail('A source file contains invalid UTF-8.') }
    if (text.includes('\0')) fail('A source file contains binary text.')
    return text
  } finally { await file.close() }
}

async function optional(read) {
  try { return await read() } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}

async function filesIn(root, folder, extension) {
  const path = join(root, folder)
  const directory = await optional(async () => {
    if (!(await lstat(path)).isDirectory() || await realpath(path) !== path) {
      fail('A source directory is linked or invalid. Choose the original folder.')
    }
    return opendir(path)
  })
  if (!directory) return []
  let count = 0
  const files = []
  for await (const entry of directory) {
    if (++count > 10000) fail('A source folder has too many entries to scan.')
    if (entry.isFile() && !entry.name.startsWith('.') && entry.name.endsWith(extension)) {
      files.push(join(folder, entry.name))
    }
  }
  return files.sort()
}

function parseJson(text) {
  try { return JSON.parse(text) } catch { fail('A Job Kit record contains invalid JSON. Refresh its export and try again.') }
}

function managed(text) {
  const start = text.indexOf(startMarker)
  return start >= 0 && text.indexOf(endMarker, start + startMarker.length) > start
}

const heading = text => text.match(/^# (.+)$/m)?.[1].trim()
function caption(value) {
  return typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, 200) : ''
}

async function scan(kind, source) {
  await checkRoot(source)
  const budget = { bytes: 0 }
  const records = new Map()
  let jobs
  const meetings = []
  const stats = { applications: 0, interviews: 0, notes: 0 }
  function add(group, key, title, body) {
    if (records.size >= maxRecords || body.length > maxBody) fail('This source exceeds the supported import size.')
    const identity = group + '/' + key
    if (records.has(identity)) fail('Two source records use the same ID. Resolve the duplicate before syncing.')
    records.set(identity, { title, body, archive: group !== 'dashboard' })
  }
  const read = (file, limit) => readText(source.path, file, budget, limit)
  if (kind === 'kit') {
    const applications = await optional(() => read(join('exports', 'applications.json'), 16 * 1024 * 1024))
    if (applications === null) fail('Choose the private Job Kit workspace containing exports/applications.json.')
    const rows = parseJson(applications)
    if (!Array.isArray(rows)) fail('The Job Kit application export must be an array of records.')
    function record(group, row) {
      if (typeof row?.id !== 'string' || !/^[a-z0-9_-]{1,256}$/i.test(row.id)) {
        fail('A Job Kit record is missing a supported stable ID.')
      }
      const label = [caption(row.company), caption(row.role)].filter(Boolean).join(' · ')
      const title = 'Kit ' + group + ' · ' + (label || row.id)
      add(group, row.id, title, JSON.stringify(row, null, 2))
    }
    for (const row of rows) {
      if (!caption(row?.company) || !caption(row?.role)) fail('A Job Kit application needs a company and role.')
      record('application', row)
    }
    stats.applications = rows.length
    jobs = rows
    for (const file of await filesIn(source.path, 'interviews', '.json')) {
      const meeting = parseJson(await read(file))
      if (!caption(meeting?.status)) fail('A Job Kit interview needs its recorded status.')
      if (meeting.status === 'Scheduled') {
        const times = [meeting.start, meeting.end].map(value =>
          typeof value === 'string' && /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) && recordDate(value)?.instant)
        if (!times[0] || !times[1] || times[1] <= times[0]) {
          fail('A scheduled interview needs a valid start and later end, each with a UTC offset.')
        }
      }
      record('interview', meeting)
      meetings.push(meeting)
      stats.interviews++
    }
  } else {
    function page(file, group, body) {
      const title = caption(heading(body) || basename(file, '.md'))
      add(group, file, 'Obsidian · ' + title, body)
      stats.notes++
    }
    const home = await optional(() => read('Home.md'))
    if (!home || !managed(home) || !/^# Job Search\s*$/m.test(home)) {
      fail('Choose the exported Job Kit Obsidian vault containing its managed Home.md.')
    }
    page('Home.md', 'dashboard', home)
    const calendar = await optional(() => read('Calendar.md'))
    if (calendar && managed(calendar)) page('Calendar.md', 'dashboard', calendar)
    const board = await optional(() => read('Application Board.md'))
    if (board && /^kanban-plugin: board\s*$/m.test(board) && /^# Applications\s*$/m.test(board)) {
      page('Application Board.md', 'dashboard', board)
    }
    for (const [folder, group] of [['Applications', 'applications'], ['Interviews', 'interviews']]) {
      for (const file of await filesIn(source.path, folder, '.md')) {
        const body = await read(file)
        if (!managed(body)) continue
        page(file, group, body)
        stats[group]++
      }
    }
  }
  await checkRoot(source)
  return { stats, records, jobs, meetings }
}

export function createJobKit({ prefs, workspace, dialog, window }) {
  let pending = Promise.resolve()
  const enqueue = action => {
    const result = pending.then(action)
    pending = result.catch(() => {})
    return result
  }

  function view(kind) {
    const source = prefs.get(preference(kind))
    return {
      connected: Boolean(source), name: source ? basename(source.path) : null,
      stats: source?.stats ?? null, lastSyncedAt: source?.lastSyncedAt ?? null,
    }
  }
  function status() {
    return { kit: view('kit'), vault: view('vault'), lastSync: prefs.get('jobKit.lastSync'), handoff: { ...handoff } }
  }
  function getPaths() {
    // Main may open this path with the OS. A former directory could now be a file or a link.
    const paths = { kit: null, vault: null }
    for (const kind of kinds) {
      const source = prefs.get(preference(kind))
      if (!source) continue
      try {
        const stat = lstatSync(source.path, { bigint: true })
        if (sameDirectory(source, stat, realpathSync(source.path))) paths[kind] = source.path
      } catch { /* A disconnected volume is unavailable to main. */ }
    }
    return paths
  }

  async function choose(input) {
    const kind = input?.kind
    if (!kinds.includes(kind)) throw new Error('Choose a kit workspace or its exported Obsidian vault.')
    const options = { title: kind === 'kit' ? 'Choose your private Job Kit workspace' : 'Choose your Job Kit Obsidian vault', properties: ['openDirectory'] }
    const parent = window?.()
    const result = await dialog.showOpenDialog(...(parent ? [parent, options] : [options]))
    if (result.canceled || !result.filePaths?.length) return { ...status(), canceled: true }

    const report = newReport()
    try {
      const source = await pickedFolder(result.filePaths[0])
      await syncSource(kind, source, report)
    } catch (error) { throw new Error(reason(error)) }
    prefs.set('jobKit.lastSync', report)
    return { ...status(), canceled: false }
  }

  function mirror(source, kind, records, notes, report) {
    const namespace = JSON.stringify([source.path, source.dev, source.ino, kind])
    for (const [key, { title, body, archive }] of records) {
      const id = 'jobkit-' + hash(JSON.stringify([namespace, key]))
      const baselineKey = 'jobKit.baseline.' + id
      const previous = prefs.get(baselineKey)
      const current = notes.get(id)
      const incoming = { id, title, body, jobId: null }
      const signature = noteHash(incoming)
      const local = current && noteHash(current)
      if (local === signature) {
        // A write can finish before its baseline is saved. An exact match safely repairs that state.
        if (previous !== signature) prefs.set(baselineKey, signature)
        report.unchanged++
        continue
      }
      if (current ? local !== previous : previous != null) {
        report.preserved++
        continue
      }
      if (current && archive) {
        // Retain the previous source record, including any superseded evidence.
        const archiveId = 'jobkit-history-' + hash(id + local)
        const archiveTitle = current.title + ' · Previous source copy'
        const existing = notes.get(archiveId)
        if (existing && (existing.title !== archiveTitle || existing.body !== current.body || existing.jobId !== current.jobId)) {
          report.preserved++
          continue
        }
        if (!existing) {
          const saved = workspace.saveNote({ ...current, id: archiveId, updatedAt: 'new', title: archiveTitle })
          notes.set(saved.id, saved)
        }
      }
      // A newly created note must still be absent. Workspace also checks revisions inside its transaction.
      const saved = workspace.saveNote({ ...incoming, updatedAt: current?.updatedAt ?? 'new' })
      notes.set(id, saved)
      prefs.set(baselineKey, signature)
      if (current) report.updated++
      else report.imported++
    }
  }

  function newReport() {
    return { at: new Date().toISOString(), imported: 0, updated: 0, unchanged: 0, preserved: 0, issues: [] }
  }

  async function syncSource(kind, source, report) {
    const data = await scan(kind, source)
    if (kind === 'kit' && workspace.importKitJobs) {
      try { report.jobs = await workspace.importKitJobs(source.path, data.jobs, data.meetings) }
      catch { fail('Could not import the Job Kit applications. Check the application export and sync again.') }
    }
    try {
      const notes = new Map(workspace.snapshot().notes.map(note => [note.id, note]))
      mirror(source, kind, data.records, notes, report)
      prefs.set(preference(kind), { ...source, stats: data.stats, lastSyncedAt: report.at })
    } catch { fail('A Notebook change could not be saved. Refresh and sync again.') }
  }

  async function sync() {
    const report = newReport()
    for (const kind of kinds) {
      const source = prefs.get(preference(kind))
      if (!source) continue
      try { await syncSource(kind, source, report) }
      catch (error) { report.issues.push((kind === 'kit' ? 'Job Kit: ' : 'Obsidian: ') + reason(error)) }
    }
    prefs.set('jobKit.lastSync', report)
    return status()
  }

  return { status, getPaths, choose: input => enqueue(() => choose(input)), sync: () => enqueue(sync) }
}
