import React, { useEffect, useRef, useState } from 'react'
import { Button } from './components/ui/button.jsx'
import { Input } from './components/ui/input.jsx'
import { Slider } from './components/ui/slider.jsx'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './components/ui/table.jsx'
import { estimateBudget, forecastDays, limits, loadBudget, normalizeBudget, rateCards } from './budget-estimate.mjs'

import './budget.css'

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

function MonthForecast({ month, selected, day, onDayChange, subscription }) {
  const [low, high] = subscription ? month.tokens : month.total
  const bounds = subscription ? selected.tokens : selected.total
  const value = subscription ? range(bounds, n => count.format(n)) + ' tokens' : range(bounds, money)
  const metric = subscription ? 'Cumulative token usage' : 'Cumulative spend'
  // Percentage coordinates keep the plotted band and day cursor aligned as the pane resizes.
  const y = amount => high > 0 ? 95 - 90 * amount / high : 95
  const cursor = day / forecastDays * 100 + '%'

  function preview(event) {
    if (event.pointerType !== 'mouse' || event.buttons !== 0) return
    const { left, width } = event.currentTarget.getBoundingClientRect()
    if (width) onDayChange(Math.round(Math.max(0, Math.min(1, (event.clientX - left) / width)) * forecastDays))
  }

  return <figure className="budget-month">
    <figcaption>{metric}<span>Day {day}</span></figcaption>
    <div className="budget-chart-value">{value}</div>
    <div className="budget-plot">
      <svg aria-hidden="true" focusable="false">
        <svg viewBox="0 0 100 100" width="100%" height="100%" preserveAspectRatio="none">
          <path className="budget-gridlines" d="M0 5H100 M0 50H100 M0 95H100" />
          <path className="budget-band" d={`M0 95 L100 ${y(high)} L100 ${y(low)} Z`} />
          <path className="budget-low" d={`M0 95 L100 ${y(low)}`} />
          <path className="budget-high" d={`M0 95 L100 ${y(high)}`} />
        </svg>
        <line className="budget-cursor" x1={cursor} x2={cursor} y1="5%" y2="95%" />
        {bounds[0] !== bounds[1] && <circle className="budget-dot low" cx={cursor} cy={y(bounds[0]) + '%'} r="3" />}
        <circle className="budget-dot" cx={cursor} cy={y(bounds[1]) + '%'} r="4" />
      </svg>
      <input type="range" aria-label="Forecast day" aria-describedby="budget-plot-help"
        aria-valuetext={`Day ${day} of ${forecastDays}, ${metric.toLowerCase()}, ${value}`}
        min="0" max={forecastDays} step="1" value={day} onPointerMove={preview}
        onChange={event => onDayChange(event.currentTarget.valueAsNumber)} />
    </div>
    <div className="budget-axis" aria-hidden="true"><span>Day 0</span><span>Day 15</span><span>Day {forecastDays}</span></div>
    <p id="budget-plot-help">Point, drag or use the arrow keys to explore.</p>
  </figure>
}

function Projection({ estimate, subscription }) {
  const [day, setDay] = useState(forecastDays)
  if (!estimate) return null
  const selected = estimate.days[day]
  const rows = [
    ['Jobs', period => count.format(period.jobs)],
    ['Estimated tokens', period => range(period.tokens, n => count.format(n))],
    subscription ? ['Subscription allocation', period => period.subscription === null ? 'Fee unspecified' : money(period.subscription)] :
      ['Model fees', period => range(period.modelFees, money)],
    ['Tool charges', period => money(period.tools)],
    ['Estimated total', period => period.total ? range(period.total, money) : 'Fee unspecified'],
  ]
  return <section className="budget-forecast" aria-labelledby="budget-forecast-title">
    <h2 id="budget-forecast-title">30-day forecast</h2>
    <div className="budget-forecast-grid">
      <Table aria-label="Daily and cumulative budget forecast">
        <TableHeader><TableRow><TableHead scope="col">Breakdown</TableHead><TableHead scope="col">Per day</TableHead><TableHead scope="col">Through day {day}</TableHead></TableRow></TableHeader>
        <TableBody>{rows.map(([label, value]) => <TableRow key={label}>
          <TableHead scope="row">{label}</TableHead><TableCell>{value(estimate.day)}</TableCell><TableCell>{value(selected)}</TableCell>
        </TableRow>)}</TableBody>
      </Table>
      <MonthForecast month={estimate.month} selected={selected} day={day} onDayChange={setDay} subscription={subscription} />
    </div>
  </section>
}

