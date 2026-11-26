import React, { useEffect, useId, useRef, useState } from 'react'

import { Button } from './components/ui/button.jsx'
import { Input } from './components/ui/input.jsx'
import OptionalWorkflows from './OptionalWorkflows.jsx'
import FreeFallback from './FreeFallback.jsx'
import DriveConnection from './DriveConnection.jsx'
import MailConnection from './MailConnection.jsx'
import ModelPicker from './ModelPicker.jsx'
import { createAccountClis } from '../desktop/account-clis.mjs'

const call = (action, payload = {}) => window.pluto.call('providers.' + action, payload)
const openExternal = url => window.pluto.call('app.openExternal', { url })
const accountGuide = createAccountClis({ openExternal })
const guides = accountGuide.list()
const codexGuide = 'https://developers.openai.com/codex/cli/'
const accounts = [
  { id: 'codex', name: 'ChatGPT' },
  { id: 'xai', name: 'Grok', guide: 'grok' },
  { id: 'anthropic', name: 'Claude', website: 'https://claude.ai/' },
  { id: 'gemini', name: 'Gemini', guide: 'gemini' },
]
const subscriptionMessages = {
  checking: 'Checking Codex sign-in…',
  chatgpt: 'Codex is signed in with ChatGPT on this computer.',
  missing: 'Install the Codex CLI on this computer, then refresh the sign-in status.',
  signedOut: 'Codex is signed out. Sign in with ChatGPT to use your subscription for drafts.',
  other: 'Codex is using another account type. To switch, sign out in Codex, sign back in with ChatGPT, then refresh here.',
  unsupported: 'Update the Codex CLI to use subscription drafts, then refresh the sign-in status.',
  error: 'Pluto couldn’t check the Codex sign-in. Refresh to try again.',
}

function SubscriptionConnection({ active, saved, onSettings, notify, busy, setBusy, setup }) {
  const { configured } = saved
  const [model, setModel] = useState(saved.model || '')
  const [status, setStatus] = useState('checking')
  const [revision, setRevision] = useState(0)
  const pending = useRef(null)

  useEffect(() => {
    let current = true
    call('subscriptionStatus').then(({ state }) => {
      if (current) setStatus(Object.hasOwn(subscriptionMessages, state) ? state : 'unsupported')
    }).catch(() => { if (current) setStatus('error') })
    return () => { current = false }
  }, [revision])

  useEffect(() => () => {
    if (pending.current?.action === 'login') call('configure', { provider: 'codex', auth: 'cancel' }).catch(() => {})
    pending.current = null
  }, [])

  function refreshStatus() {
    setStatus('checking')
    setRevision(value => value + 1)
  }

  async function perform(action) {
    const request = { action }
    pending.current = request
    setBusy(action)
    try {
      const payload = { provider: 'codex' }
      if (action === 'login' || action === 'cancel') payload.auth = action
      if (action === 'login' || action === 'activate') payload.model = model
      const result = await call(['disconnect', 'test'].includes(action) ? action : 'configure', payload)
      if (pending.current !== request) return
      if (action !== 'test') {
        onSettings(result)
        if (action !== 'cancel') setModel(result.providers.codex.model || '')
      }
      if (action === 'test') notify('ChatGPT sign-in verified.')
      else if (action === 'disconnect') notify('Subscription unlinked from Pluto.')
      else if (action === 'cancel') notify('Sign-in canceled.')
      else notify('Pluto will use your ChatGPT subscription for drafts.')
    } catch (error) {
      if (pending.current === request) notify(error.message)
    } finally {
      if (pending.current === request) {
        pending.current = null
        setBusy('')
        refreshStatus()
      }
    }
  }

  return <fieldset>
    <legend>{saved.label}</legend>
    <p role="status">{busy === 'login' ? 'Finish signing in with ChatGPT in your browser.' : subscriptionMessages[status]}</p>
    {(status === 'chatgpt' || status === 'signedOut') && <ModelPicker provider="codex" optional autoLoad={!setup} configured={configured} signedOut={status === 'signedOut'}
      value={model} onChange={setModel} disabled={Boolean(busy)} />}
    <div className="toolbar">
      {busy === 'login' ? <Button type="button" variant="outline" onClick={() => perform('cancel')}>Cancel sign-in</Button> : <>
        {(status === 'missing' || status === 'unsupported') && <Button type="button" onClick={() => openExternal(codexGuide).catch(error => notify(error.message))}>Open Codex installation guide</Button>}
        {status === 'signedOut' && <Button type="button" disabled={Boolean(busy)} onClick={() => perform('login')}>Sign in with ChatGPT</Button>}
        {status === 'chatgpt' && (!active || model !== (saved.model || '')) && <Button type="button" disabled={Boolean(busy)} onClick={() => perform('activate')}>
          {active ? 'Save subscription model' : 'Use subscription for drafts'}
        </Button>}
        {configured && status === 'chatgpt' && <Button type="button" variant="outline" disabled={Boolean(busy)} onClick={() => perform('test')}>Check sign-in</Button>}
        <Button type="button" variant="outline" disabled={Boolean(busy) || status === 'checking'} onClick={refreshStatus}>Refresh status</Button>
        {configured && <Button type="button" variant="outline" disabled={Boolean(busy)} onClick={() => perform('disconnect')}>Unlink from Pluto</Button>}
      </>}
    </div>
    {configured && <p>The check reads your Codex sign-in without running a model. Unlinking only removes the connection from Pluto.</p>}
  </fieldset>
}

