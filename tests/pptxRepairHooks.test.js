import '../scripts/testEnvironment.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { closeDb, createUser, getDb } from '../server/db.js'
import { upsertSession } from '../server/services/sessionStore.js'
import { setApprovalMode } from '../server/services/approvalSettingsStore.js'
import { appendTurnEvent } from '../server/services/turnEventStore.js'
import { createTurnEvent } from '../shared/turnEvents.js'
import { buildPptxArtifactBuffer } from '../server/services/pptxArtifactFormat.js'
import { nativePptxPreflightResult } from '../server/services/pptxPreflightResult.js'
import { canonicalSideEffectArgsDigest } from '../server/services/sideEffectExecutionSerialization.js'
import { hookAuthorizationArgsDigest } from '../server/services/hookAuthorizationProvenance.js'
import { dispatchHooks, upsertHook } from '../server/services/hooksService.js'
import { requestApproval } from '../server/services/approvalGate.js'
import { createLoopContext } from '../server/services/loop/context.js'
import { createLoopEvents } from '../server/services/loop/events.js'
import { installToolHookBridge, TOOL_HOOK_RESULT } from '../server/services/loop/executeToolCalls.js'
import { runToolsLoopCore } from '../server/services/loop/runtime.js'
import { createSideEffectExecution } from '../server/services/loop/sideEffectExecution.js'
import { createSideEffectScope, getSideEffectExecutionLedger, sideEffectRecoveryBlock,
  SIDE_EFFECT_LEDGER_CONFLICT, SIDE_EFFECT_OUTCOME_UNKNOWN } from '../server/services/sideEffectExecutionLedger.js'
import { BUILTIN_ARTIFACT_TOOL_SPECS } from '../server/services/builtinArtifactToolSpecs.js'

