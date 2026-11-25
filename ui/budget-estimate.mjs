// USD per million tokens at standard, uncached API pricing. A preset is an editable scenario.
export const rateCards = {
  openai: { label: 'OpenAI · GPT-4.1 mini', input: 0.40, output: 1.60, source: 'https://developers.openai.com/api/docs/models/gpt-4.1-mini', verified: '2026-11-25' },
  anthropic: { label: 'Anthropic · Claude Sonnet 4.6', input: 3, output: 15, source: 'https://platform.claude.com/docs/en/models/sonnet-4-6/overview', verified: '2026-11-25' },
  openrouter: { label: 'OpenRouter', input: 1, output: 4 },
  custom: { label: 'Custom API', input: 1, output: 4 },
}

export const forecastDays = 30

export const limits = { jobs: 1000, tokens: 10_000_000, rate: 100_000, toolCost: 10_000, subscription: 1_000_000 }

export function budgetDefaults() {
  return {
    version: 1, provider: 'openai', jobsPerDay: 10,
    inputLow: 2000, inputHigh: 6000, outputLow: 300, outputHigh: 800,
    rates: Object.fromEntries(Object.entries(rateCards).map(([id, card]) => [id, { input: card.input, output: card.output }])),
    toolCostPerRole: 0, monthlySubscription: null,
  }
}

export function loadBudget(saved) {
  const defaults = budgetDefaults()
  if (!saved || typeof saved !== 'object') return defaults
  const restored = Object.fromEntries(Object.keys(defaults).map(key => [key, saved[key] ?? defaults[key]]))
  restored.rates = Object.fromEntries(Object.entries(defaults.rates).map(([id, pair]) =>
    [id, { input: saved.rates?.[id]?.input ?? pair.input, output: saved.rates?.[id]?.output ?? pair.output }]))
  return restored
}

function number(value, label, max, integer = false) {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN
  if (!Number.isFinite(n) || n < 0 || n > max || (integer && !Number.isInteger(n))) {
    throw new Error(label + ' must be ' + (integer ? 'a whole number' : 'a number') + ' from 0 to ' + max.toLocaleString('en-US') + '.')
  }
  return n
}

export function normalizeBudget(form) {
  if (form.version !== 1) throw new Error('This budget was saved with a different planner version.')
  const provider = form.provider
  if (!Object.hasOwn(rateCards, provider) && provider !== 'ollama' && provider !== 'subscription') throw new Error('Choose a budget scenario.')
  const budget = {
    version: 1, provider, jobsPerDay: number(form.jobsPerDay, 'Jobs per day', limits.jobs, true),
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
    budget.rates[id] = {
      input: number(form.rates?.[id]?.input, card.label + ' input rate', limits.rate),
      output: number(form.rates?.[id]?.output, card.label + ' output rate', limits.rate),
    }
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
    if (rate) modelFees = [
      (inputLow * rate.input + outputLow * rate.output) * jobs / 1_000_000,
      (inputHigh * rate.input + outputHigh * rate.output) * jobs / 1_000_000,
    ]
    if (provider === 'ollama') modelFees = [0, 0]
    const tools = jobs * toolCostPerRole
    const subscription = provider === 'subscription' && monthlySubscription !== null ? monthlySubscription * days / forecastDays : null
    const total = modelFees ? modelFees.map(fee => fee + tools) : subscription !== null ? [subscription + tools, subscription + tools] : null
    return { jobs, tokens, modelFees, subscription, tools, total }
  }
  const days = Array.from({ length: forecastDays + 1 }, (_, day) => period(day))
  return { day: days[1], month: days[forecastDays], days }
}
