import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm, symlink, truncate } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync, strToU8 } from 'fflate'
import { createResume } from '../desktop/resume.mjs'

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'pluto-fictional-resume-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  async function file(name, bytes) {
    const p = join(dir, name)
    await writeFile(p, bytes)
    return p
  }
  return { dir, file }
}

function pick(filePaths, canceled = false) {
  const parent = {}
  const dialog = { async showOpenDialog(window, options) {
    assert.equal(window, parent)
    assert.deepEqual(options.properties, ['openFile'])
    assert.deepEqual(options.filters[0].extensions, ['pdf', 'docx', 'txt'])
    return { filePaths, canceled }
  } }
  return createResume({ dialog, window: () => parent }).pick({ path: '/ignored-renderer-input.txt' })
}

function fictionalPdf() {
  const stream = 'BT /F1 12 Tf 30 700 Td (Morgan Vale) Tj 0 -18 Td (Reviewed 18 fictional projects.) Tj ET'
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', '<< /Length ' + stream.length + ' >>\nstream\n' + stream + '\nendstream']
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  for (const [index, obj] of objects.entries()) {
    offsets.push(pdf.length)
    pdf += (index + 1) + ' 0 obj\n' + obj + '\nendobj\n'
  }
  const xref = pdf.length
  pdf += 'xref\n0 6\n0000000000 65535 f \n' +
    offsets.slice(1).map(n => String(n).padStart(10, '0') + ' 00000 n \n').join('') +
    'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF'
  return Buffer.from(pdf)
}

const wordStart = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
const wordEnd = '</w:body></w:document>'
function docx(xml, extra = {}) {
  return zipSync({ 'word/document.xml': strToU8(xml), ...extra })
}

test('native picker cancellation and selected-path boundaries', async t => {
  const { file, dir } = await fixture(t)
  const real = await file('example.TXT', 'Morgan Vale\r\nFictional analyst')
  assert.equal(await pick([], true), null)
  assert.deepEqual(await pick([real]), { name: 'example.TXT', text: 'Morgan Vale\nFictional analyst' })
  for (const paths of [[], [real, real], ['relative.txt'], ['https://example.invalid/resume.txt'],
    ['//example.invalid/share/demo.txt'], [dir], [await file('resume.txt.exe', 'ignored')]]) {
    await assert.rejects(pick(paths))
  }
  if (process.platform !== 'win32') {
    const link = join(dir, 'shortcut.txt')
    await symlink(real, link)
    await assert.rejects(pick([link]), /regular file/)
  }
})

test('text encoding, binary input, file and extracted text limits', async t => {
  const { file } = await fixture(t)
  const utf16 = await file('unicode.txt', Buffer.from('\ufeffÉva Snow', 'utf16le'))
  assert.equal((await pick([utf16])).text, 'Éva Snow')
  const p = await file('large.txt', 'A'.repeat(80_001))
  await assert.rejects(pick([p]), /80,000/)
  await truncate(p, 5 * 1024 * 1024 + 1)
  await assert.rejects(pick([p]), /5 MiB/)
  await assert.rejects(pick([await file('blank.txt', ' \n ')]), /No readable text/)
  await assert.rejects(pick([await file('binary.txt', Buffer.from([65, 0, 66]))]), /binary/)
})

test('PDF returns selectable text and rejects mislabeled files', async t => {
  const { file } = await fixture(t)
  const result = await pick([await file('fiction.PDF', fictionalPdf())])
  assert.match(result.text, /Morgan Vale\s+Reviewed 18 fictional projects\./)
  await assert.rejects(pick([await file('wrong.pdf', 'plain text')]), /not a readable PDF/)
})

test('DOCX keeps visible body text, paragraphs and entities and skips other archive members', async t => {
  const { file } = await fixture(t)
  const xml = wordStart + '<w:p><w:r><w:t>Morgan </w:t></w:r><w:r><w:t>Vale</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>Ops &amp; QA</w:t><w:tab/><w:t>Team &#65;</w:t></w:r></w:p>' +
    '<w:del><w:r><w:t>removed draft</w:t></w:r></w:del>' + wordEnd
  const path = await file('fiction.docx', docx(xml, { 'word/comments.xml': strToU8('PRIVATE COMMENT') }))
  assert.equal((await pick([path])).text, 'Morgan Vale\nOps & QA\tTeam A')
  const prefixed = xml.replaceAll('w:', 'word:').replace('xmlns:w=', 'xmlns:word=')
  assert.equal((await pick([await file('prefix.docx', docx(prefixed))])).text, 'Morgan Vale\nOps & QA\tTeam A')
  const wrong = await file('absent.docx', zipSync({ 'other/document.xml': strToU8(xml) }))
  await assert.rejects(pick([wrong]), /complete Word document/)
  const large = await file('large.docx', docx(wordStart + ' '.repeat(2 * 1024 * 1024) + wordEnd))
  await assert.rejects(pick([large]), /too large|2 MiB/)
})

test('source attribution, explicit preferences, excerpt opt-in, and conflict-safe profile editing', async t => {
  const { createServer } = await import('vite')
  const { fileURLToPath } = await import('node:url')
  const server = await createServer({ root: fileURLToPath(new URL('../', import.meta.url)),
    configFile: false, envDir: false, server: { middlewareMode: true, hmr: false }, appType: 'custom',
    optimizeDeps: { noDiscovery: true, include: [] } })
  t.after(() => server.close())
  const { suggest, reviewedChanges, hasProfile } = await server.ssrLoadModule('/ui/Profile.jsx')
  assert.equal(hasProfile({ budget: { applicationsPerDay: 5 } }), false)
  assert.equal(hasProfile({ confirmedFacts: [], name: '  ', targetRoles: 'Analyst' }), false)
  assert.equal(hasProfile({ confirmedFacts: ['Fictional project'] }), true)
  assert.equal(hasProfile({ name: 'Morgan Vale' }), true)
  assert.equal(hasProfile({ profileConfirmed: true }), true)
  const text = [
    'Morgan Vale', 'morgan@example.invalid | 212-555-0199', 'Summary',
    'Coordinates specimen-free fictional projects.', 'Experience', '• Trained six operators.',
    'Preferred work location: Example City', 'Target roles: Operations analyst',
  ].join('\n')
  const draft = suggest(text, 'fiction.txt')
  assert.deepEqual(draft.fields, {
    name: 'Morgan Vale', email: 'morgan@example.invalid', phone: '212-555-0199',
    summary: 'Coordinates specimen-free fictional projects.', location: 'Example City', targetRoles: 'Operations analyst',
  })
  assert.equal(draft.evidence.location, 'Preferred work location: Example City')
  assert.deepEqual(draft.facts[0], { text: 'Trained six operators.', quote: '• Trained six operators.',
    source: 'fiction.txt', section: 'Experience', included: true })
  const excerpt = suggest('My example role\nPreferred work location: Somewhere else', 'Selected chat excerpt', true)
  assert.deepEqual(excerpt.fields, {})
  assert.ok(excerpt.facts.every(row => !row.included))
  assert.ok(suggest(Array.from({ length: 40 }, (_, n) => 'Item ' + n).join('\n'), 'fiction.txt').omitted)
  const original = { name: 'Morgan Vale', theme: 'light', targetRoles: 'Analyst' }
  assert.deepEqual(reviewedChanges(original, { ...original, theme: 'dark', targetRoles: 'Manager' },
    { name: 'Morgan Example', targetRoles: 'Analyst' }), { name: 'Morgan Example' })
  assert.throws(() => reviewedChanges(original, { ...original, name: 'Other edit' }, { name: 'Morgan Example' }), /changed/)
})
