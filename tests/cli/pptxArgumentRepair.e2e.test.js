import assert from 'node:assert/strict'
import { basename, dirname, resolve } from 'node:path'
import test from 'node:test'
import JSZip from 'jszip'
import { validateGeneratedArtifactFile } from '../../server/services/generatedArtifactFormatValidation.js'
import { isSuccessfulTurnCompletedEvent } from '../../shared/turnEventProjection.js'
import { createCliArtifactHarness, diagnosticSummary } from './helpers/artifactCompletionHarness.js'

const PROMPT = 'Create a downloadable PPT with the supplied example slide text. Preserve every supplied sentence.'

function completedTools(events) {
  return events.filter((event) => event.type === 'tool.completed')
}

function assertPreservedArguments(generations) {
  const [first, second, third] = generations.map((event) => event.payload.args)
  assert.equal(first.slides.length, 9)
  for (const index of [7, 8]) {
    assert.equal(first.slides[index].layout, undefined)
    assert.equal(first.slides[index].bullets, undefined)
    assert.equal(first.slides[index].body, undefined)
    assert.ok(first.slides[index].elements[0].text)
  }
  const corrected = structuredClone(first)
  Object.assign(corrected.slides[7].elements[0], { x: 0.08, w: 0.84 })
  assert.deepEqual(second, corrected, 'the first model repair must preserve every unrelated field')
  Object.assign(corrected.slides[8].elements[0], { w: 0.84, h: 0.3 })
  assert.deepEqual(third, corrected, 'the second model repair must preserve every original element and word')
  return first
}

