import { calendarDay, creditCards, defaultScenario, publishedRates, rateCards } from './budget-prices.mjs'

export { calendarDay, creditCards, defaultScenario, publishedRates, rateCards }
export const forecastDays = 30

export const limits = { jobs: 1000, tokens: 10_000_000, rate: 100_000, toolCost: 10_000, subscription: 1_000_000, watts: 100_000, minutes: 1440, electricityRate: 100 }

export function budgetDefaults(today = calendarDay()) {
  return {
    version: 3, rateDate: today, provider: defaultScenario, jobsPerDay: 10,
    inputLow: 2000, inputHigh: 6000, outputLow: 300, outputHigh: 800,
    rates: Object.fromEntries(Object.entries(rateCards).map(([id, card]) => [id, publishedRates(card, today)])),
    toolCostPerRole: 0, monthlySubscription: null,
    watts: 60, minutesLow: 2, minutesHigh: 6, electricityRate: 0.1817,
  }
}

export function loadBudget(saved, today = calendarDay()) {
  const defaults = budgetDefaults(today)
  if (!saved || typeof saved !== 'object') return defaults
  const restored = Object.fromEntries(Object.keys(defaults).map(key => [key, saved[key] ?? defaults[key]]))
  restored.rateDate = today
  const legacy = saved.version === 1 || saved.version == null
  const previousPlanner = legacy || saved.version === 2
  if (previousPlanner) restored.version = 3
  restored.rates = Object.fromEntries(Object.entries(defaults.rates).map(([id, defaults]) => {
    const stored = saved.rates?.[id] || {}
    if (rateCards[id].schedule && saved.rateDate && today !== saved.rateDate) {
      const prior = publishedRates(rateCards[id], saved.rateDate)
      if (stored.input === prior.input && stored.output === prior.output && !stored.needsReview) return [id, defaults]
    }
    const input = Object.hasOwn(stored, 'input') ? stored.input : defaults.input
    const output = Object.hasOwn(stored, 'output') ? stored.output : defaults.output
    // Version 1 supplied this pair even when nobody had entered a price.
    const oldExample = legacy && !rateCards[id].source && Number(input) === 1 && Number(output) === 4
    return [id, { input, output, ...(oldExample || stored.needsReview === true ? { needsReview: true } : {}) }]
  }))
  if (previousPlanner && ['openai', 'anthropic'].includes(restored.provider)) {
    const oldCard = rateCards[restored.provider]
    const values = restored.rates[restored.provider]
    if (!values.needsReview && values.input != null && values.output != null &&
        Number(values.input) === oldCard.input && Number(values.output) === oldCard.output) {
      restored.provider = restored.provider === 'openai' ? defaultScenario : 'claude-sonnet-5-5'
    }
  }
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
  else {
    const match = Object.entries(rateCards).find(([, card]) => card.provider === id && card.models?.includes(model))
    if (match) scenario = match[0]
  }
  return { scenario, label: model ? label + ' · ' + model : label }
}

function number(value, label, max, integer = false) {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN
  if (!Number.isFinite(n) || n < 0 || n > max || (integer && !Number.isInteger(n))) {
    throw new Error(label + ' must be ' + (integer ? 'a whole number' : 'a number') + ' from 0 to ' + max.toLocaleString('en-US') + '.')
  }
  return n
}

