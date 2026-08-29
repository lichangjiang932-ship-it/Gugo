import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FINAL_ANSWER_EVIDENCE_REVIEW_MARKER,
  appendFinalAnswerToolEvidence,
  buildFinalAnswerEvidenceReviewPrompt,
  buildFinalAnswerEvidenceSnapshot,
  finalAnswerEvidenceDigest,
} from '../server/services/loop/finalAnswerEvidenceReview.js'
import { processModelResult } from '../server/services/loop/runtime-processModelResult.js'

test('final answer evidence review is deterministic and binds objective, deliverables, and tool evidence', () => {
  const messages = [
    {
      role: 'assistant',
      tool_calls: [{
        id: 'write-1',
        type: 'function',
        function: { name: 'write_file', arguments: '{"path":"result.txt","content":"hello"}' },
      }],
    },
    { role: 'tool', tool_call_id: 'write-1', content: '{"ok":true,"path":"result.txt","bytes":5}' },
  ]
  const input = {
    objective: 'Create and verify result.txt.',
    requiredArtifactTools: [],
    artifacts: [],
    selectedArtifactIds: [],
    mutationExecutionObserved: true,
    executionEvidenceObserved: true,
    postMutationVerificationPassed: true,
    messages,
  }
  const snapshot = buildFinalAnswerEvidenceSnapshot(input)
  const sameSnapshot = buildFinalAnswerEvidenceSnapshot(input)
  const digest = finalAnswerEvidenceDigest(snapshot)

  assert.equal(finalAnswerEvidenceDigest(sameSnapshot), digest)
  assert.match(digest, /^[a-f0-9]{64}$/)
  assert.deepEqual(snapshot.toolEvidence.map((item) => item.tool), ['write_file'])
  assert.equal(snapshot.toolEvidence[0].succeeded, true)

  const prompt = buildFinalAnswerEvidenceReviewPrompt(snapshot, digest)
  assert.match(prompt, new RegExp(FINAL_ANSWER_EVIDENCE_REVIEW_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(prompt, new RegExp(`evidence_digest=${digest}`))
  assert.match(prompt, /Create and verify result\.txt/)
})

test('evidence digest changes when verification or selected deliverables change', () => {
  const base = buildFinalAnswerEvidenceSnapshot({
    objective: 'Deliver the verified report.',
    artifacts: [{ id: 'report-1', tool: 'create_pdf', type: 'pdf', verified: true }],
    selectedArtifactIds: ['report-1'],
    mutationExecutionObserved: true,
    executionEvidenceObserved: true,
    postMutationVerificationPassed: false,
  })
  const verified = buildFinalAnswerEvidenceSnapshot({
    objective: 'Deliver the verified report.',
    artifacts: [{ id: 'report-1', tool: 'create_pdf', type: 'pdf', verified: true }],
    selectedArtifactIds: ['report-1'],
    mutationExecutionObserved: true,
    executionEvidenceObserved: true,
    postMutationVerificationPassed: true,
  })
  const differentSelection = buildFinalAnswerEvidenceSnapshot({
    objective: 'Deliver the verified report.',
    artifacts: [{ id: 'report-1', tool: 'create_pdf', type: 'pdf', verified: true }],
    selectedArtifactIds: [],
    mutationExecutionObserved: true,
    executionEvidenceObserved: true,
    postMutationVerificationPassed: true,
  })

  assert.notEqual(finalAnswerEvidenceDigest(base), finalAnswerEvidenceDigest(verified))
  assert.notEqual(finalAnswerEvidenceDigest(verified), finalAnswerEvidenceDigest(differentSelection))
})

test('persistent final-answer evidence keeps media metadata but never raw payloads', () => {
  const evidence = appendFinalAnswerToolEvidence([], {
    name: 'browser_screenshot',
    args: {},
  }, {
    ok: true,
    image: {
      mimeType: 'image/png',
      data: 'RAW_SCREENSHOT_BYTES',
      bytes: 20,
    },
  })

  assert.equal(evidence.length, 1)
  assert.equal(evidence[0].succeeded, true)
  assert.match(evidence[0].result, /image\/png/u)
  assert.match(evidence[0].result, /"bytes":20/u)
  assert.match(evidence[0].result, /"captured":true/u)
  assert.doesNotMatch(evidence[0].result, /RAW_SCREENSHOT_BYTES|base64|data:image/u)
})

test('an unavailable final-answer review exits with stable structured diagnostics only', async () => {
  let terminal = null
  const result = await processModelResult({
    d: {},
    iteration: { modelResult: { content: 'Unsupported completion claim.', toolCalls: [] } },
    hasVerifiedDirectoryResolution: false,
    hasRequiredArtifacts: () => true,
    hasRequiredExecutionEvidence: () => true,
    hasPendingMutationVerification: () => false,
    validateLocalHtmlDeliveries: async () => null,
    requiresPdfLayoutVerification: false,
    needsDeliverableSelection: () => false,
    requiresFinalAnswerEvidenceReview: () => true,
    hasCurrentFinalAnswerEvidenceReview: () => false,
    prepareFinalAnswerEvidenceReview: () => false,
    finishIncomplete: async (value) => {
      terminal = value
      return value
    },
  })

  assert.equal(result.kind, 'return')
  assert.equal(terminal.text, '')
  assert.equal(terminal.reason, 'final_answer_evidence_review_missing')
})
