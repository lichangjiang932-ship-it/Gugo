import '../scripts/testEnvironment.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import JSZip from 'jszip'
import { buildPptxArtifactBuffer } from '../server/services/pptxArtifactFormat.js'
import { nativePptxPreflightResult } from '../server/services/pptxPreflightResult.js'
import { PPTX_PREFLIGHT_KIND } from '../server/services/pptxPreflightDiagnostics.js'
import { resolvePptxRepairArguments, resolvePptxRepairToolCall } from '../server/services/pptxRepairArguments.js'
import { canonicalSideEffectArgsDigest } from '../server/services/sideEffectExecutionSerialization.js'
import { createArtifactReplacementGuard } from '../server/services/loop/guards.js'
import { BUILTIN_ARTIFACT_TOOL_SPECS, PPTX_FULL_AUTHORING_PARAMETERS } from '../server/services/builtinArtifactToolSpecs.js'
import { validateToolCall } from '../server/utils/toolCallArguments.js'
import { closeDb } from '../server/db.js'
import { createSideEffectExecution } from '../server/services/loop/sideEffectExecution.js'
import { createSideEffectScope, getSideEffectExecutionLedger, sideEffectRecoveryBlock,
  SIDE_EFFECT_LEDGER_CONFLICT, SIDE_EFFECT_OUTCOME_UNKNOWN } from '../server/services/sideEffectExecutionLedger.js'

test.after(() => closeDb())

const scope = { userId: 'repair-owner', sessionId: 'repair-session', turnId: 'repair-turn' }
const sourceId = 'known-failed-pptx-call'
function authoringInput() {
  return {
    title: 'Minimal geometry repair',
    design: { aspect_ratio: '16:9', background: 'F8F9FA', foreground: '1B2A4A', body_font: 'Microsoft YaHei' },
    slides: [{ title: 'Unchanged metadata', notes: 'Preserve these speaker notes.', elements: [
      { type: 'text', text: '123', font_size: 30, font_face: 'Segoe UI', x: 0.1, y: 0.6, w: 0.15, h: 0.06, color: '112233' },
      { type: 'text', text: 'Canvas Demo', font_size: 48, font_face: 'Microsoft YaHei', x: 0.11, y: 0.3, w: 0.5, h: 0.1 },
      { type: 'shape', shape: 'rect', x: 0.08, y: 0.3, w: 0.006, h: 0.22, fill: '7B6B9E' },
    ] }],
  }
}

function sourceRecord(args = authoringInput()) {
  const digest = canonicalSideEffectArgsDigest(args)
  const outcome = {
    ok: false, code: 'PPTX_CONTENT_OVERFLOW', error: 'Native preflight rejected the frame.', retryable: true,
    pptx_preflight: { kind: PPTX_PREFLIGHT_KIND, no_output: true, source_complete: true, geometry_repairable: true, base_digest: digest },
  }
  return {
    scope: { ...scope },
    events: [{ name: 'create_pptx', toolCallId: sourceId, args: structuredClone(args), result: structuredClone(outcome) }],
    ledger: { owner_id: scope.userId, session_id: scope.sessionId, turn_id: scope.turnId,
      tool_name: 'create_pptx', tool_call_id: sourceId, status: 'failed', args_digest: digest, outcome },
  }
}

function repairRequest(record = sourceRecord()) {
  return { repair_from_tool_call_id: sourceId, base_digest: record.ledger.args_digest, edits: [
    { slide_index: 0, element_index: 0, set: { h: 0.072223 } },
    { slide_index: 0, element_index: 1, set: { h: 0.115556 } },
  ] }
}

function resolve(request, record) {
  return resolvePptxRepairArguments(request, scope, { readSource: (actualScope, actualId) => {
    assert.deepEqual(actualScope, scope)
    assert.equal(actualId, sourceId)
    return record
  } })
}

test('one native preflight returns all affected elements with exact numeric fit thresholds without lowering fonts', async () => {
  const args = authoringInput()
  const original = structuredClone(args)
  let failure
  await assert.rejects(() => buildPptxArtifactBuffer(args), (error) => {
    failure = nativePptxPreflightResult(error, args, sourceId)
    return error.code === 'PPTX_CONTENT_OVERFLOW'
  })
  assert.equal(failure.pptx_preflight.kind, PPTX_PREFLIGHT_KIND)
  assert.equal(failure.pptx_preflight.no_output, true)
  assert.equal(failure.pptx_preflight.geometry_repairable, true)
  assert.equal(failure.pptx_preflight.issue_count, 2)
  assert.deepEqual(failure.pptx_preflight.issues.map((issue) => issue.element_index), [0, 1])
  assert.deepEqual(failure.pptx_preflight.issues.map((issue) => issue.minimum_h), [0.072223, 0.115556])
  assert.deepEqual(failure.pptx_preflight.issues.map((issue) => issue.text_fit.font_size), [30, 48])
  assert.equal(failure.pptx_preflight.base_digest, canonicalSideEffectArgsDigest(args))
  assert.deepEqual(args, original)
  assert.equal(nativePptxPreflightResult(Object.assign(new Error('Unproven encoder failure'), { code: 'PPTX_CONTENT_OVERFLOW' }), args, sourceId), null)
})

