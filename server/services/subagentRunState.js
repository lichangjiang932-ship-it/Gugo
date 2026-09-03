import { randomUUID } from 'node:crypto'
import {
  getActiveSubagentRunPersistencePort,
  prepareSubagentRunPersistencePort,
} from '../core/subagentRunPersistencePort.js'
import {
  SUBAGENT_PROVIDER_TRACE_EVENT,
  projectSubagentProviderProvenance,
} from './subagentProvider.js'
import {
  SUBAGENT_CHECKPOINT_EVENT,
  SUBAGENT_NEEDS_VERIFICATION,
  SUBAGENT_RECOVERY_EVENT,
  SUBAGENT_SIDE_EFFECT_RECOVERY_KIND,
} from './subagentRuntimePolicy.js'

function now() {
  return Date.now()
}

function parseTrace(value) {
  if (!value) return []
  try {
    const trace = typeof value === 'string' ? JSON.parse(value) : value
    // Persistence ports deliberately return deeply frozen DTOs. Runtime trace
    // assembly is mutable, so always detach the top-level event sequence.
    return Array.isArray(trace) ? [...trace] : []
  } catch {
    return []
  }
}

function publicTrace(trace) {
  return parseTrace(trace).filter((event) => event?.type !== SUBAGENT_CHECKPOINT_EVENT)
}

function providerProvenanceFromTrace(trace) {
  const event = parseTrace(trace).findLast((item) => item?.type === SUBAGENT_PROVIDER_TRACE_EVENT)
  return event ? projectSubagentProviderProvenance(event.provider) : null
}

function appendProviderProvenance(trace, value) {
  const provider = projectSubagentProviderProvenance(value)
  trace.push({ type: SUBAGENT_PROVIDER_TRACE_EVENT, provider, at: now() })
  return provider
}

function subagentProviderError(code, message, provider = {}) {
  const error = new Error(message)
  error.code = code
  error.retryable = false
  error.providerProvenance = projectSubagentProviderProvenance({
    pluginId: provider.pluginId,
    decision: 'error',
    error: code,
  })
  return error
}

function boundedRecoveryId(value, maxLength = 500) {
  const normalized = String(value || '').trim()
  return normalized ? normalized.slice(0, maxLength) : null
}

function checkpointExecutingToolCallId(state) {
  const calls = Array.isArray(state?.toolCalls) ? state.toolCalls : []
  return boundedRecoveryId(calls.findLast((call) => call?.checkpointStatus === 'executing')?.id)
}

function sideEffectRecoveryFields(error, { runId, checkpointState } = {}) {
  if (String(error?.code || '') !== 'SIDE_EFFECT_OUTCOME_UNKNOWN'
    || error?.unsafeToReplay !== true
    || error?.requiresUserVerification !== true) return null
  const toolCallId = boundedRecoveryId(error?.sideEffectExecution?.toolCallId)
    || checkpointExecutingToolCallId(checkpointState)
  return Object.freeze({
    runId: boundedRecoveryId(runId),
    toolCallId,
    requiresUserVerification: true,
    recoveryKind: SUBAGENT_SIDE_EFFECT_RECOVERY_KIND,
  })
}

function recoveryFieldsFromTrace(trace) {
  const event = parseTrace(trace).findLast((item) => item?.type === SUBAGENT_RECOVERY_EVENT)
  if (!event) return null
  const runId = boundedRecoveryId(event.runId)
  const toolCallId = boundedRecoveryId(event.toolCallId)
  if (!runId || !toolCallId || event.recoveryKind !== SUBAGENT_SIDE_EFFECT_RECOVERY_KIND) return null
  return {
    runId,
    toolCallId,
    requiresUserVerification: true,
    recoveryKind: SUBAGENT_SIDE_EFFECT_RECOVERY_KIND,
  }
}

function sideEffectRecoveryError(fields) {
  return Object.assign(
    new Error('Subagent side-effect outcome requires manual verification before explicit resume.'),
    {
      name: 'SubagentRecoveryBlockedError',
      code: 'SUBAGENT_SIDE_EFFECT_NEEDS_VERIFICATION',
      retryable: false,
      unsafeToReplay: true,
      ...fields,
    },
  )
}

function checkpointFromTrace(trace) {
  let latestLegacyState = null
  let sequencedCheckpoint = null
  for (const event of parseTrace(trace)) {
    if (event?.type !== SUBAGENT_CHECKPOINT_EVENT
        || !event.state
        || typeof event.state !== 'object') continue
    latestLegacyState = event.state
    const sequence = event.state.checkpointWriteSequence
    if (Number.isSafeInteger(sequence) && sequence > 0
        && (!sequencedCheckpoint || sequence > sequencedCheckpoint.sequence)) {
      sequencedCheckpoint = { sequence, state: event.state }
    }
  }
  return sequencedCheckpoint?.state || latestLegacyState
}

function traceWithCheckpoint(trace, state) {
  return [
    ...publicTrace(trace),
    { type: SUBAGENT_CHECKPOINT_EVENT, state, at: now() },
  ]
}

function subagentStatusForLoopResult(result) {
  if (result?.paused) return 'paused'
  if (result?.interrupted || result?.incomplete || result?.budgetExceeded || result?.noProgress) {
    return 'interrupted'
  }
  return 'completed'
}

export function newSubagentRunId() {
  return `subagent-${randomUUID()}`
}

