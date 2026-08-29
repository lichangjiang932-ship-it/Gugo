import assert from 'node:assert/strict'

import {
  FINAL_ANSWER_EVIDENCE_REVIEW_MARKER,
  buildFinalAnswerEvidenceReviewPrompt,
  buildFinalAnswerEvidenceSnapshot,
  finalAnswerEvidenceDigest,
} from '../../server/services/loop/finalAnswerEvidenceReview.js'
import { defineOfflineEvalCase, defineOfflineEvalSuite } from '../helpers/offlineEvalHarness.js'

function toolCall(id, name, args) {
  return {
    role: 'assistant',
    content: '',
    tool_calls: [{
      id,
      type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    }],
  }
}

function toolResult(id, result) {
  return { role: 'tool', tool_call_id: id, content: JSON.stringify(result) }
}

function selectedArtifactReadiness(snapshot) {
  const selected = new Set(snapshot.deliverables.selectedArtifactIds)
  const selectedArtifacts = snapshot.deliverables.artifacts
    .filter((artifact) => selected.has(artifact.id))
  const verified = selectedArtifacts.filter((artifact) => artifact.verified).length
  return {
    selected: selectedArtifacts.length,
    verified,
    ratio: selectedArtifacts.length ? verified / selectedArtifacts.length : 1,
  }
}

const CASES = [
  defineOfflineEvalCase({
    id: 'ANSWER-01',
    category: 'task-completion',
    title: 'a completed CLI change exposes every deliverable and verification fact to the final review',
    async run(ctx) {
      const objective = '修复 CLI doctor，就绪时显示 provider，并更新文档后运行回归测试。'
      const snapshot = buildFinalAnswerEvidenceSnapshot({
        objective,
        requiredArtifactTools: ['write_file'],
        artifacts: [
          { id: 'bin/gugo.js', tool: 'write_file', type: 'file', verified: true },
          { id: 'docs/CLI.md', tool: 'write_file', type: 'file', verified: true },
        ],
        selectedArtifactIds: ['bin/gugo.js', 'docs/CLI.md'],
        mutationExecutionObserved: true,
        executionEvidenceObserved: true,
        postMutationVerificationPassed: true,
        messages: [
          toolCall('write-cli', 'write_file', { path: 'bin/gugo.js' }),
          toolResult('write-cli', { ok: true, path: 'bin/gugo.js' }),
          toolCall('write-docs', 'write_file', { path: 'docs/CLI.md' }),
          toolResult('write-docs', { ok: true, path: 'docs/CLI.md' }),
          toolCall('run-tests', 'run_test', { target: 'tests/cliDoctor.test.js' }),
          toolResult('run-tests', { ok: true, passed: 18, failed: 0 }),
        ],
      })
      const digest = finalAnswerEvidenceDigest(snapshot)
      const prompt = buildFinalAnswerEvidenceReviewPrompt(snapshot, digest)
      const readiness = selectedArtifactReadiness(snapshot)

      assert.match(prompt, new RegExp(FINAL_ANSWER_EVIDENCE_REVIEW_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      assert.ok(prompt.includes(objective))
      assert.ok(prompt.includes('bin/gugo.js'))
      assert.ok(prompt.includes('docs/CLI.md'))
      assert.ok(prompt.includes('run_test'))
      assert.equal(JSON.parse(snapshot.toolEvidence.at(-1).result).failed, 0)
      assert.equal(readiness.ratio, 1)
      assert.equal(snapshot.execution.postMutationVerificationPassed, true)
      ctx.metric('selected_deliverables', readiness.selected)
      ctx.metric('verified_deliverables', readiness.verified)
      ctx.metric('grounding_coverage', readiness.ratio)
    },
  }),
  defineOfflineEvalCase({
    id: 'ANSWER-02',
    category: 'incomplete-boundary',
    title: 'failed verification and an unverified file remain explicit instead of supporting a false success',
    async run(ctx) {
      const snapshot = buildFinalAnswerEvidenceSnapshot({
        objective: '修改配置文件并确认所有测试通过。',
        requiredArtifactTools: ['write_file'],
        artifacts: [
          { id: 'config/runtime.json', tool: 'write_file', type: 'file', verified: false },
        ],
        selectedArtifactIds: ['config/runtime.json'],
        mutationExecutionObserved: true,
        executionEvidenceObserved: true,
        postMutationVerificationPassed: false,
        messages: [
          toolCall('write-config', 'write_file', { path: 'config/runtime.json' }),
          toolResult('write-config', { ok: true, path: 'config/runtime.json' }),
          toolCall('verify-config', 'run_test', { target: 'tests/config.test.js' }),
          toolResult('verify-config', {
            ok: false,
            code: 'TEST_FAILED',
            error: '2 assertions failed',
          }),
        ],
      })
      const prompt = buildFinalAnswerEvidenceReviewPrompt(
        snapshot,
        finalAnswerEvidenceDigest(snapshot),
      )
      const readiness = selectedArtifactReadiness(snapshot)

      assert.equal(readiness.ratio, 0)
      assert.equal(snapshot.toolEvidence.at(-1).succeeded, false)
      assert.ok(prompt.includes('TEST_FAILED'))
      assert.ok(prompt.includes('2 assertions failed'))
      assert.ok(prompt.includes('"postMutationVerificationPassed":false'))
      assert.match(prompt, /unmet requirement.*continue with tools.*concrete blocker/)
      ctx.metric('failed_tool_evidence', snapshot.toolEvidence.filter((item) => !item.succeeded).length)
      ctx.metric('verified_deliverable_ratio', readiness.ratio)
      ctx.metric('false_success_support', 0)
    },
  }),
  defineOfflineEvalCase({
    id: 'ANSWER-03',
    category: 'evidence-integrity',
    title: 'verification changes invalidate a stale review while media payloads never enter the persisted evidence',
    async run(ctx) {
      const base = {
        objective: '生成并验证预览图。',
        artifacts: [{ id: 'preview.png', tool: 'image', type: 'image', verified: false }],
        selectedArtifactIds: ['preview.png'],
        mutationExecutionObserved: true,
        executionEvidenceObserved: true,
        toolEvidence: [{
          tool: 'render_preview',
          arguments: { path: 'preview.png' },
          succeeded: true,
          result: { type: 'image', mimeType: 'image/png', data: 'SECRET_BASE64_PAYLOAD' },
        }],
      }
      const before = buildFinalAnswerEvidenceSnapshot(base)
      const after = buildFinalAnswerEvidenceSnapshot({
        ...base,
        artifacts: [{ id: 'preview.png', tool: 'image', type: 'image', verified: true }],
        postMutationVerificationPassed: true,
      })
      const serialized = JSON.stringify(after)

      assert.notEqual(finalAnswerEvidenceDigest(before), finalAnswerEvidenceDigest(after))
      assert.doesNotMatch(serialized, /SECRET_BASE64_PAYLOAD/)
      assert.match(serialized, /captured/)
      ctx.metric('stale_digest_invalidated', 1)
      ctx.metric('media_payload_leaks', 0)
    },
  }),
]

export default defineOfflineEvalSuite({
  id: 'final-answer-evidence',
  title: 'Final-answer grounding across completed, incomplete, and evidence-changing tasks',
  version: 1,
  cases: CASES,
})
