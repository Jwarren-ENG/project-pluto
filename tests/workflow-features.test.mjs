import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createWorkspace } from '../desktop/workspace.mjs'
import { workflowTask } from '../desktop/workflow-actions.mjs'
import { workflowFeatures } from '../desktop/workflow-features.mjs'

test('optional preferences are independent, durable and default off', () => {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'pluto-settings-'))
  let first, second
  try {
    first = createWorkspace(folder)
    second = createWorkspace(folder)
    assert.deepEqual(first.snapshot().features, { studyGuides:false, interviewPrep:false, emailCheck:false, autoApply:false })
    first.saveFeature({key:'studyGuides',enabled:true})
    second.saveFeature({key:'interviewPrep',enabled:true})
    first.saveFeature({key:'studyGuides',enabled:false})
    assert.throws(() => second.saveFeature({key:'__proto__',enabled:true}))
    assert.throws(() => second.saveFeature({key:'emailCheck',enabled:'yes'}))
    assert.deepEqual(second.getFeatures(), workflowFeatures({interviewPrep:true}))
    first.close()
    first = createWorkspace(folder)
    assert.deepEqual(first.snapshot().features, second.getFeatures())
  } finally {
    first?.close()
    second?.close()
    rmSync(folder,{recursive:true,force:true})
  }
})

test('dashboard handoffs enforce feature choices and require a linked settings database', () => {
  const folders = {kit:'/synthetic/kit'}
  const generate = (skill, prefs, db = '/synthetic/desktop.db') => workflowTask(skill, folders, null, db, prefs)
  assert.throws(() => generate('interview-prep', {}), /Turn on Interview prep/)
  assert.match(generate('interview-prep', {interviewPrep:true}), /next confirmed interview/)
  assert.match(generate('run', {}), /Do not submit any applications/)
  assert.match(generate('run', {autoApply:true}, null), /Do not submit any applications/)
  assert.match(generate('run', {autoApply:true}), /verify autoApply is still true/)
  assert.match(generate('status', {}), /Do not access any mailbox/)
  assert.match(generate('status', {emailCheck:true}), /verify optionalWorkflows.emailCheck/)
})
