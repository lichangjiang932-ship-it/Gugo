import assert from 'node:assert/strict'
import test from 'node:test'

import { createLoopContext } from '../server/services/loop/context.js'
import {
  consumePreparedToolsLoopTerminalOutcome,
  executePreparedToolsLoop,
  prepareToolsLoopRuntime,
  runToolsLoopCore,
  usePreparedToolsLoopRuntime,
} from '../server/services/loop/runtime.js'

function runtimeContext(text = 'prepared loop complete', overrides = {}) {
  return createLoopContext({
    job: {
      id: 'prepared-loop-runtime',
      userId: 'prepared-loop-user',
      origin: 'job',
      prompt: 'Answer once.',
    },
    step: { id: 'prepared-loop-step', kind: 'chat' },
    messages: [{ role: 'user', content: 'Answer once.' }],
    toolSpecs: [],
    maxIters: 1,
    runModel: async () => ({ content: text, toolCalls: [] }),
    ...overrides,
  })
}

function hasCode(code) {
  return (error) => {
    assert.equal(error?.code, code)
    assert.equal(error?.retryable, false)
    return true
  }
}

test('prepared Tools Loop runtime is opaque and executes the initialized state once', async () => {
  const context = runtimeContext()
  const prepared = await prepareToolsLoopRuntime(context)

  assert.equal(Object.isFrozen(prepared), true)
  assert.equal(Object.getPrototypeOf(prepared), null)
  assert.deepEqual(Reflect.ownKeys(prepared), [])
  const terminal = consumePreparedToolsLoopTerminalOutcome(prepared)
  assert.deepEqual(terminal, { terminal: false })
  assert.equal(Object.isFrozen(terminal), true)
  assert.equal(usePreparedToolsLoopRuntime(prepared, (state) => {
    assert.strictEqual(state.context, context)
    assert.equal(state.iter, 0)
    assert.equal(state.maxIters, 1)
    assert.equal(state.iteration, null)
    return 'initialized'
  }), 'initialized')

  const result = await executePreparedToolsLoop(prepared)
  assert.equal(result.text, 'prepared loop complete')
  await assert.rejects(
    executePreparedToolsLoop(prepared),
    hasCode('TOOLS_LOOP_RUNTIME_PREPARED_STALE'),
  )
  assert.throws(
    () => usePreparedToolsLoopRuntime(prepared, () => {}),
    hasCode('TOOLS_LOOP_RUNTIME_PREPARED_STALE'),
  )
})

test('prepared Tools Loop runtime rejects forged handles and reentrant consumption', async () => {
  const forged = Object.freeze(Object.create(null))
  assert.throws(
    () => consumePreparedToolsLoopTerminalOutcome(forged),
    hasCode('TOOLS_LOOP_RUNTIME_PREPARED_INVALID'),
  )
  await assert.rejects(
    executePreparedToolsLoop(forged),
    hasCode('TOOLS_LOOP_RUNTIME_PREPARED_INVALID'),
  )
  assert.throws(
    () => usePreparedToolsLoopRuntime(forged, null),
    hasCode('TOOLS_LOOP_RUNTIME_PREPARED_INVALID'),
  )

  const prepared = await prepareToolsLoopRuntime(runtimeContext('reentrant guard complete'))
  assert.throws(
    () => usePreparedToolsLoopRuntime(prepared, () => {
      usePreparedToolsLoopRuntime(prepared, () => {})
    }),
    hasCode('TOOLS_LOOP_RUNTIME_PREPARED_STALE'),
  )
  assert.throws(
    () => usePreparedToolsLoopRuntime(prepared, null),
    hasCode('TOOLS_LOOP_RUNTIME_OPERATION_INVALID'),
  )
  const result = await executePreparedToolsLoop(prepared)
  assert.equal(result.text, 'reentrant guard complete')
})

test('runToolsLoopCore composes preparation and one-shot execution', async () => {
  const result = await runToolsLoopCore(runtimeContext('composed loop complete'))
  assert.equal(result.text, 'composed loop complete')
})

test('prepared execution preserves an initialization-phase terminal outcome', async () => {
  let modelCalls = 0
  const prepared = await prepareToolsLoopRuntime(runtimeContext('must not run', {
    loadCheckpoint: async () => ({
      state: {
        messages: [{ role: 'user', content: 'already completed' }],
        toolCalls: [],
        artifactIds: [],
        iterations: 2,
        final: {
          text: 'restored terminal outcome',
          incomplete: true,
          iterations: 2,
        },
      },
    }),
    runModel: async () => {
      modelCalls += 1
      return { content: 'unexpected model result', toolCalls: [] }
    },
  }))

  const terminal = consumePreparedToolsLoopTerminalOutcome(prepared)
  assert.equal(Object.isFrozen(terminal), true)
  assert.deepEqual(Reflect.ownKeys(terminal), ['terminal', 'value'])
  assert.equal(terminal.terminal, true)
  const result = await terminal.value
  assert.equal(result.text, 'restored terminal outcome')
  assert.equal(result.resumed, true)
  assert.equal(result.iterations, 2)
  assert.equal(modelCalls, 0)
  await assert.rejects(
    executePreparedToolsLoop(prepared),
    hasCode('TOOLS_LOOP_RUNTIME_PREPARED_STALE'),
  )
})
