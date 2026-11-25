import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { Writable } from 'node:stream'
import path from 'node:path'
import os from 'node:os'
import { createAppleMail } from '../desktop/apple-mail.mjs'

function fixture({ platform = 'darwin', scanOutput = '[]', connectOutput = 'true', hold, nativeError, answer, prefs } = {}) {
  const calls = [], preferences = prefs ?? new Map()
  function executeFile(exe, args, options, callback) {
    const call = { exe, args, options, script: '' }
    calls.push(call)
    const mode = args[3]
    return { stdin: new Writable({ write(chunk, _, cb) { call.script += chunk; cb() },
      final(cb) {
        cb()
        if (hold === mode) options.signal.addEventListener('abort', () => callback(new Error('sensitive fixture diagnostic')), { once: true })
        else queueMicrotask(() => callback(nativeError, answer ? answer(mode, args.slice(4)) : mode === 'connect' ? connectOutput : scanOutput, 'private stderr fixture'))
      } }) }
  }
  const mail = createAppleMail({ prefs: preferences, platform, executeFile })
  return { mail, calls, preferences }
}

test('settings is local, connection is opt-in, and disconnect persists without a Mail event', async () => {
  const { mail, calls, preferences } = fixture()
  assert.equal(mail.settings().email, '')
  await assert.rejects(mail.scan({ company: 'Example' }), /Connect Apple Mail/)
  assert.equal(calls.length, 0)
  assert.deepEqual(await mail.connect(), { provider: 'apple', email: 'Apple Mail' })
  assert.equal(mail.settings().email, 'Apple Mail')
  assert.deepEqual([...preferences.values()], [true])
  assert.deepEqual(await mail.disconnect(), { provider: 'apple', email: '' })
  assert.equal(mail.settings().email, '')
  assert.equal(calls.length, 1)
  assert.deepEqual([...preferences.values()], [false])
  const win = fixture({ platform: 'win32' })
  assert.equal(win.mail.settings().available, false)
  await assert.rejects(win.mail.connect(), /macOS/)
  assert.equal(win.calls.length, 0)
})

test('fixed native script uses a literal, separate employer argument and limited read-only queries', async () => {
  const { mail, calls } = fixture()
  await mail.connect()
  const company = 'Example "R&D"; $(whoami)'
  await mail.scan({ company })
  const [connect, scan] = calls
  assert.equal(scan.exe, '/usr/bin/osascript')
  assert.deepEqual(scan.args, ['-l', 'AppleScript', '-', 'scan', company])
  assert.equal(scan.options.shell, false)
  assert.equal(scan.options.maxBuffer, 96 * 1024)
  assert.equal(scan.options.timeout, 20000)
  assert.equal(scan.script, connect.script)
  assert.ok(!scan.script.includes(company))
  assert.match(scan.script, /every «class mssg» of «property inmb» whose/)
  assert.match(scan.script, /hitCount ≤ 20/)
  assert.doesNotMatch(scan.script, /«property (?:ctnt|isrd|alhe|rtfs|src )»|do shell script|run script|activate|mark as read/i)
  for (const name of ['', {}, 'a\nb', ' ', '?', 'a'.repeat(161)]) await assert.rejects(mail.scan({ company: name }), /tracked employer/)
  assert.equal(calls.length, 2)
})

test('only recent matching metadata crosses the service boundary with stable keys', async () => {
  const now = Math.floor(Date.now()/1000)
  const row = { id: '101', from: '  Example   Staffing ', subject: 'Interview\r\n invitation', seconds: now,
    body: 'Private fixture', url: 'https://example.invalid', preview: 'Private fixture' }
  const rows = [row, row, { id: '102', subject: 'EXAMPLE update', seconds: now-1800 },
    { ...row, id: '103', seconds: now - 46*86400 }, { ...row, id: '104', from: 'Unrelated', subject: 'Private' }]
  const { mail } = fixture({ scanOutput: JSON.stringify(rows) })
  await mail.connect()
  const result = await mail.scan({ company: 'Example' })
  assert.equal(result.length, 2)
  assert.deepEqual(result, await mail.scan({ company: 'Example' }))
  assert.match(result[0].key, /^[a-f0-9]{64}$/)
  assert.deepEqual(result[0], { key: result[0].key, provider: 'apple', account: 'Apple Mail', from: 'Example Staffing',
    subject: 'Interview invitation', receivedAt: new Date(now*1000).toISOString(), preview: '', url: '' })
  assert.ok(!JSON.stringify(result).includes('Private'))
})

