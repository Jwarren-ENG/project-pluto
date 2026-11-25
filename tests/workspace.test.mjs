import test from 'node:test'
import assert from 'node:assert/strict'
import {
  copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync,
  rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createWorkspace } from '../desktop/workspace.mjs'

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pluto-workspace-'))
  const data = join(dir, 'data')
  const vault = join(dir, 'vault')
  mkdirSync(vault)
  const ws = createWorkspace(data)
  t.after(() => { ws.close(); rmSync(dir, { recursive: true, force: true }) })
  const pages = join(vault, 'PROJECT PLUTO')
  const file = id => join(pages, readdirSync(pages).find(p => p.endsWith(' - ' + id + '.md')))
  return { dir, data, vault, pages, ws, file }
}

const opening = { company: 'Acme', title: 'Sourcing analyst', url: 'https://example.org/jobs/12' }

test('profile, schedule, notes and jobs persist across workspace handles', t => {
  const { ws, data } = setup(t)
  assert.equal(ws.snapshot().profile, null)
  ws.saveProfile({ name: 'Casey', confirmedFacts: [{ text: 'Managed inventory' }] })
  ws.saveProfile({ location: 'Brooklyn' })
  ws.saveSchedule({ enabled: true, hour: 13, minute: 5, query: 'procurement', lastRunDate: '' })
  ws.saveSchedule({ lastRunDate: '2028-02-29' })
  assert.throws(() => ws.saveSchedule({ lastRunDate: '2027-02-29' }))
  assert.throws(() => ws.saveSchedule({ minute: 60 }))
  const job = ws.saveJob(opening)
  const note = ws.saveNote({ jobId: job.id, title: 'Call', body: 'Markdown\n\n<script>literal note</script>' })
  assert.throws(() => ws.saveNote({ id: note.id, jobId: 'missing' }), /linked job/)
  const second = createWorkspace(data)
  try {
    assert.deepEqual(second.snapshot(), ws.snapshot())
    assert.deepEqual(second.snapshot().notes, [note])
    assert.equal(second.snapshot().profile.name, 'Casey')
    assert.equal(second.snapshot().schedule.hour, 13)
    assert.equal(second.snapshot().schedule.lastRunDate, '2028-02-29')
    second.saveJob({ id: job.id, salary: '$100k' })
    assert.throws(() => ws.saveJob({ ...job, draft: 'older edit' }), /changed/)
    second.saveNote({ id: note.id, body: 'newer' })
    assert.throws(() => ws.saveNote({ ...note, body: 'older' }), /changed/)
  } finally { second.close() }
})

test('verified transitions preserve original receipt and exact submitted materials', t => {
  const { ws, data } = setup(t)
  ws.saveProfile({ resumeText: 'unrelated general résumé' })
  const draft = ws.saveJob({ ...opening, stage: 'Preparing', draft: 'Letter A', resumeText: 'Résumé A\r\nverbatim' })
  assert.throws(() => ws.saveJob({ id: draft.id, stage: 'Applied', resumeText: 'lost edit', evidence: ' ' }), /evidence/)
  assert.equal(ws.snapshot().jobs[0].resumeText, draft.resumeText)
  const evidence = { source: 'ATS', text: 'Application received', reference: 'RECEIPT-123' }
  const applied = ws.saveJob({ id: draft.id, stage: 'Applied', evidence })
  assert.deepEqual(ws.saveJob({ ...applied }), applied)
  assert.deepEqual(applied.submittedSnapshot.evidence, evidence)
  const sent = applied.submittedSnapshot
  const after = ws.saveJob({ ...applied, draft: 'Letter B', resumeText: 'Résumé B', submittedSnapshot: { evidence: 'forged' } })
  assert.deepEqual(after.submittedSnapshot, sent)
  assert.equal(sent.resumeText, 'Résumé A\r\nverbatim')
  assert.equal(sent.draft, 'Letter A')
  assert.throws(() => ws.saveJob({ id: draft.id, stage: 'Saved' }), /draft stage/)
  assert.throws(() => ws.saveJob({ ...after, stage: 'Interview' }), /new employer evidence/)
  ws.saveJob({ id: draft.id, stage: 'Interview', evidence: 'Invitation for February', interviewAt: '2090-02-05T10:00:00-05:00' })
  assert.equal(ws.snapshot().upcomingInterviews[0].interviewAt, '2090-02-05T15:00:00.000Z')
  ws.saveJob({ id: draft.id, stage: 'Offer', evidence: 'Written offer received' })
  const state = ws.snapshot()
  assert.deepEqual(state.upcomingInterviews, [])
  assert.deepEqual(state.evidence.map(e => e.stage), ['Offer', 'Interview', 'Applied'])
  assert.deepEqual(state.jobs[0].submittedSnapshot, sent)
  const sql = new DatabaseSync(join(data, 'workspace.sqlite3'))
  try {
    assert.throws(() => sql.prepare('UPDATE submissions SET data=?').run('{}'), /immutable/)
    assert.throws(() => sql.exec('DELETE FROM submissions'), /immutable/)
  } finally { sql.close() }
})

