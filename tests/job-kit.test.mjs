import assert from 'node:assert/strict'
import { link, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createConfig } from '../desktop/config.mjs'
import { createJobKit } from '../desktop/job-kit.mjs'
import { createWorkspace } from '../desktop/workspace.mjs'

const job = { id: 'example-42', company: 'Example Orchard', role: 'Analyst', url: 'https://example.test/jobs/42',
  status: 'Submission uncertain', submitted_at: null, notes: 'Awaiting portal confirmation', evidence: 'No receipt visible' }
const meeting = { id: 'event-7', company: 'Example Orchard', role: 'Analyst', status: 'Scheduled',
  start: '2099-06-10T14:00:00-04:00', end: '2099-06-10T14:30:00-04:00', evidence: { reference: 'invitation-7' } }
const managed = body => '<!-- jobkit:managed:start -->\n' + body + '\n<!-- jobkit:managed:end -->\n\n## My notes\n\n'

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pluto-kit-test-')))
  const kit = join(root, 'Private workspace')
  const vault = join(kit, 'obsidian')
  const applications = join(kit, 'exports', 'applications.json')
  const interview = join(kit, 'interviews', 'event.json')
  const caseFile = join(vault, 'Applications', job.id + '.md')
  for (const directory of [join(kit, 'exports'), join(kit, 'interviews'), join(vault, 'Applications'), join(vault, 'Interviews')]) {
    await mkdir(directory, { recursive: true })
  }
  await writeFile(applications, JSON.stringify([job]))
  await writeFile(interview, JSON.stringify(meeting))
  await writeFile(join(vault, 'Home.md'), managed('# Job Search'))
  await writeFile(join(vault, 'Calendar.md'), managed('# Calendar'))
  await writeFile(join(vault, 'Application Board.md'), '---\nkanban-plugin: board\n---\n\n# Applications\n')
  await writeFile(caseFile, managed('# Example Orchard — Analyst') + 'My own field notes\n')
  await writeFile(join(vault, 'Interviews', 'event-7.md'), managed('# Example interview'))
  await writeFile(join(vault, 'Applications', 'unrelated.md'), 'Unrelated personal note')
  await writeFile(join(kit, 'permissions.json'), 'intentionally unreadable as JSON')
  await writeFile(join(kit, 'jobkit.mjs'), 'throw new Error("A source script was executed")')

  const directory = join(root, 'pluto')
  const workspace = createWorkspace(directory)
  const config = createConfig(directory, {})
  t.after(async () => { workspace.close(); config.close(); await rm(root, { recursive: true, force: true }) })
  let next = null
  const parent = {}
  const calls = []
  const tracker = {
    ...workspace,
    importKitJobs(path, jobs, meetings) {
      calls.push({ path, jobs, meetings, existingNotes: workspace.snapshot().notes.length })
      return { received: jobs.length, meetings: meetings.length }
    },
  }
  const options = {
    prefs: config.prefs, workspace: tracker, window: () => parent,
    dialog: { async showOpenDialog(win, options) {
      assert.equal(win, parent)
      assert.deepEqual(options.properties, ['openDirectory'])
      return { canceled: next === null, filePaths: next ? [next] : [] }
    } },
  }
  const api = createJobKit(options)
  async function choose(kind, path) { next = path; return api.choose({ kind }) }
  return { root, kit, vault, applications, interview, caseFile, workspace, tracker, calls, options, api, choose }
}

