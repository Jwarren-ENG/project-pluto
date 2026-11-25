import React, { useEffect, useRef, useState } from 'react'
import { Button } from './components/ui/button.jsx'
import { Input } from './components/ui/input.jsx'
import { Slider } from './components/ui/slider.jsx'
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from './components/ui/table.jsx'
import { estimateBudget, limits, loadBudget, normalizeBudget, rateCards } from './budget-estimate.mjs'

const count = new Intl.NumberFormat('en-US')
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 })
const money = n => n > 0 && n < 0.0001 ? '< $0.0001' : usd.format(n)
function range(values, format) {
  const low = format(values[0]), high = format(values[1])
  return low === high ? low : low + ' to ' + high
}

function sliderMax(jobs) {
  const target = Number(jobs)
  return Number.isFinite(target) && target > 100 ? limits.jobs : 100
}

function NumberField({ id, label, value, onChange, max, fractional = false, optional = false }) {
  return <label>{label}
    <Input id={id} type="number" required={!optional} min="0" max={max} step={fractional ? 'any' : '1'}
      value={value ?? ''} onChange={event => onChange(event.target.value)} />
  </label>
}

function Projection({ estimate, subscription }) {
  const rows = [
    ['Roles', window => count.format(window.jobs)],
    ['Estimated tokens', window => range(window.tokens, n => count.format(n))],
    subscription ? ['Subscription allocation', window => window.subscription === null ? 'Fee unspecified' : money(window.subscription)] :
      ['Model fees', window => range(window.modelFees, money)],
    ['Tool charges', window => money(window.tools)],
    ['Estimated total', window => window.total ? range(window.total, money) : 'Fee unspecified'],
  ]
  return <section className="panel" aria-label="Cost projection">
    <h2>Cost estimate</h2>
    <Table>
      <TableCaption>USD at the same target each day</TableCaption>
      <TableHeader><TableRow><TableHead scope="col">Estimate</TableHead><TableHead scope="col">Per day</TableHead><TableHead scope="col">30 days</TableHead></TableRow></TableHeader>
      <TableBody>{rows.map(([label, value]) => <TableRow key={label}>
        <TableHead scope="row">{label}</TableHead><TableCell>{value(estimate.day)}</TableCell><TableCell>{value(estimate.month)}</TableCell>
      </TableRow>)}</TableBody>
    </Table>
  </section>
}

export default function Budget({ state, refresh, notify }) {
  const initial = state?.profile?.budget
  const [form, setForm] = useState(() => loadBudget(initial))
  const [sliderLimit, setSliderLimit] = useState(() => sliderMax(initial?.jobsPerDay))
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const loaded = useRef(initial)
  useEffect(() => {
    if (!dirty && loaded.current !== initial) {
      loaded.current = initial
      setForm(loadBudget(initial))
      setSliderLimit(sliderMax(initial?.jobsPerDay))
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
  async function openRateSource(event) {
    event.preventDefault()
    try { await window.pluto.call('app.openExternal', { url: card.source }) }
    catch (problem) { notify(problem.message) }
  }
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
        <legend>Daily target</legend>
        <label id="budget-slider-label">Adjust jobs per day</label>
        <Slider min={0} max={sliderLimit} step={1} disabled={saving}
          value={[Math.min(limits.jobs, Math.max(0, Number(form.jobsPerDay) || 0))]}
          thumbProps={{ id: 'budget-jobs-slider', 'aria-labelledby': 'budget-slider-label', 'aria-describedby': 'budget-daily-estimate' }}
          onValueChange={([jobs]) => setField('jobsPerDay', jobs)} />
        <p><output id="budget-daily-estimate" htmlFor="budget-jobs-slider budget-jobs-count" aria-live="polite" aria-atomic="true">
          {error || <>
            <strong>{isSubscription ? 'Estimated daily usage' : 'Estimated daily cost'}</strong>{' · '}
            {isSubscription ? range(estimate.day.tokens, n => count.format(n)) + ' tokens' : range(estimate.day.total, money)}
            {' for ' + count.format(estimate.day.jobs) + (estimate.day.jobs === 1 ? ' job.' : ' jobs.')}
          </>}
        </output></p>
        <NumberField id="budget-jobs-count" label="Jobs per day" value={form.jobsPerDay} max={limits.jobs} onChange={value => {
          setSliderLimit(sliderMax(value))
          setField('jobsPerDay', value)
        }} />
        <label htmlFor="budget-provider">Pricing scenario</label>
        <select id="budget-provider" value={form.provider} onChange={event => setField('provider', event.target.value)}>
          {Object.entries(rateCards).map(([id, card]) => <option key={id} value={id}>{card.label}</option>)}
          <option value="ollama">Local inference · Ollama</option>
          <option value="subscription">Subscription plan</option>
        </select>
      </fieldset>
      <details>
        <summary>Token and pricing assumptions</summary>
        <fieldset disabled={saving}>
          <legend>Tokens per role</legend>
          <p>Count the tokens across all model calls for one role, including any retries.</p>
          {[['inputLow', 'Low input tokens per role'], ['inputHigh', 'High input tokens per role'],
            ['outputLow', 'Low output tokens per role'], ['outputHigh', 'High output tokens per role']].map(([key, label]) =>
            <NumberField key={key} label={label} max={limits.tokens} value={form[key]} onChange={v => setField(key, v)} />)}
        </fieldset>
        <fieldset disabled={saving}>
          <legend>Rates and tool charges</legend>
          {card && <>
            {card.source ? <p>
              Reference rates on {card.verified} were {money(card.input)} for input and {money(card.output)} for output per million tokens.{' '}
              <a href={card.source} onClick={openRateSource} onAuxClick={event => { if (event.button === 1) openRateSource(event) }}>
                View {card.label} pricing
              </a>
            </p> : <p>Illustrative starting rates. Enter the rates for the model and account you plan to use.</p>}
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
      </details>
      <Button type="submit" disabled={Boolean(error) || saving}>{saving ? 'Saving…' : 'Save budget assumptions'}</Button>
    </form>
    {estimate && <Projection estimate={estimate} subscription={isSubscription} />}
  </div>
}