function ApiConnection({ settings, onSettings, notify, busy, setBusy, fixedProvider, setup }) {
  const [id, setId] = useState(fixedProvider || (settings.activeProvider && settings.activeProvider !== 'codex' ? settings.activeProvider : 'openai'))
  const saved = settings.providers[id]
  const [model, setModel] = useState(saved.model)
  const [endpoint, setEndpoint] = useState(saved.endpoint)
  const [key, setKey] = useState('')
  const [savedRevision, setSavedRevision] = useState(0)
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
        setSavedRevision(value => value + 1)
        if (action === 'disconnect') notify(saved.label + ' disconnected.')
        else notify(setup ? 'Draft settings saved for ' + saved.label + '.' : saved.label + ' is ready for drafts.')
      }
    } catch (error) { notify(error.message) }
    finally { setBusy('') }
  }

  return (
    <>
      <form onSubmit={event => { event.preventDefault(); perform('save') }}>
        <fieldset disabled={Boolean(busy)}>
          <legend>{fixedProvider ? saved.label + ' API' : 'API or local model'}</legend>
          {!fixedProvider && <><label htmlFor="pluto-ai-provider">Provider</label>
            <select id="pluto-ai-provider" value={id} onChange={event => select(event.target.value)}>
              {Object.entries(settings.providers).filter(([provider]) => provider !== 'firecrawl' && provider !== 'codex').map(([provider, entry]) =>
                <option key={provider} value={provider}>{entry.label}</option>)}
            </select></>}
          {(custom || local) && <label>{local ? 'Local Ollama server' : 'HTTPS API base URL'}
            <Input type="url" required value={endpoint} onChange={event => { setEndpoint(event.target.value); setKey('') }} placeholder={local ? 'http://127.0.0.1:11434' : 'https://api.example.com/v1'} />
          </label>}
          {!local && <label>API key
            <Input type="password" autoComplete="off" spellCheck={false} value={key}
              required={!saved.configured || endpoint !== saved.endpoint}
              placeholder={saved.configured && endpoint === saved.endpoint ? 'Saved key · enter a new key to replace it' : 'Enter your provider key'}
              onChange={event => setKey(event.target.value)} />
          </label>}
          {custom && <p>Enter a key issued for this address. Pluto asks for a new key when the server address changes.</p>}
          {local && <p>Start Ollama to see the models installed on your server.</p>}
          <ModelPicker key={id + ':' + savedRevision} provider={id} value={model} onChange={setModel} configured={saved.configured} autoLoad={!setup}
            apiKey={key} endpoint={endpoint} savedEndpoint={saved.endpoint} />
          <div className="toolbar">
            <Button type="submit">{busy === 'save' ? 'Saving…' : active ? 'Save connection' : 'Use for drafts'}</Button>
            {id === 'openrouter' && settings.openRouterSignIn && <Button variant="outline" type="button" disabled={!model.trim()} onClick={() => perform('oauth')}>Sign in with OpenRouter</Button>}
            {saved.configured && <>
              {!setup && <Button variant="outline" type="button" disabled={changed} onClick={() => perform('test')}>{busy === 'test' ? 'Testing…' : 'Test model'}</Button>}
              <Button variant="outline" type="button" onClick={() => perform('disconnect')}>Disconnect {saved.label}</Button>
            </>}
          </div>
        </fieldset>
        {busy === 'oauth' && <div>
          <p role="status">Finish sign-in in your browser. This request expires in three minutes.</p>
          <Button variant="outline" type="button" onClick={() => call('configure', { provider: 'openrouter', auth: 'cancel' }).catch(err => notify(err.message))}>Cancel sign-in</Button>
        </div>}
      </form>
      {!setup && saved.configured && !local && <p>The model test sends a short sample and may use provider credits.</p>}
    </>
  )
}