const previousEnv = { HOOKS_SHELL_ENABLED: process.env.HOOKS_SHELL_ENABLED, HOOKS_SHELL_ALLOWED_COMMANDS: process.env.HOOKS_SHELL_ALLOWED_COMMANDS }
process.env.HOOKS_SHELL_ENABLED = '1'
process.env.HOOKS_SHELL_ALLOWED_COMMANDS = process.execPath
test.after(() => {
  closeDb()
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

let sequence = 0
async function fixture() {
  const suffix = ++sequence
  const userId = `pptx-hook-user-${suffix}`
  const sessionId = `pptx-hook-session-${suffix}`
  const turnId = `pptx-hook-turn-${suffix}`
  const sourceId = `pptx-hook-source-${suffix}`
  const callId = `pptx-hook-repair-${suffix}`
  const prompt = 'Create an editable PPT and preserve its text.'
  createUser({ id: userId, email: `${userId}@example.test` })
  upsertSession({ id: sessionId, userId, title: 'Isolated PPT repair hooks' })
  setApprovalMode({ userId, mode: 'bypass' })
  const job = { id: turnId, userId, sessionId, origin: 'chat', prompt, userPrompt: prompt }
  const step = { id: `pptx-hook-step-${suffix}`, kind: 'chat' }
  const original = { title: 'Hook-bound repair', slides: [{ elements: [
    { type: 'text', text: '123', font_size: 30, x: 0.1, y: 0.2, w: 0.15, h: 0.06 },
  ] }] }
  let failure
  await assert.rejects(() => buildPptxArtifactBuffer(original), (error) => {
    failure = nativePptxPreflightResult(error, original, sourceId)
    return failure?.pptx_preflight?.geometry_repairable === true
  })
  appendTurnEvent({ userId, event: createTurnEvent({
    id: `pptx-hook-start-${suffix}`, sessionId, turnId, sequence: 0, createdAt: Date.now(),
    type: 'turn.started', payload: { model: 'isolated-hook-fixture' },
  }) })
  const ledger = getSideEffectExecutionLedger()
  const source = createSideEffectExecution({
    ledger, isDurableSideEffect: () => true, toolName: 'create_pptx',
    call: { id: sourceId, idempotencyKey: `source-key-${sourceId}`, checkpointStatus: 'pending' }, job, step,
    approvalOrigin: 'chat', approvalSessionId: sessionId,
    createScope: createSideEffectScope, recoveryBlock: sideEffectRecoveryBlock,
    conflictCode: SIDE_EFFECT_LEDGER_CONFLICT, unknownCode: SIDE_EFFECT_OUTCOME_UNKNOWN,
  })
  const prepared = source.prepare(original)
  source.markExecuting(prepared.input)
  source.finish(prepared.input, failure, () => false)
  appendTurnEvent({ userId, event: createTurnEvent({
    id: `pptx-hook-failed-${suffix}`, sessionId, turnId, sequence: 1, createdAt: Date.now(),
    type: 'tool.completed', payload: { name: 'create_pptx', toolCallId: sourceId, args: original, result: failure },
  }) })
  const repair = { repair_from_tool_call_id: sourceId, base_digest: failure.pptx_preflight.base_digest,
    edits: [{ slide_index: 0, element_index: 0, set: { h: 0.2 } }] }
  const expanded = structuredClone(original)
  expanded.slides[0].elements[0].h = 0.2
  return { userId, sessionId, turnId, sourceId, callId, prompt, job, step, ledger, repair, expanded }
}

async function execute(f, { hookOutcome = { allow: true }, afterHook, approvalResult } = {}) {
  upsertHook({
    userId: f.userId, event: 'pre_tool_use', toolPattern: 'create_pptx', kind: 'shell',
    command: [process.execPath, '-e',
      `const payload=JSON.parse(process.argv[1]); process.stdout.write(JSON.stringify(Array.isArray(payload.args.slides) && !Object.hasOwn(payload.args,"repair_from_tool_call_id") ? ${JSON.stringify(hookOutcome)} : {allow:false,reason:"hook received unresolved repair"}))`],
    enabled: true, blocking: true, timeoutMs: 5000,
  })
  const events = createLoopEvents()
  const observed = []
  events.on('pre-tool', (call) => { observed.push(structuredClone(call.args)); return call })
  const dispose = installToolHookBridge({
    loopEvents: events, dispatchHooks, job: f.job, step: f.step,
    approvalOrigin: 'chat', approvalSessionId: f.sessionId,
  })
  if (afterHook) events.on('pre-tool', (call) => afterHook(call, f))
  const executions = []
  const approvals = []
  const gates = []
  const completed = []
  const started = []
  const checkpoints = []
  let modelCalls = 0
  const context = createLoopContext({
    job: f.job, step: f.step, messages: [{ role: 'user', content: f.prompt }],
    loopEvents: events, enableToolHooks: true, approvalOrigin: 'chat', approvalSessionId: f.sessionId,
    toolSpecs: [BUILTIN_ARTIFACT_TOOL_SPECS.create_pptx], fallbackToolSpecs: [],
    sideEffectLedger: f.ledger, maxIters: 2, semanticSummary: false,
    saveCheckpoint: async (checkpoint) => checkpoints.push(structuredClone(checkpoint)),
    onToolStarted: async (call) => started.push({ args: structuredClone(call.args), hook: call[TOOL_HOOK_RESULT] }),
    onToolCompleted: async (value) => completed.push(value),
    requestToolApproval: async (input) => {
      approvals.push(input)
      const gate = await (approvalResult ? approvalResult(input, f) : requestApproval(input))
      gates.push(gate)
      return gate
    },
    runModel: async () => ++modelCalls === 1 ? { content: '', toolCalls: [{
      id: f.callId, type: 'function', function: { name: 'create_pptx', arguments: JSON.stringify(f.repair) },
    }] } : { content: 'This test executor does not publish an artifact.', toolCalls: [] },
    executeTool: async ({ args }) => {
      executions.push(structuredClone(args))
      return { ok: true, inspectedCompleteInput: true }
    },
  })
  try { await runToolsLoopCore(context) } finally { dispose() }
  const row = getDb().prepare('SELECT args_digest, status FROM side_effect_executions WHERE owner_id = ? AND turn_id = ? AND tool_call_id = ? AND effect_kind = ?')
    .get(f.userId, f.turnId, f.callId, 'tool')
  return { executions, approvals, gates, completed, started, checkpoints, observed, ledger: row }
}

test('real no-op hook and observing pre-tool listener both see complete repair input before audit and execution', async () => {
  const f = await fixture()
  const run = await execute(f)
  assert.deepEqual(run.observed, [f.expanded])
  assert.deepEqual(run.started.map((call) => call.args), [f.expanded])
  assert.deepEqual(run.started[0].hook.replacementArgs, f.expanded)
  assert.deepEqual(run.executions, [f.expanded])
  assert.deepEqual(run.approvals.map((request) => request.args), [f.expanded])
  assert.equal(run.ledger.status, 'committed')
  assert.equal(run.ledger.args_digest, canonicalSideEffectArgsDigest(f.expanded))
  const savedCalls = run.checkpoints.flatMap((checkpoint) => checkpoint.toolCalls || [])
  assert.ok(savedCalls.length)
  const executingCalls = savedCalls.filter((call) => call.id === f.callId && call.checkpointStatus === 'executing')
  assert.ok(executingCalls.length, 'exercise the actual executing checkpoint, not only pending calls')
  for (const call of executingCalls) {
    assert.deepEqual(call.checkpointExecutionArgs, f.expanded)
    assert.deepEqual(JSON.parse(call.argumentsText), f.repair)
  }
})

test('real hook allow provenance is bound to expanded full args, never the model repair envelope', async () => {
  const f = await fixture()
  const run = await execute(f, { hookOutcome: { allow: true, permissionDecision: 'allow' } })
  assert.deepEqual(run.executions, [f.expanded])
  const provenance = run.approvals[0].hookAuthorizationProvenance
  assert.ok(provenance)
  assert.equal(provenance.argsDigest, hookAuthorizationArgsDigest(f.expanded))
  assert.notEqual(provenance.argsDigest, hookAuthorizationArgsDigest(f.repair))
  assert.equal(run.ledger.args_digest, canonicalSideEffectArgsDigest(f.expanded))
})

test('a valid hook geometry replacement is revalidated and its allow binds the actually executed full args', async () => {
  const f = await fixture()
  const changed = structuredClone(f.expanded)
  changed.slides[0].elements[0].h = 0.25
  const run = await execute(f, { hookOutcome: {
    allow: true, permissionDecision: 'allow', replacementArgs: { slides: changed.slides },
  } })
  assert.deepEqual(run.executions, [changed])
  assert.equal(run.approvals[0].hookAuthorizationProvenance.argsDigest, hookAuthorizationArgsDigest(changed))
  assert.equal(run.ledger.args_digest, canonicalSideEffectArgsDigest(changed))
})

test('a hook cannot reintroduce a mixed or short repair after host resolution', async () => {
  for (const kind of ['mixed', 'short']) {
    const f = await fixture()
    const run = await execute(f, kind === 'mixed'
      ? { hookOutcome: { allow: true, replacementArgs: f.repair } }
      : { afterHook: (call) => ({ ...call, args: structuredClone(f.repair) }) })
    assert.deepEqual(run.executions, [], kind)
    assert.deepEqual(run.approvals, [], kind)
    assert.equal(run.ledger, undefined, kind)
    assert.equal(run.completed[0].result.code, 'tool_arguments_validation_failed', kind)
    assert.match(run.completed[0].result.hint, /Repair envelopes are expanded before pre-tool hooks/, kind)
  }
})

test('a later waterfall mutation cannot be overwritten by stale hook args or inherit the old allow provenance', async () => {
  const f = await fixture()
  const changed = structuredClone(f.expanded)
  changed.slides[0].elements[0].h = 0.25
  const run = await execute(f, {
    hookOutcome: { allow: true, permissionDecision: 'allow' },
    afterHook: (call) => ({ ...call, args: changed }),
  })
  assert.deepEqual(run.approvals.map((request) => request.args), [changed])
  assert.deepEqual(run.executions, [])
  assert.equal(run.ledger, undefined)
  assert.equal(run.gates[0].code, 'hook_authorization_args_mismatch')
  assert.equal(run.completed[0].result.retryable, false)
  assert.equal(run.completed[0].result.systemFailure, true)
})

test('the final execution gate still rejects a raw repair reintroduced by approval after a valid hook', async () => {
  const f = await fixture()
  const run = await execute(f, { approvalResult: () => ({ proceed: true, args: f.repair }) })
  assert.deepEqual(run.executions, [])
  assert.equal(run.ledger, undefined)
  assert.equal(run.completed[0].result.code, 'tool_arguments_validation_failed')
  assert.match(run.completed[0].result.hint, /Repair envelopes are expanded before pre-tool hooks/)
})
