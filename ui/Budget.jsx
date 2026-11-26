import React, { useEffect, useRef, useState } from 'react'
import { Button } from './components/ui/button.jsx'
import { Input } from './components/ui/input.jsx'
import { Slider } from './components/ui/slider.jsx'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './components/ui/table.jsx'
import { calendarDay, connectedBudget, creditCards, estimateBudget, forecastDays, limits, loadBudget, normalizeBudget, publishedRates, rateCards } from './budget-estimate.mjs'

import './budget.css'

const count = new Intl.NumberFormat('en-US')
const energy = new Intl.NumberFormat('en-US', { maximumSignificantDigits: 5 })
const credits = new Intl.NumberFormat('en-US', { maximumSignificantDigits: 12 })
const electricitySource = 'https://www.eia.gov/electricity/monthly/epm_table_grapher.php?t=epmt_5_6_a'
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 })
const money = n => n > 0 && n < 0.0001 ? '< $0.0001' : usd.format(n)
function range(values, format) {
  const low = format(values[0]), high = format(values[1])
  return low === high ? low : low + ' to ' + high
}

const metrics = {
  total: { daily: 'Estimated daily cost', cumulative: 'Cumulative spend', format: values => values ? range(values, money) : 'Price needed' },
  tokens: { daily: 'Estimated daily usage', cumulative: 'Cumulative token usage', format: values => range(values, count.format) + ' tokens' },
  credits: { daily: 'Estimated daily credits', cumulative: 'Cumulative credit usage', format: values => range(values, credits.format) + ' credits' },
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

function MonthForecast({ days, day, onDayChange, metric }) {
  const high = days[forecastDays][metric][1]
  const bounds = days[day][metric]
  const value = metrics[metric].format(bounds)
  const title = metrics[metric].cumulative
  // Percentage coordinates keep the plotted band and day cursor aligned as the pane resizes.
  const y = amount => high > 0 ? 95 - 90 * amount / high : 95
  const points = bound => days.map((period, index) => `${100 * index / forecastDays} ${y(period[metric][bound])}`)
  const lower = points(0)
  const upper = points(1)
  const cursor = day / forecastDays * 100 + '%'

  function preview(event) {
    if (event.pointerType !== 'mouse' || event.buttons !== 0) return
    const { left, width } = event.currentTarget.getBoundingClientRect()
    if (width) onDayChange(Math.round(Math.max(0, Math.min(1, (event.clientX - left) / width)) * forecastDays))
  }

  return <figure className="budget-month">
    <figcaption>{title}<span>Day {day}</span></figcaption>
    <div className="budget-chart-value">{value}</div>
    <div className="budget-plot">
      <svg aria-hidden="true" focusable="false">
        <svg viewBox="0 0 100 100" width="100%" height="100%" preserveAspectRatio="none">
          <path className="budget-gridlines" d="M0 5H100 M0 50H100 M0 95H100" />
          <path className="budget-band" d={`M${upper.join(' L')} L${lower.toReversed().join(' L')} Z`} />
          <path className="budget-low" d={`M${lower.join(' L')}`} />
          <path className="budget-high" d={`M${upper.join(' L')}`} />
        </svg>
        <line className="budget-cursor" x1={cursor} x2={cursor} y1="5%" y2="95%" />
        {bounds[0] !== bounds[1] && <circle className="budget-dot low" cx={cursor} cy={y(bounds[0]) + '%'} r="3" />}
        <circle className="budget-dot" cx={cursor} cy={y(bounds[1]) + '%'} r="4" />
      </svg>
      <input type="range" aria-label="Forecast day" aria-describedby="budget-plot-help"
        aria-valuetext={`Day ${day} of ${forecastDays}, ${title.toLowerCase()}, ${value}`}
        min="0" max={forecastDays} step="1" value={day} onPointerMove={preview}
        onChange={event => onDayChange(event.currentTarget.valueAsNumber)} />
    </div>
    <div className="budget-axis" aria-hidden="true"><span>Day 0</span><span>Day 15</span><span>Day {forecastDays}</span></div>
    <p id="budget-plot-help">Point, drag or use the arrow keys to explore.</p>
  </figure>
}

function Projection({ estimate, metric, local }) {
  const [day, setDay] = useState(forecastDays)
  if (!estimate) return null
  const selected = estimate.days[day]
  const rows = [
    ['Jobs', period => count.format(period.jobs)],
    ['Estimated tokens', period => range(period.tokens, count.format)],
  ]
  if (metric === 'credits') rows.push(['Purchased credits', period => metrics.credits.format(period.credits)])
  else if (metric === 'tokens') rows.push(['Subscription allocation', period => period.subscription === null ? 'Fee unspecified' : money(period.subscription)])
  else rows.push(['Model fees', period => period.modelFees ? range(period.modelFees, money) : 'Price needed'])
  if (local) rows.push(
    ['Energy use', period => range(period.energyKwh, energy.format) + ' kWh'],
    ['Electricity', period => range(period.electricity, money)],
  )
  rows.push(['Tool charges', period => money(period.tools)])
  if (metric !== 'credits') rows.push(['Estimated total', period => period.total ? range(period.total, money) : metric === 'tokens' ? 'Fee unspecified' : 'Price needed'])
  return <section className="budget-forecast" aria-labelledby="budget-forecast-title">
    <h2 id="budget-forecast-title">30-day forecast</h2>
    <div className="budget-forecast-grid">
      <Table aria-label="Daily and cumulative budget forecast">
        <TableHeader><TableRow><TableHead scope="col">Breakdown</TableHead><TableHead scope="col">Per day</TableHead><TableHead scope="col">Through day {day}</TableHead></TableRow></TableHeader>
        <TableBody>{rows.map(([label, value]) => <TableRow key={label} className={label === 'Estimated total' ? 'budget-total' : undefined}>
          <TableHead scope="row">{label}</TableHead><TableCell>{value(estimate.day)}</TableCell><TableCell>{value(selected)}</TableCell>
        </TableRow>)}</TableBody>
      </Table>
      <MonthForecast days={estimate.days} day={day} onDayChange={setDay}
        metric={metric === 'total' && !estimate.month.total ? 'tokens' : metric} />
    </div>
  </section>
}

export default function Budget({ state, refresh, notify, setup }) {
  const initial = state?.profile?.budget
  const [form, setForm] = useState(() => loadBudget(setup?.draft ?? initial))
  const [sliderLimit, setSliderLimit] = useState(() => sliderMax(form.jobsPerDay))
  const [dirty, setDirty] = useState(Boolean(setup?.draft))
  const [connection, setConnection] = useState(null)
  const [saving, setSaving] = useState(false)
  const loaded = useRef(initial)
  const userTouchedBudget = useRef(Boolean(setup?.draft))

  useEffect(() => {
    // Refresh scheduled prices if the planner stays open overnight or the computer wakes.
    const refreshRates = () => {
      const today = calendarDay()
      setForm(previous => previous.rateDate === today ? previous : loadBudget(previous, today))
    }
    const now = new Date()
    const nextMidnight = new Date(now)
    nextMidnight.setHours(24, 0, 0, 0)
    const timer = window.setTimeout(refreshRates, nextMidnight - now)
    window.addEventListener('focus', refreshRates)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('focus', refreshRates)
    }
  }, [form.rateDate])

  useEffect(() => {
    let current = true
    window.pluto.call('providers.settings', {}).then(settings => {
      if (!current) return
      const connected = connectedBudget(settings)
      setConnection(connected)
      if (initial == null && !userTouchedBudget.current && connected) {
        setForm(previous => ({ ...previous, provider: connected.scenario }))
      }
    }).catch(() => {
      // Offline, the scenario label still identifies the rates being estimated.
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
  function editForm(next) {
    userTouchedBudget.current = true
    setDirty(true)
    setForm(next)
    setup?.onEdit(next)
  }
  const setField = (key, value) => {
    editForm({ ...form, [key]: value })
  }
  function setRate(key, value) {
    editForm({ ...form, rates: { ...form.rates, [form.provider]: { ...form.rates[form.provider], [key]: value } } })
  }
  const card = Object.hasOwn(rateCards, form.provider) ? rateCards[form.provider] : null
  const creditCard = Object.hasOwn(creditCards, form.provider) ? creditCards[form.provider] : null
  const sourceCard = card || creditCard
  const prices = form.rates[form.provider]
  const isSubscription = form.provider === 'subscription'
  const isLocal = form.provider === 'ollama'
  const metric = creditCard ? 'credits' : isSubscription ? 'tokens' : 'total'
  const todayRates = card?.input != null && card?.output != null ? publishedRates(card, calendarDay()) : null
  const editedPreset = todayRates && (prices.input == null || prices.output == null ||
    prices.input === '' || prices.output === '' ||
    Number(prices.input) !== todayRates.input || Number(prices.output) !== todayRates.output)
  let estimate, error
  try { estimate = estimateBudget(form) } catch (problem) { error = problem.message }
  const onValidityChange = setup?.onValidityChange
  useEffect(() => { onValidityChange?.(!error) }, [error, onValidityChange])
  async function openSource(event) {
    if (event.type === 'auxclick' && event.button !== 1) return
    event.preventDefault()
    try { await window.pluto.call('app.openExternal', { url: event.currentTarget.href }) }
    catch (problem) { notify(problem.message) }
  }
  async function save(event) {
    event.preventDefault()
    if (error || saving) return
    userTouchedBudget.current = true
    setSaving(true)
    try {
      const budget = normalizeBudget(form)
      if (setup) {
        await setup.onSave(budget)
        return
      }
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
    <form id={setup ? 'setup-budget-form' : undefined} onSubmit={save}>
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
          <span className="budget-readout-label">{metrics[metric].daily}</span>
          {error ? <span className="budget-error">{error}</span> : <>
            <strong className="budget-amount">{metrics[metric].format(estimate.day[metric])}</strong>
            <span className="budget-readout-note">{count.format(estimate.day.jobs)} {estimate.day.jobs === 1 ? 'job' : 'jobs'} per day</span>
          </>}
        </output>
      </div>
      <div className="budget-toolbar">
        <label htmlFor="budget-provider">Pricing scenario</label>
        <select id="budget-provider" aria-describedby="budget-scenario-help" disabled={saving} value={form.provider} onChange={event => setField('provider', event.target.value)}>
          <optgroup label="API models">
            {Object.entries(rateCards).filter(([id, entry]) => !entry.legacy || id === form.provider)
              .map(([id, entry]) => <option key={id} value={id}>{entry.label}</option>)}
          </optgroup>
          <optgroup label="Purchased Codex credits">
            {Object.entries(creditCards).map(([id, entry]) => <option key={id} value={id}>{entry.label}</option>)}
          </optgroup>
          <option value="ollama">Local inference · Ollama</option>
          <option value="subscription">Subscription plan</option>
        </select>
        {!setup && <Button type="submit" disabled={Boolean(error) || saving}>{saving ? 'Saving…' : 'Save budget'}</Button>}
      </div>
      <div id="budget-scenario-help" className="budget-scenario-help">
        {sourceCard?.source && <p>
          {todayRates && <>Per million tokens, today’s published rates are {money(todayRates.input)} USD for input and {money(todayRates.output)} USD for output. </>}
          {creditCard && <>Per million tokens, the rates are {credits.format(creditCard.input)} input credits and {credits.format(creditCard.output)} output credits. </>}
          {sourceCard.note && !(editedPreset && sourceCard.schedule) && <>{sourceCard.note} </>}
          {sourceCard.verified && <>Checked <time dateTime={sourceCard.verified}>{sourceCard.verified}</time>. </>}
          <a href={sourceCard.source} onClick={openSource} onAuxClick={openSource}>{sourceCard.label} pricing</a>
        </p>}
        <p>
          {connection && <>Draft connection: {connection.label}. </>}
          {isSubscription ? 'Tokens estimate drafting workload. Plan limits depend on the model and task.' :
            creditCard ? 'After your allowance is used, this estimates purchased credits for uncached tokens at Standard speed.' :
            isLocal ? 'Ollama model fees are $0.' :
            editedPreset ? 'This forecast uses your edited model prices for all 30 days.' :
            !todayRates ? 'Enter your model’s input and output prices under Token and pricing assumptions.' : null}
          {' '}Tools are budgeted at {money(Number(form.toolCostPerRole) || 0)} per job.
        </p>
      </div>
      {isLocal && <fieldset className="budget-electricity" disabled={saving}>
        <legend>Local electricity</legend>
        <p>60 W and 2 to 6 minutes per job are examples. Enter the average power and run time you measure while drafting.</p>
        <NumberField label="Average power (W)" value={form.watts} max={limits.watts} fractional onChange={v => setField('watts', v)} />
        <NumberField label="Electricity rate (USD/kWh)" value={form.electricityRate} max={limits.electricityRate} fractional onChange={v => setField('electricityRate', v)} />
        <NumberField label="Low minutes per job" value={form.minutesLow} max={limits.minutes} fractional onChange={v => setField('minutesLow', v)} />
        <NumberField label="High minutes per job" value={form.minutesHigh} max={limits.minutes} fractional onChange={v => setField('minutesHigh', v)} />
        <p>The starting rate is $0.1817/kWh, the U.S. residential average for September 2026. Use the rate on your electricity bill.{' '}
          <a href={electricitySource} onClick={openSource} onAuxClick={openSource}>EIA electricity prices, Table 5.6.A</a>
        </p>
      </fieldset>}
      <details>
        <summary>Token and pricing assumptions</summary>
        <fieldset disabled={saving}>
          <legend>Tokens per role</legend>
          <p>Enter the combined input and output for all calls and retries per job. The starting ranges are examples. Optional Notebook generation uses additional tokens.</p>
          {[['inputLow', 'Low input tokens per role'], ['inputHigh', 'High input tokens per role'],
            ['outputLow', 'Low output tokens per role'], ['outputHigh', 'High output tokens per role']].map(([key, label]) =>
            <NumberField key={key} label={label} max={limits.tokens} value={form[key]} onChange={v => setField(key, v)} />)}
        </fieldset>
        <fieldset disabled={saving}>
          <legend>Rates and tool charges</legend>
          {card && <>
            {!todayRates && <p>Use 0 for a verified free rate.</p>}
            <NumberField optional label="Input USD per million tokens" value={form.rates[form.provider].input} max={limits.rate} fractional onChange={v => setRate('input', v)} />
            <NumberField optional label="Output USD per million tokens" value={form.rates[form.provider].output} max={limits.rate} fractional onChange={v => setRate('output', v)} />
            {prices.needsReview && <div><p>Your previous budget contains example rates. Verify the prices before using this forecast.</p>
              <Button type="button" disabled={prices.input == null || prices.input === '' || prices.output == null || prices.output === '' || Boolean(error)}
                onClick={() => setRate('needsReview', false)}>Use these prices</Button>
            </div>}
          </>}
          {isSubscription && <>
            <p>Token totals measure workload. The monthly fee is spread across 30 days.</p>
            <NumberField label="Monthly subscription fee in USD (optional)" value={form.monthlySubscription} max={limits.subscription} fractional optional onChange={v => setField('monthlySubscription', v)} />
          </>}
          <NumberField label="Separate tool charges in USD per role" value={form.toolCostPerRole} max={limits.toolCost} fractional onChange={v => setField('toolCostPerRole', v)} />
          <p>Include paid searches and other tool calls.</p>
        </fieldset>
      </details>
    </form>
    {setup ? <details><summary>Explore the 30-day forecast</summary><Projection estimate={estimate} metric={metric} local={isLocal} /></details> :
      <Projection estimate={estimate} metric={metric} local={isLocal} />}
  </div>
}
