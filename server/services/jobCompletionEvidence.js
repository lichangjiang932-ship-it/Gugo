import { getDb } from '../db.js'

const STRUCTURED_EVIDENCE_STEP_KINDS = new Set(['execute', 'batch_item', 'verify'])
const COMPLETION_EVIDENCE_TYPE_ALIASES = new Map([
  ['tool', 'tool_result'],
  ['tool_result', 'tool_result'],
  ['test', 'check'],
  ['test_result', 'check'],
  ['check', 'check'],
  ['check_result', 'check'],
  ['artifact', 'artifact'],
  ['artifact_result', 'artifact'],
  ['readback', 'readback'],
  ['file_readback', 'readback'],
  ['user_confirmation', 'user_confirmation'],
])

function boundedText(value, maxLength) {
  const text = typeof value === 'string' ? value.trim() : ''
  return text ? text.slice(0, maxLength) : ''
}

function normalizeCompletionEvidenceEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
  const type = COMPLETION_EVIDENCE_TYPE_ALIASES.get(boundedText(entry.type, 64).toLowerCase())
  const summary = boundedText(entry.summary, 2_000)
  if (!type || !summary) return null

  if (type === 'tool_result') {
    const toolCallId = boundedText(entry.toolCallId, 256)
    if (!toolCallId || entry.ok !== true) return null
    return { type, summary, toolCallId, ok: true }
  }
  if (type === 'check') {
    const command = boundedText(entry.command, 4_000)
    const passed = entry.ok === true || entry.exitCode === 0
    if (!command || !passed) return null
    return {
      type,
      summary,
      command,
      ok: true,
      ...(Number.isInteger(entry.exitCode) ? { exitCode: entry.exitCode } : {}),
    }
  }
  if (type === 'artifact') {
    const artifactId = boundedText(entry.artifactId, 256)
    if (!artifactId) return null
    return { type, summary, artifactId }
  }
  if (type === 'readback') {
    const path = boundedText(entry.path, 2_000)
    if (!path || entry.ok !== true) return null
    return { type, summary, path, ok: true }
  }
  if (entry.confirmed !== true) return null
  return { type, summary, confirmed: true }
}

export function requiresStructuredCompletionEvidence(step) {
  return STRUCTURED_EVIDENCE_STEP_KINDS.has(String(step?.kind || '').trim().toLowerCase())
}

export function validateStructuredCompletionEvidence(evidence, {
  jobId = null,
  userId = null,
} = {}) {
  if (!Array.isArray(evidence) || evidence.length === 0) {
    return {
      ok: false,
      code: 'JOB_COMPLETION_EVIDENCE_REQUIRED',
      error: 'Structured completion evidence is required for this step.',
    }
  }
  const normalized = evidence.map(normalizeCompletionEvidenceEntry)
  if (normalized.some((entry) => !entry)) {
    return {
      ok: false,
      code: 'JOB_COMPLETION_EVIDENCE_INVALID',
      error: 'Completion evidence must use a supported structured evidence shape.',
    }
  }
  if (jobId) {
    const artifactIds = normalized
      .filter((entry) => entry.type === 'artifact')
      .map((entry) => entry.artifactId)
    if (artifactIds.length > 0) {
      const db = getDb()
      const artifactBelongsToJob = userId
        ? db.prepare(`
            SELECT 1
              FROM job_artifacts
             WHERE id = ? AND job_id = ? AND user_id = ?
          `)
        : db.prepare(`
            SELECT 1
              FROM job_artifacts
             WHERE id = ? AND job_id = ?
          `)
      const missing = artifactIds.find((artifactId) => !(
        userId
          ? artifactBelongsToJob.get(artifactId, jobId, userId)
          : artifactBelongsToJob.get(artifactId, jobId)
      ))
      if (missing) {
        return {
          ok: false,
          code: 'JOB_COMPLETION_EVIDENCE_ARTIFACT_NOT_FOUND',
          error: 'Artifact completion evidence must reference a persisted artifact owned by this job.',
        }
      }
    }
  }
  return { ok: true, evidence: normalized }
}