for (const presentationPreToolHook of [false, true]) {
test(`real CLI repairs free-canvas PPT geometry and text fit in one durable turn without settings confirmation or resume (hook=${presentationPreToolHook})`, { timeout: 60_000 }, async (t) => {
  const harness = await createCliArtifactHarness(t, null, { presentationArgumentRepair: true, presentationPreToolHook })
  const run = await harness.run(PROMPT)
  const diagnosis = diagnosticSummary(run)
  assert.equal(run.timedOut, false, diagnosis)
  assert.equal(run.status, 0, diagnosis)
  assert.deepEqual(harness.provider.failures, [], diagnosis)
  assert.equal(run.argv.includes('--resume'), false)
  assert.equal(run.argv[run.argv.indexOf('--mode') + 1], 'bypass')
  assert.deepEqual(run.emittedTools, ['create_pptx', 'create_pptx', 'create_pptx', 'set_deliverables'])
  assert.equal(run.execution.scriptExists, false, 'argument repair must use the real PPT tool, not a producer script')
  assert.equal(run.argumentRepairRequestIndices.length, 5, diagnosis)
  assert.ok(run.compactionRequestIndices.length >= 2, 'real compaction must perform evidence extraction and final summarization')
  assert.ok(run.compactionRequests.some((request) => request.stage === 'map'), diagnosis)
  assert.ok(run.compactionRequests.some((request) => request.stage === 'final'), diagnosis)
  assert.deepEqual(run.compactionRequests.map((request) => request.requestIndex), run.compactionRequestIndices)
  assert.equal(run.providerRequests, 5 + run.compactionRequestIndices.length + run.postTurnMemoryRequestIndices.length, diagnosis)
  assert.deepEqual([...run.argumentRepairRequestIndices, ...run.compactionRequestIndices, ...run.postTurnMemoryRequestIndices].sort((a, b) => a - b),
    Array.from({ length: run.providerRequests }, (_, index) => index + 1), 'every request belongs to exactly one main/compaction/memory category')
  assert.ok(run.events.some((event) => event.type === 'model.phase' && event.payload?.phase === 'compacting'), diagnosis)
  assert.ok(run.postTurnMemoryRequestIndices.length <= 1, 'background memory extraction must not trigger retry traffic')
  const tools = completedTools(run.events)
  assert.deepEqual(tools.map((event) => event.payload.name), run.emittedTools, diagnosis)
  const generations = tools.filter((event) => event.payload.name === 'create_pptx')
  assert.equal(generations.length, 3)
  assert.deepEqual(generations.map((event) => event.payload.result.ok), [false, false, true])
  assert.equal(new Set(generations.map((event) => event.payload.toolCallId)).size, 3, 'repairs need fresh call identities')
  const originalArgs = assertPreservedArguments(generations)
  const hooks = harness.persistedPptHooks()
  assert.equal(hooks.length, presentationPreToolHook ? 3 : 0)
  if (presentationPreToolHook) {
    assert.deepEqual(hooks.map((hook) => hook.status), ['ok', 'ok', 'ok'])
    assert.deepEqual(hooks.map((hook) => hook.input.args), generations.map((event) => event.payload.args))
  }
  const authoringCalls = run.providerExchanges.flatMap((exchange) => (
    JSON.parse(exchange.responseBody || '{}').choices?.[0]?.message?.tool_calls || []
  )).filter((call) => call.function.name === 'create_pptx').map((call) => JSON.parse(call.function.arguments))
  assert.equal(authoringCalls.length, 3)
  assert.deepEqual(authoringCalls[0], originalArgs)
  for (const index of [1, 2]) {
    const request = authoringCalls[index]
    assert.deepEqual(Object.keys(request).sort(), ['base_digest', 'edits', 'repair_from_tool_call_id'])
    assert.equal(request.repair_from_tool_call_id, generations[index - 1].payload.toolCallId)
    assert.equal(request.base_digest, generations[index - 1].payload.result.pptx_preflight.base_digest)
    assert.ok(JSON.stringify(request).length < JSON.stringify(originalArgs).length / 4, 'a repair must be a small geometry patch, not a repeated deck')
  }
  assert.equal(run.observedArgumentFailures.length, 2)
  for (const [index, failure] of run.observedArgumentFailures.entries()) {
    const rejected = generations[index]
    const repaired = generations[index + 1]
    const slideIndex = index + 7
    assert.equal(failure.toolCallId, rejected.payload.toolCallId)
    assert.equal(failure.slideIndex, slideIndex)
    assert.equal(failure.repairKind, index === 0 ? 'geometry' : 'text_fit')
    assert.ok(failure.message.includes(`slides[${slideIndex}].elements[0]`), diagnosis)
    assert.notEqual(failure.code, 'SIDE_EFFECT_OUTCOME_UNKNOWN')
    assert.ok(repaired.sequence > rejected.sequence, 'the actual rejection must precede the next fresh repair call')
  }
  const [completed] = run.events.filter(isSuccessfulTurnCompletedEvent)
  assert.ok(completed, diagnosis)
  assert.equal(run.events.filter(isSuccessfulTurnCompletedEvent).length, 1)
  const generated = generations[2]
  const artifactId = generated.payload.result.artifactId
  assert.ok(artifactId)
  assert.deepEqual(tools.at(-1).payload.args.artifact_ids, [artifactId])
  assert.ok(completed.payload.deliveryArtifactIds?.includes(artifactId), diagnosis)
  assert.ok(completed.sequence > tools.at(-1).sequence)
  const forbiddenEvents = new Set(['cli.error', 'turn.failed', 'turn.blocked', 'turn.cancelled', 'turn.paused',
    'turn.interrupted', 'turn.resumed', 'approval.required', 'clarification.required'])
  assert.equal(run.events.some((event) => forbiddenEvents.has(event.type)), false, diagnosis)
  assert.doesNotMatch(JSON.stringify(run.events), /SIDE_EFFECT_OUTCOME_UNKNOWN|open_settings|\/settings\?tab=recovery/u)
  assert.doesNotMatch(run.stderr, /SIDE_EFFECT_OUTCOME_UNKNOWN|CLI-E2E-NETWORK-GUARD/u)
  const durable = harness.persistedEvents()
  assert.ok(durable.every((event) => event.turnId === completed.turnId && event.sessionId === completed.sessionId))
  assert.equal(durable.filter(isSuccessfulTurnCompletedEvent).length, 1)
  assert.equal(durable.some((event) => forbiddenEvents.has(event.type)), false)
  assert.deepEqual(completedTools(durable).map((event) => event.payload.toolCallId), tools.map((event) => event.payload.toolCallId))
  const ledger = harness.persistedSideEffects().filter((entry) => entry.toolName === 'create_pptx')
  assert.equal(ledger.length, 3)
  assert.deepEqual(ledger.map((entry) => entry.status), ['failed', 'failed', 'committed'])
  assert.ok(ledger.every((entry) => entry.turnId === completed.turnId && entry.sessionId === completed.sessionId))
  assert.deepEqual(ledger.map((entry) => entry.toolCallId), generations.map((event) => event.payload.toolCallId))
  assert.match(ledger[0].outcome.error, /slides\[7\]\.elements\[0\]/u)
  assert.match(ledger[1].outcome.error, /slides\[8\]\.elements\[0\]/u)
  assert.equal(ledger[2].outcome.ok, true)
  assert.equal(ledger[2].outcome.artifactId, artifactId)
  const filename = generated.payload.result.filename
  assert.equal(basename(filename), filename)
  assert.equal(dirname(resolve(harness.paths.artifacts, filename)), resolve(harness.paths.artifacts))
  assert.equal(resolve(harness.paths.artifacts, filename), harness.paths.ppt)
  const validation = await validateGeneratedArtifactFile({ filePath: harness.paths.ppt, artifactType: 'pptx' })
  assert.equal(validation.ok, true)
  const bytes = harness.readPpt()
  assert.equal(validation.byteLength, bytes.length)
  const zip = await JSZip.loadAsync(bytes)
  assert.equal(zip.file(/^ppt\/slides\/slide\d+\.xml$/u).length, 9)
  for (const index of [7, 8]) {
    const xml = await zip.file(`ppt/slides/slide${index + 1}.xml`).async('string')
    assert.ok(xml.includes(originalArgs.slides[index].elements[0].text), 'the final PPT must retain text from every repaired element')
  }
  t.diagnostic('real CLI: create_pptx[geometry rejected] -> create_pptx[text-fit rejected] -> create_pptx[committed] -> set_deliverables; ledger=failed/failed/committed; exit=0; no presets, settings confirmation or --resume')
})
}
