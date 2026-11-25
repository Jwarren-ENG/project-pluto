import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { budgetDefaults, estimateBudget, loadBudget, normalizeBudget } from '../ui/budget-estimate.mjs'
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
  const form = { ...budgetDefaults(), provider: 'ollama', toolCostPerRole: 0.10 }
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
  for (const [key, value] of [['jobsPerDay', ''], ['jobsPerDay', false], ['jobsPerDay', 2.5], ['jobsPerDay', 1001], ['inputLow', 7000], ['outputHigh', 2], ['inputHigh', Infinity], ['toolCostPerRole', -1], ['monthlySubscription', NaN], ['provider', 'constructor'], ['version', 2]]) {
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
