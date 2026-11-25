import test from 'node:test'
import assert from 'node:assert/strict'
import { Writable } from 'node:stream'
import { createAppleMail } from '../desktop/apple-mail.mjs'
import { createMailRouting } from '../desktop/mail-routing.mjs'
import { createJobMail } from '../desktop/job-mail.mjs'

const chosen = { id: 'work-id', label: 'Work', email: 'recruiting@example.invalid' }
function fixture({ cloudStatus = {}, waitForSettings, holdSelection = false, prefs = new Map(), platform = 'darwin' } = {}) {
  const cloudCalls = [], native = []
  const accounts = { gmail: '', outlook: '' }
  const cloudMail = {
    async settings() {
      if (waitForSettings) await waitForSettings
      return Object.entries(accounts).map(([provider,email]) => ({ provider, email, busy:'', direct:false, ...cloudStatus[provider] }))
    },
    async connect(p) { cloudCalls.push(['connect',p.provider]); accounts[p.provider] = 'cloud@example.invalid'; return {provider:p.provider,email:accounts[p.provider]} },
    async scan(p) { cloudCalls.push(['scan',p.provider]); return [] },
    async disconnect(p) { cloudCalls.push(['disconnect',p.provider]); accounts[p.provider] = ''; return {provider:p.provider,email:''} },
    close() {}
  }
  let present = true
  const appleMail = createAppleMail({ platform, prefs, executeFile(exe, args, options, cb) {
    const [mode, ...params] = args.slice(3)
    native.push({ mode, params, signal:options.signal })
    return { stdin:new Writable({ write(_text, _encoding, done) { done() }, final(done) {
      done()
      if (holdSelection && mode === 'select') {
        options.signal.addEventListener('abort', () => cb(new Error('aborted')), {once:true})
        return
      }
      let data
      if (mode === 'accounts') data = [chosen]
      if (mode === 'select') data = present && chosen.id === params[0] ? [chosen] : []
      if (mode === 'connect') data = true
      if (mode === 'scan') data = [{ id:'7', subject:'Interview for Product Manager at Example', from:'Example Recruiting', seconds:Date.now()/1000 }]
      queueMicrotask(() => cb(null, !present && mode === 'scan' && params.length > 1 ? 'ACCOUNT_GONE' : JSON.stringify(data)))
    } }) }
  } })
  return { mail:createMailRouting({ cloudMail, appleMail }), native, cloudCalls, remove() { present=false } }
}

test('provider settings and job-mail scans follow only the chosen mailbox, including after restart', async () => {
  const prefs = new Map()
  const f = fixture({prefs})
  const { mail } = f
  assert.equal((await mail.settings()).find(s=>s.provider==='gmail').email, '')
  assert.equal(f.native.length,0)
  assert.deepEqual(await mail.appleAccounts({}),[chosen])
  assert.deepEqual(await mail.connect({provider:'gmail',appleAccountId:chosen.id}), {provider:'gmail',email:chosen.email,via:'apple'})
  const settings = await mail.settings()
  assert.equal(settings.find(s=>s.provider==='apple').email,'')
  assert.deepEqual(settings.find(s=>s.provider==='gmail'), {provider:'gmail',email:chosen.email,busy:'',direct:false,via:'apple'})
  const restarted = fixture({prefs})
  assert.equal((await restarted.mail.settings()).find(s=>s.provider==='gmail').email,chosen.email)
  assert.equal(restarted.native.length,0)
  const jobs = createJobMail({mail:restarted.mail,getJobs:()=>[{id:'role',company:'Example',title:'Product Manager',stage:'Applied'}]})
  const page = await jobs.scan({provider:'gmail',jobId:'role',scanId:'manual'})
  assert.equal(page.matches.length,1)
  assert.equal(page.matches[0].message.account,chosen.email)
  assert.equal(page.matches[0].message.provider,'gmail')
  assert.deepEqual(restarted.native[0].params,['Example',chosen.id,chosen.email])
  restarted.remove()
  await assert.rejects(restarted.mail.scan({provider:'gmail',company:'Example'}), /no longer enabled/)
  await assert.rejects(restarted.mail.scan({provider:'gmail',company:'Example'}), /Disconnect/)
  const stale = (await restarted.mail.settings()).find(s=>s.provider==='gmail')
  assert.equal(stale.via,'apple')
  assert.ok(stale.error)
  await restarted.mail.disconnect({provider:'gmail'})
  assert.deepEqual(restarted.cloudCalls,[])
  assert.equal((await restarted.mail.settings()).find(s=>s.provider==='gmail').email,'')
  jobs.close()
})

