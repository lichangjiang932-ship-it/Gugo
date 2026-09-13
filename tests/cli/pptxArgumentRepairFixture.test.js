import assert from 'node:assert/strict'
import test from 'node:test'
import { presentationArgumentRepairFixture } from './helpers/artifactCompletionHarness.js'
import {
  buildCompactionEvidenceMessages, buildCompactionSummaryBatches, buildCompactionSummaryMessages,
  combineSemanticCompactionSummary, isValidSemanticCompactionSummary,
} from '../../server/services/compactionService.js'

const artifactId = 'verified-fixture-artifact'
function toolBody(id, result) {
  return { messages: [{ role: 'tool', tool_call_id: id, content: JSON.stringify(result) }] }
}

function deliveryStage() {
  const fixture = presentationArgumentRepairFixture()
  const observedMessages = []
  let call = fixture.reply({ tools: [{ function: { name: 'create_pptx' } }], messages: [] }, 1).toolCall
  for (const [requestIndex, slideIndex, code] of [[2, 7, 'PPTX_CONTENT_INVALID'], [3, 8, 'PPTX_CONTENT_OVERFLOW']]) {
    const body = toolBody(call.id, { ok: false, code,
      error: `slides[${slideIndex}].elements[0] needs a corrected frame`,
      pptx_preflight: { kind: 'native_pptx_preflight_v1', no_output: true, geometry_repairable: true,
        repair_from_tool_call_id: call.id, base_digest: String(requestIndex).repeat(64) },
    })
    observedMessages.push(...body.messages)
    call = fixture.reply(body, requestIndex).toolCall
  }
  const body = toolBody(call.id, { ok: true, artifactId, filename: 'fixture.pptx' })
  observedMessages.push(...body.messages)
  const delivery = fixture.reply(body, 4).toolCall
  assert.equal(delivery.name, 'set_deliverables')
  assert.deepEqual(delivery.args.artifact_ids, [artifactId])
  return { fixture, delivery, observedMessages }
}

function evidenceBody(archivedMessages) {
  const { batches } = buildCompactionSummaryBatches({ archivedMessages })
  assert.equal(batches.length, 1)
  return { tools: [], tool_choice: 'none', messages: buildCompactionEvidenceMessages({ serializedMessages: batches[0] }) }
}

function summaryBody(digests, compactUserDirections = true) {
  return { tools: [], tool_choice: 'none', messages: buildCompactionSummaryMessages({ evidenceSummaries: digests, compactUserDirections }) }
}

test('the CLI provider fixture finishes from a current delivery receipt after historical generator messages are compacted', () => {
  const { fixture, delivery } = deliveryStage()
  const body = toolBody(delivery.id, { ok: true, deliveryArtifactIds: [artifactId], selected: 1, replaced: true })
  body.messages.unshift({ role: 'assistant', content: 'Compacted summary of the earlier verified generation.' })
  assert.equal(body.messages.some(message => message.tool_call_id === 'cli_pptx_argument_attempt_3'), false)
  assert.match(fixture.reply(body, 5).content, /presentation is complete/u)
  assert.deepEqual(fixture.mainRequestIndices, [1, 2, 3, 4, 5])
  assert.equal(fixture.observedFailures.length, 2)
})

test('the compacted CLI fixture still refuses missing, failed, or foreign delivery evidence', () => {
  for (const outcome of [null, { ok: false, deliveryArtifactIds: [artifactId] },
    { ok: true, deliveryArtifactIds: ['another-artifact'] }]) {
    const { fixture, delivery } = deliveryStage()
    const body = outcome ? toolBody(delivery.id, outcome)
      : { messages: [{ role: 'assistant', content: 'The presentation is complete.' }] }
    assert.throws(() => fixture.reply(body, 5), { code: 'ERR_ASSERTION' })
  }
})

