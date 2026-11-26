// Exercise the packaged desktop entry, source picker, applications and external refresh.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright'
import { createWorkspace } from '../desktop/workspace.mjs'
import { enterFixtureWorkspace } from './setup-fixture.mjs'

const temp = await mkdtemp(path.join(os.tmpdir(), 'pluto-workflow-desktop-'))
const userData = path.join(temp,'app')
const kit = path.join(temp,'private kit')
const job = { id:'fixture-32',company:'Fictional Printworks',role:'Studio Buyer',
  location:'New York',url:'https://example.org/roles/32',status:'Submitted',
  first_seen:'2025-02-11',submitted_at:'2025-02-12',evidence:'Fixture confirmation 32' }
const exported = path.join(kit,'exports/applications.json')
const executablePath = process.env.PLUTO_SMOKE_EXECUTABLE
let app, writer
try {
  await mkdir(path.dirname(exported),{recursive:true})
  await writeFile(exported, JSON.stringify([job]))
  app = await electron.launch({executablePath,args:['--user-data-dir='+userData,...(executablePath ? [] : ['.'])]})
  const page = await app.firstWindow()
  page.setDefaultTimeout(12000)
  await enterFixtureWorkspace(page)
  const nav = page.getByRole('navigation',{name:'Workspace'})
  await page.getByRole('button',{name:'Show workflow'}).click()
  await app.evaluate(({ dialog, app, shell }, folder) => {
    app.getApplicationNameForProtocol = () => 'Codex'
    shell.openExternal = async uri => { globalThis.lastWorkflowURI = uri }
    dialog.showOpenDialog = async () => ({ canceled:false,filePaths:[folder] })
  }, kit)
  await page.getByRole('button',{name:'Connect kit',exact:true}).click()
  await page.getByRole('button',{name:'Change kit',exact:true}).waitFor()
  await page.getByRole('button',{name:'Open task in Codex',exact:true}).click()
  const target = new URL(await app.evaluate(() => globalThis.lastWorkflowURI))
  assert.equal(target.protocol,'codex:')
  assert.equal(target.host,'threads')
  assert.equal(target.pathname,'/new')
  assert.ok(target.searchParams.get('prompt').includes(JSON.stringify(await realpath(kit))))
  if (process.env.PLUTO_KIT_SCREENSHOT) {
    await page.evaluate(() => document.fonts.ready)
    await page.getByRole('region',{name:'Job Kit workflow'}).screenshot({path:process.env.PLUTO_KIT_SCREENSHOT,animations:'disabled'})
  }
  await page.getByRole('button',{name:/Open applications/i}).click()
  await page.getByRole('button',{name:'Open Studio Buyer at Fictional Printworks',exact:true}).click()
  const snap = await page.evaluate(()=>window.pluto.call('workspace.snapshot'))
  assert.equal(snap.jobs.length,1)
  assert.equal(snap.jobs[0].submittedSnapshot.submittedAt,'2025-02-12')
  assert.equal(snap.jobs[0].submittedSnapshot.evidence.text,'Fixture confirmation 32')
  await nav.getByRole('button',{name:'Notebook',exact:true}).click()
  writer = createWorkspace(userData)
  writer.saveNote({title:'External workflow update',body:'Fictional local refresh.'})
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')))
  await page.getByRole('button',{name:'Edit External workflow update',exact:true}).waitFor()
  console.log('Native picker, historical receipt, Applications, Notebook and external refresh passed.')
} finally {
  writer?.close()
  await app?.close()
  await rm(temp,{recursive:true,force:true,maxRetries:4,retryDelay:100})
}
