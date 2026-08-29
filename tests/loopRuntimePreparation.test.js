import assert from 'node:assert/strict'
import test from 'node:test'

import { createLoopContext } from '../server/services/loop/context.js'
import { SERVER_TOOL_SPECS } from '../server/services/toolLoopHeuristics.js'
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

test('restored successful final without a current evidence review re-enters the model loop', async () => {
  let modelCalls = 0
  let reviewPromptObserved = false
  const prepared = await prepareToolsLoopRuntime(runtimeContext('unused', {
    loadCheckpoint: async () => ({
      state: {
        messages: [{ role: 'user', content: 'Apply and verify the requested fix.' }],
        toolCalls: [],
        artifactIds: [],
        iterations: 0,
        completionGuards: {
          executionEvidenceObserved: true,
          mutationExecutionObserved: true,
        },
        final: {
          text: 'stale unreviewed completion',
          iterations: 1,
        },
      },
    }),
    runModel: async ({ messages }) => {
      modelCalls += 1
      reviewPromptObserved = messages.some((message) => (
        String(message?.content || '').includes('[FINAL ANSWER EVIDENCE REVIEW REQUIRED]')
      ))
      return { content: 'reviewed recovery completion', toolCalls: [] }
    },
  }))

  assert.deepEqual(consumePreparedToolsLoopTerminalOutcome(prepared), { terminal: false })
  const result = await executePreparedToolsLoop(prepared)
  assert.equal(result.text, 'reviewed recovery completion')
  assert.equal(modelCalls, 1)
  assert.equal(reviewPromptObserved, true)
})

test('restored successful final with an unselected artifact enters set_deliverables first', async () => {
  const suffix = `${process.pid}-${Date.now()}`
  const userId = `prepared-artifact-user-${suffix}`
  const sessionId = `prepared-artifact-session-${suffix}`
  const turnId = `prepared-artifact-turn-${suffix}`
  const artifactId = `prepared-artifact-${suffix}`

  const createDocx = SERVER_TOOL_SPECS.find((spec) => spec?.function?.name === 'create_docx')
  let modelCalls = 0
  const forcedToolChoices = []
  const prepared = await prepareToolsLoopRuntime(createLoopContext({
    job: {
      id: turnId,
      userId,
      sessionId,
      origin: 'chat',
      prompt: 'Create and deliver the final Word document.',
      userPrompt: 'Create and deliver the final Word document.',
    },
    step: { id: turnId, kind: 'chat' },
    messages: [{ role: 'user', content: 'Create and deliver the final Word document.' }],
    toolSpecs: [createDocx],
    maxIters: 3,
    loadCheckpoint: async () => ({
      state: {
        messages: [{ role: 'user', content: 'Create and deliver the final Word document.' }],
        toolCalls: [],
        artifactIds: [artifactId],
        iterations: 0,
        completionGuards: {
          activeArtifactTools: ['create_docx'],
          requiredArtifactTools: ['create_docx'],
          artifactProvenance: [{
            artifactId,
            toolName: 'create_docx',
            verified: true,
            artifactType: 'docx',
          }],
          executionEvidenceObserved: true,
          mutationExecutionObserved: true,
        },
        final: {
          text: 'stale completion without deliverable selection',
          iterations: 1,
        },
      },
    }),
    runModel: async ({ toolChoice }) => {
      modelCalls += 1
      forcedToolChoices.push(toolChoice?.function?.name || null)
      return { content: 'completion attempted without selecting the recovered artifact', toolCalls: [] }
    },
  }))

  assert.deepEqual(consumePreparedToolsLoopTerminalOutcome(prepared), { terminal: false })
  const result = await executePreparedToolsLoop(prepared)
  assert.notEqual(result.text, 'stale completion without deliverable selection')
  assert.equal(result.incomplete, true)
  assert.equal(result.reason, 'deliverable_selection_missing')
  assert.ok(modelCalls > 0)
  assert.deepEqual(forcedToolChoices, Array(modelCalls).fill('set_deliverables'))
})
