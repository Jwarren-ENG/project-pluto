import test from 'node:test'
import assert from 'node:assert/strict'
import {orderModels, readCatalog} from '../desktop/model-catalog.mjs'

test('newest available model dates sort first and undated choices retain provider order', () => {
  const list = orderModels([{ id:'undated-b' }, { id:'first-release', created:'2024-07-19' },
    { id:'undated-a' }, { id:'new-release', created:1753000000 }, { id:'first-release' }])
  assert.equal(list.order, 'mixed')
  assert.deepEqual(list.models.map(model => model.id), ['new-release', 'first-release', 'undated-b', 'undated-a'])
})

test('OpenAI chat catalog excludes voice, video and dedicated runtime choices', async () => {
  const found = await readCatalog('openai', () => ({ data: [
    { id:'gpt-example' }, { id:'gpt-image-1' }, { id:'tts-1' }, { id:'gpt-special-codex' },
  ] }))
  assert.deepEqual(found.map(model => model.id), ['gpt-example'])
})
