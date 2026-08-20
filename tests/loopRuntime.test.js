import assert from 'node:assert/strict'
import test from 'node:test'

import { createToolLoop, runToolLoop } from '../server/services/loop/index.js'

const ECHO_TOOL_SPEC = {
  type: 'function',
  function: {
    name: 'echo_tool',
    description: 'Echo a short value.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    },
  },
}

function baseOptions(overrides = {}) {
  return {
    job: { id: 'loop-index-test', userId: null, origin: 'chat', prompt: 'Use echo_tool, then answer.' },
    step: { id: 'loop-index-step', kind: 'chat' },
    messages: [{ role: 'user', content: 'Use echo_tool, then answer.' }],
    toolSpecs: [ECHO_TOOL_SPEC],
    enableToolHooks: false,
    maxIters: 3,
    ...overrides,
  }
}

test('loop/index drives a complete extensible tool loop', async () => {
  const observed = []
  const requests = []
  let modelCalls = 0
  const loop = createToolLoop(baseOptions({
    saveCheckpoint: async (_state, meta) => {
      observed.push(`checkpoint:${meta?.boundary}`)
      return true
    },
    runModel: async (request) => {
      requests.push(request)
      modelCalls += 1
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [{
            id: 'echo-1',
            type: 'function',
            function: { name: 'echo_tool', arguments: '{"text":"before"}' },
          }],
        }
      }
      return { content: 'done', toolCalls: [] }
    },
    executeTool: async ({ args }) => {
      observed.push(`execute:${args.text}`)
      return { ok: true, echoed: args.text }
    },
  }))

  loop.on('pre-step', (state) => {
    observed.push('pre-step')
    return state
  })
  loop.on('request', (request) => ({ ...request, extensionMarker: 'rewritten' }))
  loop.on('pre-tool', (call) => ({ ...call, args: { ...call.args, text: 'after' } }))
  loop.on('post-tool', ({ result }) => observed.push(`post-tool:${result.echoed}`))
  loop.on('turn-stopping', ({ text }) => observed.push(`turn-stopping:${text}`))

  const result = await loop.run()

  assert.equal(result.text, 'done')
  assert.equal(requests.length, 2)
  assert.ok(requests.every((request) => request.extensionMarker === 'rewritten'))
  assert.ok(observed.indexOf('execute:after') > observed.indexOf('checkpoint:tool-execution'))
  assert.ok(observed.includes('post-tool:after'))
  assert.equal(observed.at(-1), 'turn-stopping:done')
})

test('pre-tool listeners cannot replace host call identity or forge checkpoint state', async () => {
  let modelCalls = 0
  const approvals = []
  const executions = []
  const loop = createToolLoop(baseOptions({
    runModel: async () => {
      modelCalls += 1
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [{
            id: 'host-call-id',
            type: 'function',
            function: { name: 'echo_tool', arguments: '{"text":"before"}' },
          }],
        }
      }
      return { content: 'done', toolCalls: [] }
    },
    requestToolApproval: async (request) => {
      approvals.push(request)
      return { proceed: true, args: request.args }
    },
    executeTool: async (request) => {
      executions.push(request)
      return { ok: true, echoed: request.args.text }
    },
  }))
  loop.on('pre-tool', (call) => ({
    ...call,
    id: 'forged-call-id',
    name: 'forged_tool',
    args: { text: 'after' },
    checkpointStatus: 'executing',
    checkpointApprovalId: 'forged-approval-id',
    checkpointExecutionArgs: { text: 'forged-checkpoint-args' },
    dynamicToolRegistrationId: 'forged-registration-id',
    idempotencyKey: 'forged-idempotency-key',
  }))

  const result = await loop.run()

  assert.equal(result.text, 'done')
  assert.equal(approvals.length, 1)
  assert.equal(approvals[0].toolName, 'echo_tool')
  assert.deepEqual(approvals[0].args, { text: 'after' })
  assert.equal(executions.length, 1)
  assert.equal(executions[0].name, 'echo_tool')
  assert.equal(executions[0].toolCallId, 'host-call-id')
  assert.deepEqual(executions[0].args, { text: 'after' })
})

test('request-error may claim exactly one model retry', async () => {
  let modelCalls = 0
  const loop = createToolLoop(baseOptions({
    toolSpecs: [],
    runModel: async () => {
      modelCalls += 1
      if (modelCalls === 1) throw new Error('temporary model failure')
      return { content: 'recovered', toolCalls: [] }
    },
  }))
  loop.on('request-error', ({ error, request }) => {
    assert.match(error.message, /temporary model failure/)
    return { kind: 'retry', request: { ...request, recovered: true } }
  })

  const result = await loop.run()
  assert.equal(result.text, 'recovered')
  assert.equal(modelCalls, 2)
})

test('a failed tool checkpoint prevents the tool side effect', async () => {
  const checkpointCause = new Error('checkpoint database unavailable')
  let executed = 0
  await assert.rejects(runToolLoop(baseOptions({
    runModel: async () => ({
      content: '',
      toolCalls: [{
        id: 'blocked-echo',
        type: 'function',
        function: { name: 'echo_tool', arguments: '{"text":"blocked"}' },
      }],
    }),
    executeTool: async () => {
      executed += 1
      return { ok: true }
    },
    saveCheckpoint: async (_state, meta) => {
      if (meta?.boundary === 'tool-execution') throw checkpointCause
      return true
    },
  })), (error) => {
    assert.equal(error?.code, 'CHECKPOINT_FLUSH_FAILED')
    assert.equal(error?.retryable, true)
    assert.equal(error?.cause, checkpointCause)
    return true
  })
  assert.equal(executed, 0)
})

test('post-tool observes a normalized executor failure exactly once', async () => {
  let modelCalls = 0
  const outcomes = []
  const loop = createToolLoop(baseOptions({
    runModel: async () => {
      modelCalls += 1
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [{
            id: 'failing-echo',
            type: 'function',
            function: { name: 'echo_tool', arguments: '{"text":"fail"}' },
          }],
        }
      }
      return { content: 'failure observed', toolCalls: [] }
    },
    executeTool: async () => { throw new Error('executor exploded') },
  }))
  loop.on('post-tool', ({ result }) => outcomes.push(result))

  const result = await loop.run()
  assert.equal(result.text, 'failure observed')
  assert.equal(outcomes.length, 1)
  assert.equal(outcomes[0].ok, false)
  assert.match(outcomes[0].error, /executor exploded/)
})
