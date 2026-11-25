import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { budgetDefaults, connectedBudget, estimateBudget, loadBudget, normalizeBudget } from '../ui/budget-estimate.mjs'
import { createWorkspace } from '../desktop/workspace.mjs'

test('API range prices input and output separately and scales all usage over 30 days', () => {
  const form = budgetDefaults()
  Object.assign(form, { provider: 'custom', jobsPerDay: '4', inputLow: 1000, inputHigh: 2000, outputLow: 500, outputHigh: 1000, toolCostPerRole: '0.25' })
  form.rates.custom = { input: '2', output: '6' }
  const { day, month } = estimateBudget(form)
  assert.deepEqual(day, { jobs: 4, tokens: [6000, 12000], modelFees: [0.02, 0.04], tools: 1, subscription: null, total: [1.02, 1.04] })
  assert.deepEqual(month, { jobs: 120, tokens: [180000, 360000], modelFees: [0.6, 1.2], tools: 30, subscription: null, total: [30.6, 31.2] })
})

test('Ollama has zero provider fees with or without estimated tool spending', () => {
  const form = { ...budgetDefaults(), provider: 'ollama', electricityRate: 0, toolCostPerRole: 0.10 }
  assert.deepEqual(estimateBudget(form).day.modelFees, [0, 0])
  assert.deepEqual(estimateBudget(form).month.total, [30, 30])
  form.toolCostPerRole = 0
  assert.deepEqual(estimateBudget(form).month.total, [0, 0])
})

test('subscription reports workload, leaves unknown fees unspecified, and allocates a known flat fee once', () => {
  const form = { ...budgetDefaults(), provider: 'subscription', toolCostPerRole: 0.10 }
  const unknown = estimateBudget(form)
  assert.equal(unknown.day.modelFees, null)
  assert.equal(unknown.month.total, null)
  assert.deepEqual(unknown.month.tokens, [690000, 2040000])
  form.monthlySubscription = '30'
  const { day, month } = estimateBudget(form)
  assert.equal(day.subscription, 1)
  assert.deepEqual(day.total, [2, 2])
  assert.deepEqual(month.total, [60, 60])
  form.jobsPerDay = 0
  assert.deepEqual(estimateBudget(form).month.total, [30, 30])
  assert.deepEqual(estimateBudget(form).month.tokens, [0, 0])
  form.monthlySubscription = 0
  assert.deepEqual(estimateBudget(form).month.total, [0, 0])
})

test('blank, inverted, negative, fractional job counts and nonfinite inputs fail validation', () => {
  for (const [key, value] of [['jobsPerDay', ''], ['jobsPerDay', false], ['jobsPerDay', 2.5], ['jobsPerDay', 1001], ['inputLow', 7000], ['outputHigh', 2], ['inputHigh', Infinity], ['toolCostPerRole', -1], ['monthlySubscription', NaN], ['provider', 'constructor'], ['version', 999]]) {
    assert.throws(() => normalizeBudget({ ...budgetDefaults(), [key]: value }))
  }
  const form = budgetDefaults()
  form.rates.openrouter.output = ' '
  assert.throws(() => normalizeBudget(form), /output rate/)
})

test('partial saved profiles gain new defaults, preserve zero and retain independent rate edits', () => {
  const a = loadBudget({ jobsPerDay: 0, rates: { anthropic: { output: 0 } } })
  assert.deepEqual(a.rates.anthropic, { input: 3, output: 0 })
  assert.equal(a.jobsPerDay, 0)
  a.rates.openai.input = 123
  const b = loadBudget(null)
  assert.equal(b.rates.openai.input, 0.4)
  assert.equal(b.rates.anthropic.output, 15)
  assert.deepEqual(normalizeBudget(b), b)
})