test('the new schema accepts full authoring or a small geometry repair, never a mixed payload', () => {
  const spec = BUILTIN_ARTIFACT_TOOL_SPECS.create_pptx
  const request = repairRequest()
  assert.equal(validateToolCall({ name: 'create_pptx', args: authoringInput() }, [spec]), null)
  assert.equal(validateToolCall({ name: 'create_pptx', args: request }, [spec]), null)
  assert.equal(validateToolCall({ name: 'create_pptx', args: { ...authoringInput(), ...request } }, [spec])?.code, 'tool_arguments_validation_failed')
  assert.equal(validateToolCall({ name: 'create_pptx', args: request }, [{ function: { name: 'create_pptx', parameters: PPTX_FULL_AUTHORING_PARAMETERS } }])?.code, 'tool_arguments_validation_failed')
})

test('geometry resolution preserves every source word, font, image, style, note and output target by deep copy', async () => {
  const args = authoringInput()
  args.output_directory = 'D:\\authorized-output'
  args.replace_artifact_id = 'original-owned-artifact'
  args.images = [{ path: 'attachment://authorized-image', alt: 'Keep this image meaning.' }]
  const record = sourceRecord(args)
  const original = structuredClone(record)
  const request = repairRequest(record)
  const originalRequest = structuredClone(request)
  const resolved = resolve(request, record)
  const expected = structuredClone(args)
  expected.slides[0].elements[0].h = 0.072223
  expected.slides[0].elements[1].h = 0.115556
  assert.deepEqual(resolved, expected)
  assert.deepEqual(record, original)
  assert.deepEqual(request, originalRequest)
  const guard = createArtifactReplacementGuard({ revisionMode: 'create_copy', priorArtifacts: [{ id: args.replace_artifact_id, type: 'pptx' }] })
  assert.equal(guard.validate('create_pptx', resolved)?.code, 'artifact_replacement_not_authorized', 'normal target guards must see the inherited replacement target')
  const renderable = { ...resolved }
  delete renderable.images
  const { buffer } = await buildPptxArtifactBuffer(renderable)
  const zip = await JSZip.loadAsync(buffer)
  const xml = await zip.file('ppt/slides/slide1.xml').async('string')
  assert.ok(xml.includes('<a:t>123</a:t>'))
  assert.ok(xml.includes('<a:t>Canvas Demo</a:t>'))
  assert.ok(xml.includes('sz="3000"'))
  assert.ok(xml.includes('sz="4800"'))
})

for (const [label, mutate] of [
  ['cross-user scope', (record) => { record.scope.userId = 'another-user' }],
  ['cross-session ledger', (record) => { record.ledger.session_id = 'another-session' }],
  ['cross-turn ledger', (record) => { record.ledger.turn_id = 'another-turn' }],
  ['different generator', (record) => { record.events[0].name = 'create_docx' }],
  ['ordinary failed encoder without native proof', (record) => { delete record.ledger.outcome.pptx_preflight }],
  ['non-preflight error code', (record) => { record.events[0].result.code = 'PPTX_ENCODER_INVALID' }],
  ['compacted pointer arguments', (record) => { record.events[0].args = { __artifactReference: true, artifactId: 'pointer' } }],
  ['truncated host source', (record) => { record.events[0].modelOutputTruncated = true }],
  ['truncated result', (record) => { record.events[0].result._truncated = true }],
  ['changed base words', (record) => { record.events[0].args.slides[0].elements[0].text = 'changed' }],
  ['existing output', (record) => { record.events[0].result.artifactId = 'already-written' }],
  ['committed source', (record) => { record.ledger.status = 'committed' }],
  ['prepared source', (record) => { record.ledger.status = 'prepared' }],
]) {
  test(`repair refuses ${label}`, () => {
    const record = sourceRecord()
    const request = repairRequest(record)
    mutate(record)
    assert.throws(() => resolve(request, record), (error) => /^PPTX_REPAIR_/u.test(error.code))
  })
}

for (const status of ['unknown', 'executing']) {
  test(`a ${status} source remains unsafe to replay rather than becoming a repairable failure`, () => {
    const record = sourceRecord()
    record.ledger.status = status
    assert.throws(() => resolve(repairRequest(record), record), (error) => error.code === 'SIDE_EFFECT_OUTCOME_UNKNOWN' && error.unsafeToReplay === true)
  })
}

