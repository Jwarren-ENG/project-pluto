import assert from 'node:assert/strict'
import test from 'node:test'

import { createAccountClis } from '../desktop/account-clis.mjs'

test('lists independent user choices without opening or probing accounts', () => {
  const service = createAccountClis({ openExternal: assert.fail })
  const entries = service.list()
  assert.deepEqual(entries.map(entry => entry.id), ['grok', 'gemini'])
  for (const { options } of entries) {
    assert.equal(new Set(options.map(option => option.id)).size, options.length)
    for (const option of options) {
      assert.equal(new URL(option.documentation).protocol, 'https:')
      assert.ok(option.instructions)
    }
  }
  entries[0].options[0].command.push('untrusted')
  assert.deepEqual(service.list()[0].options[0].command, ['grok', 'login'])
})

test('the terminal handoff gives the correct interactive command for each account type', async () => {
  const service = createAccountClis({ openExternal: assert.fail })
  for (const [provider, method, command] of [
    ['grok', 'cli', ['grok', 'login']],
    ['grok', 'device', ['grok', 'login', '--device-auth']],
    ['gemini', 'cli', ['agy']],
    ['gemini', 'enterprise-cli', ['gemini']],
  ]) {
    const result = await service.handoff({ provider, method })
    assert.equal(result.status, 'manual')
    assert.deepEqual(result.option.command, command)
    result.option.command.pop()
    assert.deepEqual((await service.handoff({ provider, method })).option.command, command)
  }
})

test('native app routes leave sign-in with the user', async () => {
  const service = createAccountClis({ openExternal: assert.fail })
  for (const provider of ['grok', 'gemini']) {
    const { option, status } = await service.handoff({ provider, method: 'native' })
    assert.equal(status, 'manual')
    assert.equal(option.kind, 'app')
    assert.equal(option.command, undefined)
  }
})

test('browser handoff opens only the selected fixed website and never returns opener data', async () => {
  const urls = []
  const service = createAccountClis({ openExternal: async url => {
    urls.push(url)
    return { account: 'opener-private-data' }
  } })
  for (const [provider, expected] of [['grok', 'https://grok.com/'], ['gemini', 'https://gemini.google.com/app']]) {
    const input = { provider, method: 'web', url: 'https://untrusted.invalid/' }
    const result = await service.handoff(input)
    assert.equal(urls.at(-1), expected)
    assert.equal(result.status, 'opened')
    assert.deepEqual(Object.keys(result).sort(), ['option', 'provider', 'status'])
    assert.equal(JSON.stringify(result).includes('opener-private-data'), false)
    const manual = await createAccountClis().handoff(input)
    assert.equal(manual.status, 'manual')
    assert.equal(manual.option.url, expected)
  }
  assert.equal(urls.length, 2)
})

test('rejects unknown provider and method pairs before opening anything', async () => {
  const service = createAccountClis({ openExternal: assert.fail })
  for (const input of [undefined, null, {}, { provider: 'unknown', method: 'web' },
    { provider: 'gemini', method: 'device' }, { provider: 'grok', method: '__proto__' }]) {
    await assert.rejects(service.handoff(input), /Choose a supported account sign-in option/)
  }
})

test('a failed browser launch reports a recoverable error without leaking driver output', async () => {
  const service = createAccountClis({ openExternal: () => { throw new Error('private driver details') } })
  await assert.rejects(service.handoff({ provider: 'gemini', method: 'web' }), {
    message: 'The browser could not be opened. Open the provider website yourself.',
  })
})