test('permission denial, native failures and oversized data have safe user errors', async () => {
  for (const [raw, pattern] of [['DENIED',/Automation/],['TIMEOUT',/too long/],['TOO_MANY',/Too many/],
    ['unexpected private diagnostic',/Couldn’t read/],['x'.repeat(97*1024),/unreadable/], [JSON.stringify(Array(21).fill({})),/unreadable/]]) {
    const { mail } = fixture({ scanOutput: raw })
    await mail.connect()
    await assert.rejects(mail.scan({ company: 'Example' }), e => pattern.test(e.message) && !e.message.includes('private diagnostic'))
  }
  const rejected = fixture({ connectOutput: 'DENIED' })
  await assert.rejects(rejected.mail.connect(), /Automation/)
  assert.equal(rejected.mail.settings().email, '')
  const failed = fixture({ nativeError: new Error('private native output') })
  await assert.rejects(failed.mail.connect(), /Couldn’t run/)
})

test('cancel, disconnect and process shutdown terminate a pending native request', async () => {
  for (const action of ['cancel', 'disconnect', 'close']) {
    const { mail, calls } = fixture({ hold: 'scan' })
    await mail.connect()
    const pending = mail.scan({ company: 'Example' })
    const rejected = assert.rejects(pending, /cancelled/)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(mail.settings().busy, 'scan')
    await assert.rejects(mail.scan({ company: 'Second' }), /in progress/)
    if (action === 'cancel') assert.equal(await mail.scan({ cancel: true }), null)
    else await mail[action]()
    await rejected
    assert.equal(calls[1].options.signal.aborted, true)
    assert.equal(mail.settings().busy, '')
    if (action === 'close') await assert.rejects(mail.connect(), /running macOS app/)
  }
})

test('macOS compiles the complete Mail script without executing an Apple Event', { skip: process.platform !== 'darwin' }, async t => {
  const { mail, calls } = fixture()
  await mail.connect()
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pluto-mail-compile-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  execFileSync('/usr/bin/osacompile', ['-l', 'AppleScript', '-o', path.join(dir, 'mail.scpt'), '-'], {input: calls[0].script})
})

test('macOS encodes a synthetic sender, subject and timestamp through the same native metadata encoder', { skip: process.platform !== 'darwin' }, async () => {
  const { mail, calls } = fixture()
  await mail.connect()
  const source = calls[0].script
  const preamble = source.slice(0, source.indexOf('on run argv'))
  const encode = source.slice(source.indexOf('      set stamp to'), source.indexOf('    end repeat\n    set bytes to'))
  const finish = source.slice(source.indexOf('    set bytes to'), source.indexOf('  on error number'))
  const localScript = preamble + `
    set rows to current application's NSMutableArray's array()
    set msgID to 12
    set msgFrom to "Example Recruiting"
    set msgSubject to "Fixture"
    set msgDate to current date
  ` + encode + finish
  assert.doesNotMatch(localScript, /tell application|com\.apple\.mail|«class mssg»/i)
  const result = JSON.parse(execFileSync('/usr/bin/osascript', ['-l','AppleScript','-'], { input: localScript, encoding: 'utf8' }))
  assert.deepEqual(Object.keys(result[0]).sort(), ['from','id','seconds','subject'])
  assert.equal(result[0].id, '12')
  assert.equal(result[0].subject, 'Fixture')
  assert.ok(Math.abs(Date.now() / 1000 - result[0].seconds) < 10)
})

const work = { id: 'work-id', label: 'Work', email: 'work@example.invalid' }
const home = { id: 'personal-id', label: 'Personal', email: 'personal@example.invalid' }

test('picker explicitly reads enabled account metadata and returns only usable IDs, labels and primary addresses', async () => {
  const f = fixture({ answer: () => JSON.stringify([{...work, label: ' Work\n Mail ', aliases: ['other@example.invalid']}, home,
    { id: 'unnamed', label: '', email: 'alias@example.invalid' }, { id: 'invalid', email: '' }]) })
  f.mail.settings()
  f.mail.settings('gmail')
  await f.mail.appleAccounts({cancel:true})
  assert.equal(f.calls.length, 0)
  assert.deepEqual(await f.mail.appleAccounts({}), [{...work, label:'Work Mail'}, home, {id:'unnamed',label:'alias@example.invalid',email:'alias@example.invalid'}])
  const call = f.calls[0]
  assert.deepEqual(call.args.slice(3), ['accounts'])
  assert.match(call.script, /every «class mact» whose «property isac» is true/)
  assert.doesNotMatch(call.script, /«class mssg»|«property (?:inmb|macp|host|path|ctnt)»/)
  assert.equal(f.preferences.size, 0)
  assert.deepEqual(f.mail.settings('gmail'), null)
})

