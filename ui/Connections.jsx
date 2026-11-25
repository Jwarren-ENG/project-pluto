import React, { useEffect, useState } from 'react'

const call = (action, payload = {}) => window.pluto.call('providers.' + action, payload)

function AIConnection({ settings, onSettings, notify }) {
  const [id, setId] = useState(settings.activeProvider || 'openai')
  const saved = settings.providers[id]
  const [model, setModel] = useState(saved.model)
  const [endpoint, setEndpoint] = useState(saved.endpoint)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState('')
  const local = id === 'ollama'
  const custom = id === 'custom'
  const changed = model !== saved.model || endpoint !== saved.endpoint || Boolean(key)
  const active = settings.activeProvider === id

  function select(next) {
    setId(next)
    setModel(settings.providers[next].model)
    setEndpoint(settings.providers[next].endpoint)
    setKey('')
  }

  async function perform(action) {
    setBusy(action)
    try {
      if (action === 'test') {
        await call('test', { provider: id })
        notify(saved.label + ' returned a test response.')
      } else {
        const payload = { provider: id }
        if (action !== 'disconnect') {
          payload.model = model
          if (custom || local) payload.endpoint = endpoint
          if (action === 'oauth') payload.auth = 'oauth'
          else if (key) payload.apiKey = key
        }
        const next = await call(action === 'disconnect' ? action : 'configure', payload)
        onSettings(next)
        setModel(next.providers[id].model)
        setEndpoint(next.providers[id].endpoint)
        setKey('')
        notify(action === 'disconnect' ? saved.label + ' disconnected.' : saved.label + ' is ready for drafts.')
      }
    } catch (error) { notify(error.message) }
    finally { setBusy('') }
  }

  return (
    <section className="panel">
      <h2>AI for drafts</h2>
      <p>{settings.activeProvider ? 'Current provider: ' + settings.providers[settings.activeProvider].label : 'Choose where Pluto sends your profile and job details when you request a draft.'}</p>
      <form onSubmit={event => { event.preventDefault(); perform('save') }}>
        <fieldset disabled={Boolean(busy)}>
          <legend>AI connection</legend>
          <label htmlFor="pluto-ai-provider">Provider</label>
          <select id="pluto-ai-provider" value={id} onChange={event => select(event.target.value)}>
              {Object.entries(settings.providers).filter(([provider]) => provider !== 'firecrawl').map(([provider, entry]) =>
                <option key={provider} value={provider}>{entry.label}</option>)}
          </select>
          {(custom || local) && <label>{local ? 'Local Ollama server' : 'HTTPS API base URL'}
            <input type="url" required value={endpoint} onChange={event => setEndpoint(event.target.value)} placeholder={local ? 'http://127.0.0.1:11434' : 'https://api.example.com/v1'} />
          </label>}
          <label>{local ? 'Installed model name' : 'Model ID'}
            <input required value={model} maxLength={256} onChange={event => setModel(event.target.value)} placeholder={local ? 'qwen2.5:7b' : 'Model ID from your provider'} />
          </label>
          {!local && <label>API key
            <input type="password" autoComplete="off" spellCheck={false} value={key}
              required={!saved.configured || endpoint !== saved.endpoint}
              placeholder={saved.configured && endpoint === saved.endpoint ? 'Saved key · enter a new key to replace it' : 'Enter your provider key'}
              onChange={event => setKey(event.target.value)} />
          </label>}
          {custom && <p>Enter a key issued for this address. Pluto asks for a new key when the server address changes.</p>}
          {local && <p>Start Ollama and enter a model you have already installed.</p>}
          <button type="submit">{busy === 'save' ? 'Saving…' : active ? 'Save connection' : 'Use for drafts'}</button>
          {id === 'openrouter' && settings.openRouterSignIn && <button type="button" disabled={!model.trim()} onClick={() => perform('oauth')}>Sign in with OpenRouter</button>}
          {saved.configured && <>
            <button type="button" disabled={changed} onClick={() => perform('test')}>{busy === 'test' ? 'Testing…' : 'Test model'}</button>
            <button type="button" onClick={() => perform('disconnect')}>Disconnect {saved.label}</button>
          </>}
        </fieldset>
        {busy === 'oauth' && <div>
          <p role="status">Finish sign-in in your browser. This request expires in three minutes.</p>
          <button type="button" onClick={() => call('configure', { provider: 'openrouter', auth: 'cancel' }).catch(err => notify(err.message))}>Cancel sign-in</button>
        </div>}
      </form>
      {saved.configured && !local && <p>The model test sends a short sample and may use provider credits.</p>}
    </section>
  )
}

function FirecrawlConnection({ saved, onSettings, notify }) {
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState('')
  async function perform(action) {
    setBusy(action)
    try {
      const result = await call(action, { provider: 'firecrawl', ...(action === 'configure' && { apiKey: key }) })
      if (action === 'test') notify('Firecrawl confirmed access to your credits.')
      else {
        onSettings(result)
        setKey('')
        notify(action === 'disconnect' ? 'Firecrawl disconnected.' : 'Firecrawl is ready for searches.')
      }
    } catch (error) { notify(error.message) }
    finally { setBusy('') }
  }
  return (
    <section className="panel">
      <h2>Job search with Firecrawl</h2>
      <p>{saved.configured ? 'Connected. Searches use your Firecrawl credits.' : 'Connect a Firecrawl account to search the web for openings.'}</p>
      <form onSubmit={event => { event.preventDefault(); perform('configure') }}>
        <fieldset disabled={Boolean(busy)}>
          <legend>Firecrawl connection</legend>
          <label>Firecrawl API key
            <input type="password" autoComplete="off" spellCheck={false} value={key} required
              placeholder={saved.configured ? 'Enter a replacement key' : 'Enter your Firecrawl key'}
              onChange={event => setKey(event.target.value)} />
          </label>
          <button type="submit">{busy === 'configure' ? 'Saving…' : saved.configured ? 'Replace key' : 'Connect Firecrawl'}</button>
          {saved.configured && <>
            <button type="button" disabled={Boolean(key)} onClick={() => perform('test')}>{busy === 'test' ? 'Testing…' : 'Test connection'}</button>
            <button type="button" onClick={() => perform('disconnect')}>Disconnect Firecrawl</button>
          </>}
        </fieldset>
      </form>
    </section>
  )
}

export default function Connections({ notify }) {
  const [settings, setSettings] = useState(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let current = true
    setError('')
    call('settings').then(value => { if (current) setSettings(value) }).catch(err => { if (current) setError(err.message) })
    return () => { current = false }
  }, [attempt])
  if (error) return <section className="panel"><p role="alert">{error}</p><button onClick={() => setAttempt(attempt + 1)}>Retry connections</button></section>
  if (!settings) return <p role="status">Loading connections…</p>
  return <div className="section">
    <AIConnection settings={settings} onSettings={setSettings} notify={notify} />
    <FirecrawlConnection saved={settings.providers.firecrawl} onSettings={setSettings} notify={notify} />
  </div>
}
