import { authHeaders, jsonOk } from './agentClient.js'
import { resumeServerTurnRequest } from './turnClient/turnRequests.js'

function requiredId(value, name) {
  const normalized = String(value || '').trim()
  if (!normalized) {
    throw Object.assign(new Error(`${name} is required`), {
      code: 'MODEL_REQUEST_RECOVERY_TARGET_REQUIRED',
    })
  }
  return normalized
}

function normalizedTarget(target = {}) {
  const requestedScope = String(target.scopeKind || '').trim()
  const useJob = requestedScope === 'job'
    || (!requestedScope && (target.jobId || target.stepId))
  if (requestedScope && !['turn', 'job'].includes(requestedScope)) {
    throw Object.assign(new Error('scopeKind must be turn or job'), {
      code: 'MODEL_REQUEST_RECOVERY_TARGET_REQUIRED',
    })
  }
  if (useJob) {
    return {
      scopeKind: 'job',
      jobId: requiredId(target.jobId, 'jobId'),
      stepId: requiredId(target.stepId, 'stepId'),
    }
  }
  return {
    scopeKind: 'turn',
    sessionId: requiredId(target.sessionId, 'sessionId'),
    turnId: requiredId(target.turnId, 'turnId'),
  }
}

function recoveryEndpoint(target) {
  if (target.scopeKind === 'job') {
    return `/api/jobs/${encodeURIComponent(target.jobId)}/steps/${encodeURIComponent(target.stepId)}/model-request-recovery`
  }
  const query = new URLSearchParams({ sessionId: target.sessionId })
  return `/api/turns/${encodeURIComponent(target.turnId)}/model-request-recovery?${query}`
}

function resumeDescriptor(resume, target) {
  if (target.scopeKind === 'job') {
    return resume?.jobId === target.jobId && resume?.stepId === target.stepId
      ? { ready: resume.ready === true, jobId: target.jobId, stepId: target.stepId }
      : null
  }
  return resume?.sessionId === target.sessionId && resume?.turnId === target.turnId
    ? { ready: resume.ready === true, sessionId: target.sessionId, turnId: target.turnId }
    : null
}

export function parseModelRecoveryTarget(search, activeSessionId = '') {
  const params = new URLSearchParams(search)
  const scopeKind = String(params.get('scopeKind') || '').trim()
  const modelRequestId = String(params.get('modelRequestId') || '').trim()
  const jobId = String(params.get('jobId') || '').trim()
  const stepId = String(params.get('stepId') || '').trim()
  if (scopeKind === 'job' || jobId || stepId) {
    if (!jobId || !stepId) return null
    return {
      scopeKind: 'job',
      jobId,
      stepId,
      ...(modelRequestId ? { modelRequestId } : {}),
    }
  }
  if (scopeKind && scopeKind !== 'turn') return null
  const sessionId = String(params.get('sessionId') || activeSessionId || '').trim()
  const turnId = String(params.get('turnId') || '').trim()
  if (!sessionId || !turnId) return null
  return {
    scopeKind: 'turn',
    sessionId,
    turnId,
    ...(modelRequestId ? { modelRequestId } : {}),
  }
}

export async function getModelRequestRecoveryApi(input = {}) {
  const target = normalizedTarget(input)
  const response = await fetch(
    recoveryEndpoint(target),
    { headers: authHeaders(), signal: input.signal },
  )
  const data = await jsonOk(response)
  return data?.recovery || null
}

export async function resolveModelRequestRecoveryApi(input = {}) {
  const {
  recovery,
  resolution,
  verificationConfirmed,
  confirmModelRequestId,
  response: modelResponse,
  receipt,
  note,
  } = input
  const target = normalizedTarget(input)
  const modelRequestId = requiredId(recovery?.modelRequestId, 'modelRequestId')
  if (verificationConfirmed !== true
    || String(confirmModelRequestId || '').trim() !== modelRequestId) {
    throw Object.assign(
      new Error('Model request recovery requires confirmation for the exact request ID.'),
      { code: 'MODEL_REQUEST_RECOVERY_CONFIRMATION_REQUIRED' },
    )
  }
  const body = {
    ...(target.scopeKind === 'job'
      ? { checkpointRevision: recovery.checkpointRevision }
      : {
          sessionId: target.sessionId,
          checkpointSequence: recovery.checkpointSequence,
        }),
    modelRequestId,
    requestFingerprint: recovery.requestFingerprint,
    providerId: recovery.providerId,
    modelName: recovery.modelName,
    configRevision: recovery.configRevision,
    idempotencyKey: recovery.idempotencyKey,
    confirmModelRequestId: modelRequestId,
    verificationConfirmed: true,
    resolution,
    ...(modelResponse !== undefined ? { response: modelResponse } : {}),
    ...(receipt !== undefined ? { receipt } : {}),
    ...(String(note || '').trim() ? { note: String(note).trim() } : {}),
  }
  const response = await fetch(
    `${recoveryEndpoint(target).split('?')[0]}/resolve`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(body),
      signal: input.signal,
    },
  )
  const data = await jsonOk(response)
  return {
    recovery: data?.recovery || null,
    resume: resumeDescriptor(data?.resume, target),
  }
}

export async function resumeResolvedModelRequestApi(input = {}) {
  const target = normalizedTarget(input)
  if (target.scopeKind === 'turn') {
    return resumeServerTurnRequest({
      sessionId: target.sessionId,
      turnId: target.turnId,
      retryRecovery: true,
      signal: input.signal,
    })
  }
  const response = await fetch(`${recoveryEndpoint(target)}/resume`, {
    method: 'POST',
    headers: authHeaders(),
    signal: input.signal,
  })
  return jsonOk(response)
}