test('direct interview evidence creates no submission and upcoming interviews are sorted', t => {
  const { ws } = setup(t)
  const interview = (title, at) => ws.saveJob({ ...opening, title, stage: 'Interview', evidence: 'Invitation from employer', interviewAt: at })
  const later = interview('Later', '2095-12-03T09:00:00Z')
  const earlier = interview('Earlier', '2095-02-02T09:00:00Z')
  interview('Past', '2000-01-01T09:00:00Z')
  assert.equal(later.submittedSnapshot, null)
  assert.deepEqual(ws.snapshot().upcomingInterviews.map(j => j.jobId), [earlier.id, later.id])
  assert.throws(() => interview('Bad day', '2095-02-31T09:00:00Z'))
  assert.throws(() => ws.saveJob({ ...opening, stage: 'Unknown' }))
  assert.throws(() => ws.saveJob({ ...opening, url: 'file:///private/example' }))
  assert.throws(() => ws.saveJob({ ...opening, id: '../escape' }))
  assert.equal(ws.snapshot().jobs.length, 3)
})

test('a failure after writing the job rolls back stage, event and submission together', t => {
  const { ws, data } = setup(t)
  const job = ws.saveJob(opening)
  const sql = new DatabaseSync(join(data, 'workspace.sqlite3'))
  try {
    sql.exec("CREATE TRIGGER simulate_interruption BEFORE INSERT ON submissions BEGIN SELECT RAISE(ABORT,'interrupted'); END")
    assert.throws(() => ws.saveJob({ id: job.id, stage: 'Applied', evidence: 'Received' }), /interrupted/)
    assert.deepEqual(ws.snapshot().jobs, [job])
    sql.exec('DROP TRIGGER simulate_interruption')
    assert.equal(ws.saveJob({ id: job.id, stage: 'Applied', evidence: 'Received' }).history.length, 2)
  } finally { sql.close() }
})

test('renamed notes round-trip, preserving other frontmatter, Markdown and nearby files', t => {
  const { ws, vault, pages, file } = setup(t)
  const job = ws.saveJob(opening)
  const note = ws.saveNote({ title: 'Interview prep', body: 'one\r\ntwo', jobId: job.id })
  assert.equal(ws.exportVault(vault).written, 2)
  assert.equal(ws.exportVault(vault).unchanged, 2)
  mkdirSync(join(pages, 'My folder'))
  const moved = join(pages, 'My folder', 'Prep.md')
  renameSync(file(note.id), moved)
  const base = readFileSync(moved, 'utf8')
  writeFileSync(moved, base.replace('pluto-type:', 'tags: [career]\npluto-type:').replace('# Interview prep', '# Questions') + '\nthird')
  const other = join(pages, 'My private page.md')
  writeFileSync(other, 'untouched')
  assert.equal(ws.exportVault(vault).preserved.length, 1)
  assert.equal(ws.importVault(vault).imported, 1)
  assert.equal(ws.importVault(vault).imported, 0)
  assert.equal(ws.snapshot().notes.length, 1)
  assert.deepEqual([ws.snapshot().notes[0].title, ws.snapshot().notes[0].body], ['Questions', 'one\ntwo\nthird'])
  ws.saveNote({ id: note.id, body: 'Follow up' })
  assert.equal(ws.exportVault(vault).written, 1)
  assert.match(readFileSync(moved, 'utf8'), /tags: \[career\]/)
  assert.match(readFileSync(moved, 'utf8'), /Follow up$/)
  assert.equal(readFileSync(other, 'utf8'), 'untouched')
})

test('diverged note versions are retained until explicitly reconciled', t => {
  const { ws, vault, file } = setup(t)
  const note = ws.saveNote({ title: 'Notes', body: 'common' })
  ws.exportVault(vault)
  const path = file(note.id)
  writeFileSync(path, readFileSync(path, 'utf8').replace('common', 'Obsidian edit'))
  ws.saveNote({ id: note.id, body: 'Pluto edit' })
  for (const report of [ws.importVault(vault), ws.exportVault(vault)]) {
    assert.equal(report.conflicts[0].id, note.id)
    assert.equal(report.written + report.imported, 0)
  }
  assert.equal(ws.snapshot().notes[0].body, 'Pluto edit')
  assert.match(readFileSync(path, 'utf8'), /Obsidian edit$/)
  ws.saveNote({ id: note.id, body: 'Obsidian edit' })
  assert.equal(ws.importVault(vault).conflicts.length, 0)
  ws.saveNote({ id: note.id, body: 'Resolved' })
  assert.equal(ws.exportVault(vault).written, 1)
})

