import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { basename, resolve } from 'node:path'
import test from 'node:test'
import { buildPptxArtifactBuffer } from '../../server/services/pptxArtifactFormat.js'
import { validateGeneratedArtifactFile } from '../../server/services/generatedArtifactFormatValidation.js'
import { isSuccessfulTurnCompletedEvent } from '../../shared/turnEventProjection.js'
import { createCliArtifactHarness, diagnosticSummary } from './helpers/artifactCompletionHarness.js'

const PROMPT = '这个ppt太丑了，重新做一个，要前沿未来科技风'

async function fixtureBytes() {
  const { buffer } = await buildPptxArtifactBuffer({
    title: 'CLI artifact completion fixture',
    generatedAt: '2026-09-01T00:00:00.000Z',
    slides: [
      { layout: 'cover', title: 'Future technology', subtitle: 'Real CLI, real files, automatic verification' },
      { layout: 'bullets', title: 'Evidence', bullets: ['Local provider only', 'No model-issued readback'] },
    ],
  })
  return buffer
}

function completedTools(events) {
  return events.filter((event) => event.type === 'tool.completed')
}

function matchesTarget(path, target, workspace) {
  const actual = resolve(workspace, path || '')
  return process.platform === 'win32' ? actual.toLowerCase() === target.toLowerCase() : actual === target
}

function readsTarget(event, target, workspace) {
  return event.payload?.name === 'read_file' && matchesTarget(event.payload.args?.path, target, workspace)
}

test('real CLI bypass auto-verifies a PPT production turn without user resume or model readback', { timeout: 60_000 }, async (t) => {
  const bytes = await fixtureBytes()
  const harness = await createCliArtifactHarness(t, bytes)
  const run = await harness.run(PROMPT)
  const diagnosis = diagnosticSummary(run)
  assert.equal(run.timedOut, false, diagnosis)
  assert.equal(run.status, 0, diagnosis)
  assert.deepEqual(harness.provider.failures, [], diagnosis)
  assert.deepEqual(harness.provider.emittedTools, ['write_file', 'run_command', 'set_deliverables'])
  assert.ok(harness.provider.requests.some((body) => body.tools?.some((tool) => tool.function?.name === 'create_pptx')),
    'the real user remake prompt must authorize PPT tools through the real CLI')
  const toolEvents = completedTools(run.events)
  const generated = toolEvents.find((event) => event.payload.name === 'run_command')
  assert.equal(generated?.payload.result.ok, true, diagnosis)
  assert.equal(generated?.payload.result.exitCode, 0, diagnosis)
  assert.ok(generated?.payload.result.verifiedOutputs?.some((output) => output.type === 'file'), diagnosis)
  const hostReadback = toolEvents.find((event) => readsTarget(event, harness.paths.script, harness.paths.workspace)
    && /host_verify_/.test(event.payload.toolCallId))
  assert.equal(hostReadback?.payload.result.ok, true, diagnosis)
  assert.ok(hostReadback.sequence > generated.sequence, diagnosis)
  const completed = run.events.find(isSuccessfulTurnCompletedEvent)
  assert.ok(completed, diagnosis)
  assert.ok(completed.sequence > hostReadback.sequence, diagnosis)
  assert.equal(run.events.some((event) => event.type === 'turn.resumed' || event.type === 'approval.required'), false, diagnosis)
  assert.deepEqual(harness.readPpt(), bytes)
  const validation = await validateGeneratedArtifactFile({ filePath: harness.paths.ppt, artifactType: 'pptx' })
  assert.equal(validation.ok, true)
  assert.equal(validation.format, 'pptx')
  assert.equal(validation.byteLength, bytes.length)
  const receipt = generated.payload.result.artifactValidation?.receipts?.find((entry) => entry.format === 'pptx')
  assert.equal(receipt?.sha256, createHash('sha256').update(bytes).digest('hex'), diagnosis)
  const durable = harness.persistedEvents()
  assert.ok(durable.some(isSuccessfulTurnCompletedEvent), 'completion must be committed to the temporary SQLite DB')
  assert.ok(completedTools(durable).some((event) => readsTarget(event, harness.paths.script, harness.paths.workspace)
    && /host_verify_/.test(event.payload.toolCallId)), 'host readback must be durably auditable')
  t.diagnostic(`real tools: ${toolEvents.map((event) => `${event.payload.name}${/host_verify_/.test(event.payload.toolCallId) ? '[host]' : ''}`).join(' -> ')}; exit=${run.status}; no --resume`)
})

