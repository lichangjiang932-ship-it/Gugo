import { authHeaders, jsonOk } from './agentClient.js'

const DEFAULT_UNKNOWN_LIMIT = 50
const DEFAULT_HISTORY_LIMIT = 50

function pageResult(data) {
  const nextCursor = typeof data?.nextCursor === 'string' && data.nextCursor.trim()
    ? data.nextCursor
    : null
  return {
    records: Array.isArray(data?.records) ? data.records : [],
    nextCursor,
  }
}

function pageUrl(path, { limit, cursor }) {
  const params = new URLSearchParams({ limit: String(limit) })
  if (typeof cursor === 'string' && cursor.trim()) params.set('cursor', cursor)
  return `${path}?${params}`
}

function exactNonEmptyId(left, right) {
  return typeof left === 'string'
    && left.length > 0
    && typeof right === 'string'
    && right.length > 0
    && left === right
}

export function safeSideEffectResumeDescriptor(record, resume) {
  if (!record || !resume || typeof resume !== 'object') return null
  if (record.scopeKind === 'turn'
    && resume.kind === 'turn'
    && exactNonEmptyId(record.sessionId, resume.sessionId)
    && exactNonEmptyId(record.turnId, resume.turnId)
    && exactNonEmptyId(record.toolCallId, resume.toolCallId)) {
    return {
      kind: 'turn',
      sessionId: resume.sessionId,
      turnId: resume.turnId,
      toolCallId: resume.toolCallId,
    }
  }
  if (record.scopeKind === 'job'
    && resume.kind === 'job'
    && exactNonEmptyId(record.jobId, resume.jobId)
    && exactNonEmptyId(record.stepId, resume.stepId)) {
    return { kind: 'job', jobId: resume.jobId, stepId: resume.stepId }
  }
  return null
}

export async function listUnknownSideEffectsApi({
  limit = DEFAULT_UNKNOWN_LIMIT,
  cursor = null,
  signal,
} = {}) {
  const response = await fetch(pageUrl('/api/side-effects/unknown', { limit, cursor }), {
    headers: authHeaders(),
    signal,
  })
  const data = await jsonOk(response)
  return pageResult(data)
}

export async function listSideEffectRecoveryHistoryApi({
  limit = DEFAULT_HISTORY_LIMIT,
  cursor = null,
  signal,
} = {}) {
  const response = await fetch(pageUrl('/api/side-effects/history', { limit, cursor }), {
    headers: authHeaders(),
    signal,
  })
  return pageResult(await jsonOk(response))
}

export async function resolveUnknownSideEffectApi({
  record,
  scopeKey,
  toolCallId,
  verificationConfirmed,
  confirmToolCallId,
  resolution,
  note,
}) {
  if (verificationConfirmed !== true || String(confirmToolCallId || '') !== String(toolCallId || '')) {
    throw Object.assign(
      new Error('Side-effect recovery requires verified confirmation for the exact tool call.'),
      { code: 'SIDE_EFFECT_RECOVERY_CONFIRMATION_REQUIRED' },
    )
  }
  const response = await fetch('/api/side-effects/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({
      scopeKey,
      toolCallId,
      verificationConfirmed: true,
      confirmToolCallId,
      resolution,
      ...(String(note || '').trim() ? { note: String(note).trim() } : {}),
    }),
  })
  const data = await jsonOk(response)
  return {
    record: data?.record || null,
    resume: safeSideEffectResumeDescriptor(record, data?.resume),
  }
}
