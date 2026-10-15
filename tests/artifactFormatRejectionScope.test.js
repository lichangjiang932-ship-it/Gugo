import assert from 'node:assert/strict'
import test from 'node:test'
import { trackPolicyBlockedArtifactRejection } from '../server/services/loop/artifactFormatRejections.js'
import { normalizeMutationTarget, targetsMatch } from '../server/services/loop/heuristics/mutationClassification.js'

const code = 'ARTIFACT_FORMAT_ACTIVE_CONTENT_FORBIDDEN'
function state(overrides = {}) {
  return { requiresPersistedArtifact: true, mutationExecutionRequested: false,
    expectedArtifactTools: new Set(['create_docx']), pendingMutationTargets: new Set(['output.docx']),
    executionScope: { projectDirectory: 'D:/work' }, d: { normalizeMutationTarget, targetsMatch }, ...overrides }
}

test('only requested generators or actually changed output paths count toward the policy fuse', () => {
  const s = state()
  const warning = { ok: true, formatValidationCode: code, path: 'D:/work/source.docx' }
  for (let i = 0; i < 3; i += 1) {
    assert.equal(trackPolicyBlockedArtifactRejection(s, warning, { name: 'read_file' }), null)
  }
  assert.equal(s.artifactFormatRejections, undefined)
  const output = { ...warning, path: 'D:/work/output.docx' }
  assert.equal(trackPolicyBlockedArtifactRejection(s, output, { name: 'read_file' }), null)
  assert.equal(trackPolicyBlockedArtifactRejection(s, output, { name: 'read_file' }).code, code)
})

test('generator failures can be bound to their requested filename, but unnamed failures cannot merge', () => {
  const s = state({ pendingMutationTargets: new Set() })
  const refusal = { ok: false, code }
  for (let i = 0; i < 3; i += 1) {
    assert.equal(trackPolicyBlockedArtifactRejection(s, refusal, { name: 'create_docx', args: {} }), null)
  }
  const call = { name: 'create_docx', args: { filename: 'output.docx' } }
  assert.equal(trackPolicyBlockedArtifactRejection(s, refusal, call), null)
  assert.equal(trackPolicyBlockedArtifactRejection(s, refusal, call).code, code)
})

test('a text-only read-only task cannot inherit a deliverable fuse from stale path debt', () => {
  const s = state({ requiresPersistedArtifact: false })
  for (let i = 0; i < 3; i += 1) {
    assert.equal(trackPolicyBlockedArtifactRejection(s, { formatValidationCode: code, path: 'output.docx' }, { name: 'read_file' }), null)
  }
  assert.equal(s.artifactFormatRejections, undefined)
})
