import assert from 'node:assert/strict'
import { test } from 'node:test'
import { budgetDefaults, estimateBudget } from '../ui/budget-estimate.mjs'

// All inputs are explicit so changes to model choices or preset prices do not change this audit.
function scenario(overrides = {}) {
  const form = budgetDefaults()
  form.rates.custom = { input: 0.40, output: 1.60 }
  return { ...form, provider: 'custom', jobsPerDay: 25, inputLow: 2000, inputHigh: 6000,
    outputLow: 300, outputHigh: 800, toolCostPerRole: 0.02, monthlySubscription: null, ...overrides }
}

// Compare unrounded dollars, allowing only ordinary floating-point error.
function dollars(actual, expected) {
  assert.ok(Number.isFinite(actual), 'Expected a finite dollar amount')
  assert.ok(Math.abs(actual - expected) <= 8 * Number.EPSILON * Math.max(1, Math.abs(expected)),
    `Expected ${expected} USD, got ${actual} USD`)
}

function dollarRange(actual, [low, high]) {
  assert.equal(actual.length, 2)
  dollars(actual[0], low)
  dollars(actual[1], high)
}

// Reference values computed independently in exact fractions, before display rounding.
const checkpoints = [
  { day: 0, roles: 0, tokens: [0, 0], model: [0, 0], tools: 0, total: [0, 0], plan: 0, planTotal: 0 },
  { day: 1, roles: 25, tokens: [57500, 170000], model: [0.032, 0.092], tools: 0.50, total: [0.532, 0.592], plan: 2 / 3, planTotal: 7 / 6 },
  { day: 15, roles: 375, tokens: [862500, 2550000], model: [0.48, 1.38], tools: 7.50, total: [7.98, 8.88], plan: 10, planTotal: 17.50 },
  { day: 30, roles: 750, tokens: [1725000, 5100000], model: [0.96, 2.76], tools: 15, total: [15.96, 17.76], plan: 20, planTotal: 35 },
]

test('one role prices input and output tokens separately at fractions of a cent', () => {
  const perRole = { jobsPerDay: 1, toolCostPerRole: 0 }
  const input = estimateBudget(scenario({ ...perRole, outputLow: 0, outputHigh: 0 }))
  dollarRange(input.day.modelFees, [0.00080, 0.00240])
  const output = estimateBudget(scenario({ ...perRole, inputLow: 0, inputHigh: 0 }))
  dollarRange(output.day.modelFees, [0.00048, 0.00128])
  const both = estimateBudget(scenario(perRole))
  dollarRange(both.day.total, [0.00128, 0.00368])
})

test('25 roles per day accumulate hosted fees, tools and tokens at the reference checkpoints', () => {
  const forecast = estimateBudget(scenario())
  for (const ref of checkpoints) {
    const period = forecast.days[ref.day]
    assert.equal(period.jobs, ref.roles)
    assert.deepEqual(period.tokens, ref.tokens)
    dollarRange(period.modelFees, ref.model)
    dollars(period.tools, ref.tools)
    dollarRange(period.total, ref.total)
  }
  dollarRange(forecast.day.total, checkpoints[1].total)
  dollarRange(forecast.month.total, checkpoints[3].total)
})

test('local inference at 25 roles per day accumulates workload and only the per-role tool charge', () => {
  const forecast = estimateBudget(scenario({ provider: 'ollama' }))
  for (const ref of checkpoints) {
    const period = forecast.days[ref.day]
    assert.deepEqual(period.tokens, ref.tokens)
    dollarRange(period.modelFees, [0, 0])
    dollars(period.tools, ref.tools)
    dollarRange(period.total, [ref.tools, ref.tools])
  }
})

test('a 20 USD monthly subscription accrues by elapsed day while tool costs follow role count', () => {
  const subscribed = { provider: 'subscription', monthlySubscription: 20 }
  const active = estimateBudget(scenario(subscribed))
  const idle = estimateBudget(scenario({ ...subscribed, jobsPerDay: 0 }))
  for (const ref of checkpoints) {
    const period = active.days[ref.day]
    assert.deepEqual(period.tokens, ref.tokens)
    assert.equal(period.modelFees, null)
    dollars(period.tools, ref.tools)
    dollars(period.subscription, ref.plan)
    dollarRange(period.total, [ref.planTotal, ref.planTotal])
    assert.deepEqual(idle.days[ref.day].tokens, [0, 0])
    dollars(idle.days[ref.day].tools, 0)
    dollarRange(idle.days[ref.day].total, [ref.plan, ref.plan])
  }
})
