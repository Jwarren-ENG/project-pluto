import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSources } from '../desktop/sources.mjs'

const repo = 'https://github.com/Example-Org/New-Grad-Positions'
const github = 'https://api.github.com/repos/example-org/new-grad-positions/readme'
const career = 'https://careers.example.com/openings'
const apply = 'https://jobs.lever.co/example/example-12345'
const listing = `<!-- An ordinary public README with employer badges and a secondary directory link. -->
<table style="width:100%"><thead><tr><th>Company</th><th>Role</th><th>Location</th><th>Application</th><th>Age</th></tr></thead><tbody>
<tr><td><strong><a href="https://simplify.jobs/c/Example">Example &amp; Co.</a></strong></td>
<td>Software Engineer</td><td>New York, NY</td><td><div align="center"><a href="https://simplify.jobs/p/example-1"><img alt="Simplify"></a>
<a href="${apply}?utm_source=Simplify&amp;ref=Simplify"><img width="52" alt="Apply"></a></div></td><td>1d</td></tr>
<tr><td>↳</td><td>Product Analyst</td><td>Remote</td><td><a href="https://careers.example.com/jobs/298?jobId=298&amp;utm_medium=repo">Apply</a></td><td>1d</td></tr>
<tr><td>Retired Co.</td><td>Software Engineer</td><td>Remote</td><td>🔒</td><td>5d</td></tr>
<tr><td>↳</td><td>Only a directory listing</td><td>NYC</td><td><a href="https://simplify.jobs/p/directory-only">Simplify</a></td><td>2d</td></tr>
</tbody></table>

## Other open positions
Company | Position | Location | Apply | Status
:--- | :--- | :--- | :--- | :---
Example Co. | Software Engineer | NYC | [![Apply](https://imgur.com/badge.png)](${apply}/apply) | Open
Example Co. | [Risk Analyst](https://example.com/careers/risk?req=123) | New York | | Open
↳ | Data Scientist | New York | [Apply](https://example.com/jobs/old) | Expired
↳ | ~~Business Analyst~~ | Ohio | [Apply](https://example.com/jobs/old2) | Open

## Archived positions
| Company | Role | Location | Application |
| --- | --- | --- | --- |
| Another | Product Analyst | Ohio | [Apply](https://example.com/jobs/archived) |

## Current
| Company | Job title | Link |
| --- | --- | --- |
| Demo | Operations Analyst | [Apply](https://example.com/jobs/ops) |`

function setup(overrides = {}) {
  const calls = [], prefs = new Map()
  const options = {
    prefs, webSearch: async arg => { calls.push(['web', arg]); return [{ title: 'Web result', url: 'https://example.com/jobs/web', description: 'From search' }] },
    fetchImpl: async (url, init) => { calls.push(['github', url, init]); return new Response(listing) },
    scrape: async url => { calls.push(['scrape', url]); return '# Careers\n[Software Engineer](' + apply + '/apply)\nLocation: New York\n\n[Platform Lead](/jobs/platform-5432)\nRemote' },
    ...overrides,
  }
  const svc = createSources(options)
  return { svc, calls, options, prefs }
}

test('source CRUD persists normalized URLs and enabled state, rejects duplicates, and performs no network work', () => {
  const f = setup()
  const source = f.svc.add({ url: repo + '.git/', label: 'Early careers' })
  assert.equal(source.label, 'Early careers')
  assert.equal(source.kind, 'github')
  assert.equal(source.enabled, true)
  assert.equal(f.svc.list()[0].url, repo.toLowerCase())
  assert.throws(() => f.svc.add({ url: repo.toLowerCase() }), /already saved/)
  assert.throws(() => f.svc.setEnabled({ id: source.id, enabled: 'yes' }))
  f.svc.setEnabled({ id: source.id, enabled: false })
  assert.equal(createSources(f.options).list()[0].enabled, false)
  const copy = f.svc.list(); copy[0].label = 'mutated'
  assert.equal(f.svc.list()[0].label, 'Early careers')
  f.svc.remove({ id: source.id })
  assert.deepEqual(f.svc.list(), [])
  assert.deepEqual(f.calls, [])
})