test('selected ID and its Inbox are rechecked natively and cannot be switched by a scan payload', async () => {
  let removed = false
  const f = fixture({ answer: (mode, args) => {
    if (mode === 'select') return JSON.stringify([work, home].filter(a => a.id === args[0]))
    if (mode === 'connect') return 'true'
    if (mode === 'scan' && args[1] === work.id && removed) return 'ACCOUNT_GONE'
    return JSON.stringify([{id:'12',from:'Example',subject:'Interview',seconds: Date.now()/1000}])
  } })
  const { mail, calls } = f
  await assert.rejects(mail.connect({provider:'gmail',appleAccountId:'unknown'}), /unavailable/)
  assert.equal(mail.settings('gmail'), null)
  for (const [provider, selected] of [['gmail', work], ['outlook', home]]) {
    assert.deepEqual(await mail.connect({provider, appleAccountId:selected.id, email:'forged@example.invalid'}), {provider, via:'apple', email:selected.email})
    const select = calls.at(-1)
    assert.deepEqual(select.args.slice(3), ['select', selected.id])
    assert.match(select.script, /every «class mact» whose «property ID  » is wantedID and «property isac» is true/)
    assert.match(select.script, /«property ID  » of «property mact» of selectedInbox/)
    assert.doesNotMatch(select.script, /«property inmb»|«class mssg»/)
    const [message] = await mail.scan({ provider, company:'Example', appleAccountId:'forged', email:'forged@example.invalid' })
    assert.equal(message.provider, provider)
    assert.equal(message.account, selected.email)
    const scan = calls.at(-1)
    assert.deepEqual(scan.args.slice(3), ['scan', 'Example', selected.id, selected.email])
    assert.match(scan.script, /«class mbxp» of selectedAccount whose «property pnam» is "INBOX"/)
    assert.match(scan.script, /reference to «class mbxp» inboxName of «class mact» id wantedID/)
    assert.match(scan.script, /«class mssg» of selectedInbox whose/)
    assert.match(scan.script, /«property mact» of «property mbxp» of hitRef/)
    assert.match(scan.script, /is not expectedEmail then return "ACCOUNT_GONE"/)
    assert.doesNotMatch(scan.script, /«property inmb»|«property (?:ctnt|isrd|macp)»/)
  }
  const gmailKey = (await mail.scan({provider:'gmail', company:'Example'}))[0].key
  assert.notEqual(gmailKey,(await mail.scan({provider:'outlook',company:'Example'}))[0].key)
  // Settings, startup and disconnect use only the stored selection.
  const restored = fixture({ prefs:f.preferences })
  assert.deepEqual(restored.mail.settings('gmail'), {provider:'gmail',via:'apple',email:work.email,busy:''})
  assert.equal(restored.calls.length, 0)
  await mail.connect({provider:'apple'})
  removed = true
  await assert.rejects(mail.scan({provider:'gmail', company:'Example'}), /no longer enabled/)
  const callCount = calls.length
  assert.equal(mail.settings('gmail').via, 'apple')
  assert.match(mail.settings('gmail').error,/choose an available account/)
  await assert.rejects(mail.scan({provider:'gmail', company:'Example'}), /choose an available account/)
  await mail.disconnect({provider:'gmail'})
  assert.equal(calls.length,callCount)
  assert.equal(mail.settings('gmail'), null)
  assert.equal(mail.settings('outlook').email, home.email)
  assert.equal(mail.settings().email, 'Apple Mail')
})

test('picker cancellation works before launch, after launch, and at shutdown', async () => {
  for (const stop of ['before','dismiss','close']) {
    const { mail, calls } = fixture({hold:'accounts'})
    const result = assert.rejects(mail.appleAccounts({}), /cancelled/)
    if (stop !== 'before') await new Promise(resolve => setImmediate(resolve))
    if (stop === 'close') mail.close()
    else assert.equal(await mail.appleAccounts({cancel:true}), null)
    await result
    assert.equal(calls.length, stop === 'before' ? 0 : 1)
    if (calls.length) assert.ok(calls[0].options.signal.aborted)
  }
})

test('a picker dismissal cannot cancel a pending selected-account scan', async () => {
  const f = fixture({ hold:'scan', answer: () => JSON.stringify([work]) })
  await f.mail.connect({provider:'gmail',appleAccountId:work.id})
  const done = assert.rejects(f.mail.scan({provider:'gmail', company:'Example'}), /cancelled/)
  await new Promise(resolve => setImmediate(resolve))
  const scan = f.calls.at(-1)
  await f.mail.appleAccounts({cancel:true})
  await f.mail.scan({provider:'outlook',cancel:true})
  assert.equal(scan.options.signal.aborted, false)
  await f.mail.disconnect({provider:'gmail'})
  await done
  assert.equal(scan.options.signal.aborted, true)
})

test('macOS compiles picker, selected-account verification and selected Inbox search without contacting Mail', { skip: process.platform !== 'darwin' }, async t => {
  const f = fixture({ answer: mode => mode === 'scan' ? '[]' : JSON.stringify([work]) })
  await f.mail.appleAccounts({})
  await f.mail.connect({provider:'gmail', appleAccountId:work.id})
  await f.mail.scan({provider:'gmail', company:'Example'})
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pluto-account-compile-'))
  t.after(() => rm(dir, { recursive:true, force:true }))
  for (const call of f.calls) {
    execFileSync('/usr/bin/osacompile', ['-l','AppleScript','-o',path.join(dir,call.args[3]+'.scpt'),'-'], {input:call.script})
  }
})
