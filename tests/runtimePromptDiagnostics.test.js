import assert from 'node:assert/strict'
import test from 'node:test'
import * as fingerprints from '../server/services/promptPrefixFingerprint.js'
import { runToolLoop } from '../server/services/loop/index.js'
import { createTurnEvent } from '../shared/turnEvents.js'
import { summarizeTurnTrace } from '../server/services/localTurnTraceService.js'
import { formatProgressEvent } from '../bin/cli/runDiagnostics.js'
import { emitContextPreparation, requireContextDiagnosticDurability } from '../server/services/loop/runtimeContextDiagnostics.js'

const tool = { type: 'function', function: { name: 'echo_tool', description: 'PRIVATE_TOOL_DESCRIPTION',
  parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } } }
const messages = [{ role: 'system', content: 'PRIVATE_STABLE_INSTRUCTIONS', __gugoPromptStability: 'stable' },
  { role: 'user', content: 'PRIVATE_QUERY' }]

test('an optional context diagnostic observer cannot prevent an otherwise valid model request', async () => {
  let modelCalls = 0
  const result = await runToolLoop({ job: { id: 'context-observer-failure', userId: 'fixture-context-user', origin: 'chat' },
    step: { id: 'context-observer-step', kind: 'chat' }, messages: [{ role: 'user', content: 'Hello.' }],
    toolSpecs: [], enableToolHooks: false, maxIters: 1,
    onModelPhase: async ({ phase }) => {
      if (phase === 'context_prepared') throw new Error('PRIVATE_OBSERVER_FAILURE')
    },
    runModel: async () => { modelCalls += 1; return { content: 'Hello from the offline fixture.', toolCalls: [] } },
  })
  assert.equal(modelCalls, 1)
  assert.equal(result.text, 'Hello from the offline fixture.')
  assert.ok(!result.incomplete)
})

test('the real loop emits safe pre-compaction context observations and checkpoints their fingerprints', async () => {
  const phases = []
  const checkpoints = []
  let calls = 0
  await runToolLoop({ job: { id: 'context-diagnostics', userId: 'fixture-context-user', origin: 'chat',
    prompt: 'Use echo_tool, then answer.' }, step: { id: 'context-step', kind: 'chat' },
  messages: [{ role: 'system', content: 'Fixture stable instructions.', __gugoPromptStability: 'stable' },
    { role: 'user', content: 'Use echo_tool, then answer.' }], toolSpecs: [tool],
  maxIters: 3, enableToolHooks: false,
  requestToolApproval: async ({ args }) => ({ proceed: true, args, approvalId: 'fixture-approved' }),
  onModelPhase: async (event) => { phases.push(event) },
  saveCheckpoint: async (checkpoint) => checkpoints.push(checkpoint?.state || checkpoint),
  runModel: async () => ++calls === 1 ? { content: '', toolCalls: [{ id: 'context-call', type: 'function',
    function: { name: 'echo_tool', arguments: JSON.stringify({ text: 'value' }) } }] }
    : { content: 'Fixture completed.', toolCalls: [] },
  executeTool: async () => ({ ok: true, value: 'value' }),
  })
  const observations = phases.filter((event) => event.phase === 'context_prepared')
  assert.ok(observations.length >= 2)
  assert.equal(observations[0].contextDiagnostics.stage, 'pre_compaction')
  assert.equal(observations[0].contextDiagnostics.stablePrefixChanged, null)
  assert.equal(observations[1].contextDiagnostics.prefixComparable, false)
  assert.equal(observations[1].contextDiagnostics.stablePrefixChanged, null)
  assert.ok(checkpoints.some((checkpoint) => checkpoint.runtimePromptFingerprint?.version === 2
    && checkpoint.runtimePromptFingerprint?.comparisonScope === 'within_turn'))
  assert.ok(!JSON.stringify(observations).includes('PRIVATE_TOOL_DESCRIPTION'))
})

test('context fingerprints distinguish prefix, history and schema changes without exposing text', () => {
  const first = fingerprints.describeRuntimePrompt({ messages, tools: [tool] })
  const later = fingerprints.describeRuntimePrompt({ messages: [...messages, { role: 'assistant', content: 'private later text' }],
    tools: [tool], previous: first.snapshot })
  assert.equal(later.diagnostics.stablePrefixChanged, false)
  assert.equal(later.diagnostics.toolsChanged, false)
  assert.notEqual(later.snapshot.fullFingerprint, first.snapshot.fullFingerprint)
  const changed = fingerprints.describeRuntimePrompt({ messages: [{ ...messages[0], content: 'changed instructions' }, messages[1]],
    tools: [tool, { type: 'function', function: { name: 'another_tool', parameters: { type: 'object' } } }], previous: first.snapshot })
  assert.equal(changed.diagnostics.stablePrefixChanged, true)
  assert.equal(changed.diagnostics.toolsChanged, true)
  assert.ok(!JSON.stringify(first.diagnostics).includes('PRIVATE_'))
})

