// Each price belongs to one provider, model and billing basis. Amounts are per million tokens.
const checked = '2026-11-26'
const openai = 'https://developers.openai.com/api/docs/models/'
const anthropic = 'https://platform.claude.com/docs/en/about-claude/pricing'
const openaiTier = 'Standard speed through 272,000 input tokens per request. For a longer request, double the input rate and multiply the output rate by 1.5.'
function card(provider, model, label, input, output, source, note, aliases = []) {
  return { provider, models: [model, ...aliases], label, input, output, source, note, verified: checked }
}

export function calendarDay(now = new Date()) {
  const pad = n => String(n).padStart(2, '0')
  return now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate())
}

export function publishedRates(entry, day) {
  const step = entry.schedule?.findLast(change => change.from <= day)
  return { input: step?.input ?? entry.input, output: step?.output ?? entry.output }
}

const google = 'https://aistudio.google.com/docs/pricing#'
function geminiLaunchCard(model, label) {
  return { ...card('gemini', model, label, 2, 10, google + model,
    'Standard text. Dec 1, 2026: input rises to $4 and output to $20 per million. The forecast includes the change.'),
    schedule: [{ from: '2026-12-01', input: 4, output: 20 }] }
}

export const defaultScenario = 'gpt-6.2-sol'
export const rateCards = {
  'gpt-6.2-sol': card('openai', 'gpt-6.2-sol', 'OpenAI · GPT-6.2 Sol', 2, 10, openai + 'gpt-6.2-sol', openaiTier),
  'gpt-6.2-astra': card('openai', 'gpt-6.2-astra', 'OpenAI · GPT-6.2 Astra', 8, 40, openai + 'gpt-6.2-astra', openaiTier),
  'gpt-6.1-terra': card('openai', 'gpt-6.1-terra', 'OpenAI · GPT-6.1 Terra', 1, 5, openai + 'gpt-6.1-terra', openaiTier),
  'gpt-6-luna': card('openai', 'gpt-6-luna', 'OpenAI · GPT-6 Luna', 0.10, 0.50, openai + 'gpt-6-luna', openaiTier),
  'chat-latest': card('openai', 'chat-latest', 'OpenAI · chat-latest (rolling alias)', 5, 30, openai + 'chat-latest',
    'This API alias follows the current ChatGPT Instant model. OpenAI can update the underlying model.'),
  'claude-sonnet-5-5': card('anthropic', 'claude-sonnet-5-5', 'Anthropic · Claude Sonnet 5.5', 2, 10, anthropic, 'Standard global API pricing.'),
  'claude-opus-5-5': card('anthropic', 'claude-opus-5-5', 'Anthropic · Claude Opus 5.5', 4, 20, anthropic, 'Standard global API pricing.'),
  'claude-haiku-5-5': card('anthropic', 'claude-haiku-5-5', 'Anthropic · Claude Haiku 5.5', 0.10, 0.50, anthropic, 'Through 100,000 input tokens per request. Above this, use $0.50 input and $2.50 output per million.'),
  'claude-fable-5-2': card('anthropic', 'claude-fable-5-2', 'Anthropic · Claude Fable 5.2', 8, 40, anthropic, 'Standard global API pricing.'),
  'gemini-4-carbon': geminiLaunchCard('gemini-4-carbon', 'Google · Gemini 4 Carbon'),
  'gemini-4-argon': geminiLaunchCard('gemini-4-argon', 'Google · Gemini 4 Argon'),
  'gemini-4-neon': card('gemini', 'gemini-4-neon', 'Google · Gemini 4 Neon', 3, 15, google + 'gemini-4-neon', 'Paid Standard tier, including thinking tokens in output.'),
  'gemini-4-hydrogen': card('gemini', 'gemini-4-hydrogen', 'Google · Gemini 4 Hydrogen', 1.50, 7.50, google + 'gemini-4-hydrogen', 'Paid Standard tier, including thinking tokens in output.'),
  'grok-4.7': card('xai', 'grok-4.7', 'xAI · Grok 4.7', 2, 6, 'https://docs.x.ai/developers/pricing', 'Global endpoint, below 200,000 input tokens per request. At or above that threshold, use $4 input and $12 output per million.', ['grok-4.7-latest']),
  openrouter: { label: 'OpenRouter · manual rates', input: null, output: null },
  custom: { label: 'Other API model · manual rates', input: null, output: null },
  // Old IDs retain their original model identity for saved overrides and explicit drafting connections.
  openai: { ...card('openai', 'gpt-4.1-mini', 'OpenAI · GPT-4.1 mini', 0.40, 1.60, openai + 'gpt-4.1-mini', 'Previous model.', ['gpt-4.1-mini-2025-04-14']), legacy: true },
  anthropic: { ...card('anthropic', 'claude-sonnet-4-6', 'Anthropic · Claude Sonnet 4.6', 3, 15, anthropic, 'Previous model.'), legacy: true },
}

const creditSource = 'https://developers.openai.com/codex/pricing/'
export const creditCards = {
  'codex-sol-credits': { label: 'Codex credits · GPT-6.2 Sol', input: 50, output: 250, source: creditSource, verified: checked },
  'codex-astra-credits': { label: 'Codex credits · GPT-6.2 Astra', input: 200, output: 1000, source: creditSource, verified: checked },
}
