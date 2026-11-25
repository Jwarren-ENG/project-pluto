import { createHash } from 'node:crypto'
import { isIP } from 'node:net'

const prefKey = 'discovery.sources'
const maxBytes = 6 * 1024 * 1024
const trackers = /^(?:utm_.+|gh_src|lever-source|lever-origin)$/i
const boards = /(?:^|\.)(?:simplify\.jobs|linkedin\.com|indeed\.com|glassdoor\.com|ziprecruiter\.com)$/i
const intermediary = /(?:^|\.)(?:github\.com|githubusercontent\.com|imgur\.com|bit\.ly|tinyurl\.com|t\.co|linktr\.ee)$/i
const ats = /(?:^|\.)(?:greenhouse\.io|lever\.co|ashbyhq\.com|myworkdayjobs\.com|workday\.com|smartrecruiters\.com|icims\.com|oraclecloud\.com|jobvite\.com|workable\.com|bamboohr\.com|applytojob\.com|dayforcehcm\.com|successfactors\.(?:com|eu)|eightfold\.ai|recruitee\.com|teamtailor\.com)$/i
class SourceError extends Error {}
const closed = /🔒|(?:^|\b)(?:closed|expired|no longer (?:accepting|available)|position filled|applications? ended)\b/i
const applyText = /^(?:apply(?: now| here| today)?|application|view (?:role|job|posting|opening|details)|learn more|details|link|click here|read more)$/i
const ignoreTitle = /^(?:all (?:jobs|openings)|open (?:roles|positions)|job (?:search|alerts?|openings|opportunities)|careers?|search(?: jobs)?|locations?|teams?|benefits|privacy|sign in|sign up|next|previous|home|hiring now|jobs|opportunities|about us|join (?:us|our team))$/i

function publicUrl(value, base) {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || /[\x00-\x1f\\]/.test(value)) return null
  const url = URL.parse(value.trim(), base)
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.port) return null
  url.hostname = url.hostname.replace(/\.$/, '')
  const host = url.hostname
  if (isIP(host) || host.startsWith('[') || !host.includes('.') || /(?:\.|^)(?:localhost|local|internal|invalid|test|onion|lan|home|intranet|arpa)\.?$/.test(host)) return null
  return url
}

