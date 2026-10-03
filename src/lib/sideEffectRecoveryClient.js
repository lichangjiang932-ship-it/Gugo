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

function interactionError(code, message) {
  return Object.assign(new Error(message), { code })
}

async function interactionJson(response) {
  try { return await jsonOk(response) } catch (error) {
    if (response.ok && !error?.code) {
      throw interactionError('SIDE_EFFECT_RECOVERY_RESPONSE_INVALID', 'The server returned an invalid recovery response. Refresh the task state.')
    }
    throw error
  }
}

function exactInteractionId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 500
    && !/\s/u.test(value)
    && !Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
}

function assertInteractionScope(scope) {
  if (!['sessionId', 'turnId', 'toolCallId'].every(key => exactInteractionId(scope?.[key]))) {
    throw interactionError('SIDE_EFFECT_RECOVERY_SCOPE_MISMATCH', 'Recovery requires the exact current session, turn and tool call.')
  }
}

function assertInteractionRecord(record, scope, status) {
  assertInteractionScope(scope)
  if (!record || Array.isArray(record) || record.scopeKind !== 'turn' || record.status !== status
    || !['sessionId', 'turnId', 'toolCallId'].every(key => record[key] === scope[key])
    || record.scopeKey !== JSON.stringify(['turn', scope.sessionId, scope.turnId])
    || typeof record.argsDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(record.argsDigest)) {
    throw interactionError('SIDE_EFFECT_RECOVERY_SCOPE_MISMATCH', 'The recovery response does not identify the requested operation.')
  }
}

function assertInteractionBoundary(boundary) {
  if (!boundary || Array.isArray(boundary) || !exactInteractionId(boundary.id)
    || !Number.isSafeInteger(boundary.sequence) || boundary.sequence < 0 || boundary.type !== 'turn.blocked') {
    throw interactionError('SIDE_EFFECT_RECOVERY_BOUNDARY_INVALID', 'The current pending operation has no valid confirmation boundary.')
  }
}

export async function getSideEffectTurnInteractionApi({ sessionId, turnId, toolCallId, signal } = {}) {
  const scope = { sessionId, turnId, toolCallId }
  assertInteractionScope(scope)
  const response = await fetch(`/api/side-effects/unknown/turn?${new URLSearchParams(scope)}`, {
    headers: authHeaders(), signal,
  })
  const data = await interactionJson(response)
  if (data?.record === null && data?.boundary === null) return { record: null, boundary: null }
  const confirmed = ['committed', 'failed'].includes(data?.record?.status)
  assertInteractionRecord(data?.record, scope, confirmed ? data.record.status : 'unknown')
  assertInteractionBoundary(data?.boundary)
  if (confirmed) {
    const confirmation = data.confirmation
    const resume = safeSideEffectResumeDescriptor(data.record, data.resume)
    if (!confirmation || confirmation.resolution !== data.record.status
      || !Number.isSafeInteger(confirmation.confirmedAt) || confirmation.confirmedAt < 0 || !resume) {
      throw interactionError('SIDE_EFFECT_RECOVERY_RESPONSE_INVALID', 'The stored confirmation has no matching recovery receipt.')
    }
    return { record: data.record, boundary: { id: data.boundary.id, sequence: data.boundary.sequence, type: data.boundary.type },
      confirmation: { resolution: confirmation.resolution, confirmedAt: confirmation.confirmedAt }, resume }
  }
  return { record: data.record, boundary: { id: data.boundary.id, sequence: data.boundary.sequence, type: data.boundary.type } }
}

export async function resolveSideEffectTurnInteractionApi({
  record, boundary, resolution, verificationConfirmed, confirmToolCallId, note, signal,
} = {}) {
  assertInteractionRecord(record, record, 'unknown')
  assertInteractionBoundary(boundary)
  if (verificationConfirmed !== true || confirmToolCallId !== record.toolCallId
    || !['committed', 'failed'].includes(resolution)) {
    throw interactionError('SIDE_EFFECT_RECOVERY_CONFIRMATION_REQUIRED', 'Confirm the verified result of this exact operation.')
  }
  const response = await fetch('/api/side-effects/resolve/turn', {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({
      sessionId: record.sessionId, turnId: record.turnId, toolCallId: record.toolCallId,
      argsDigest: record.argsDigest,
      boundary: { id: boundary.id, sequence: boundary.sequence, type: boundary.type },
      resolution, verificationConfirmed: true, confirmToolCallId: record.toolCallId,
      ...(typeof note === 'string' && note.trim() ? { note: note.trim() } : {}),
    }),
  })
  const data = await interactionJson(response)
  assertInteractionRecord(data?.record, record, resolution)
  const resume = safeSideEffectResumeDescriptor(record, data?.resume)
  if (data?.ok !== true || data.record.argsDigest !== record.argsDigest || !resume) {
    throw interactionError('SIDE_EFFECT_RECOVERY_RESPONSE_INVALID', 'The confirmation did not return a matching task continuation. Refresh its state.')
  }
  return { record: data.record, resume }
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