export default function Budget({ state, refresh, notify }) {
  const initial = state?.profile?.budget
  const [form, setForm] = useState(() => loadBudget(initial))
  const [sliderLimit, setSliderLimit] = useState(() => sliderMax(initial?.jobsPerDay))
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const loaded = useRef(initial)
  const userTouchedBudget = useRef(false)

  useEffect(() => {
    if (initial != null || userTouchedBudget.current) return
    let current = true
    window.pluto.call('providers.settings', {}).then(settings => {
      if (current && !userTouchedBudget.current && settings?.activeProvider === 'codex') {
        setForm(previous => ({ ...previous, provider: 'subscription' }))
      }
    }).catch(() => {
      // The planner still works with its standard assumptions when settings are unavailable.
    })
    return () => { current = false }
  }, [initial])

  useEffect(() => {
    if (!dirty && loaded.current !== initial) {
      loaded.current = initial
      setForm(loadBudget(initial))
      setSliderLimit(sliderMax(initial?.jobsPerDay))
    }
  }, [initial, dirty])
  const setField = (key, value) => {
    userTouchedBudget.current = true
    setDirty(true)
    setForm(previous => ({ ...previous, [key]: value }))
  }
  function setRate(key, value) {
    userTouchedBudget.current = true
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
    userTouchedBudget.current = true
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
  return <div className="budget-screen">
    <form onSubmit={save}>
      <div className="budget-plan">
        <section className="budget-target" aria-labelledby="budget-target-heading">
          <h2 id="budget-target-heading">Daily target</h2>
          <label className="budget-target-count">
            <Input id="budget-jobs-count" type="number" required min="0" max={limits.jobs} step="1" disabled={saving}
              value={form.jobsPerDay} onChange={event => {
                setSliderLimit(sliderMax(event.target.value))
                setField('jobsPerDay', event.target.value)
              }} />
            <span>Jobs per day</span>
          </label>
          <Slider min={0} max={sliderLimit} step={1} disabled={saving}
            value={[Math.min(limits.jobs, Math.max(0, Number(form.jobsPerDay) || 0))]}
            thumbProps={{ id: 'budget-jobs-slider', 'aria-label': 'Adjust jobs per day', 'aria-describedby': 'budget-daily-estimate' }}
            onValueChange={([jobs]) => setField('jobsPerDay', jobs)} />
          <div className="budget-axis budget-scale" aria-hidden="true">
            {[0, 0.25, 0.5, 0.75, 1].map(t => <span key={t}>{count.format(t * sliderLimit)}</span>)}
          </div>
        </section>
        <output id="budget-daily-estimate" className="budget-readout" htmlFor="budget-jobs-slider budget-jobs-count" aria-live="polite" aria-atomic="true">
          <span className="budget-readout-label">{isSubscription ? 'Estimated daily usage' : 'Estimated daily cost'}</span>
          {error ? <span className="budget-error">{error}</span> : <>
            <strong className="budget-amount">{range(isSubscription ? estimate.day.tokens : estimate.day.total, isSubscription ? n => count.format(n) : money)}</strong>
            <span className="budget-readout-note">{isSubscription ? 'Tokens' : 'USD including model and tool charges'} for {count.format(estimate.day.jobs)} {estimate.day.jobs === 1 ? 'job' : 'jobs'}.</span>
          </>}
        </output>
      </div>
      <div className="budget-toolbar">
        <label htmlFor="budget-provider">Pricing scenario</label>
        <select id="budget-provider" aria-describedby="budget-scenario-help" disabled={saving} value={form.provider} onChange={event => setField('provider', event.target.value)}>
          <option value="openai">OpenAI API · example rates</option>
          <option value="anthropic">Anthropic API · example rates</option>
          <option value="openrouter">OpenRouter · editable estimate</option>
          <option value="custom">Custom API · editable estimate</option>
          <option value="ollama">Local inference · Ollama</option>
          <option value="subscription">Subscription plan</option>
        </select>
        <Button type="submit" disabled={Boolean(error) || saving}>{saving ? 'Saving…' : 'Save budget'}</Button>
      </div>
      <p id="budget-scenario-help" className="muted">Choose your drafting model in <strong>Connections → AI for drafts</strong>. For an API estimate, enter that model’s published rates below.</p>
      <details>
        <summary>Token and pricing assumptions</summary>
        <fieldset disabled={saving}>
          <legend>Tokens per role</legend>
          <p>Include every model call and retry for one role.</p>
          {[['inputLow', 'Low input tokens per role'], ['inputHigh', 'High input tokens per role'],
            ['outputLow', 'Low output tokens per role'], ['outputHigh', 'High output tokens per role']].map(([key, label]) =>
            <NumberField key={key} label={label} max={limits.tokens} value={form[key]} onChange={v => setField(key, v)} />)}
        </fieldset>
        <fieldset disabled={saving}>
          <legend>Rates and tool charges</legend>
          {card && <>
            {card.source ? <p>
              {card.label} example, dated {card.verified}. Input was {money(card.input)} and output was {money(card.output)} per million tokens.{' '}
              <a href={card.source} onClick={openRateSource} onAuxClick={event => { if (event.button === 1) openRateSource(event) }}>
                View {card.label} pricing
              </a>
            </p> : <p>Illustrative rates. Enter your model’s prices.</p>}
            <NumberField label="Input USD per million tokens" value={form.rates[form.provider].input} max={limits.rate} fractional onChange={v => setRate('input', v)} />
            <NumberField label="Output USD per million tokens" value={form.rates[form.provider].output} max={limits.rate} fractional onChange={v => setRate('output', v)} />
          </>}
          {form.provider === 'ollama' && <p>Local model fees are $0. Hardware and electricity are excluded.</p>}
          {isSubscription && <>
            <p>Token totals measure workload. The monthly fee is spread across 30 days.</p>
            <NumberField label="Monthly subscription fee in USD (optional)" value={form.monthlySubscription} max={limits.subscription} fractional optional onChange={v => setField('monthlySubscription', v)} />
          </>}
          <NumberField label="Separate tool charges in USD per role" value={form.toolCostPerRole} max={limits.toolCost} fractional onChange={v => setField('toolCostPerRole', v)} />
          <p>Include paid searches and other tool calls.</p>
        </fieldset>
      </details>
    </form>
    <Projection estimate={estimate} subscription={isSubscription} />
  </div>
}
