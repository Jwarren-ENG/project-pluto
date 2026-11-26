import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { managedSummary, workflowTask, vaultAddress, requestManagedRefresh } from '../desktop/workflow-actions.mjs'

test('handoff honors the selected workspace and restricts native actions', () => {
  const root = path.resolve('test folder & notes')
  const managed = { configured: true, tracker: 'Application tracker', vault: 'Notebook', workspacePath: root, vaultPath: root, vaultHome: 'Home.md', ok: true }
  assert.equal(managedSummary(managed).workspacePath, undefined)
  assert.match(workflowTask('status', {}, managed), /Match each response to the role/)
  assert.ok(workflowTask('run', {kit:root}, null).includes(JSON.stringify(root)))
  assert.ok(workflowTask('run', {kit:root}, null, path.join(root,'workspace.sqlite3')).includes('read-only mode'))
  assert.throws(() => workflowTask('unknown', {}, managed))
  assert.throws(() => workflowTask('run', {}, null))
  assert.equal(vaultAddress({}, managed), 'obsidian://open?path='+encodeURIComponent(path.join(root, 'Home.md')))
  assert.throws(() => vaultAddress({}, {...managed, vaultHome: '../escape'}))
  assert.equal(vaultAddress({vault:root}, managed), 'obsidian://open?vault=test%20folder%20%26%20notes')
})

test('each managed refresh replaces one local request file', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(),'pluto-workflow-'))
  try {
    const target=path.join(dir,'workflow-requests','sync.json')
    await requestManagedRefresh(dir)
    const first=JSON.parse(await readFile(target,'utf8'))
    await requestManagedRefresh(dir)
    const second=JSON.parse(await readFile(target,'utf8'))
    assert.deepEqual(Object.keys(first), ['request'])
    assert.notEqual(first.request, second.request)
  } finally { await rm(dir,{recursive:true,force:true}) }
})