test('real CLI refuses a corrupt PPT even when its shell exits zero and the model claims completion', { timeout: 60_000 }, async (t) => {
  const validBytes = await fixtureBytes()
  const corruptBytes = validBytes.subarray(0, validBytes.length - 32)
  const harness = await createCliArtifactHarness(t, corruptBytes)
  const run = await harness.run(PROMPT)
  const diagnosis = diagnosticSummary(run)
  assert.equal(run.timedOut, false, diagnosis)
  assert.equal(run.status, 1, diagnosis)
  assert.deepEqual(harness.provider.failures, [], diagnosis)
  assert.deepEqual(harness.provider.emittedTools, ['write_file', 'run_command'])
  const tools = completedTools(run.events)
  const generated = tools.find((event) => event.payload.name === 'run_command')
  assert.equal(generated?.payload.result.ok, true, diagnosis)
  assert.equal(generated?.payload.result.exitCode, 0, diagnosis)
  assert.equal(generated?.payload.result.artifactPublication?.ok, false, diagnosis)
  assert.equal(generated?.payload.result.artifactPublication?.code, 'artifact_validation_failed', diagnosis)
  assert.deepEqual(generated.payload.args.expected_outputs, [harness.paths.ppt])
  assert.ok(generated.payload.result.verifiedOutputs?.some((output) => output.type === 'file'
    && matchesTarget(output.path || output.declaredPath, harness.paths.ppt, harness.paths.workspace)), diagnosis)
  assert.ok(generated.payload.result.artifactPublication.failures.some((failure) => (
    failure.candidateIndex === 0 && failure.filename === basename(harness.paths.ppt)
      && failure.phase === 'validation' && failure.causeCode === 'ARTIFACT_FORMAT_ZIP_INVALID'
  )), 'the real format rejection must bind to the declared PPT output')
  assert.notEqual(generated.payload.result.artifactValidation?.ok, true, diagnosis)
  assert.equal(run.events.some(isSuccessfulTurnCompletedEvent), false, diagnosis)
  assert.equal(harness.persistedEvents().some(isSuccessfulTurnCompletedEvent), false, diagnosis)
  assert.deepEqual(harness.readPpt(), corruptBytes, 'rejected user-workspace bytes remain available for repair')
  await assert.rejects(
    validateGeneratedArtifactFile({ filePath: harness.paths.ppt, artifactType: 'pptx' }),
    (error) => /^ARTIFACT_FORMAT_/.test(error?.code),
  )
  const hostChecks = tools.filter((event) => readsTarget(event, harness.paths.ppt, harness.paths.workspace)
    && /host_verify_/.test(event.payload.toolCallId))
  // Publication already performed real target-bound binary validation. A
  // pending repair need not reread the same known-corrupt bytes merely to fail again.
  assert.ok(hostChecks.every((event) => event.payload.result?.formatValidated !== true), diagnosis)
  assert.equal(run.events.some((event) => event.type === 'turn.resumed'), false, diagnosis)
  t.diagnostic(`real tools: ${tools.map((event) => `${event.payload.name}${/host_verify_/.test(event.payload.toolCallId) ? '[host]' : ''}`).join(' -> ')}; corrupt PPT refused; exit=${run.status}`)
})

