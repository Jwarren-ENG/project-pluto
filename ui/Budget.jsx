import React, { useEffect, useRef, useState } from 'react'
import { estimateBudget, limits, loadBudget, normalizeBudget, rateCards } from './budget-estimate.mjs'

const count = new Intl.NumberFormat('en-US')
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 })
const money = n => n > 0 && n < 0.0001 ? '< $0.0001' : usd.format(n)
function range(values, format) {
  const low = format(values[0]), high = format(values[1])
  return low === high ? low : low + ' to ' + high
}

function NumberField({ label, value, onChange, max, fractional = false, optional = false }) {
  return <label>{label}
    <input type="number" required={!optional} min="0" max={max} step={fractional ? 'any' : '1'}
      value={value ?? ''} onChange={event => onChange(event.target.value)} />
  </label>
}

function Projection({ estimate, subscription, error }) {
  const rows = estimate && [
    ['Roles', window => count.format(window.jobs)],
    ['Estimated tokens', window => range(window.tokens, n => count.format(n))],
    subscription ? ['Subscription allocation', window => window.subscription === null ? 'Fee unspecified' : money(window.subscription)] :
      ['Model fees', window => range(window.modelFees, money)],
    ['Tool charges', window => money(window.tools)],
    ['Estimated total', window => window.total ? range(window.total, money) : 'Fee unspecified'],
  ]
  return <section className="panel" aria-label="Cost projection">
    <h2>Cost estimate</h2>
    {error ? <p role="status">{error}</p> : <table>
      <caption>USD at the same target each day</caption>
      <thead><tr><th scope="col">Estimate</th><th scope="col">Per day</th><th scope="col">30 days</th></tr></thead>
      <tbody>{rows.map(([label, value]) => <tr key={label}>
        <th scope="row">{label}</th><td>{value(estimate.day)}</td><td>{value(estimate.month)}</td>
      </tr>)}</tbody>
    </table>}
  </section>
}

export default function Budget({ state, refresh, notify }) {
  const initial = state?.profile?.budget
  const [form, setForm] = useState(() => loadBudget(initial))
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const loaded = useRef(initial)
  useEffect(() => {
    if (!dirty && loaded.current !== initial) {
      loaded.current = initial
      setForm(loadBudget(initial))
    }
  }, [initial, dirty])
  const setField = (key, value) => {
    setDirty(true)
    setForm(previous => ({ ...previous, [key]: value }))
  }
  function setRate(key, value) {
    setDirty(true)
    setForm(previous => ({ ...previous, rates: { ...previous.rates, [previous.provider]: { ...previous.rates[previous.provider], [key]: value } } }))
  }
  const card = Object.hasOwn(rateCards, form.provider) ? rateCards[form.provider] : null
  const isSubscription = form.provider === 'subscription'
  let estimate, error
  try { estimate = estimateBudget(form) } catch (problem) { error = problem.message }
  async function save(event) {
    event.preventDefault()
    if (error || saving) return
    setSaving(true)
    try {
      const budget = normalizeBudget(form)
      await window.pluto.call('workspace.saveProfile', { budget })
      setForm(budget)
      try {
        await refresh()
        setDirty(false)
        notify('Budget assumptions saved.')
      } catch { notify('Budget saved. Reopen the planner to refresh the displayed profile.') }
    } catch (problem) { notify(problem.message) }
    finally { setSaving(false) }
  }
  return <div className="section">
    <form onSubmit={save} className="panel">
      <h2>Budget planner</h2>
      <fieldset disabled={saving}>
        <legend>Daily workload</legend>
        <label htmlFor="budget-jobs-slider">Adjust jobs per day</label>
        <input id="budget-jobs-slider" type="range" min="0" max={Math.max(100, Math.min(limits.jobs, Number(form.jobsPerDay) || 0))}
          step="1" value={Math.min(limits.jobs, Math.max(0, Number(form.jobsPerDay) || 0))} onChange={event => setField('jobsPerDay', event.target.value)} />
        <NumberField label="Jobs per day" value={form.jobsPerDay} max={limits.jobs} onChange={v => setField('jobsPerDay', v)} />
        <p>Count the tokens across all model calls for one role, including any retries.</p>
        {[['inputLow', 'Low input tokens per role'], ['inputHigh', 'High input tokens per role'],
          ['outputLow', 'Low output tokens per role'], ['outputHigh', 'High output tokens per role']].map(([key, label]) =>
          <NumberField key={key} label={label} max={limits.tokens} value={form[key]} onChange={v => setField(key, v)} />)}
      </fieldset>
      <fieldset disabled={saving}>
        <legend>Pricing assumptions</legend>
        <label htmlFor="budget-provider">Pricing scenario</label>
        <select id="budget-provider" value={form.provider} onChange={event => setField('provider', event.target.value)}>
          {Object.entries(rateCards).map(([id, card]) => <option key={id} value={id}>{card.label}</option>)}
          <option value="ollama">Local inference · Ollama</option>
          <option value="subscription">Subscription plan</option>
        </select>
        {card && <>
          <p>{card.source ? 'Reference rates as of ' + card.verified + ': ' + money(card.input) + ' input and ' + money(card.output) + ' output per million tokens.' :
            'Illustrative starting rates. Enter the rates for the model and account you plan to use.'}</p>
          <NumberField label="Input USD per million tokens" value={form.rates[form.provider].input} max={limits.rate} fractional onChange={v => setRate('input', v)} />
          <NumberField label="Output USD per million tokens" value={form.rates[form.provider].output} max={limits.rate} fractional onChange={v => setRate('output', v)} />
        </>}
        {form.provider === 'ollama' && <p>Local inference has a $0 provider fee. Hardware and electricity are outside this estimate.</p>}
        {isSubscription && <>
          <p>Token totals estimate workload. Your plan determines access and usage limits. Enter a monthly fee to spread it across 30 days.</p>
          <NumberField label="Monthly subscription fee in USD (optional)" value={form.monthlySubscription} max={limits.subscription} fractional optional onChange={v => setField('monthlySubscription', v)} />
        </>}
        <NumberField label="Separate tool charges in USD per role" value={form.toolCostPerRole} max={limits.toolCost} fractional onChange={v => setField('toolCostPerRole', v)} />
        <p>Include expected web search or other paid tool use. The starting value is $0 until you enter a cost.</p>
      </fieldset>
      <button type="submit" disabled={Boolean(error) || saving}>{saving ? 'Saving…' : 'Save budget assumptions'}</button>
    </form>
    <Projection estimate={estimate} error={error} subscription={isSubscription} />
  </div>
}
