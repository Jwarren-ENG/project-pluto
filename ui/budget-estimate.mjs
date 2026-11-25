// USD per million tokens at standard, uncached API pricing. A preset is an editable scenario.
export const rateCards = {
  openai: { label: 'OpenAI · GPT-4.1 mini', models: ['gpt-4.1-mini', 'gpt-4.1-mini-2025-04-14'], input: 0.40, output: 1.60, source: 'https://developers.openai.com/api/docs/models/gpt-4.1-mini', verified: '2026-11-25' },
  anthropic: { label: 'Anthropic · Claude Sonnet 4.6', models: ['claude-sonnet-4-6'], input: 3, output: 15, source: 'https://platform.claude.com/docs/en/about-claude/pricing', verified: '2026-11-25' },
  openrouter: { label: 'OpenRouter', input: null, output: null },
  custom: { label: 'Custom API', input: null, output: null },
}

export const forecastDays = 30

export const limits = { jobs: 1000, tokens: 10_000_000, rate: 100_000, toolCost: 10_000, subscription: 1_000_000 }

export function budgetDefaults() {
  return {
    version: 2, provider: 'openai', jobsPerDay: 10,
    inputLow: 2000, inputHigh: 6000, outputLow: 300, outputHigh: 800,
    rates: Object.fromEntries(Object.entries(rateCards).map(([id, card]) => [id, { input: card.input, output: card.output }])),
    toolCostPerRole: 0, monthlySubscription: null,
  }
}

export function loadBudget(saved) {
  const defaults = budgetDefaults()
  if (!saved || typeof saved !== 'object') return defaults
  const restored = Object.fromEntries(Object.keys(defaults).map(key => [key, saved[key] ?? defaults[key]]))
  const legacy = saved.version === 1 || saved.version == null
  if (legacy) restored.version = 2
  restored.rates = Object.fromEntries(Object.entries(defaults.rates).map(([id, defaults]) => {
    const stored = saved.rates?.[id] || {}
    const input = Object.hasOwn(stored, 'input') ? stored.input : defaults.input
    const output = Object.hasOwn(stored, 'output') ? stored.output : defaults.output
    // Version 1 supplied this pair even when nobody had entered a price.
    const oldExample = legacy && !rateCards[id].source && Number(input) === 1 && Number(output) === 4
    return [id, { input, output, ...(oldExample || stored.needsReview === true ? { needsReview: true } : {}) }]
  }))
  return restored
}

// Only use a published rate when both the provider and model match.
export function connectedBudget(settings) {
  const id = settings?.activeProvider
  if (!id) return null
  const model = settings.providers?.[id]?.model || ''
  const label = settings.providers?.[id]?.label || id
  let scenario = 'custom'
  if (id === 'codex') scenario = 'subscription'
  else if (id === 'ollama' || id === 'openrouter') scenario = id
  else if (rateCards[id]?.models?.includes(model)) scenario = id
  return { scenario, label: model ? label + ' · ' + model : label }
}

function number(value, label, max, integer = false) {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN
  if (!Number.isFinite(n) || n < 0 || n > max || (integer && !Number.isInteger(n))) {
    throw new Error(label + ' must be ' + (integer ? 'a whole number' : 'a number') + ' from 0 to ' + max.toLocaleString('en-US') + '.')
  }
  return n
}

export function normalizeBudget(form) {
  if (form.version === 1) return normalizeBudget(loadBudget(form))
  if (form.version !== 2) throw new Error('This budget was saved with a different planner version.')
  const provider = form.provider
  if (!Object.hasOwn(rateCards, provider) && provider !== 'ollama' && provider !== 'subscription') throw new Error('Choose a budget scenario.')
  const budget = {
    version: 2, provider, jobsPerDay: number(form.jobsPerDay, 'Jobs per day', limits.jobs, true),
    inputLow: number(form.inputLow, 'Low input tokens', limits.tokens, true),
    inputHigh: number(form.inputHigh, 'High input tokens', limits.tokens, true),
    outputLow: number(form.outputLow, 'Low output tokens', limits.tokens, true),
    outputHigh: number(form.outputHigh, 'High output tokens', limits.tokens, true),
    toolCostPerRole: number(form.toolCostPerRole, 'Tool costs per role', limits.toolCost),
    monthlySubscription: form.monthlySubscription == null || form.monthlySubscription === '' ? null :
      number(form.monthlySubscription, 'Monthly subscription fee', limits.subscription),
    rates: {},
  }
  if (budget.inputHigh < budget.inputLow || budget.outputHigh < budget.outputLow) {
    throw new Error('Each high token estimate must be at least its corresponding low estimate.')
  }
  for (const [id, card] of Object.entries(rateCards)) {
    const rates = form.rates?.[id] || {}
    const price = key => rates[key] == null || rates[key] === '' ? null :
      number(rates[key], card.label + ' ' + key + ' rate', limits.rate)
    budget.rates[id] = { input: price('input'), output: price('output'),
      ...(rates.needsReview === true ? { needsReview: true } : {}) }
  }
  return budget
}

export function estimateBudget(form) {
  const budget = normalizeBudget(form)
  const { provider, jobsPerDay, inputLow, inputHigh, outputLow, outputHigh, monthlySubscription, toolCostPerRole } = budget
  const rate = budget.rates[provider]
  function period(days) {
    const jobs = jobsPerDay * days
    const tokens = [(inputLow + outputLow) * jobs, (inputHigh + outputHigh) * jobs]
    let modelFees = null
    const canPrice = rate && !rate.needsReview &&
      (rate.input != null || inputHigh === 0) && (rate.output != null || outputHigh === 0)
    if (canPrice) modelFees = [
      (inputLow * rate.input + outputLow * rate.output) * jobs / 1_000_000,
      (inputHigh * rate.input + outputHigh * rate.output) * jobs / 1_000_000,
    ]
    if (provider === 'ollama' || (rate && (jobs === 0 || inputHigh + outputHigh === 0))) modelFees = [0, 0]
    const tools = jobs * toolCostPerRole
    const subscription = provider === 'subscription' && (days === 0 || monthlySubscription !== null) ? (monthlySubscription ?? 0) * days / forecastDays : null
    const total = modelFees ? modelFees.map(fee => fee + tools) : subscription !== null ? [subscription + tools, subscription + tools] : null
    return { jobs, tokens, modelFees, subscription, tools, total }
  }
  const days = Array.from({ length: forecastDays + 1 }, (_, day) => period(day))
  return { day: days[1], month: days[forecastDays], days }
}
