export const defaultClaudeModel = 'claude-sonnet-5-5'
export const claudeModels = [
  { id: defaultClaudeModel, label: 'Claude Sonnet 5.5' },
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' },
  { id: 'claude-fable-5-2', label: 'Claude Fable 5.2' },
]

// Providers use seconds, ISO dates, or no date at all. Keep undated entries in
// their original order, which also preserves Codex's account-specific ranking.
function publishedTime(value) {
  if (!value) return undefined
  const time = typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : Date.parse(value)
  return Number.isFinite(time) && time > 0 && time <= Date.now() + 86400000 ? time : undefined
}

export function orderModels(entries) {
  const unique = new Map()
  for (const row of entries) {
    if (typeof row?.id !== 'string' || !row.id.trim() || row.id.length > 256 || /[\u0000-\u001f]/.test(row.id) || unique.has(row.id)) continue
    const created = publishedTime(row.created)
    unique.set(row.id, { id: row.id, label: typeof row.label === 'string' && row.label.trim() ? row.label.trim().slice(0, 256) : row.id,
      ...(created && { created }), ...(row.recommended && { recommended: true }) })
  }
  const models = [...unique.values()].sort((a, b) => (b.created || 0) - (a.created || 0))
  const dated = models.filter(row => row.created).length
  return { models, order: dated === 0 ? 'provider' : dated === models.length ? 'newest' : 'mixed' }
}

function openAITextModel(id) {
  return typeof id === 'string' && /^(?:gpt-|chatgpt-|o[1-9](?:-|$)|ft:(?:gpt-|o[1-9]))/.test(id)
    && !/(?:embedding|moderation|realtime|transcrib|search-api|audio|tts|image|deep-research|codex|computer-use|instruct)/i.test(id)
}

export async function readCatalog(id, read) {
  if (id === 'anthropic') {
    const models = [], cursors = new Set()
    let cursor = ''
    do {
      const query = new URLSearchParams({ limit: '100' })
      if (cursor) query.set('after_id', cursor)
      const page = await read('/models?' + query)
      if (!Array.isArray(page?.data)) throw new Error('Claude returned an unreadable model list.')
      models.push(...page.data.map(row => ({ id: row.id, label: row.display_name, created: row.created_at })))
      if (!page.has_more) break
      cursor = page.last_id
      if (typeof cursor !== 'string' || !cursor || cursors.has(cursor) || cursors.size >= 50) throw new Error('Claude returned an incomplete model list.')
      cursors.add(cursor)
    } while (cursor)
    return models
  }
  const page = await read(id === 'ollama' ? '/api/tags' : '/models')
  if (id === 'ollama') {
    if (!Array.isArray(page?.models)) throw new Error('Ollama returned an unreadable model list.')
    return page.models.filter(row => !row.remote_model && !row.remote_host && !row.name?.endsWith(':cloud'))
      .map(row => ({ id: row.name || row.model, label: row.name || row.model, created: row.modified_at }))
  }
  if (!Array.isArray(page?.data)) throw new Error('The provider returned an unreadable model list.')
  return page.data.filter(row => {
    if (id === 'openai') return openAITextModel(row.id)
    const output = row.architecture?.output_modalities
    const input = row.architecture?.input_modalities
    return (!Array.isArray(output) || output.includes('text')) && (!Array.isArray(input) || input.includes('text'))
  }).map(row => ({ id: row.id, label: row.name || row.id, created: row.created || row.created_at }))
}
