import '../scripts/testEnvironment.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { runToolLoop } from '../server/services/loop/index.js'

async function run({ history, content, prompt = 'Current request', intentMode = 'auto' }) {
  const messages = [...history, { role: 'user', content }]
  const original = structuredClone(messages)
  const requests = []
  const result = await runToolLoop({
    job: { id: 'typed-user-intent', userId: null, origin: 'chat', prompt },
    step: { id: 'typed-user-intent', kind: 'chat' },
    messages, intentMode, toolSpecs: [], fallbackToolSpecs: [], maxIters: 4, enableToolHooks: false,
    runModel: async ({ messages: outbound }) => {
      requests.push(structuredClone(outbound))
      return { content: 'Fixture reply.', toolCalls: [], finishReason: 'stop' }
    },
    executeTool: async () => { throw new Error('No real tool execution in this fixture') },
  })
  assert.deepEqual(messages, original)
  for (const request of requests) assert.deepEqual(request.findLast((message) => message.role === 'user')?.content, content)
  return { result, requests }
}

for (const intentMode of ['auto', 'execute']) {
  test(`latest typed user greeting overrides a historical mutation in ${intentMode} chat`, async () => {
    const content = [
      { type: 'text', text: 'hi' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,UNCHANGED_IMAGE_FIXTURE' } },
    ]
    const { result, requests } = await run({
      history: [{ role: 'user', content: 'Please fix src/App.jsx.' }, { role: 'assistant', content: 'Earlier task complete.' }],
      content, prompt: 'hi', intentMode,
    })
    assert.equal(requests.length, 1)
    assert.equal(result.text, 'Fixture reply.')
    assert.notEqual(result.incomplete, true)
    assert.equal(requests[0].some((message) => message.role === 'system' && String(message.content).includes('[DIRECT EXECUTION REQUIRED]')), false)
  })
}

test('a typed mutation request remains executable instead of falling back to an older greeting', async () => {
  const { result } = await run({
    history: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'Hello.' }],
    content: [{ type: 'text', text: '请修复 src/App.jsx 的登录问题。' }],
  })
  assert.equal(result.incomplete, true)
  assert.equal(result.reason, 'execution_evidence_missing')
})

test('input_text parts are recognized without treating attachment metadata as a work order', async () => {
  const { result, requests } = await run({
    history: [{ role: 'user', content: 'Please delete old.txt.' }, { role: 'assistant', content: 'Earlier task complete.' }],
    content: [
      { type: 'input_text', text: 'Explain this format.' },
      { type: 'file', file: { filename: 'delete-files.md', file_data: 'UNCHANGED_FILE_FIXTURE' } },
    ],
  })
  assert.equal(requests.length, 1)
  assert.notEqual(result.incomplete, true)
})

test('image-only latest user input does not silently reactivate an older mutation', async () => {
  const { result, requests } = await run({
    history: [{ role: 'user', content: 'Please fix src/App.jsx.' }, { role: 'assistant', content: 'Earlier task complete.' }],
    content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,UNCHANGED_IMAGE_FIXTURE' } }],
    prompt: 'Describe the supplied image.',
  })
  assert.equal(requests.length, 1)
  assert.notEqual(result.incomplete, true)
})
