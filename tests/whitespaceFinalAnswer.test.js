import test from 'node:test'
import assert from 'node:assert/strict'
import { runToolLoop } from '../server/services/loop/index.js'

// A reply of only whitespace used to end the turn as a normal completion with
// an empty answer in the final slot and no incomplete marker.

test('a whitespace-only reply is not a completed answer', async () => {
  let modelCalls = 0
  const result = await runToolLoop({
    job: { id: 'blank-answer', userId: 'blank-user', origin: 'chat', prompt: 'Say hello.' },
    step: { id: 'blank-answer-step', kind: 'chat' },
    messages: [{ role: 'user', content: 'Say hello.' }],
    toolSpecs: [],
    maxIters: 2,
    enableToolHooks: false,
    runModel: async () => { modelCalls += 1; return { content: '  \n\t ', toolCalls: [] } },
  })
  assert.equal(result.incomplete, true, JSON.stringify(result))
  assert.equal(result.reason, 'empty_model_response')
  assert.ok(String(result.text).trim().length > 0, 'the reader is told what happened')
  assert.ok(modelCalls >= 1)
})