test('real CLI repairs a rejected PPT in the same turn and auto-verifies the fresh output without resume', { timeout: 60_000 }, async (t) => {
  const validBytes = await fixtureBytes()
  const corruptBytes = validBytes.subarray(0, validBytes.length - 32)
  const harness = await createCliArtifactHarness(t, corruptBytes, { repairBytes: validBytes })
  const run = await harness.run(PROMPT)
  const diagnosis = diagnosticSummary(run)
  assert.equal(run.timedOut, false, diagnosis)
  assert.equal(run.status, 0, diagnosis)
  assert.deepEqual(harness.provider.failures, [], diagnosis)
  assert.deepEqual(harness.provider.emittedTools, [
    'write_file', 'run_command', 'write_file', 'run_command', 'set_deliverables',
  ], 'the provider must repair with fresh producing calls, never issue a readback or resume')
  const tools = completedTools(run.events)
  const generations = tools.filter((event) => event.payload.name === 'run_command')
  const scriptWrites = tools.filter((event) => event.payload.name === 'write_file')
  assert.equal(generations.length, 2, diagnosis)
  assert.equal(scriptWrites.length, 2, diagnosis)
  const [rejected, repaired] = generations
  for (const event of [...scriptWrites, ...generations]) assert.equal(event.payload.result.ok, true, diagnosis)
  assert.equal(rejected.payload.result.exitCode, 0, diagnosis)
  assert.equal(rejected.payload.result.artifactPublication?.ok, false, diagnosis)
  assert.equal(rejected.payload.result.artifactPublication?.code, 'artifact_validation_failed', diagnosis)
  assert.ok(rejected.payload.result.artifactPublication.failures.some((failure) => failure.causeCode === 'ARTIFACT_FORMAT_ZIP_INVALID'), diagnosis)
  assert.equal(rejected.payload.result.artifactValidation?.receipts?.some((receipt) => receipt.verified === true) || false, false)
  assert.equal(harness.provider.observedValidationFailures.length, 1, diagnosis)
  assert.equal(harness.provider.observedValidationFailures[0].toolCallId, rejected.payload.toolCallId)
  assert.equal(harness.provider.observedValidationFailures[0].code, 'ARTIFACT_FORMAT_ZIP_INVALID')
  assert.ok(scriptWrites[1].sequence > rejected.sequence, 'validation rejection must precede the fresh repair mutation')
  assert.ok(repaired.sequence > scriptWrites[1].sequence)
  assert.notEqual(scriptWrites[0].payload.toolCallId, scriptWrites[1].payload.toolCallId)
  assert.notEqual(rejected.payload.toolCallId, repaired.payload.toolCallId, 'repair cannot replay the rejected producing call')
  assert.equal(repaired.payload.result.exitCode, 0, diagnosis)
  assert.equal(repaired.payload.result.artifactValidation?.ok, true, diagnosis)
  const receipt = repaired.payload.result.artifactValidation?.receipts?.find((entry) => entry.format === 'pptx')
  assert.equal(receipt?.verified, true, diagnosis)
  assert.equal(receipt.toolCallId, repaired.payload.toolCallId)
  assert.equal(receipt.sourcePath, harness.paths.ppt)
  assert.equal(receipt.sha256, createHash('sha256').update(validBytes).digest('hex'))
  const successes = run.events.filter(isSuccessfulTurnCompletedEvent)
  assert.equal(successes.length, 1, diagnosis)
  const completed = successes[0]
  assert.equal(receipt.turnId, completed.turnId)
  assert.equal(receipt.sessionId, completed.sessionId)
  assert.ok(completed.payload.deliveryArtifactIds?.includes(receipt.artifactId), diagnosis)
  const finalReadback = tools.find((event) => event.sequence > repaired.sequence
    && readsTarget(event, harness.paths.script, harness.paths.workspace) && /host_verify_/.test(event.payload.toolCallId))
  assert.equal(finalReadback?.payload.result.ok, true, diagnosis)
  assert.ok(completed.sequence > finalReadback.sequence, diagnosis)
  assert.equal(run.events.some((event) => ['turn.failed', 'turn.blocked', 'turn.resumed', 'approval.required'].includes(event.type)), false, diagnosis)
  assert.deepEqual(harness.readPpt(), validBytes)
  const validation = await validateGeneratedArtifactFile({ filePath: harness.paths.ppt, artifactType: 'pptx' })
  assert.equal(validation.ok, true)
  assert.equal(validation.byteLength, validBytes.length)
  const durable = harness.persistedEvents()
  assert.ok(durable.every((event) => event.turnId === completed.turnId && event.sessionId === completed.sessionId))
  assert.ok(completedTools(durable).some((event) => event.payload.toolCallId === rejected.payload.toolCallId
    && event.payload.result.artifactPublication?.code === 'artifact_validation_failed'))
  assert.ok(completedTools(durable).some((event) => event.payload.toolCallId === repaired.payload.toolCallId
    && event.payload.result.artifactValidation?.receipts?.some((entry) => entry.sha256 === receipt.sha256)))
  assert.equal(durable.filter(isSuccessfulTurnCompletedEvent).length, 1, 'the repaired completion must be durable')
  t.diagnostic(`real tools: ${tools.map((event) => `${event.payload.name}${/host_verify_/.test(event.payload.toolCallId) ? '[host]' : ''}`).join(' -> ')}; format rejection -> fresh repair -> verified completion; no --resume`)
})