test('native selection immediately imports the real export shapes and keeps locations in main', async t => {
  const f = await fixture(t)
  assert.equal(f.api.status().kit.connected, false)
  assert.deepEqual(f.api.getPaths(), { kit: null, vault: null })
  const kit = await f.choose('kit', f.kit)
  assert.equal(kit.kit.name, 'Private workspace')
  assert.deepEqual(kit.kit.stats, { applications: 1, interviews: 1, notes: 0 })
  assert.equal(kit.lastSync.imported, 2)
  assert.deepEqual(kit.lastSync.jobs, { received: 1, meetings: 1 })
  assert.deepEqual(f.calls, [{ path: f.kit, jobs: [job], meetings: [meeting], existingNotes: 0 }])
  assert.ok(kit.kit.lastSyncedAt)
  assert.equal(JSON.stringify(kit).includes(f.root), false)
  assert.equal(JSON.stringify(kit).includes(job.evidence), false)
  assert.match(kit.handoff.url, /^https:\/\/github\.com\/[^/]+\/lockedin-job-kit\/blob\/main\/skills\/job-application-autofill\//)
  assert.equal(kit.canceled, false)

  const before = await readFile(f.caseFile, 'utf8')
  const result = await f.choose('vault', f.vault)
  assert.deepEqual(result.vault.stats, { applications: 1, interviews: 1, notes: 5 })
  assert.equal(result.lastSync.imported, 5)
  assert.equal(f.calls.length, 1, 'vault pages cannot generate tracker events')
  assert.equal(f.workspace.snapshot().notes.length, 7)
  const bodies = f.workspace.snapshot().notes.map(note => note.body)
  assert.ok(bodies.includes(before))
  const records = bodies.filter(body => body.startsWith('{')).map(body => JSON.parse(body))
  assert.deepEqual(records.find(row => row.id === job.id), job)
  assert.deepEqual(records.find(row => row.id === meeting.id), meeting)
  assert.ok(!bodies.some(body => body.includes('Unrelated personal note')))
  assert.equal(await readFile(f.caseFile, 'utf8'), before)
  assert.deepEqual(createJobKit(f.options).getPaths(), { kit: f.kit, vault: f.vault })

  const reports = await Promise.all([f.api.sync(), f.api.sync()])
  for (const synced of reports) {
    assert.equal(synced.lastSync.unchanged, 7)
    assert.equal(synced.lastSync.imported, 0)
    assert.deepEqual(synced.lastSync.issues, [])
  }
  assert.equal(f.workspace.snapshot().notes.length, 7)
})

test('source updates archive previous evidence and preserve user-edited mirrors and links', async t => {
  const f = await fixture(t)
  await f.choose('kit', f.kit)
  const notes = f.workspace.snapshot().notes
  const role = notes.find(note => note.title.startsWith('Kit application'))
  const invite = notes.find(note => note.title.startsWith('Kit interview'))
  const localJob = f.workspace.saveJob({ company: 'Local example', title: 'Local role' })
  const userEdit = f.workspace.saveNote({ ...invite, title: 'Keep my heading', jobId: localJob.id })
  const updated = { ...job, status: 'Submitted', submitted_at: '2030-04-10', evidence: 'Receipt EXAMPLE' }
  const cancelled = { ...meeting, status: 'Cancelled', evidence: 'Cancellation notice' }
  await writeFile(f.applications, JSON.stringify([updated]))
  await writeFile(f.interview, JSON.stringify(cancelled))
  const synced = await f.api.sync()
  assert.equal(synced.lastSync.updated, 1)
  assert.equal(synced.lastSync.preserved, 1)
  assert.deepEqual(f.calls.at(-1).meetings, [cancelled])
  const next = f.workspace.snapshot().notes
  assert.equal(next.length, 3)
  assert.deepEqual(JSON.parse(next.find(note => note.id === role.id).body), updated)
  assert.deepEqual(JSON.parse(next.find(note => note.title.endsWith('Previous source copy')).body), job)
  assert.deepEqual(next.find(note => note.id === invite.id), userEdit)
  const repeat = await f.api.sync()
  assert.equal(repeat.lastSync.unchanged, 1)
  assert.equal(repeat.lastSync.preserved, 1)
  assert.equal(f.workspace.snapshot().notes.length, 3)
  await writeFile(f.applications, '[]')
  await f.api.sync()
  assert.equal(f.workspace.snapshot().notes.length, 3, 'removed source records keep their local copies')
})

test('cancel, wrong folders and invalid data leave the prior configuration and evidence intact', async t => {
  const f = await fixture(t)
  const original = await f.choose('kit', f.kit)
  assert.equal((await f.choose('kit', null)).canceled, true)
  await assert.rejects(f.choose('kit', f.vault), /private Job Kit workspace/)
  await assert.rejects(f.choose('vault', f.kit), /exported Job Kit Obsidian vault/)
  await assert.rejects(f.api.choose({ kind: 'custom', path: f.root }), /Choose a kit workspace/)
  await writeFile(f.applications, JSON.stringify([job, job]))
  await assert.rejects(f.choose('kit', f.kit), /same ID/)
  assert.deepEqual(f.api.status().kit, original.kit)
  assert.equal(f.calls.length, 1)
  assert.equal(f.workspace.snapshot().notes.length, 2)
  await writeFile(f.applications, JSON.stringify([job]))
  await writeFile(f.interview, JSON.stringify({ ...meeting, start: '2099-06-10T15:00:00' }))
  await assert.rejects(f.choose('kit', f.kit), /UTC offset/)
  await f.choose('vault', f.vault)
  const both = await f.api.sync()
  assert.equal(both.lastSync.unchanged, 5)
  assert.match(both.lastSync.issues.join(' '), /UTC offset/)
  assert.equal(both.kit.lastSyncedAt, original.kit.lastSyncedAt)
  assert.equal(f.calls.length, 1)
})

test('same export IDs from different selected workspaces keep separate copies', async t => {
  const f = await fixture(t)
  await f.choose('kit', f.kit)
  const other = join(f.root, 'Another kit')
  await mkdir(join(other, 'exports'), { recursive: true })
  await writeFile(join(other, 'exports', 'applications.json'), JSON.stringify([{ ...job, evidence: 'Second workspace evidence' }]))
  const switched = await f.choose('kit', other)
  assert.equal(switched.lastSync.imported, 1)
  assert.equal(f.workspace.snapshot().notes.length, 3)
  const back = await f.choose('kit', f.kit)
  assert.equal(back.lastSync.unchanged, 2)
})

test('sync rejects an escaping directory link and getPaths rejects a replaced selected folder', async t => {
  const f = await fixture(t)
  await f.choose('kit', f.kit)
  const exports = join(f.kit, 'exports')
  const elsewhere = join(f.root, 'outside')
  await rename(exports, elsewhere)
  await symlink(elsewhere, exports, process.platform === 'win32' ? 'junction' : 'dir')
  const linked = await f.api.sync()
  assert.match(linked.lastSync.issues.join(' '), /linked/)
  assert.equal(f.calls.length, 1)
  assert.equal(f.workspace.snapshot().notes.length, 2)
  await rename(f.kit, join(f.root, 'moved'))
  await writeFile(f.kit, 'a file in place of the selected directory')
  assert.equal(f.api.getPaths().kit, null)
  assert.match((await f.api.sync()).lastSync.issues.join(' '), /moved or was replaced/)
  assert.equal(f.calls.length, 1)
})

test('retry after an interrupted notebook import finishes without replacing an intervening edit', async t => {
  const f = await fixture(t)
  let attempts = 0
  f.tracker.saveNote = input => {
    if (++attempts === 2) throw new Error('synthetic database failure')
    return f.workspace.saveNote(input)
  }
  await assert.rejects(f.choose('kit', f.kit), /could not be saved/)
  assert.equal(f.api.status().kit.connected, false)
  const first = f.workspace.snapshot().notes[0]
  f.workspace.saveNote({ ...first, body: 'Keep my edit between attempts.' })
  const recovered = await f.choose('kit', f.kit)
  assert.equal(recovered.lastSync.imported, 1)
  assert.equal(recovered.lastSync.preserved, 1)
  assert.equal(f.workspace.snapshot().notes.length, 2)
  assert.ok(f.workspace.snapshot().notes.some(note => note.body === 'Keep my edit between attempts.'))
})

test('linked and oversized evidence files cannot replace a valid local mirror', async t => {
  const f = await fixture(t)
  const first = await f.choose('kit', f.kit)
  const outside = join(f.root, 'private-record.json')
  await writeFile(outside, JSON.stringify({ ...meeting, evidence: 'Outside the selection' }))
  await rm(f.interview)
  await link(outside, f.interview)
  const linked = await f.api.sync()
  assert.match(linked.lastSync.issues.join(' '), /linked/)
  assert.equal(linked.kit.lastSyncedAt, first.kit.lastSyncedAt)
  await rm(f.interview)
  await writeFile(f.interview, ' '.repeat(2_000_001))
  const oversized = await f.api.sync()
  assert.match(oversized.lastSync.issues.join(' '), /size/)
  assert.equal(f.calls.length, 1)
  assert.equal(f.workspace.snapshot().notes.length, 2)
  assert.ok(!f.workspace.snapshot().notes.some(note => note.body.includes('Outside the selection')))
})
