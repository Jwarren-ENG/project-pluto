import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { createWorkspace } from '../desktop/workspace.mjs'

test('kit roles, receipts and interview rounds share the normal desktop workspace', t => {
  const dir = mkdtempSync(path.join(os.tmpdir(),'kit-native-'))
  const ws = createWorkspace(dir)
  t.after(() => { ws.close(); rmSync(dir,{recursive:true,force:true}) })
  const row = { id:'JR1',company:'Bookshop',role:'Buyer',url:'https://example.org/jobs/1',
    status:'Submitted',submitted_at:'2024-05-03',evidence:'Portal receipt 123' }
  const meeting = { id:'interview1',company:'Bookshop',role:'Buyer',status:'Scheduled',start:'2099-08-19T10:30:00Z' }
  const pending = {...row,id:'other',role:'Writer',url:'https://example.org/jobs/2',status:'Submission uncertain',submitted_at:null,evidence:'Awaiting confirmation'}
  const submit = () => ws.importKitJobs(dir,[row,pending],[meeting])
  assert.equal(submit().receipts, 1)
  assert.equal(submit().unchanged, 2)
  const state = ws.snapshot()
  assert.equal(state.upcomingInterviews.length,1)
  const imported = state.jobs.find(x=>x.title==='Buyer')
  assert.equal(imported.stage,'Interview')
  assert.equal(imported.submittedSnapshot.submittedAt,'2024-05-03')
  assert.equal(state.jobs.find(x=>x.title==='Writer').submittedSnapshot,null)
  ws.saveJob({id:imported.id,caseNotes:'My local note'})
  row.next_action = 'Updated at source'
  meeting.status = 'Cancelled'
  submit()
  const after = ws.snapshot()
  assert.equal(after.upcomingInterviews.length,0)
  const revised=after.jobs.find(j=>j.id===imported.id)
  assert.equal(revised.stage,'Applied')
  assert.equal(revised.caseNotes,'My local note')
  assert.deepEqual(revised.submittedSnapshot,imported.submittedSnapshot)
  const alone={...meeting,company:'Printshop',id:'solo',status:'Scheduled'}
  ws.importKitJobs(dir,[],[alone])
  const solo=ws.snapshot().jobs.find(j=>j.company==='Printshop')
  assert.equal(solo.stage,'Interview')
  assert.equal(solo.submittedSnapshot,null)
  assert.throws(()=>ws.importKitJobs(dir,[{...row,id:'bad',url:'file:///etc'}]))
  assert.equal(ws.snapshot().jobs.length,3)
})