test('cloud registration, existing cloud sessions and generic Apple Mail retain their own routes', async () => {
  for (const status of [{direct:true}, {email:'existing@example.invalid'}, {error:'locked'}, {busy:'connect'}]) {
    const f = fixture({ cloudStatus:{gmail:status} })
    await assert.rejects(f.mail.connect({provider:'gmail',appleAccountId:chosen.id}), /registered|existing cloud/)
    assert.deepEqual(f.native,[])
    assert.deepEqual(f.cloudCalls,[])
  }
  const f = fixture({ cloudStatus:{outlook:{direct:true}} })
  await f.mail.connect({provider:'apple'})
  await f.mail.connect({provider:'outlook'})
  await f.mail.connect({provider:'gmail',appleAccountId:chosen.id})
  await assert.rejects(f.mail.connect({provider:'gmail',clientId:'custom'}),/Disconnect/)
  await f.mail.scan({provider:'apple',company:'Example'})
  await f.mail.scan({provider:'outlook',company:'Example'})
  await f.mail.disconnect({provider:'gmail'})
  assert.deepEqual(f.native.map(c=>[c.mode,...c.params]),[['connect'],['select',chosen.id],['scan','Example']])
  assert.deepEqual(f.cloudCalls,[['connect','outlook'],['scan','outlook']])
  assert.equal((await f.mail.settings()).find(s=>s.provider==='apple').email,'Apple Mail')
  assert.equal((await f.mail.settings()).find(s=>s.provider==='outlook').email,'cloud@example.invalid')
  await f.mail.disconnect({provider:'outlook'})
  assert.deepEqual(f.cloudCalls.at(-1),['disconnect','outlook'])
})

test('Windows hides local picker and keeps cloud registration flows', async () => {
  const f = fixture({ platform:'win32' })
  assert.deepEqual((await f.mail.settings()).map(row=>row.provider),['gmail','outlook'])
  await assert.rejects(f.mail.appleAccounts({}),/macOS/)
  await assert.rejects(f.mail.connect({provider:'gmail',appleAccountId:chosen.id}),/available mailbox/)
  await f.mail.connect({provider:'gmail',clientId:'custom'})
  assert.deepEqual(f.native,[])
  assert.deepEqual(f.cloudCalls,[['connect','gmail']])
})

test('cancelling or closing a connection while cloud status is pending never starts the native selection', async () => {
  for (const stop of ['cancel','close']) {
    let complete
    const waitForSettings = new Promise(resolve => {complete=resolve})
    const f = fixture({waitForSettings})
    const result = assert.rejects(f.mail.connect({provider:'gmail',appleAccountId:chosen.id}), /cancelled/)
    await assert.rejects(f.mail.connect({provider:'gmail',clientId:'custom'}),/in progress/)
    const done = stop === 'close' ? f.mail.close() : f.mail.connect({provider:'gmail',cancel:true})
    complete()
    await result
    await done
    assert.deepEqual(f.native,[])
    assert.deepEqual(f.cloudCalls,[])
  }
})

test('unmount cancels provider verification even when the cancellation payload omits the account ID', async () => {
  const f = fixture({holdSelection:true})
  const pending = assert.rejects(f.mail.connect({provider:'outlook',appleAccountId:chosen.id}),/cancelled/)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.native.at(-1).mode,'select')
  assert.equal(await f.mail.connect({provider:'outlook',cancel:true}),null)
  await pending
  assert.equal(f.native.at(-1).signal.aborted,true)
  assert.deepEqual(f.cloudCalls,[])
  assert.equal((await f.mail.settings()).find(s=>s.provider==='outlook').email,'')
})