test('runtime prefix stops at volatile, unmarked, unknown and non-system boundaries', () => {
  for (const barrier of [
    { role: 'system', content: 'session' },
    { role: 'system', content: 'session', __gugoPromptStability: 'volatile' },
    { role: 'system', content: 'session', __gugoPromptStability: 'unknown' },
    { role: 'user', content: 'session', __gugoPromptStability: 'stable' },
  ]) {
    const first = fingerprints.describeRuntimePrompt({ messages: [messages[0], barrier, messages[0]] })
    const later = fingerprints.describeRuntimePrompt({ messages: [messages[0], { ...barrier, content: 'changed' },
      { ...messages[0], content: 'later stable changed' }], previous: first.snapshot })
    assert.equal(first.diagnostics.stableBlockCount, 1)
    assert.equal(later.diagnostics.stablePrefixChanged, false)
    assert.notEqual(later.diagnostics.contextFingerprint, first.diagnostics.contextFingerprint)
    const unknown = fingerprints.describeRuntimePrompt({ messages: [barrier, messages[0]] })
    assert.equal(unknown.diagnostics.stableBlockCount, 0)
    assert.equal(unknown.diagnostics.stablePrefixFingerprint, null)
  }
})

test('runtime snapshots reject the old all-system boundary and declare within-turn comparison scope', () => {
  const first = fingerprints.describeRuntimePrompt({ messages })
  assert.equal(first.snapshot.version, 2)
  assert.equal(first.snapshot.comparisonScope, 'within_turn')
  for (const previous of [{ ...first.snapshot, version: 1 },
    { ...first.snapshot, comparisonScope: 'cross_turn' }, null]) {
    const current = fingerprints.describeRuntimePrompt({ messages, previous })
    assert.equal(current.diagnostics.comparisonScope, 'within_turn')
    assert.equal(current.diagnostics.prefixComparable, false)
    assert.equal(current.diagnostics.stablePrefixChanged, null)
    assert.equal(current.diagnostics.toolsChanged, null)
  }
})

test('diagnostic computation and schema failures are isolated with data-free warnings', async () => {
  const logs = []
  let emitted = 0
  const state = { convo: messages, iter: 0, runtimePromptFingerprint: { old: true },
    onModelPhase: async () => { emitted += 1 } }
  const warn = (...entry) => logs.push(entry)
  await emitContextPreparation(state, [tool], { warn, describe: () => { throw new Error('PRIVATE_COMPUTATION') } })
  assert.equal(state.runtimePromptFingerprint, null)
  await emitContextPreparation(state, [tool], { warn, describe: () => ({ diagnostics: { prompt: 'PRIVATE_SCHEMA' } }) })
  assert.equal(emitted, 0)
  assert.equal(logs.length, 2)
  assert.ok(!logs.some((entry) => entry.map(String).join(' ').includes('PRIVATE_')))
})

test('durable context observers and cancellation retain their failure semantics', async () => {
  for (const code of ['TURN_EVENT_PERSISTENCE_FAILED', 'TURN_LEASE_LOST', 'CHECKPOINT_FLUSH_FAILED']) {
    const failure = Object.assign(new Error('durable failure'), { code })
    const state = { convo: messages, iter: 0,
      onModelPhase: requireContextDiagnosticDurability(async () => { throw failure }) }
    await assert.rejects(emitContextPreparation(state, [tool]), (error) => error === failure)
  }
  const cancelled = Object.assign(new Error('cancelled'), { name: 'AbortError' })
  await assert.rejects(emitContextPreparation({ convo: messages, iter: 0,
    onModelPhase: async () => { throw cancelled } }, [tool]), (error) => error === cancelled)
})

test('diagnostics survive the event contract and show prefix facts separately from measured cache usage', () => {
  const { diagnostics } = fingerprints.describeRuntimePrompt({ messages, tools: [tool] })
  const event = createTurnEvent({ id: 'ctx-e', userId: 'u', sessionId: 's', turnId: 't', sequence: 1,
    type: 'model.phase', payload: { phase: 'context_prepared', contextDiagnostics: diagnostics } })
  assert.match(formatProgressEvent(event), /context prepared.*within.turn/)
  assert.equal(event.payload.contextDiagnostics.comparisonScope, 'within_turn')
  assert.throws(() => createTurnEvent({ ...event, payload: { ...event.payload,
    contextDiagnostics: { ...diagnostics, prompt: 'must never be a diagnostic field' } } }))
  const noMeasurement = summarizeTurnTrace([event])
  assert.equal(noMeasurement.contextPreparations, 1)
  assert.equal(noMeasurement.cacheUsageReported, false)
  const measured = summarizeTurnTrace([event, { type: 'model.phase', payload: { phase: 'completed', usage: { cacheHitTokens: 0 } } }])
  assert.equal(measured.cacheUsageReported, true, 'reported zero is different from an absent measurement')
})