test('repair rejects missing or stale digests, text/font edits, arbitrary pointers and self-claimed scope before source access', () => {
  for (const mutate of [
    (request) => { delete request.base_digest },
    (request) => { request.base_digest = 'not-a-digest' },
    (request) => { request.edits[0].set.font_size = 12 },
    (request) => { request.edits[0].set.text = 'removed original content' },
    (request) => { request.edits[0].path = '/slides/0/elements/0/text' },
    (request) => { request.userId = 'claimed-owner' },
    (request) => { request.slides = [] },
    (request) => { request.edits[0].set = {} },
  ]) {
    const request = repairRequest()
    mutate(request)
    assert.throws(() => resolvePptxRepairArguments(request, scope, { readSource: () => assert.fail('invalid patch must not read a source') }), /./u)
  }
  const stale = repairRequest()
  stale.base_digest = '0'.repeat(64)
  assert.throws(() => resolve(stale, sourceRecord()), /complete, same-turn/u)
})

test('repairs reject missing targets, duplicate edits, no-op values and retain full validation after merging', () => {
  const record = sourceRecord()
  for (const mutate of [
    (request) => { request.edits[0].element_index = 30 },
    (request) => { request.edits.push(structuredClone(request.edits[0])) },
    (request) => { request.edits = [{ slide_index: 0, element_index: 0, set: { h: 0.06 } }] },
  ]) {
    const request = repairRequest(record)
    mutate(request)
    assert.throws(() => resolve(request, record), (error) => /^PPTX_REPAIR_/u.test(error.code))
  }
  const stillInvalid = repairRequest(record)
  stillInvalid.edits[0].set = { h: 0.001 }
  const merged = resolve(stillInvalid, record)
  return assert.rejects(() => buildPptxArtifactBuffer(merged), (error) => error.code === 'PPTX_CONTENT_OVERFLOW')
})

test('resolved call checkpoints retain complete execution args and the short original protocol input', () => {
  const record = sourceRecord()
  const request = repairRequest(record)
  const call = { id: 'fresh-repair', name: 'create_pptx', args: request, argumentsText: JSON.stringify(request), checkpointStatus: 'pending' }
  const original = structuredClone(call)
  const resolved = resolvePptxRepairToolCall(call, scope, { readSource: () => record })
  assert.deepEqual(call, original)
  assert.equal(resolved.argumentsText, call.argumentsText)
  assert.ok(resolved.args.slides)
  const saved = structuredClone({ ...resolved, checkpointStatus: 'executing', checkpointExecutionArgs: resolved.args })
  assert.strictEqual(resolvePptxRepairToolCall(saved, scope, { readSource: () => assert.fail('resolved checkpoint must not reopen its source') }), saved)
  assert.throws(() => resolvePptxRepairToolCall({ ...call, checkpointStatus: 'executing' }, scope, { readSource: () => assert.fail('unknown raw repair must not reopen its source') }), (error) => error.unsafeToReplay === true)
  assert.throws(() => resolvePptxRepairToolCall({ ...call, id: sourceId }, scope, { readSource: () => record }), /fresh tool-call identity/u)
})

test('resolved repair arguments keep durable replay, conflicting reuse and unknown-resume protection', () => {
  const record = sourceRecord()
  const full = resolve(repairRequest(record), record)
  const ledger = getSideEffectExecutionLedger()
  const call = { id: 'local-repair-replay', idempotencyKey: 'local-repair-replay-key', checkpointStatus: 'pending' }
  const boundary = (current) => createSideEffectExecution({
    ledger, isDurableSideEffect: () => true, toolName: 'create_pptx', call: current,
    job: { id: scope.turnId, userId: scope.userId, sessionId: scope.sessionId, origin: 'chat' },
    step: { id: 'repair-step' }, approvalOrigin: 'chat', approvalSessionId: scope.sessionId,
    createScope: createSideEffectScope, recoveryBlock: sideEffectRecoveryBlock,
    conflictCode: SIDE_EFFECT_LEDGER_CONFLICT, unknownCode: SIDE_EFFECT_OUTCOME_UNKNOWN,
  })
  const first = boundary(call)
  const prepared = first.prepare(full)
  assert.equal(prepared.replayed, false)
  first.markExecuting(prepared.input)
  const receipt = { ok: true, artifactId: 'already-verified-repair-artifact' }
  first.finish(prepared.input, receipt, (value) => value.ok === true)
  const replay = boundary(call).prepare(structuredClone(full))
  assert.equal(replay.replayed, true, 'the same resolved repair cannot execute its writer twice')
  assert.equal(replay.result.artifactId, receipt.artifactId)
  const changed = structuredClone(full)
  changed.slides[0].elements[0].h = 0.2
  assert.throws(() => boundary(call).prepare(changed), (error) => error.code === SIDE_EFFECT_LEDGER_CONFLICT)

  const uncertain = { id: 'local-repair-unknown', idempotencyKey: 'local-repair-unknown-key', checkpointStatus: 'pending' }
  const pending = boundary(uncertain)
  const input = pending.prepare(full).input
  pending.markExecuting(input)
  const restored = { ...uncertain, checkpointStatus: 'executing', checkpointExecutionArgs: structuredClone(full) }
  assert.throws(() => boundary(restored).recover(restored.checkpointExecutionArgs), (error) => error.code === SIDE_EFFECT_OUTCOME_UNKNOWN && error.unsafeToReplay === true)
  assert.equal(ledger.read(input).status, 'unknown')
})