export function normalizeBudget(form, today = calendarDay()) {
  if (form.version == null || form.version === 1 || form.version === 2) return normalizeBudget(loadBudget(form, today), today)
  if (form.version !== 3) throw new Error('This budget was saved with a different planner version.')
  if (form.rateDate !== today) return normalizeBudget(loadBudget(form, today), today)
  const provider = form.provider
  if (!Object.hasOwn(rateCards, provider) && !Object.hasOwn(creditCards, provider) && provider !== 'ollama' && provider !== 'subscription') throw new Error('Choose a budget scenario.')
  const budget = {
    version: 3, rateDate: today, provider, jobsPerDay: number(form.jobsPerDay, 'Jobs per day', limits.jobs, true),
    inputLow: number(form.inputLow, 'Low input tokens', limits.tokens, true),
    inputHigh: number(form.inputHigh, 'High input tokens', limits.tokens, true),
    outputLow: number(form.outputLow, 'Low output tokens', limits.tokens, true),
    outputHigh: number(form.outputHigh, 'High output tokens', limits.tokens, true),
    toolCostPerRole: number(form.toolCostPerRole, 'Tool costs per role', limits.toolCost),
    monthlySubscription: form.monthlySubscription == null || form.monthlySubscription === '' ? null :
      number(form.monthlySubscription, 'Monthly subscription fee', limits.subscription),
    watts: number(form.watts, 'Average power in watts', limits.watts),
    minutesLow: number(form.minutesLow, 'Low active minutes per job', limits.minutes),
    minutesHigh: number(form.minutesHigh, 'High active minutes per job', limits.minutes),
    electricityRate: number(form.electricityRate, 'Electricity price per kWh', limits.electricityRate),
    rates: {},
  }
  if (budget.inputHigh < budget.inputLow || budget.outputHigh < budget.outputLow) {
    throw new Error('Each high token estimate must be at least its corresponding low estimate.')
  }
  if (budget.minutesHigh < budget.minutesLow) throw new Error('High active minutes must be at least the low estimate.')
  for (const [id, card] of Object.entries(rateCards)) {
    const rates = form.rates?.[id] || {}
    const price = key => rates[key] == null || rates[key] === '' ? null :
      number(rates[key], card.label + ' ' + key + ' rate', limits.rate)
    budget.rates[id] = { input: price('input'), output: price('output'),
      ...(rates.needsReview === true ? { needsReview: true } : {}) }
  }
  return budget
}

export function estimateBudget(form, today = calendarDay()) {
  const budget = normalizeBudget(form, today)
  const { provider, jobsPerDay, inputLow, inputHigh, outputLow, outputHigh, monthlySubscription, toolCostPerRole } = budget
  const rate = budget.rates[provider]
  const creditCard = Object.hasOwn(creditCards, provider) ? creditCards[provider] : null
  const card = rateCards[provider]
  const sums = [{ input: 0, output: 0 }]
  if (card?.schedule) {
    const standard = publishedRates(card, today)
    if (rate.input === standard.input && rate.output === standard.output) {
      const midnight = Date.parse(today + 'T00:00:00Z')
      for (let day = 0; day < forecastDays; day++) {
        const date = new Date(midnight + day * 86_400_000).toISOString().slice(0, 10)
        const prices = publishedRates(card, date)
        sums.push({ input: sums[day].input + prices.input, output: sums[day].output + prices.output })
      }
    }
  }
  function period(days) {
    const jobs = jobsPerDay * days
    const tokens = [(inputLow + outputLow) * jobs, (inputHigh + outputHigh) * jobs]
    let modelFees = null
    const canPrice = rate && !rate.needsReview &&
      (rate.input != null || inputHigh === 0) && (rate.output != null || outputHigh === 0)
    if (canPrice) {
      const input = sums[days]?.input ?? rate.input * days
      const output = sums[days]?.output ?? rate.output * days
      modelFees = [(inputLow * input + outputLow * output) * jobsPerDay / 1_000_000,
        (inputHigh * input + outputHigh * output) * jobsPerDay / 1_000_000]
    }
    if (provider === 'ollama' || (rate && (jobs === 0 || inputHigh + outputHigh === 0))) modelFees = [0, 0]
    const tools = jobs * toolCostPerRole
    const subscription = provider === 'subscription' && (days === 0 || monthlySubscription !== null) ? (monthlySubscription ?? 0) * days / forecastDays : null
    if (provider === 'ollama') {
      const energyKwh = [budget.minutesLow, budget.minutesHigh].map(minutes => budget.watts * minutes * jobs / 60_000)
      const electricity = energyKwh.map(kwh => kwh * budget.electricityRate)
      return { jobs, tokens, modelFees, energyKwh, electricity, subscription, tools, total: electricity.map(cost => cost + tools) }
    }
    if (creditCard) {
      const credits = [(inputLow * creditCard.input + outputLow * creditCard.output) * jobs / 1_000_000,
        (inputHigh * creditCard.input + outputHigh * creditCard.output) * jobs / 1_000_000]
      return { jobs, tokens, credits, modelFees, subscription, tools, total: null }
    }
    const total = modelFees ? modelFees.map(fee => fee + tools) : subscription !== null ? [subscription + tools, subscription + tools] : null
    return { jobs, tokens, modelFees, subscription, tools, total }
  }
  const days = Array.from({ length: forecastDays + 1 }, (_, day) => period(day))
  return { day: days[1], month: days[forecastDays], days }
}