test('readme raw format handles real Simplify table shape, arrow inheritance, escaped entities, closed rows and duplicate badges', async () => {
  const f = setup(); f.svc.add({ url: repo, label: 'Grad list' })
  const { results, sources } = await f.svc.search({ query: 'jobs' })
  assert.equal(results.length, 4)
  assert.deepEqual(sources, [{ label: 'Grad list', status: 'ok', count: 4 }])
  assert.deepEqual(results[0], { title: 'Software Engineer', url: apply, company: 'Example & Co.', location: 'New York, NY',
    description: 'Example & Co. · New York, NY', source: 'Grad list' })
  assert.equal(results[1].company, 'Example & Co.')
  assert.equal(results[1].url, 'https://careers.example.com/jobs/298?jobId=298')
  assert.deepEqual(results.map(item => item.title), ['Software Engineer', 'Product Analyst', 'Risk Analyst', 'Operations Analyst'])
  assert.deepEqual((await f.svc.search({ query: 'risk analyst in NYC' })).results.map(job => job.title), ['Risk Analyst'])
  assert.equal(f.calls[0][1], github)
  assert.equal(f.calls[0][2].redirect, 'error')
  assert.equal(f.calls[0][2].headers.Accept, 'application/vnd.github.raw+json')
})

test('root, raw and .github README links stay on the fixed GitHub API; handles base64 JSON responses', async () => {
  for (const [url, endpoint] of [
    [repo + '/blob/main/.github/README.md', '/contents/.github/README.md?ref=main'],
    [repo + '/raw/refs/heads/main/README.md', '/contents/README.md?ref=main'],
    ['https://raw.githubusercontent.com/Example-Org/New-Grad-Positions/refs/heads/dev/README.md', '/contents/README.md?ref=dev'],
    [github + '?ref=release', '/readme?ref=release'],
  ]) {
    const f = setup({ fetchImpl: async (request, options) => {
      assert.equal(request, github.slice(0, -'/readme'.length) + endpoint)
      assert.ok(!options.headers.Authorization)
      return Response.json({ encoding: 'base64', content: Buffer.from(listing).toString('base64') })
    } })
    f.svc.add({ url })
    assert.equal((await f.svc.search({ query: 'product analyst' })).results.length, 1)
  }
})

test('web search works without configured sources; only explicitly enabled custom sources run', async () => {
  const f = setup()
  const web = await f.svc.search({ query: '  Risk analyst  ' })
  assert.deepEqual(f.calls, [['web', { query: 'Risk analyst' }]])
  assert.equal(web.results[0].source, 'Web search')
  f.calls.length = 0
  const g = f.svc.add({ url: repo }), site = f.svc.add({ url: career })
  f.svc.setEnabled({ id: g.id, enabled: false })
  const result = await f.svc.search({ query: 'platform lead remote' })
  assert.deepEqual(f.calls, [['scrape', career]])
  assert.equal(result.results[0].url, 'https://careers.example.com/jobs/platform-5432')
  f.svc.setEnabled({ id: site.id, enabled: false })
  assert.deepEqual(await f.svc.search({ query: 'platform' }), { results: [], sources: [] })
})

test('combines distinct postings, preserves requisition IDs, and reports failures without leaking backend messages', async () => {
  const f = setup({ scrape: async url => {
    if (url === career) return '[Software Engineer](' + apply + '/apply)\n[Data Engineer](/jobs/view?jobId=71)\n[SRE](/jobs/view?jobId=82)'
    throw new Error('upstream private response data')
  } })
  f.svc.add({ url: repo, label: 'GitHub jobs' }); f.svc.add({ url: career, label: 'Engineering' })
  f.svc.add({ url: 'https://board.example.com/jobs', label: 'Industry jobs' })
  const { results, sources } = await f.svc.search({ query: 'jobs' })
  assert.deepEqual(sources.map(s => [s.status, s.count]), [['ok', 4], ['ok', 3], ['error', 0]])
  assert.equal(results.length, 6)
  assert.equal(results.filter(r => r.url.startsWith(apply)).length, 1)
  assert.ok(!sources.at(-1).error.includes('private'))
  assert.ok(sources.at(-1).error.includes('Firecrawl'))
})