function toRun(storedRun) {
  if (!storedRun) return null
  const storedTrace = parseTrace(storedRun.trace)
  const recovery = storedRun.status === SUBAGENT_NEEDS_VERIFICATION
    ? recoveryFieldsFromTrace(storedTrace)
    : null
  const trace = recovery
    ? [{ type: SUBAGENT_RECOVERY_EVENT, ...recovery }]
    : publicTrace(storedTrace)
  const provider = providerProvenanceFromTrace(storedTrace)
  return {
    id: storedRun.id,
    userId: storedRun.userId,
    parentSessionId: storedRun.parentSessionId,
    parentMessageId: storedRun.parentMessageId,
    agentType: storedRun.agentType,
    prompt: storedRun.prompt,
    modelName: storedRun.modelName || null,
    modelProviderId: storedRun.modelProviderId || null,
    modelConfigRevision: Number.isInteger(storedRun.modelConfigRevision)
      ? storedRun.modelConfigRevision
      : null,
    status: storedRun.status,
    resultText: storedRun.resultText || '',
    trace,
    ...(provider ? { provider } : {}),
    team: trace.find((event) => event?.type === 'team')?.team || null,
    transcript: trace.filter((event) => event?.type === 'transcript'),
    tokensIn: storedRun.tokensIn,
    tokensOut: storedRun.tokensOut,
    createdAt: storedRun.createdAt,
    finishedAt: storedRun.finishedAt,
    ...(recovery || {}),
  }
}

function resolveRunPersistencePort(port) {
  return port
    ? prepareSubagentRunPersistencePort(port)
    : getActiveSubagentRunPersistencePort()
}

async function insertRun(port, { id, userId, type, prompt, parentSessionId = null, parentMessageId = null, modelName = null, modelProviderId = null, modelConfigRevision = null, trace = [] }) {
  return port.createRun({
    id,
    userId,
    parentSessionId,
    parentMessageId,
    agentType: type,
    prompt,
    modelName,
    modelProviderId,
    modelConfigRevision,
    trace,
    createdAt: now(),
  })
}

async function markRunRunning(port, { id, userId, trace }) {
  return port.markRunning({ id, userId, trace, startedAt: now() })
}

async function saveRunTrace(port, { id, userId, trace }) {
  return port.saveRunningTrace({ id, userId, trace })
}

async function saveRunCheckpoint(port, { id, userId, trace, state }) {
  if (!state || typeof state !== 'object') throw new Error('checkpoint state must be an object')
  const checkpointTrace = traceWithCheckpoint(trace, state)
  const checkpointWriteSequence = Number(state.checkpointWriteSequence)
  const saved = await port.saveRunningTrace({
    id,
    userId,
    trace: checkpointTrace,
    ...(Number.isSafeInteger(checkpointWriteSequence) && checkpointWriteSequence > 0
      ? { checkpointWriteSequence }
      : {}),
  })
  const persistedTrace = parseTrace(saved?.trace)
  const persistedState = checkpointFromTrace(persistedTrace) || state
  trace.splice(0, trace.length, ...persistedTrace)
  return { state: persistedState }
}

function makeCheckpointResumable(state) {
  if (!state || typeof state !== 'object') return state || null
  const iterations = Math.max(0, Number(state.iterations) || 0)
  const previousWriteSequence = Number(state.checkpointWriteSequence)
  const checkpointWriteSequence = Number.isSafeInteger(previousWriteSequence)
    && previousWriteSequence > 0
    ? previousWriteSequence + 1
    : 1
  if (!Number.isSafeInteger(checkpointWriteSequence)) {
    throw Object.assign(new Error('subagent checkpoint write sequence exhausted'), {
      code: 'SUBAGENT_CHECKPOINT_SEQUENCE_EXHAUSTED',
    })
  }
  return {
    ...state,
    checkpointWriteSequence,
    final: null,
    iterationWindowStart: iterations,
  }
}

async function updateRun(port, { id, userId, status, resultText = '', trace = [] }) {
  const storedRun = await port.finishRun({
    id,
    userId,
    status,
    resultText,
    trace,
    finishedAt: now(),
  })
  if (!storedRun) throw new Error('subagent run not found')
  return toRun(storedRun)
}

export async function getSubagentRun({ userId, id }, { persistencePort = null } = {}) {
  const port = resolveRunPersistencePort(persistencePort)
  return toRun(await port.getRun({ userId, id }))
}

export async function recoverInterruptedSubagentRuns({
  at = now(),
  persistencePort = null,
} = {}) {
  const port = resolveRunPersistencePort(persistencePort)
  const rows = await port.listRunningRuns()
  if (!rows.length) return 0
  let changed = 0
  for (const row of rows) {
    const trace = parseTrace(row.trace)
    trace.push({
      type: 'interrupted',
      reason: 'service_restart',
      resumable: Boolean(checkpointFromTrace(trace)),
      at,
    })
    const receipt = await port.interruptRunningRun({
      id: row.id,
      userId: row.userId,
      status: 'interrupted',
      resultText: '子代理因服务重启而中断；可使用原运行 ID 重试并从 checkpoint 继续。',
      trace,
      finishedAt: at,
    })
    if (receipt.interrupted) changed += 1
  }
  return changed
}

export {
  appendProviderProvenance,
  boundedRecoveryId,
  checkpointFromTrace,
  insertRun,
  makeCheckpointResumable,
  markRunRunning,
  now,
  parseTrace,
  providerProvenanceFromTrace,
  publicTrace,
  recoveryFieldsFromTrace,
  resolveRunPersistencePort,
  saveRunCheckpoint,
  saveRunTrace,
  sideEffectRecoveryError,
  sideEffectRecoveryFields,
  subagentProviderError,
  subagentStatusForLoopResult,
  toRun,
  traceWithCheckpoint,
  updateRun,
}