test('case annotations import separately from authoritative stage and receipt', t => {
  const { ws, vault, file } = setup(t)
  const job = ws.saveJob({ ...opening, stage: 'Applied', evidence: 'Portal receipt 456', resumeText: 'Exact résumé' })
  ws.exportVault(vault)
  const path = file(job.id)
  const page = readFileSync(path, 'utf8')
  assert.match(page, /Portal receipt 456/)
  assert.match(page, /Exact résumé/)
  writeFileSync(path, page + 'Ask about training')
  ws.saveJob({ id: job.id, stage: 'Interview', evidence: 'Recruiter confirmed next round' })
  assert.equal(ws.importVault(vault).imported, 1)
  assert.equal(ws.snapshot().jobs[0].caseNotes, 'Ask about training')
  assert.equal(ws.exportVault(vault).written, 1)
  const current = readFileSync(path, 'utf8')
  assert.match(current, /Stage: Interview/)
  assert.match(current, /Ask about training$/)
  const edited = current.replace('Portal receipt 456', 'fabricated receipt')
  writeFileSync(path, edited)
  assert.equal(ws.importVault(vault).conflicts.length, 1)
  assert.equal(ws.exportVault(vault).conflicts.length, 1)
  assert.equal(readFileSync(path, 'utf8'), edited)
  assert.deepEqual(ws.snapshot().jobs[0].submittedSnapshot, job.submittedSnapshot)
})

test('missing, duplicate, symlinked and unowned files survive sync', t => {
  const { ws, vault, pages, file, dir } = setup(t)
  const note = ws.saveNote({ title: 'My note', body: 'Original' })
  ws.exportVault(vault)
  const path = file(note.id)
  const duplicate = join(pages, 'Duplicate.md')
  copyFileSync(path, duplicate)
  assert.equal(ws.importVault(vault).conflicts[0].paths.length, 2)
  assert.equal(ws.exportVault(vault).conflicts.length, 1)
  rmSync(duplicate)
  rmSync(path)
  assert.equal(ws.exportVault(vault).preserved.length, 1)
  assert.deepEqual(readdirSync(pages), [])
  const unrelated = join(dir, 'unrelated.md')
  writeFileSync(unrelated, 'Outside the vault')
  if (process.platform !== 'win32') symlinkSync(unrelated, path)
  ws.exportVault(vault)
  assert.equal(readFileSync(unrelated, 'utf8'), 'Outside the vault')
  const fresh = ws.saveNote({ id: 'new-id', title: 'Unowned', body: 'Pluto content' })
  const collision = join(pages, 'Note - Unowned - ' + fresh.id + '.md')
  writeFileSync(collision, 'My existing page')
  assert.ok(ws.exportVault(vault).conflicts.some(c => c.id === fresh.id))
  assert.equal(readFileSync(collision, 'utf8'), 'My existing page')
})

test('new managed notes import by ID, while unmanaged files and dangling links stay local', t => {
  const { ws, vault, pages } = setup(t)
  assert.equal(ws.importVault(vault).imported, 0)
  ws.exportVault(vault)
  const header = '---\npluto-type: note\npluto-id: conference\n---\n'
  writeFileSync(join(pages, 'Conference.md'), header + '# Conference\n\nFollow up.')
  writeFileSync(join(pages, 'Unmanaged.md'), '# Personal journal')
  writeFileSync(join(pages, 'Dangling.md'), header.replace('conference', 'dangling\npluto-job: unknown') + '# Linked\n\nNotes.')
  const result = ws.importVault(vault)
  assert.equal(result.imported, 1)
  assert.equal(result.conflicts[0].id, 'dangling')
  assert.deepEqual(ws.snapshot().notes.map(n => n.id), ['conference'])
  assert.equal(ws.importVault(vault).unchanged, 1)
})

test('refuses a symlinked managed directory and an unsupported database version', t => {
  const { ws, dir, vault } = setup(t)
  if (process.platform !== 'win32') {
    symlinkSync(dir, join(vault, 'PROJECT PLUTO'), 'dir')
    assert.throws(() => ws.exportVault(vault), /real directory/)
  }
  const other = join(dir, 'newer')
  mkdirSync(other)
  const sql = new DatabaseSync(join(other, 'workspace.sqlite3'))
  sql.exec('PRAGMA user_version=2')
  sql.close()
  assert.throws(() => createWorkspace(other), /newer version/)
})