function sourceInfo(input) {
  const url = publicUrl(input)
  if (!url) throw new Error('Enter a public HTTPS repository or career page URL.')
  if (!/^#!?\//.test(url.hash)) url.hash = ''
  const host = url.hostname.replace(/^www\./, '')
  if (['github.com', 'raw.githubusercontent.com', 'api.github.com'].includes(host)) {
    let parts = url.pathname.split('/').filter(Boolean)
    if (host === 'api.github.com') {
      if (parts[0] !== 'repos' || parts.length !== 4 || parts[3] !== 'readme') throw new Error('Use the GitHub repository or its README URL.')
      parts = parts.slice(1, 3)
      if (url.searchParams.has('ref')) parts.push('tree', url.searchParams.get('ref'))
    }
    if (host === 'raw.githubusercontent.com') parts.splice(2, 0, 'raw')
    const [owner, rawRepo, mode, ...tail] = parts
    const repo = rawRepo?.replace(/\.git$/i, '')
    if (!/^[a-z\d-]{1,39}$/i.test(owner || '') || !repo || !/^[\w.-]{1,100}$/.test(repo) || /^\.+$/.test(repo)) {
      throw new Error('Use a public GitHub repository URL.')
    }
    if (tail[0] === 'refs' && tail[1] === 'heads') tail.splice(0, 2)
    let subdir = '', filename = ''
    if (mode === 'raw' || mode === 'blob') {
      filename = tail.pop() || ''
      if (!/^readme(?:\.md|\.markdown)?$/i.test(filename)) throw new Error('Choose the repository README.')
      if (tail.length >= 2 && ['.github', 'docs'].includes(tail.at(-1))) subdir = tail.pop() + '/'
    } else if (mode && mode !== 'tree') throw new Error('Use a GitHub repository or README URL.')
    if (mode && (!tail.length || tail.some(item => !/^[\w.-]{1,150}$/.test(item) || /^\.+$/.test(item)))) {
      throw new Error('Use the repository URL or a README on a named branch.')
    }
    const ref = tail.join('/')
    const key = owner.toLowerCase() + '/' + repo.toLowerCase()
    const page = 'https://github.com/' + key
    const query = ref ? '?ref=' + encodeURIComponent(ref) : ''
    return { kind: 'github', label: owner + '/' + repo,
      url: filename ? page + '/blob/' + ref + '/' + subdir + filename : page + (ref ? '/tree/' + ref : ''),
      api: 'https://api.github.com/repos/' + key + (filename ? '/contents/' + subdir + filename : '/readme') + query }
  }
  if (intermediary.test(host)) throw new Error('Use a public job board, career page or GitHub repository URL.')
  return { kind: 'website', url: url.href, label: url.hostname }
}

const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rarr: '→', crarr: '↵', rdsh: '↳' }
function decode(value) {
  return value.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (original, name) => {
    if (!name.startsWith('#')) return Object.hasOwn(entities, name.toLowerCase()) ? entities[name.toLowerCase()] : original
    const hex = name[1].toLowerCase() === 'x'
    const code = Number.parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10)
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
  })
}
function stripImages(value) {
  return value.replace(/!\[([^\]\n]*)\]\([^\n)]*\)/g, '$1')
}
function plain(value = '') {
  return decode(stripImages(value).replace(/<img\b[^>]*?\balt\s*=\s*["']([^"']*)["'][^>]*>/gi, '$1').replace(/<\/?br\s*\/?\s*>/gi, ', ').replace(/<[^>]{1,4096}>/g, ' ')
    .replace(/\[([^\]\n]*)\]\([^\n)]*\)/g, '$1')).replace(/(?:\*\*|__|~~)/g, '').replace(/\\\|/g, '|').replace(/\s+/g, ' ').trim()
}
function links(value) {
  const found = []
  for (const m of value.matchAll(/<a\b([^>]{0,8192})>([\s\S]*?)<\/a\s*>/gi)) {
    const href = m[1].match(/(?:^|\s)href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i)
    if (href) found.push({ href: decode(href[1] ?? href[2] ?? href[3]), title: plain(m[2]) })
  }
  for (const m of stripImages(value).matchAll(/\[([^\]\n]*)\]\(\s*(?:<([^>\n]+)>|((?:[^\s()]|\([^()\s]*\))+))(?:\s+["'][^\n]*?["'])?\s*\)/g)) {
    found.push({ href: decode(m[2] || m[3]), title: plain(m[1]) })
  }
  return found
}
function destination(href, base) {
  if (!href || (href.startsWith('#') && !/^#!?\//.test(href))) return null
  const url = publicUrl(href, base)
  if (!url || intermediary.test(url.hostname) || /\.(?:svg|png|jpe?g|gif|webp|pdf|zip)$/i.test(url.pathname)) return null
  if (url.pathname === '/' && !url.search && !url.hash) return null
  if (!/^#(?:job|req|posting)/i.test(url.hash) && !/^#!?\//.test(url.hash)) url.hash = ''
  for (const key of [...url.searchParams.keys()]) {
    if (trackers.test(key) || (key === 'ref' && /^simplify$/i.test(url.searchParams.get(key)))) url.searchParams.delete(key)
  }
  return url
}
function samePosting(url) {
  const key = new URL(url)
  if (!/^#!?\/|^#(?:job|req|posting)/i.test(key.hash)) key.hash = ''
  key.pathname = key.pathname.replace(/\/$/, '')
  if (/^(?:jobs|jobs\.eu)\.lever\.co$/.test(key.hostname)) key.pathname = key.pathname.replace(/\/apply$/i, '')
  key.searchParams.sort()
  return key.href
}
function columns(row) {
  const names = row.map(cell => plain(cell).toLowerCase())
  const idx = pattern => names.findIndex(name => pattern.test(name))
  return { role: idx(/^(?:role|position|title|opportunity|job)(?:s| title| name)?$/),
    company: idx(/^(?:company|companies|organization|employer|organisation)(?: name)?$/),
    location: idx(/^(?:locations?|city|where)$/), apply: idx(/^(?:application|apply|link|posting|job link|application link|apply link|url)s?$/),
    status: idx(/^status$/) }
}

function tableRows(rows, source, base) {
  let col, company = ''
  const hits = []
  for (const cells of rows) {
    if (!col) {
      const header = columns(cells)
      if (header.role >= 0) col = header
      continue
    }
    const rawCompany = plain(cells[col.company]).replace(/^🔥\s*|\s*🔥$/gu, '').trim()
    if (rawCompany && !/^(?:↳|↪|↵|⤷|→|↓|〃|"|ditto|same)(?:\s|$)/i.test(rawCompany)) company = rawCompany
    const roleCell = cells[col.role]
    if (!roleCell) continue
    const application = cells[col.apply] || ''
    const title = plain(roleCell)
    if (!title || closed.test(plain(cells[col.status])) || closed.test(plain(application)) || closed.test(title) ||
      /~~.+~~|<(?:del|s|strike)\b/i.test(roleCell)) continue
    const choices = [...links(application), ...links(roleCell)]
    if (!choices.length && /^https:\/\//i.test(application.trim())) choices.push({ href: decode(application.trim()) })
    const destinations = choices.map(link => destination(link.href, base)).filter(Boolean)
    const url = destinations.find(link => !boards.test(link.hostname)) ||
      (base && destinations.find(link => looksLikeOpening(link)))
    if (!url) continue
    const location = plain(cells[col.location]).slice(0, 500)
    hits.push({ url: url.href, title: title.slice(0, 300), ...(company && { company: company.slice(0, 200) }), ...(location && { location }),
      description: [company, location].filter(Boolean).join(' · ').slice(0, 800), source })
  }
  return hits
}

function markdownCells(line) {
  return line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/).map(c => c.trim())
}
function parseTables(content, source, base) {
  const hits = []
  // Tables are text inputs only. No embedded HTML or remote images are loaded.
  const rest = content.replace(/<table\b[^>]*>([\s\S]*?)<\/table\s*>/gi, (_, table) => {
    const rows = Array.from(table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi),
      m => Array.from(m[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]\s*>/gi), cell => cell[1]))
    hits.push(...tableRows(rows, source, base))
    return '\n'
  })
  const lines = rest.split(/\r?\n/)
  const others = []
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('|') && lines[i + 1]?.includes('|') && markdownCells(lines[i + 1]).every(cell => /^:?-{2,}:?$/.test(cell))) {
      const rows = [markdownCells(lines[i])]
      i += 2
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(markdownCells(lines[i++]))
      i--
      hits.push(...tableRows(rows, source, base))
    } else others.push(lines[i])
  }
  return { hits, lines: others }
}

function looksLikeOpening(url) {
  const path = (url.pathname + url.hash).replace(/\/+$/, '')
  if (/(?:^|\.)simplify\.jobs$/.test(url.hostname)) return /^\/p\/[\w-]+/.test(path)
  if (/(?:^|\.)linkedin\.com$/.test(url.hostname)) return /^\/jobs\/view\/(?:[^/]+-)?\d+$/i.test(path)
  if (/(?:^|\.)indeed\.com$/.test(url.hostname)) return /^\/viewjob$/i.test(path) && !!url.searchParams.get('jk')
  if (/(?:^|\.)glassdoor\.com$/.test(url.hostname)) return /^\/job-listing\/.+/.test(path) || (url.searchParams.has('jl') && /job/i.test(path))
  if (/(?:^|\/)(?:privacy|benefits|talent-community|job-alerts|job-search|search-jobs|departments?|teams?|categories|events?|locations?|search|faq|about|culture)(?:\/|$)/i.test(path)) return false
  return /\/(?:jobs?|positions?|openings?|vacancies|requisitions?|careers?|stellenangebote)\/(?!search\b|locations?\b|categories\b|teams?\b|all\b)[^/]+/i.test(path) ||
    [...url.searchParams.keys()].some(key => /^(?:gh_jid|job_?id|requisition_?id|vacancy_?id)$/i.test(key)) ||
    (ats.test(url.hostname) && path.split('/').filter(Boolean).length >= 2 && /[\da-f]{5}|\d{3}/i.test(path))
}
function openSections(markdown) {
  let closedLevel = 0, fence = ''
  return markdown.replace(/<!--[\s\S]*?-->/g, '').split(/\r?\n/).filter(line => {
    const delimiter = line.match(/^\s*(`{3,}|~{3,})/)
    if (delimiter) {
      if (!fence) fence = delimiter[1]
      else if (delimiter[1].startsWith(fence)) fence = ''
      return false
    }
    if (fence) return false
    const header = line.match(/^\s*(#{1,6})\s+(.+)/)
    if (header) {
      if (closedLevel && header[1].length <= closedLevel) closedLevel = 0
      if (!closedLevel && /\b(?:archived|expired|closed|filled)\b/i.test(header[2])) closedLevel = header[1].length
    }
    return !closedLevel
  }).join('\n')
}

function careerPage(content, source, base) {
  const { hits, lines } = parseTables(content, source, base)
  const home = base ? new URL(base) : null
  const detail = home && looksLikeOpening(home)
  if (detail && /(?:\b(?:job|posting|listing|role|position|vacancy|application)s?\b.{0,24}\b(?:closed|expired|filled)\b|\bno longer (?:available|accepting)\b)/i.test(content)) return []
  let heading = '', pageTitle = ''
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const header = line.match(/^\s*(#{1,6})\s+(.+?)\s*$/)
    if (header) {
      heading = plain(header[2])
      if (header[1] === '#' && !pageTitle) pageTitle = heading
    }
    const anchors = links(line)
    if (!anchors.length || closed.test(plain(line)) || /~~.+~~/.test(line)) continue
    const context = []
    for (const next of lines.slice(i + 1, i + 5)) {
      if (next.trim().startsWith('#') || next.includes('](') || /<a\b/i.test(next)) break
      if (next.trim()) context.push(plain(next))
    }
    const nearby = context.join(' ').slice(0, 600)
    if (closed.test(nearby)) continue
    for (const link of anchors) {
      const url = destination(link.href, base)
      if (!url || (!base && boards.test(url.hostname)) || !looksLikeOpening(url)) continue
      const title = applyText.test(link.title) ? heading : link.title
      if (!title || ignoreTitle.test(title) || applyText.test(title) || closed.test(title)) continue
      const inline = plain(line).replace(title, '').replace(/^[\s#*|:–—-]+/, '').trim()
      hits.push({ url: url.href, title: title.slice(0, 300), description: [inline, nearby].filter(Boolean).join(' ').slice(0, 700), source })
    }
  }
  if (base && !hits.length && (!content.trim() || /(?:sign in (?:to (?:continue|see|view)|or sign up)|verify (?:that )?you are human|access (?:to this page (?:has been |is ))?denied|security checkpoint|checking your browser|enable javascript to continue)/i.test(content))) {
    throw new SourceError('This site did not expose a public job listing. It may require sign-in or block public readers.')
  }
  if (detail && pageTitle && !ignoreTitle.test(pageTitle)) {
    hits.unshift({ url: home.href, title: pageTitle.slice(0, 300), description: plain(lines.slice(0, 25).join(' ')).slice(0, 800), source })
  }
  return hits
}

function normalized(value) {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/\bnyc\b/g, 'new york')
    .replace(/\bswe\b/g, 'software engineer').replace(/[^\p{L}\p{N}+#]+/gu, ' ').trim()
}
function matcher(query) {
  const stop = new Set(['in', 'at', 'a', 'an', 'the', 'for', 'and', 'of', 'to', 'role', 'roles', 'job', 'jobs', 'position', 'positions'])
  const alternatives = query.split(/\s+or\s+|;/i).map(part => normalized(part).split(' ').filter(word => word && !stop.has(word)))
  return job => {
    const words = normalized([job.title, job.company, job.location, job.description].filter(Boolean).join(' ')).split(' ')
    return alternatives.some(terms => terms.every(term => words.some(word => term.length > 3 ? word.startsWith(term) : word === term)))
  }
}

async function readGitHub(address, fetchImpl) {
  const response = await fetchImpl(address, { headers: { Accept: 'application/vnd.github.raw+json', 'User-Agent': 'Project-Pluto' },
    redirect: 'error', signal: AbortSignal.timeout(30_000) })
  if (!response.ok) {
    if (response.status === 403 || response.status === 429) throw new SourceError('GitHub denied the request or reached its public API limit.')
    if (response.status === 404) throw new SourceError('The public repository or README was not found.')
    throw new SourceError('GitHub could not return the README.')
  }
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel()
    throw new SourceError('The README exceeds the 6 MB limit.')
  }
  let bytes = 0
  const chunks = []
  if (!response.body) throw new SourceError('GitHub returned an empty README response.')
  for await (const part of response.body) {
    bytes += part.byteLength
    if (bytes > maxBytes) throw new SourceError('The README exceeds the 6 MB limit.')
    chunks.push(part)
  }
  const body = Buffer.concat(chunks).toString('utf8')
  if (body.trimStart().startsWith('{')) {
    let document
    try { document = JSON.parse(body) } catch { return body }
    if (document.truncated || document.size > maxBytes || document.encoding !== 'base64' || typeof document.content !== 'string') {
      throw new SourceError('GitHub returned incomplete README content.')
    }
    return Buffer.from(document.content, 'base64').toString('utf8')
  }
  return body
}

export function createSources({ prefs, webSearch, scrape, fetchImpl = globalThis.fetch }) {
  const list = () => (prefs.get(prefKey) || []).map(item => ({ ...item }))
  function add({ url, label } = {}) {
    const info = sourceInfo(url)
    const saved = list()
    if (saved.some(value => value.url === info.url)) throw new Error('This source is already saved.')
    if (label != null && (typeof label !== 'string' || label.trim().length > 120 || /[\x00-\x1f]/.test(label))) throw new Error('Use a source label of up to 120 characters.')
    const record = { id: createHash('sha256').update(info.url).digest('hex').slice(0, 32), url: info.url, label: label?.trim() || info.label, enabled: true, kind: info.kind }
    prefs.set(prefKey, [...saved, record])
    return record
  }
  function setEnabled({ id, enabled } = {}) {
    if (typeof enabled !== 'boolean') throw new Error('Choose whether the source is enabled.')
    const saved = list()
    const record = saved.find(item => item.id === id)
    if (!record) throw new Error('This source no longer exists.')
    record.enabled = enabled
    prefs.set(prefKey, saved)
    return record
  }
  function remove({ id } = {}) {
    const saved = list()
    prefs.set(prefKey, saved.filter(item => item.id !== id))
    return list()
  }
  async function search({ query } = {}) {
    if (typeof query !== 'string' || !query.trim() || query.length > 1000) throw new Error('Enter a search query of up to 1,000 characters.')
    query = query.trim()
    const sources = [], results = [], seen = new Set()
    const matches = matcher(query)
    const configured = list()
    const selected = configured.filter(item => item.enabled)
    if (!configured.length) selected.push({ kind: 'web', label: 'Web search' })
    for (const item of selected) {
      try {
        let rows
        if (item.kind === 'web') {
          rows = (await webSearch({ query })).flatMap(row => {
            const url = publicUrl(row.url)
            return url && typeof row.title === 'string' ? [{ ...row, url: url.href, description: row.description || '', source: item.label }] : []
          })
        } else {
          const info = sourceInfo(item.url)
          if (info.kind === 'github') {
            const markdown = await readGitHub(info.api, fetchImpl)
            rows = careerPage(openSections(markdown), item.label)
          } else {
            const markdown = await scrape(info.url)
            if (typeof markdown !== 'string') throw new SourceError('The career page returned unreadable text.')
            if (Buffer.byteLength(markdown) > maxBytes) throw new SourceError('The career page exceeds the 6 MB limit.')
            rows = careerPage(openSections(markdown), item.label, info.url)
          }
          rows = rows.filter(matches)
        }
        const local = new Set()
        for (const row of rows) {
          const key = samePosting(row.url)
          local.add(key)
          if (!seen.has(key)) { seen.add(key); results.push(row) }
        }
        sources.push({ label: item.label, status: 'ok', count: local.size })
      } catch (err) {
        const fallback = item.kind === 'github' ? 'Could not read the public GitHub README.' : 'Firecrawl could not read this source. Check its connection and try again.'
        sources.push({ label: item.label, status: 'error', count: 0, error: err instanceof SourceError ? err.message : fallback })
      }
    }
    return { results, sources }
  }
  return { list, add, setEnabled, remove, search }
}

export { createSources as CreateSources }
