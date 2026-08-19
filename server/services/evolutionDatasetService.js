import { createHash } from 'node:crypto'

import { getDb } from '../db.js'
import { sanitizeAuditValue } from '../utils/audit.js'
import { listEvolutionEvidence } from './evolutionEvidenceStore.js'

export const EVOLUTION_CURATION_VERSION = '2026-08-20-v1'
const EVIDENCE_ID_RE = /^(?:feedback:[0-9a-f-]{36}|task-review:[1-9][0-9]*)$/i
const MAX_REASON_CHARS = 500
const CLUSTER_RULES = Object.freeze([
  ['verification', /\b(?:test|tests|assert|assertion|verify|verification|build|lint|typecheck|check)\b|测试|验证|构建|断言|检查/iu],
  ['artifact_delivery', /\b(?:artifact|file|readback|delivery|output|preview)\b|产物|文件|回读|交付|预览/iu],
  ['authorization', /\b(?:permission|approval|authorization|credential|login|user input)\b|权限|审批|授权|登录|用户输入/iu],
  ['external_dependency', /\b(?:timeout|network|provider|quota|rate limit|endpoint|dependency)\b|超时|网络|供应商|配额|限流|外部依赖/iu],
  ['tool_runtime', /\b(?:plugin|tool|sandbox|runtime|executor)\b|插件|工具|沙箱|运行时|执行器/iu],
])

function serviceError(code, message, statusCode = 400) {
  return Object.assign(new Error(message), { code, statusCode })
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
  )
}

function stableJson(value) {
  return JSON.stringify(stableValue(value))
}

function sha256(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : stableJson(value)).digest('hex')
}

