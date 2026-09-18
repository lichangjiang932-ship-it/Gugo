import assert from 'node:assert/strict'
import test from 'node:test'
import { runToolLoop } from '../server/services/loop/index.js'
import { callStreamingModelWithTools } from '../server/adapters/modelInvocationRuntime.js'

test('a tracked model error after confirmed tool progress remains unknown and cannot be resumed by replay', async () => {
  let modelCalls = 0
  let requests = 0
  let executions = 0
  const checkpoints = []
  const completed = []
  const options = {
    job: { id: 'unknown-after-progress', userId: 'unknown-progress-user', origin: 'chat', prompt: 'Write a small result file and verify it.' },
    step: { id: 'unknown-progress-step', kind: 'chat' },
    messages: [{ role: 'user', content: 'Write a small result file and verify it.' }],
    toolSpecs: [{ type: 'function', function: { name: 'write_file', parameters: { type: 'object' } } }],
    maxIters: 4, enableToolHooks: false,
    requestToolApproval: async ({ args }) => ({ proceed: true, args, approvalId: 'fixture-write' }),
    saveCheckpoint: (state) => checkpoints.push(structuredClone(state)),
    onToolCompleted: (value) => completed.push(value),
    executeTool: async () => { executions += 1; return { ok: true, path: 'result.txt', size: 7 } },
    runModel: async (request) => {
      modelCalls += 1
      if (modelCalls === 1) return { content: '', toolCalls: [{ id: 'write-once', type: 'function',
        function: { name: 'write_file', arguments: '{"path":"result.txt","content":"fixture"}' } }] }
      return callStreamingModelWithTools({ ...request, modelRequestId: request.modelRequestId || 'unknown-fixture-request',
        env: { MODEL_BASE_URL: 'http://127.0.0.1:11434/v1', MODEL_NAME: 'isolated-fixture' },
        fetchImpl: async () => { requests += 1; return new Response('data: {"error":{"message":"isolated upstream stream failure"}}\n\n') } })
    },
  }
  const isUnknown = (error) => error?.code === 'MODEL_REQUEST_OUTCOME_UNKNOWN'
    && error?.unsafeToReplay === true && error?.retryable === false
  await assert.rejects(() => runToolLoop(options), isUnknown)
  assert.equal(modelCalls, 2)
  assert.equal(requests, 1)
  assert.equal(executions, 1)
  assert.equal(completed[0].result.ok, true)
  assert.ok(checkpoints.at(-1).modelInvocation)
  await assert.rejects(() => runToolLoop({ ...options, loadCheckpoint: () => checkpoints.at(-1) }), isUnknown)
  assert.equal(modelCalls, 2, 'unknown invocation cannot be sent or wrapped up again')
  assert.equal(requests, 1)
  assert.equal(executions, 1)
})