test('saving only the budget preserves other profile edits and survives reopening the workspace', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pluto-fictional-budget-'))
  let workspace = createWorkspace(dir)
  try {
    workspace.saveProfile({ name: 'Fictional Applicant', summary: 'First revision' })
    const form = loadBudget(workspace.snapshot().profile.budget)
    form.jobsPerDay = '18'
    form.rates.custom.output = '5.75'
    workspace.saveProfile({ summary: 'Later revision' })
    workspace.saveProfile({ budget: normalizeBudget(form) })
    workspace.close()
    workspace = createWorkspace(dir)
    const { profile } = workspace.snapshot()
    assert.equal(profile.name, 'Fictional Applicant')
    assert.equal(profile.summary, 'Later revision')
    assert.equal(profile.budget.jobsPerDay, 18)
    assert.equal(profile.budget.rates.custom.output, 5.75)
    assert.deepEqual(normalizeBudget(loadBudget(profile.budget)), profile.budget)
  } finally {
    workspace.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('cumulative days share the daily and monthly endpoints and keep both ends of a cost range', () => {
  const form = { ...budgetDefaults(), provider: 'custom', jobsPerDay: 4,
    inputLow: 1000, inputHigh: 2000, outputLow: 500, outputHigh: 1000, toolCostPerRole: 0.25 }
  form.rates.custom = { input: 2, output: 6 }
  const { day, month, days } = estimateBudget(form)
  assert.equal(days.length, 31)
  assert.deepEqual(days[1], day)
  assert.deepEqual(days[30], month)
  assert.deepEqual(days[0], { jobs: 0, tokens: [0, 0], modelFees: [0, 0], tools: 0, subscription: null, total: [0, 0] })
  assert.deepEqual(days[15], { jobs: 60, tokens: [90000, 180000], modelFees: [0.3, 0.6], tools: 15, subscription: null, total: [15.3, 15.6] })
})

test('selected-day estimates use local tool fees and preserve subscription fee and workload semantics', () => {
  const form = { ...budgetDefaults(), provider: 'ollama', watts: 0, jobsPerDay: 3, toolCostPerRole: 0.25 }
  assert.deepEqual(estimateBudget(form).days[4].total, [3, 3])
  form.provider = 'subscription'
  assert.equal(estimateBudget(form).days[4].total, null)
  assert.deepEqual(estimateBudget(form).days[4].tokens, [27600, 81600])
  form.monthlySubscription = 30
  form.jobsPerDay = 0
  assert.deepEqual(estimateBudget(form).days[4], { jobs: 0, tokens: [0, 0], modelFees: null, tools: 0, subscription: 4, total: [4, 4] })
})

test('missing or legacy example rates do not produce a dollar forecast until confirmed', () => {
  const form = { ...budgetDefaults(), provider:'openrouter', toolCostPerRole:0.05 }
  let est = estimateBudget(form)
  assert.equal(est.day.total, null)
  assert.equal(est.day.tools, 0.5)
  assert.deepEqual(est.days[0].total, [0,0])
  const saved = loadBudget({ ...form, version:1, rates:{openrouter:{input:1,output:4}} })
  assert.deepEqual(saved.rates.openrouter, {input:1,output:4,needsReview:true})
  assert.equal(estimateBudget(loadBudget(normalizeBudget(saved))).day.total, null)
  saved.rates.openrouter.needsReview = false
  assert.deepEqual(estimateBudget(saved).day.total, [0.532,0.592])
  form.rates.openrouter = { input:0, output:0 }
  assert.deepEqual(estimateBudget(loadBudget(normalizeBudget(form))).day.total,[0.5,0.5])
  form.rates.openrouter.output = null
  assert.equal(estimateBudget(form).day.total,null)
  form.outputHigh = form.outputLow = 0
  assert.deepEqual(estimateBudget(form).day.total,[0.5,0.5])
  assert.deepEqual(estimateBudget({...form,provider:'subscription'}).days[0].total,[0,0])
  assert.equal(loadBudget({version:1,rates:{custom:{input:2,output:7}}}).rates.custom.needsReview,undefined)
})

test('default and connected scenarios price the exact API model, independently of credits', () => {
  const form = { ...budgetDefaults(), jobsPerDay: 100 }
  assert.equal(form.provider, 'gpt-6.2-sol')
  assert.deepEqual(estimateBudget(form).day.total, [0.70, 2])
  const check = (provider, model) => connectedBudget({activeProvider: provider, providers: {[provider]: {model}}}).scenario
  assert.equal(check('openai','gpt-6.2-astra'), 'gpt-6.2-astra')
  assert.equal(check('anthropic','claude-sonnet-5-5'), 'claude-sonnet-5-5')
  assert.equal(check('xai','grok-4.7-latest'), 'grok-4.7')
  assert.equal(check('gemini','gemini-4-hydrogen'), 'gemini-4-hydrogen')
  assert.equal(check('openai','gemini-4-hydrogen'), 'custom')
  assert.equal(check('gemini','gemini-flash-latest'), 'custom')
  assert.equal(check('openai','gpt-4.1-mini'),'openai')
  assert.equal(check('codex','gpt-6.2-sol'), 'subscription')
  const credits = estimateBudget({ ...form, provider: 'codex-sol-credits', toolCostPerRole: 0.01 })
  assert.deepEqual(credits.day.credits, [17.5, 50])
  assert.deepEqual(credits.month.credits, [525, 1500])
  assert.equal(credits.day.tools, 1)
  assert.equal(credits.day.total, null)
  assert.deepEqual(estimateBudget({ ...form, provider: 'codex-astra-credits' }).day.credits, [70, 200])
})

test('old stock scenario migrates at the same target and custom prices keep their model', () => {
  const saved = { version: 2, provider: 'openai', jobsPerDay: 100, rates: { openai: { input: 0.4, output: 1.6 } } }
  assert.equal(loadBudget(saved).provider, 'gpt-6.2-sol')
  assert.equal(loadBudget(saved).jobsPerDay, 100)
  assert.equal(loadBudget({ ...saved, provider: 'anthropic' }).provider,'claude-sonnet-5-5')
  const custom = loadBudget({ ...saved, rates: { openai: { input: 0, output: 1 } } })
  assert.equal(custom.provider,'openai')
  assert.deepEqual(custom.rates.openai,{input:0,output:1})
  assert.equal(normalizeBudget(custom).version,3)
})

test('local energy uses watt-hours, elapsed inference time and a separate utility price', () => {
  const local = { ...budgetDefaults(), provider:'ollama', jobsPerDay: 100, watts: 60, minutesLow: 2, minutesHigh: 6, electricityRate: 0.2 }
  const result = estimateBudget(local)
  assert.deepEqual(result.day.energyKwh,[0.2,0.6])
  const near = (actual, expected) => assert.ok(Math.abs(actual-expected) < 1e-10)
  near(result.day.total[0],0.04); near(result.day.total[1],0.12)
  near(result.month.total[0],1.20); near(result.month.total[1],3.60)
  near(estimateBudget({...local, toolCostPerRole:0.01}).day.total[1],1.12)
  assert.deepEqual(estimateBudget({...local, jobsPerDay:0}).day.total,[0,0])
  for (const invalid of [{watts:-1},{minutesLow:7},{electricityRate:''},{minutesHigh:Infinity}]) {
    assert.throws(() => normalizeBudget({...local,...invalid}))
  }
})

test('published Gemini change is charged on the correct day and saved overrides stay fixed', () => {
  const start = '2026-11-25', december = '2026-12-01'
  const form = { ...budgetDefaults(start), provider:'gemini-4-carbon', jobsPerDay:100 }
  const forecast = estimateBudget(form,start)
  assert.deepEqual(forecast.day.total, [0.7,2])
  assert.deepEqual(forecast.days[6].total,[4.2,12])
  assert.deepEqual(forecast.days[7].total,[5.6,16])
  assert.deepEqual(forecast.month.total,[37.8,108])
  assert.deepEqual(estimateBudget(form,december).day.total,[1.4,4])
  assert.deepEqual(loadBudget(normalizeBudget(form,start),december).rates[form.provider],{input:4,output:20})
  form.rates[form.provider] = {input:0,output:2}
  assert.deepEqual(estimateBudget(form,start).month.total,[1.8,4.8])
  assert.deepEqual(loadBudget(normalizeBudget(form,start),december).rates[form.provider],{input:0,output:2})
})