test('real CLI expires the exact execution lease after a verified PPT and exits without a forged terminal', { timeout: 60_000 }, async (t) => {
  const bytes = await fixtureBytes()
  const harness = await createCliArtifactHarness(t, bytes, { expireLeaseAfterArtifactReceipt: true })
  const run = await harness.run(PROMPT)
  const diagnosis = diagnosticSummary(run)
  assert.equal(run.timedOut, false, diagnosis)
  assert.equal(run.status, 1, diagnosis)
  assert.deepEqual(harness.provider.failures, [], diagnosis)
  assert.deepEqual(harness.provider.emittedTools, ['write_file', 'run_command'], 'loss must not cause a producing tool to repeat')
  assert.equal(harness.provider.observedLeaseExpirations.length, 1, diagnosis)
  const fault = harness.provider.observedLeaseExpirations[0]
  assert.equal(fault.updatedLeaseCount, 1)
  assert.ok(fault.originalExpiresAt > fault.expiredAt)
  const faultToExitMs = run.closedAtMonotonic - fault.injectedAtMonotonic
  assert.ok(faultToExitMs >= 0 && faultToExitMs < 15_000, `CLI must exit promptly after deterministic lease loss: ${faultToExitMs}ms\n${diagnosis}`)
  const errors = run.events.filter((event) => event.type === 'cli.error')
  assert.ok(errors.length > 0, diagnosis)
  const acceptedErrors = new Set([
    'TURN_TERMINAL_EVENT_MISSING', 'TURN_EXECUTION_LEASE_STALE', 'TURN_LEASE_LOST',
    'CHECKPOINT_FLUSH_FAILED', 'TURN_EVENT_PERSISTENCE_FAILED',
    'TURN_TERMINAL_PERSISTENCE_FAILED', 'TURN_CHECKPOINT_PERSISTENCE_FAILED',
  ])
  assert.ok(errors.some((event) => acceptedErrors.has(event.error?.code)), diagnosis)
  const durable = harness.persistedEvents()
  assert.ok(durable.every((event) => event.turnId === fault.turnId && event.sessionId === fault.sessionId))
  const terminalTypes = new Set(['turn.completed', 'turn.failed', 'turn.blocked', 'turn.cancelled', 'turn.interrupted', 'turn.paused'])
  assert.equal(durable.some((event) => terminalTypes.has(event.type)), false, 'an expired owner cannot commit a counterfeit terminal event')
  assert.equal(run.events.some(isSuccessfulTurnCompletedEvent), false, diagnosis)
  assert.equal(run.events.some((event) => event.type === 'turn.resumed'), false, diagnosis)
  const durableTools = completedTools(durable)
  assert.deepEqual(durableTools.map((event) => event.payload.name), ['write_file', 'run_command'])
  const produced = durableTools.find((event) => event.payload.name === 'run_command')
  assert.equal(produced.sequence, fault.afterEventSequence, 'the lease fault must follow the actual committed producing outcome')
  assert.equal(produced.payload.toolCallId, fault.toolCallId)
  assert.equal(produced.payload.result.exitCode, 0)
  assert.equal(produced.payload.result.ok, true)
  const receipt = produced.payload.result.artifactValidation?.receipts?.find((entry) => entry.artifactId === fault.artifactId)
  assert.equal(receipt?.verified, true)
  assert.equal(receipt.userId, fault.userId)
  assert.equal(receipt.turnId, fault.turnId)
  assert.equal(receipt.sessionId, fault.sessionId)
  assert.equal(receipt.sha256, createHash('sha256').update(bytes).digest('hex'))
  assert.deepEqual(harness.readPpt(), bytes, 'lease loss must preserve the already produced local PPT')
  const validation = await validateGeneratedArtifactFile({ filePath: harness.paths.ppt, artifactType: 'pptx' })
  assert.equal(validation.ok, true)
  assert.equal(validation.byteLength, bytes.length)
  t.diagnostic(`verified PPT retained; exact lease expired after sequence ${fault.afterEventSequence}; exit=1 after ${Math.round(faultToExitMs)}ms; CLI error=${errors[0].error.code}; no durable terminal or replay`)
})
