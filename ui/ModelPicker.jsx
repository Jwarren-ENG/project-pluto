import React, { useEffect, useEffectEvent, useId, useLayoutEffect, useRef, useState } from 'react'
import { Button } from './components/ui/button.jsx'
import { Input } from './components/ui/input.jsx'

const orderLabels = {
  newest: 'Newest first.',
  mixed: 'Newest first where dates are available.',
  provider: 'Provider order. Release dates unavailable.',
}

function catalogSummary(catalog) {
  if (!catalog) return ''
  const date = catalog.asOf && new Date(catalog.asOf)
  const saved = catalog.source === 'saved'
  const when = saved && date && Number.isFinite(date.getTime()) ? ' from ' + date.toLocaleDateString() : ''
  const source = saved ? 'Last known model list' + when + '.' : 'Provider model list.'
  return [source, catalog.models.length ? orderLabels[catalog.order] : 'No models listed.'].filter(Boolean).join(' ')
}

export default function ModelPicker({ provider, value, onChange, configured, apiKey = '', endpoint, savedEndpoint, optional = false, disabled = false, signedOut = false, autoLoad = true }) {
  const id = useId()
  const generation = useRef(0)
  const [catalog, setCatalog] = useState(null)
  const [phase, setPhase] = useState('idle')
  const [manual, setManual] = useState(false)
  const editableEndpoint = provider === 'custom' || provider === 'ollama'
  const needsKey = !['ollama', 'codex', 'openrouter'].includes(provider) && !apiKey.trim() && !(configured && endpoint === savedEndpoint)
  const options = catalog?.models || []

  async function load(explicit) {
    const request = ++generation.current
    setPhase('loading')
    const payload = { provider }
    if (editableEndpoint) payload.endpoint = endpoint
    if (explicit && apiKey && provider !== 'openrouter') payload.apiKey = apiKey
    try {
      const result = await window.pluto.call('providers.models', payload)
      if (generation.current === request) {
        setCatalog(result)
        setPhase('ready')
      }
    } catch {
      if (generation.current === request) {
        setCatalog(null)
        setPhase('failed')
      }
    }
  }

  useLayoutEffect(() => {
    setPhase('idle')
    setCatalog(null)
    return () => { generation.current++ }
  }, [provider, configured, apiKey, endpoint, savedEndpoint, signedOut])

  const initialLoad = useEffectEvent(() => {
    if (autoLoad && !signedOut && !apiKey && endpoint === savedEndpoint && (configured || provider === 'openrouter')) load(false)
  })
  // Typing a key or address invalidates the old list. Only the button may use those edits.
  useEffect(() => { initialLoad() }, [provider, configured, savedEndpoint, signedOut])

  function choose(selection) {
    setManual(selection === 'manual')
    if (selection !== 'manual') onChange(selection ? selection.slice('id:'.length) : '')
  }

  let status = catalogSummary(catalog)
  if (signedOut) status = 'Sign in to load models for your subscription.'
  else if (needsKey) status = 'Enter your API key to load models, or enter a model ID manually.'
  else if (phase === 'loading') status = 'Loading models…'
  else if (phase === 'failed') status = 'Model list unavailable. You can enter a model ID manually.'
  return <div>
    <label htmlFor={id}>{optional ? 'Subscription model' : 'Model'}</label>
    <select id={id} value={manual ? 'manual' : value ? 'id:' + value : ''} onChange={event => choose(event.target.value)}
      aria-describedby={status ? id + '-status' : undefined} required={!optional} disabled={disabled}>
      <option value="" disabled={!optional}>{optional ? 'Account default' : 'Choose a model'}</option>
      {options.map(model => <option key={model.id} value={'id:' + model.id}>{model.label || model.id}{model.recommended ? ' · Recommended' : ''}</option>)}
      {value && !options.some(entry => entry.id === value) && <option value={'id:' + value}>{value} · Current selection</option>}
      <option value="manual">Enter a model ID manually</option>
    </select>
    {manual && <label>Model ID
      <Input autoFocus value={value} onChange={event => onChange(event.target.value)} required={!optional} maxLength={256} disabled={disabled} spellCheck={false} />
    </label>}
    <div className="toolbar">
      <Button type="button" variant="outline" disabled={disabled || signedOut || needsKey || phase === 'loading' || (editableEndpoint && !endpoint?.trim())}
        onClick={() => load(true)}>{catalog ? 'Refresh models' : 'Load models'}</Button>
      <span id={id + '-status'} role="status" className="muted">{status}</span>
    </div>
  </div>
}