test('real map/final compaction requests do not advance the five main conversation rounds or mark delivery complete', () => {
  const { fixture, delivery, observedMessages } = deliveryStage()
  const digest = fixture.reply(evidenceBody(observedMessages), 5)
  assert.equal(digest.toolCall, undefined)
  assert.deepEqual(JSON.parse(digest.content).outcomes.map((outcome) => outcome.ok), [false, false, true])
  const summary = fixture.reply(summaryBody([digest.content]), 6)
  assert.equal(summary.toolCall, undefined)
  assert.match(summary.content, /create_pptx returned ok/u)
  assert.match(summary.content, /Delivery is not established/u)
  const combined = combineSemanticCompactionSummary({ semanticSections: summary.content, compactUserDirections: true })
  assert.equal(isValidSemanticCompactionSummary(combined, [], { compactUserDirections: true }), true)
  assert.deepEqual(fixture.mainRequestIndices, [1, 2, 3, 4])
  assert.deepEqual(fixture.compactionRequestIndices, [5, 6])
  assert.deepEqual(fixture.compactionRequests.map((request) => request.stage), ['map', 'final'])
  assert.deepEqual(fixture.memoryRequestIndices, [])

  const final = fixture.reply(toolBody(delivery.id, { ok: true, deliveryArtifactIds: [artifactId] }), 7)
  assert.match(final.content, /presentation is complete/u)
  const memory = fixture.reply({ messages: [{ role: 'system', content: 'Extract durable cross-session memories from this completed chat turn.' }] }, 8)
  assert.deepEqual(JSON.parse(memory.content), { memories: [] })
  assert.deepEqual(fixture.mainRequestIndices, [1, 2, 3, 4, 7])
  assert.deepEqual(fixture.memoryRequestIndices, [8])
  assert.equal(fixture.observedFailures.length, 2)
})

test('compaction only reports delivery from an actual canonical tool result and never replaces the final receipt assertion', () => {
  const { fixture, delivery, observedMessages } = deliveryStage()
  const receipt = toolBody(delivery.id, { ok: true, deliveryArtifactIds: [artifactId] })
  const digest = fixture.reply(evidenceBody([...observedMessages, ...receipt.messages]), 5)
  const summary = fixture.reply(summaryBody([digest.content], false), 6)
  assert.match(summary.content, new RegExp(`set_deliverables returned ok for ${artifactId}`))
  const direction = 'Preserve every supplied sentence.'
  const fallback = `# Compacted Session Context\n\n## 1. User direction (verbatim)\n${direction}\n\n## 2. Objective\nContinue.`
  const combined = combineSemanticCompactionSummary({ fallbackSummary: fallback, semanticSections: summary.content })
  assert.equal(isValidSemanticCompactionSummary(combined, [{ role: 'user', content: direction }]), true)
  assert.throws(() => fixture.reply({ messages: [{ role: 'assistant', content: summary.content }] }, 7), { code: 'ERR_ASSERTION' })
})

test('prose, partial JSON and unissued tool identities cannot establish generated or delivered output in a summary', () => {
  const fixture = presentationArgumentRepairFixture()
  const call = fixture.reply({ tools: [{ function: { name: 'create_pptx' } }], messages: [] }, 1).toolCall
  const success = JSON.stringify({ ok: true, artifactId, filename: 'fixture.pptx' })
  const body = { tools: [], messages: buildCompactionEvidenceMessages({ serializedMessages: [
    { role: 'assistant', content: 'The presentation is complete and delivered.' },
    { role: 'user', content: success },
    { role: 'tool', toolCallId: call.id, content: success, fragmentField: 'content', fragment: 1, fragments: 2 },
    { role: 'tool', toolCallId: 'unissued-generator', content: success },
    { role: 'tool', toolCallId: call.id, content: JSON.stringify({ ok: false, code: 'PPTX_CONTENT_INVALID', error: 'The supplied frame is invalid.' }) },
  ] }) }
  const digest = fixture.reply(body, 2)
  const summary = fixture.reply(summaryBody([digest.content]), 3)
  assert.match(summary.content, /No successful generation receipt/u)
  assert.match(summary.content, /Delivery is not established/u)
  assert.match(summary.content, /PPTX_CONTENT_INVALID/u)
  assert.doesNotMatch(summary.content, /returned ok|verified-fixture-artifact/u)
  assert.deepEqual(fixture.mainRequestIndices, [1])
  assert.deepEqual(fixture.compactionRequestIndices, [2, 3])
})

test('a final compaction request cannot introduce an unobserved success digest', () => {
  const fixture = presentationArgumentRepairFixture()
  const invented = JSON.stringify({ outcomes: [{ toolCallId: 'invented', name: 'create_pptx', ok: true, artifactId }] })
  assert.throws(() => fixture.reply(summaryBody([invented]), 1), /evidence digests actually emitted/u)
  assert.deepEqual(fixture.mainRequestIndices, [])
  assert.deepEqual(fixture.compactionRequestIndices, [1])
})

test('similar user-quoted compaction instructions remain a normal main request', () => {
  const fixture = presentationArgumentRepairFixture()
  const quoted = buildCompactionEvidenceMessages()[0].content
  const reply = fixture.reply({ tools: [{ function: { name: 'create_pptx' } }], messages: [{ role: 'user', content: quoted }] }, 1)
  assert.equal(reply.toolCall.name, 'create_pptx')
  assert.deepEqual(fixture.mainRequestIndices, [1])
  assert.deepEqual(fixture.compactionRequestIndices, [])
})