test('public boards yield job detail links, excluding sign-in, navigation, employer profiles and closed sections', async () => {
  const f = setup({ scrape: async url => {
    if (url.includes('linkedin.')) return '# Jobs\n[View company](https://www.linkedin.com/company/demo)\n[Software Engineer](/jobs/view/software-engineer-123456?utm_source=test)\n[Search jobs](/jobs/search)\n[Sign in](/login)'
    if (url.includes('indeed.')) return '[Analyst](/viewjob?jk=abcdef123)\n[Company](/cmp/Example)'
    if (url.includes('simplify.')) return '# Listings\n[Analyst at Demo](/p/000-test-123/Analyst)\n[Company](/c/Demo)\n## Closed positions\n[Analyst at Retired](/p/002-closed)'
    return 'Access denied. Sign in to continue.'
  } })
  for (const url of ['https://www.linkedin.com/jobs/search/', 'https://indeed.com/jobs?q=analyst', 'https://simplify.jobs/jobs', career]) f.svc.add({ url })
  const response = await f.svc.search({ query: 'jobs' })
  assert.deepEqual(response.results.map(r => r.title), ['Software Engineer', 'Analyst', 'Analyst at Demo'])
  assert.match(response.sources[3].error, /public job listing/)
})

test('rejects unsafe sources, oversized README bodies and explicit rate or truncation failures', async () => {
  const f = setup()
  for (const url of ['file:///tmp/README.md', 'http://public.example.com/', 'https://a:b@public.example.com/x',
    'https://127.0.0.1/foo', 'https://0x7f000001/jobs', 'https://[::1]/', 'https://box.local/', 'https://metadata.google.internal/',
    repo + '/issues', 'https://raw.githubusercontent.com/org/repo/main/script.js']) assert.throws(() => f.svc.add({ url }))
  assert.equal(f.calls.length, 0)
  for (const [response, match] of [
    [new Response('', { status: 403 }), /limit/],
    [new Response('', { status: 404 }), /not found/],
    [new Response('', { headers: { 'content-length': '20000000' } }), /6 MB/],
    [new Response(new Uint8Array(6 * 1024 * 1024 + 1)), /6 MB/],
    [Response.json({ encoding: 'none', content: '', truncated: true }), /incomplete/],
  ]) {
    const limited = setup({ fetchImpl: async () => response })
    limited.svc.add({ url: repo })
    const outcome = await limited.svc.search({ query: 'jobs' })
    assert.deepEqual(outcome.results, [])
    assert.match(outcome.sources[0].error, match)
  }
})

test('blocked job-detail pages, expired listings and industry-board navigation do not become roles', async () => {
  const pages = {
    'https://industry.example.com/jobs/openings-123': '# Access denied\nSign in to continue.',
    'https://industry.example.com/jobs/openings-124': '# Research analyst\nThis posting has expired.\n[Apply](/jobs/old/apply)',
    'https://industry.example.com/vacancies': '# Vacancies\n[Engineering events](/careers/events)\n[Graduate Analyst](/vacancies/graduate-analyst-871)\nLocation: Miami',
  }
  const f = setup({ scrape: url => pages[url] })
  for (const url of Object.keys(pages)) f.svc.add({ url })
  const report = await f.svc.search({ query: 'jobs' })
  assert.deepEqual(report.results.map(r => r.title), ['Graduate Analyst'])
  assert.deepEqual(report.sources.map(s => s.status), ['error', 'ok', 'ok'])
})