export function sanitizeEvolutionText(value) {
  return String(sanitizeAuditValue(String(value || '')) || '')
    .replace(/\b(?:sk|ghp|github_pat)[-_]?[A-Za-z0-9_-]{12,}\b/giu, '[REDACTED]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/gu, '[REDACTED]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, '[EMAIL]')
    .replace(/\b[A-Za-z]:[\\/](?:[^\s<>:"|?*]+[\\/])*[^\s<>:"|?*]*/gu, '[LOCAL_PATH]')
    .replace(/(^|[\s("'`])\/(?:Users|home|tmp|var|etc|opt|srv)(?:\/[^\s)"'`]+)*/gu, '$1[LOCAL_PATH]')
    .trim()
}

function sanitizeList(value) {
  return (Array.isArray(value) ? value : [])
    .map(sanitizeEvolutionText)
    .filter(Boolean)
    .slice(0, 50)
}

function curatedPayload(evidence) {
  if (evidence.source === 'user_feedback') {
    return { feedback: sanitizeEvolutionText(evidence.feedback) }
  }
  const review = evidence.review || {}
  return {
    verdict: String(review.verdict || 'unknown'),
    summary: sanitizeEvolutionText(review.summary),
    issues: sanitizeList(review.issues),
    evidence: sanitizeList(review.evidence),
    repairAttempts: Number.isInteger(review.repairAttempts) ? review.repairAttempts : 0,
    reviewer: {
      independent: review.reviewer?.independent === true,
      mode: sanitizeEvolutionText(review.reviewer?.mode) || null,
      workerModel: sanitizeEvolutionText(review.reviewer?.workerModel) || null,
      reviewerModel: sanitizeEvolutionText(review.reviewer?.reviewerModel) || null,
    },
  }
}

function clusterFor(evidence, payload) {
  if (evidence.source === 'user_feedback') return 'user_feedback'
  if (evidence.signal === 'pass') return 'success'
  const text = stableJson(payload)
  return CLUSTER_RULES.find(([, pattern]) => pattern.test(text))?.[0] || 'unclassified_failure'
}

function evidenceExistsForUser(db, userId, evidenceId) {
  if (evidenceId.startsWith('feedback:')) {
    return !!db.prepare('SELECT 1 FROM evolution_feedback WHERE id = ? AND user_id = ?')
      .get(evidenceId.slice('feedback:'.length), userId)
  }
  return !!db.prepare(`
    SELECT 1
    FROM job_events AS event
    JOIN jobs AS job ON job.id = event.job_id
    WHERE event.id = ? AND event.type = 'task_reviewed' AND job.user_id = ?
  `).get(Number(evidenceId.slice('task-review:'.length)), userId)
}

function normalizeEvidenceId(value) {
  const evidenceId = String(value || '').trim()
  if (!EVIDENCE_ID_RE.test(evidenceId)) {
    throw serviceError('EVOLUTION_EVIDENCE_ID_INVALID', 'evidenceId is invalid')
  }
  return evidenceId
}

function exclusionView(row) {
  return {
    evidenceId: row.evidence_id,
    reason: row.reason || null,
    createdAt: row.created_at,
  }
}

export function listEvolutionExclusions({ userId } = {}) {
  const owner = String(userId || '').trim()
  if (!owner) throw serviceError('EVOLUTION_USER_REQUIRED', 'userId is required')
  return getDb().prepare(`
    SELECT evidence_id, reason, created_at
    FROM evolution_evidence_exclusions
    WHERE user_id = ?
    ORDER BY created_at DESC, evidence_id ASC
  `).all(owner).map(exclusionView)
}

export function setEvolutionEvidenceExcluded({
  userId,
  evidenceId: evidenceIdValue,
  excluded = true,
  reason = null,
  now = Date.now(),
}) {
  const owner = String(userId || '').trim()
  if (!owner) throw serviceError('EVOLUTION_USER_REQUIRED', 'userId is required')
  const evidenceId = normalizeEvidenceId(evidenceIdValue)
  if (typeof excluded !== 'boolean') {
    throw serviceError('EVOLUTION_EXCLUDED_FLAG_INVALID', 'excluded must be boolean')
  }
  const db = getDb()
  if (!evidenceExistsForUser(db, owner, evidenceId)) {
    throw serviceError('EVOLUTION_EVIDENCE_NOT_FOUND', 'evidence was not found', 404)
  }
  if (excluded !== true) {
    db.prepare('DELETE FROM evolution_evidence_exclusions WHERE user_id = ? AND evidence_id = ?')
      .run(owner, evidenceId)
    return { evidenceId, excluded: false }
  }
  const rawReason = String(reason || '').trim()
  if (rawReason.length > MAX_REASON_CHARS) {
    throw serviceError('EVOLUTION_EXCLUSION_REASON_TOO_LARGE', `reason must not exceed ${MAX_REASON_CHARS} characters`)
  }
  const normalizedReason = sanitizeEvolutionText(rawReason)
  if (normalizedReason.length > MAX_REASON_CHARS) {
    throw serviceError('EVOLUTION_EXCLUSION_REASON_TOO_LARGE', `reason must not exceed ${MAX_REASON_CHARS} characters`)
  }
  const timestamp = Number(now)
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw serviceError('EVOLUTION_TIMESTAMP_INVALID', 'now must be a non-negative safe integer')
  }
  db.prepare(`
    INSERT INTO evolution_evidence_exclusions (user_id, evidence_id, reason, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, evidence_id) DO UPDATE SET
      reason = excluded.reason,
      created_at = excluded.created_at
  `).run(owner, evidenceId, normalizedReason || null, timestamp)
  return { evidenceId, excluded: true, reason: normalizedReason || null, createdAt: timestamp }
}

export function buildEvolutionDataset({ userId, limit = 200 } = {}) {
  const rawEvidence = listEvolutionEvidence({ userId, limit })
  const exclusions = listEvolutionExclusions({ userId })
  const excludedIds = new Set(exclusions.map((entry) => entry.evidenceId))
  const deduplicated = new Map()

  for (const evidence of rawEvidence) {
    if (excludedIds.has(evidence.id)) continue
    const payload = curatedPayload(evidence)
    const canonical = {
      source: evidence.source,
      signal: evidence.signal,
      payload,
    }
    const contentFingerprint = sha256(canonical)
    const existing = deduplicated.get(contentFingerprint)
    if (existing) {
      existing.evidenceIds.push(evidence.id)
      existing.occurrenceCount += 1
      existing.firstSeenAt = Math.min(existing.firstSeenAt, evidence.createdAt)
      existing.lastSeenAt = Math.max(existing.lastSeenAt, evidence.createdAt)
      continue
    }
    deduplicated.set(contentFingerprint, {
      id: `record:${contentFingerprint.slice(0, 24)}`,
      contentFingerprint,
      source: evidence.source,
      signal: evidence.signal,
      cluster: clusterFor(evidence, payload),
      payload,
      evidenceIds: [evidence.id],
      occurrenceCount: 1,
      firstSeenAt: evidence.createdAt,
      lastSeenAt: evidence.createdAt,
    })
  }

  const records = [...deduplicated.values()]
    .map((record) => ({ ...record, evidenceIds: record.evidenceIds.sort() }))
    .sort((left, right) => left.contentFingerprint.localeCompare(right.contentFingerprint))
  const clusters = Object.entries(records.reduce((counts, record) => {
    counts[record.cluster] = (counts[record.cluster] || 0) + record.occurrenceCount
    return counts
  }, {})).sort(([left], [right]) => left.localeCompare(right))
    .map(([id, evidenceCount]) => ({ id, evidenceCount }))
  const relevantExcludedIds = rawEvidence
    .filter((item) => excludedIds.has(item.id))
    .map((item) => item.id)
    .sort()
  const fingerprintSource = {
    curationVersion: EVOLUTION_CURATION_VERSION,
    records,
    excludedEvidenceIds: relevantExcludedIds,
  }
  return {
    schemaVersion: 1,
    evidenceSchemaVersion: 1,
    curationVersion: EVOLUTION_CURATION_VERSION,
    datasetFingerprint: sha256(fingerprintSource),
    summary: {
      sourceEvidenceCount: rawEvidence.length,
      includedEvidenceCount: records.reduce((sum, record) => sum + record.occurrenceCount, 0),
      excludedEvidenceCount: rawEvidence.filter((item) => excludedIds.has(item.id)).length,
      deduplicatedRecordCount: records.length,
    },
    clusters,
    records,
  }
}