function AccountHandoff({ account, notify }) {
  const methodId = useId()
  const [instructions, setInstructions] = useState(null)
  const guide = guides.find(item => item.id === account.guide)
  async function choose(method) {
    try {
      if (!guide) { await openExternal(account.website); return }
      const result = await accountGuide.handoff({ provider: guide.id, method })
      if (result.status === 'manual') setInstructions(result.option)
    } catch (error) { notify(error.message) }
  }
  return <div>
    <Button type="button" variant="outline" onClick={() => choose('web')}>Open {account.name} in browser</Button>
    {guide && <details>
      <summary>Other ways to sign in to {account.name}</summary>
      <label htmlFor={methodId}>Sign-in method</label>
      <select id={methodId} value={instructions?.id || ''} onChange={event => choose(event.target.value)}>
        <option value="" disabled>Choose a method</option>
        {guide.options.filter(option => option.kind !== 'browser').map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
      </select>
      {instructions && <div>
        <p role="status">{instructions.instructions}</p>
        {instructions.command && <pre><code>{instructions.command.join(' ')}</code></pre>}
        <Button type="button" variant="link" onClick={() => openExternal(instructions.documentation).catch(error => notify(error.message))}>Open official guide</Button>
      </div>}
    </details>}
  </div>
}

function AIConnection({ settings, onSettings, notify, onBusyChange, setup }) {
  const active = settings.activeProvider
  const [mode, setMode] = useState(accounts.some(item => item.id === active) ? active : active ? 'api' : '')
  const [busy, setBusy] = useState('')
  useEffect(() => { onBusyChange?.(Boolean(busy)) }, [busy, onBusyChange])
  const props = { onSettings, notify, busy, setBusy, setup }
  const account = accounts.find(item => item.id === mode)

  return <section className="panel">
    <h2 id="ai-connections-heading" tabIndex={-1}>AI for drafts</h2>
    <p>{active ? 'Current provider: ' + settings.providers[active].label : 'Choose an account or configure an API or local model for drafting.'}</p>
    <div className="toolbar" role="group" aria-label="AI accounts">
      {accounts.map(item => <Button key={item.id} type="button" aria-pressed={mode === item.id} variant={mode === item.id ? 'default' : 'outline'}
        disabled={Boolean(busy)} onClick={() => setMode(item.id)}>{item.name}</Button>)}
    </div>
    {mode === 'codex' && <SubscriptionConnection {...props} active={active === 'codex'} saved={settings.providers.codex} />}
    {account && mode !== 'codex' && <div>
      <p>Use an API key to draft inside Pluto, or open {account.name} in your browser.</p>
      <ApiConnection key={account.id} {...props} settings={settings} fixedProvider={account.id} />
      <AccountHandoff key={account.name} account={account} notify={notify} />
    </div>}
    <div className="toolbar">
      <Button type="button" aria-pressed={mode === 'api'} variant={mode === 'api' ? 'default' : 'outline'}
        disabled={Boolean(busy)} onClick={() => setMode('api')}>API or local model</Button>
    </div>
    {mode === 'api' && <ApiConnection key="api" {...props} settings={settings} />}
  </section>
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
            <Input type="password" autoComplete="off" spellCheck={false} value={key} required
              placeholder={saved.configured ? 'Enter a replacement key' : 'Enter your Firecrawl key'}
              onChange={event => setKey(event.target.value)} />
          </label>
          <div className="toolbar">
            <Button type="submit">{busy === 'configure' ? 'Saving…' : saved.configured ? 'Replace key' : 'Connect Firecrawl'}</Button>
            {saved.configured && <>
              <Button variant="outline" type="button" disabled={Boolean(key)} onClick={() => perform('test')}>{busy === 'test' ? 'Testing…' : 'Test connection'}</Button>
              <Button variant="outline" type="button" onClick={() => perform('disconnect')}>Disconnect Firecrawl</Button>
            </>}
          </div>
        </fieldset>
      </form>
    </section>
  )
}

export default function Connections({ notify, state, refresh, go, entrySection, aiOnly = false, emailOnly = false, onBusyChange }) {
  const [settings, setSettings] = useState(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (emailOnly) return
    let current = true
    setError('')
    call('settings').then(value => { if (current) setSettings(value) }).catch(err => { if (current) setError(err.message) })
    return () => { current = false }
  }, [attempt, emailOnly])
  const [mailAccounts, setMailAccounts] = useState(null)
  useEffect(() => { if (entrySection === 'features') document.getElementById('optional-workflows-heading')?.focus() }, [entrySection])
  if (emailOnly) return <MailConnection notify={notify} onBusyChange={onBusyChange} />
  return <div className="section">
    {!aiOnly && state && <OptionalWorkflows state={state} settings={settings} accounts={mailAccounts} refresh={refresh} go={go}/>}
    {entrySection === 'email' && <MailConnection notify={notify} onAccounts={setMailAccounts} focusOnOpen />}
    {settings ? <AIConnection settings={settings} onSettings={setSettings} notify={notify} onBusyChange={onBusyChange} setup={aiOnly} /> :
      error ? <section className="panel"><p role="alert">{error}</p><Button variant="outline" onClick={() => setAttempt(attempt + 1)}>Retry connections</Button></section>
      : <p role="status">Loading AI connections…</p>}
    {!aiOnly && <>
      {entrySection !== 'email' && <MailConnection notify={notify} onAccounts={setMailAccounts} />}
      <DriveConnection notify={notify} />
      {settings && <FirecrawlConnection saved={settings.providers.firecrawl} onSettings={setSettings} notify={notify} />}
      <FreeFallback notify={notify} />
    </>}
  </div>
}
