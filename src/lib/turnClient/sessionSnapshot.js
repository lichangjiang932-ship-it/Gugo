import { TOOL_CALL_STATUS } from '../../store/taskStatus.js'
import { normalizeModelUsage } from '../../../shared/modelUsage.js'
import { modelAuthoredTurnEvidenceText } from '../../../shared/turnEvidenceText.js'
import { removeVerifiedLocalFilesFromRetained } from '../localFileReferences.js'
import { DEFAULT_SNAPSHOT_PAGE_SIZE, DEFAULT_SNAPSHOT_REVISION_ATTEMPTS, headers, parseResponse } from './turnTransport.js'

function parseToolResult(content) {
  try { return JSON.parse(content) } catch { return null }
}

function finiteTimestamp(value) {
  if (value == null || value === '') return null
  const normalized = Number(value)
  return Number.isFinite(normalized) && normalized >= 0 ? normalized : null
}

function nonNegativeInteger(value) {
  if (value == null || value === '') return null
  const normalized = Number(value)
  return Number.isInteger(normalized) && normalized >= 0 ? normalized : null
}

function snapshotLastSequence(context) {
  if (!context || typeof context !== 'object') return null
  for (const key of [
    'serverLastSequence',
    'server_last_sequence',
    'lastSequence',
    'last_sequence',
    'eventSequence',
    'event_sequence',
    'pausedSequence',
    'paused_sequence',
  ]) {
    const sequence = nonNegativeInteger(context[key])
    if (sequence !== null) return sequence
  }
  return null
}

function snapshotText(value, fallback = '') {
  if (typeof value === 'string') return value
  if (value == null) return fallback
  try { return JSON.stringify(value) } catch { return String(value) }
}

function normalizeSnapshotToolCall(call) {
  const id = String(call?.id || '').trim()
  const name = String(call?.function?.name || call?.name || '').trim()
  if (!id || !name) return null
  return {
    id,
    type: 'function',
    function: {
      name,
      arguments: snapshotText(
        call?.function?.arguments ?? call?.arguments ?? call?.argumentsText ?? call?.args ?? {},
        '{}',
      ),
    },
  }
}

function unavailableToolResult(call) {
  return {
    role: 'tool',
    tool_call_id: call.id,
    name: call.function.name,
    content: JSON.stringify({
      ok: false,
      code: 'tool_result_unavailable',
      error: 'The prior tool result was not retained by the server.',
    }),
  }
}

function importedToolTrace(message, messageIndex, resultRows, consumedRows) {
  const calls = (Array.isArray(message?.modelContext?.toolCalls) ? message.modelContext.toolCalls : [])
    .map(normalizeSnapshotToolCall)
    .filter(Boolean)
  if (!calls.length) return []

  const results = calls.map((call) => {
    const match = resultRows.get(call.id)?.find((entry) => (
      entry.index > messageIndex && !consumedRows.has(entry.index)
    ))
    if (!match) return unavailableToolResult(call)
    consumedRows.add(match.index)
    const context = match.message?.modelContext && typeof match.message.modelContext === 'object'
      ? match.message.modelContext
      : {}
    return {
      role: 'tool',
      tool_call_id: call.id,
      name: String(context.name || call.function.name),
      content: snapshotText(match.message?.content),
    }
  })
  return [{ role: 'assistant', content: '', tool_calls: calls }, ...results]
}

function toolCallsFromContext(context) {
  const calls = []
  const byId = new Map()
  for (const message of Array.isArray(context?.toolTrace) ? context.toolTrace : []) {
    if (message?.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        const entry = {
          id: call?.id,
          name: call?.function?.name || '',
          arguments: call?.function?.arguments || '{}',
          status: TOOL_CALL_STATUS.RUNNING,
        }
        if (!entry.id) continue
        calls.push(entry)
        byId.set(entry.id, entry)
      }
    } else if (message?.role === 'tool') {
      const entry = byId.get(message.tool_call_id)
      if (!entry) continue
      const parsed = parseToolResult(message.content)
      entry.status = parsed?.ok === false ? TOOL_CALL_STATUS.ERROR : TOOL_CALL_STATUS.SUCCESS
      entry.result = String(message.content || '')
      entry.error = parsed?.ok === false ? parsed?.error || 'Tool call failed' : undefined
      entry.errorCode = parsed?.ok === false && parsed?.code ? String(parsed.code) : undefined
      entry.errorStatus = parsed?.ok === false && Number.isInteger(parsed?.status)
        ? parsed.status
        : undefined
      entry.retryable = parsed?.ok === false ? parsed?.retryable === true : undefined
      entry.errorHint = parsed?.ok === false && parsed?.hint ? String(parsed.hint) : undefined
      entry.attempts = parsed?.ok === false && Number.isInteger(parsed?.attempts)
        ? parsed.attempts
        : undefined
      entry.approvalAuthorization = parsed?.approvalAuthorization || null
    }
  }
  return calls
}

function optionalContextArtifactIds(context, key) {
  if (!context || typeof context !== 'object' || !Object.hasOwn(context, key)) return undefined
  return [...new Set((Array.isArray(context[key]) ? context[key] : [])
    .map((id) => String(id || '').trim())
    .filter(Boolean))]
}

function recoveredArtifactUrl(value) {
  const url = String(value || '').trim()
  return url.startsWith('/api/artifacts/') ? url : ''
}

function normalizeRecoveredToolArtifact(value, toolCallId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const id = String(value.id || value.artifactId || '').trim()
  const filename = String(value.filename || '').trim().split(/[\\/]/).pop() || ''
  const url = recoveredArtifactUrl(value.url || value.downloadUrl)
  if (!id || !filename || !url) return null
  return {
    id,
    filename,
    url,
    toolCallId: String(toolCallId || ''),
    ...(value.title ? { title: String(value.title) } : {}),
    ...(value.type ? { type: String(value.type) } : {}),
    ...(value.mimeType ? { mimeType: String(value.mimeType) } : {}),
  }
}

/**
 * Older snapshots did not always copy persisted artifacts onto the assistant
 * message. Recover only server-selected deliverables from successful, stored
 * tool results; assistant prose is never treated as artifact evidence.
 */
function recoverSelectedToolArtifacts(context, deliveryArtifactIds) {
  if (!Array.isArray(deliveryArtifactIds) || deliveryArtifactIds.length === 0) return []
  const selected = new Set(deliveryArtifactIds)
  const recovered = new Map()
  const toolTrace = Array.isArray(context?.toolTrace) ? context.toolTrace : []
  const declaredCallIds = new Set(toolTrace.flatMap((trace) => (
    trace?.role === 'assistant' && Array.isArray(trace.tool_calls)
      ? trace.tool_calls.map((call) => String(call?.id || '').trim()).filter(Boolean)
      : []
  )))
  for (const trace of toolTrace) {
    if (trace?.role !== 'tool') continue
    const toolCallId = String(trace.tool_call_id || '').trim()
    if (!toolCallId || !declaredCallIds.has(toolCallId)) continue
    const parsed = parseToolResult(trace.content)
    if (parsed?.ok !== true) continue
    const result = parsed.result && typeof parsed.result === 'object' && !Array.isArray(parsed.result)
      ? parsed.result
      : parsed
    const candidates = [
      ...(Array.isArray(result.artifacts) ? result.artifacts : []),
      ...(result.artifact && typeof result.artifact === 'object' ? [result.artifact] : []),
      ...(result.artifactId ? [{
        artifactId: result.artifactId,
        filename: result.filename,
        url: result.url || result.downloadUrl,
        title: result.title,
        type: result.type,
        mimeType: result.mimeType,
      }] : []),
    ]
    for (const candidate of candidates) {
      const artifact = normalizeRecoveredToolArtifact(candidate, toolCallId)
      if (artifact && selected.has(artifact.id) && !recovered.has(artifact.id)) {
        recovered.set(artifact.id, artifact)
      }
    }
  }
  return deliveryArtifactIds.map((id) => recovered.get(id)).filter(Boolean)
}

function optionalContextLocalFileReceipts(context, key, timestampKey) {
  if (!context || typeof context !== 'object' || !Object.hasOwn(context, key)) return undefined
  const seen = new Set()
  return (Array.isArray(context[key]) ? context[key] : [])
    .map((file) => {
      const id = String(file?.id || '').trim()
      const path = String(file?.path || '').trim()
      const filename = String(file?.filename || '').trim()
      if (!id || !path || !filename || seen.has(id)) return null
      seen.add(id)
      return {
        id,
        path,
        filename,
        ...(Number.isFinite(Number(file?.size)) ? { size: Math.max(0, Number(file.size)) } : {}),
        ...(Number.isFinite(Number(file?.[timestampKey]))
          ? { [timestampKey]: Math.max(0, Number(file[timestampKey])) }
          : {}),
        ...(Array.isArray(file?.relatedArtifactIds) && file.relatedArtifactIds.length > 0
          ? { relatedArtifactIds: [...new Set(file.relatedArtifactIds.map(String).filter(Boolean))] }
          : {}),
      }
    })
    .filter(Boolean)
}

function optionalContextVerifiedLocalFiles(context) {
  return optionalContextLocalFileReceipts(context, 'verifiedLocalFiles', 'verifiedAt')
}

function optionalContextRetainedLocalFiles(context) {
  return optionalContextLocalFileReceipts(context, 'retainedLocalFiles', 'retainedAt')
}

function modelAuthoredEvidenceText(message, failure, state) {
  // Older servers persisted their localized fallback error as assistant
  // content when no model text existed. Keep that durable row intact, but do
  // not reclassify the fallback as model-authored partial output on reload.
  return modelAuthoredTurnEvidenceText({
    content: message?.content,
    failureMessage: failure?.message,
    state,
  })
}

function turnEvidenceMeta(message) {
  const context = message?.modelContext && typeof message.modelContext === 'object'
    ? message.modelContext
    : {}
  const state = context.turnEvidence === true ? String(context.evidenceState || '') : ''
  if (!['blocked', 'cancelled', 'failed', 'interrupted'].includes(state)) return {}

  const failure = context.error && typeof context.error === 'object' ? context.error : null
  const artifactIds = [...new Set((Array.isArray(context.artifactIds) ? context.artifactIds : [])
    .map((id) => String(id || '').trim())
    .filter(Boolean))]
  const iterations = Number.isInteger(context.iterations) && context.iterations >= 0
    ? context.iterations
    : undefined
  const deliveryArtifactIds = optionalContextArtifactIds(context, 'deliveryArtifactIds')
  const recovery = context.recovery && typeof context.recovery === 'object'
    && !Array.isArray(context.recovery)
    ? context.recovery
    : null
  const sideEffectUnknown = state === 'blocked'
    && recovery?.requiresUserVerification === true
    && ['side_effect_unknown', 'side_effect_outcome_unknown'].includes(recovery?.recoveryKind)
  const modelRequestUnknown = state === 'blocked'
    && recovery?.requiresUserVerification === true
    && recovery?.recoveryKind === 'model_request_outcome_unknown'
  const recoveryToolCallId = sideEffectUnknown
    ? String(recovery?.toolCallId || '').trim().slice(0, 200)
    : ''
  const recoveryModelRequestId = modelRequestUnknown
    ? String(recovery?.modelRequestId || '').trim().slice(0, 200)
    : ''

  return {
    ...(state === 'failed'
      ? { failed: true }
      : state === 'cancelled'
        ? {
            cancelled: true,
            streaming: false,
            serverConnectionState: 'cancelled',
          }
        : state === 'interrupted'
          ? {
              interrupted: true,
              streaming: true,
              turnCompletedAt: null,
              latency: null,
              serverConnectionState: 'interrupted',
            }
          : {
              failed: false,
              paused: false,
              streaming: false,
              turnCompletedAt: null,
              latency: null,
              serverConnectionState: 'blocked',
              serverRecoveryBlocked: true,
              serverRecoveryKind: sideEffectUnknown
                ? 'side_effect_outcome_unknown'
                : modelRequestUnknown ? 'model_request_outcome_unknown' : null,
              serverRecoveryToolCallId: recoveryToolCallId || null,
              ...(recoveryModelRequestId ? { serverRecoveryModelRequestId: recoveryModelRequestId } : {}),
              serverRecoveryActionPath: (sideEffectUnknown || modelRequestUnknown)
                && recovery?.recoveryAction?.kind === 'open_settings'
                && recovery?.recoveryAction?.path === '/settings?tab=recovery'
                ? '/settings?tab=recovery'
                : null,
            }),
    serverFailure: failure,
    serverPartialText: modelAuthoredEvidenceText(message, failure, state),
    serverArtifactIds: artifactIds,
    ...(deliveryArtifactIds !== undefined ? { serverDeliveryArtifactIds: deliveryArtifactIds } : {}),
    ...(iterations !== undefined ? { serverIterations: iterations } : {}),
  }
}

function pausedTurnMeta(message) {
  const context = message?.modelContext && typeof message.modelContext === 'object'
    ? message.modelContext
    : {}
  if (context.paused !== true) return {}

  const clarification = context.clarification
    && typeof context.clarification === 'object'
    && !Array.isArray(context.clarification)
    ? { ...context.clarification }
    : null
  const pausedSequence = Number(context.pausedSequence ?? context.paused_sequence)

  return {
    paused: true,
    serverConnectionState: 'paused',
    serverClarification: clarification,
    directoryAuthorizationPending: false,
    serverResumeResolution: null,
    ...(Number.isInteger(pausedSequence) && pausedSequence >= 0
      ? { serverLastSequence: pausedSequence }
      : {}),
  }
}

function activeTurnRecoveryStub(rawMessages) {
  const assistantTurnIds = new Set()
  let latestCanonicalUser = null
  let latestTimestamp = 0

  for (const message of rawMessages) {
    latestTimestamp = Math.max(
      latestTimestamp,
      Number(message?.updatedAt ?? message?.createdAt) || 0,
    )
    const turnId = String(message?.modelContext?.turnId || '').trim()
    if (!turnId) continue
    if (message.role === 'assistant') {
      assistantTurnIds.add(turnId)
      continue
    }
    if (message.role === 'user' && String(message.id || '') === `${turnId}:user`) {
      latestCanonicalUser = { message, turnId }
    }
  }

  if (!latestCanonicalUser || assistantTurnIds.has(latestCanonicalUser.turnId)) return null
  const { message, turnId } = latestCanonicalUser
  return {
    id: `${turnId}:assistant`,
    role: 'assistant',
    content: '',
    timestamp: latestTimestamp || Number(message.updatedAt ?? message.createdAt) || 0,
    meta: {
      serverTurnId: turnId,
      serverLastSequence: -1,
      serverRecoveryStub: true,
      streaming: true,
    },
  }
}

export function normalizeServerSessionSnapshot(snapshot) {
  if (!snapshot || snapshot.complete !== true) return null
  const rawMessages = Array.isArray(snapshot.messages) ? snapshot.messages : []
  const resultRows = new Map()
  const legacyTurnStartedAt = new Map()
  rawMessages.forEach((message, index) => {
    if (message?.role === 'user') {
      const turnId = String(message?.modelContext?.turnId || '').trim()
      const createdAt = finiteTimestamp(message?.createdAt)
      if (turnId && createdAt !== null) legacyTurnStartedAt.set(turnId, createdAt)
    }
    if (message?.role !== 'tool') return
    const callId = String(
      message?.modelContext?.toolCallId || message?.tool_call_id || message?.toolCallId || '',
    ).trim()
    if (!callId) return
    const entries = resultRows.get(callId) || []
    entries.push({ index, message })
    resultRows.set(callId, entries)
  })
  const consumedRows = new Set()
  const messages = rawMessages
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => message.role === 'user' || message.role === 'assistant')
    .map(({ message, index: messageIndex }) => {
      const steeringClientRequestId = message.role === 'user'
        ? String(
            message?.modelContext?.steeringClientRequestId
              || message?.modelContext?.clientRequestId
              || '',
          ).trim()
        : ''
      const explicitTrace = Array.isArray(message?.modelContext?.toolTrace)
        ? message.modelContext.toolTrace.map((entry) => ({ ...entry }))
        : []
      const toolTrace = message.role === 'assistant' && explicitTrace.length === 0
        ? importedToolTrace(message, messageIndex, resultRows, consumedRows)
        : explicitTrace
      const toolCalls = message.role === 'assistant'
        ? toolCallsFromContext({ toolTrace })
        : []
      const serverDeliveryArtifactIds = message.role === 'assistant'
        ? optionalContextArtifactIds(message?.modelContext, 'deliveryArtifactIds')
        : undefined
      const persistedArtifacts = message.role === 'assistant' && Array.isArray(message?.artifacts)
        ? message.artifacts.filter((artifact) => artifact?.id && artifact?.url && artifact?.filename)
        : []
      const serverArtifacts = persistedArtifacts.length > 0
        ? persistedArtifacts
        : recoverSelectedToolArtifacts(message?.modelContext, serverDeliveryArtifactIds)
      const verifiedLocalFiles = message.role === 'assistant'
        ? optionalContextVerifiedLocalFiles(message?.modelContext)
        : undefined
      const retainedLocalFiles = message.role === 'assistant'
        ? removeVerifiedLocalFilesFromRetained(
            optionalContextRetainedLocalFiles(message?.modelContext),
            verifiedLocalFiles,
          )
        : undefined
      const modelUsage = message.role === 'assistant'
        ? normalizeModelUsage(message?.modelContext?.usage)
        : null
      const turnModelUsage = message.role === 'assistant'
        ? normalizeModelUsage(message?.modelContext?.turnModelUsage)
        : null
      const estimatedPromptTokens = message.role === 'assistant'
        ? nonNegativeInteger(message?.modelContext?.estimatedPromptTokens)
        : null
      const assistantTurnId = message.role === 'assistant'
        ? String(message?.modelContext?.turnId || '').trim()
        : ''
      const evidenceState = message.role === 'assistant'
        && message?.modelContext?.turnEvidence === true
        ? String(message.modelContext.evidenceState || '')
        : ''
      const interrupted = evidenceState === 'interrupted'
      const serverLastSequence = message.role === 'assistant'
        ? snapshotLastSequence(message?.modelContext)
        : null
      const storedTurnStartedAt = message.role === 'assistant'
        ? finiteTimestamp(message?.modelContext?.turnStartedAt)
        : null
      const turnStartedAt = storedTurnStartedAt
        ?? (assistantTurnId ? legacyTurnStartedAt.get(assistantTurnId) ?? null : null)
      const storedTurnCompletedAt = message.role === 'assistant'
        ? finiteTimestamp(message?.modelContext?.turnCompletedAt)
        : null
      const turnCompletedAt = interrupted
        ? null
        : storedTurnCompletedAt
          ?? (message.role === 'assistant' ? finiteTimestamp(message?.createdAt) : null)
      const storedLatency = message.role === 'assistant'
        ? finiteTimestamp(message?.modelContext?.latency)
        : null
      const latency = storedLatency ?? (
        turnStartedAt !== null && turnCompletedAt !== null
          ? Math.max(0, turnCompletedAt - turnStartedAt)
          : null
      )
      const storedAttachments = message?.attachments ?? message?.modelContext?.attachments
      const attachments = message.role === 'user' && Array.isArray(storedAttachments)
        ? storedAttachments.filter((attachment) => attachment?.id).map((attachment) => ({
            id: String(attachment.id),
            name: String(attachment.name || 'attachment').split(/[\\/]/).pop(),
            mimeType: String(attachment.mimeType || 'application/octet-stream'),
            size: Math.max(0, Number(attachment.size) || 0),
            sha256: String(attachment.sha256 || ''),
            downloadUrl: String(attachment.downloadUrl || ''),
          }))
        : []
      return {
        id: message.id || (steeringClientRequestId ? `steer:${steeringClientRequestId}` : undefined),
        role: message.role,
        content: message.content,
        timestamp: message.createdAt,
        ...(attachments.length ? { attachments } : {}),
        ...(steeringClientRequestId ? {
          meta: {
            steering: true,
            steeringClientRequestId,
            serverTurnId: message.modelContext?.turnId || null,
            serverAuthoritative: true,
          },
        } : {}),
        ...(message.role === 'assistant' ? {
          meta: {
            serverTurnId: message.modelContext?.turnId || null,
            streaming: false,
            serverAuthoritative: true,
            toolCalls,
            ...(toolTrace.length ? { toolTrace } : {}),
            ...(serverArtifacts.length ? { serverArtifacts } : {}),
            ...(serverDeliveryArtifactIds !== undefined ? { serverDeliveryArtifactIds } : {}),
            ...(verifiedLocalFiles !== undefined ? { verifiedLocalFiles } : {}),
            ...(retainedLocalFiles !== undefined ? { retainedLocalFiles } : {}),
            ...(modelUsage ? {
              modelUsage,
              actualPromptTokens: modelUsage.promptTokens,
            } : {}),
            ...(turnModelUsage ? { turnModelUsage } : {}),
            ...(estimatedPromptTokens !== null
              ? { serverEstimatedPromptTokens: estimatedPromptTokens }
              : {}),
            ...(turnStartedAt !== null ? { turnStartedAt } : {}),
            ...(turnCompletedAt !== null ? { turnCompletedAt } : {}),
            ...(latency !== null ? { latency } : {}),
            ...(serverLastSequence !== null
              ? { serverLastSequence }
              : interrupted ? { serverLastSequence: -1 } : {}),
            ...turnEvidenceMeta(message),
            ...pausedTurnMeta(message),
          },
        } : {}),
      }
    })
  const recoveryStub = activeTurnRecoveryStub(rawMessages)
  if (recoveryStub && !messages.some((message) => message.id === recoveryStub.id)) {
    messages.push(recoveryStub)
  }
  return {
    ...snapshot,
    messages,
  }
}

function snapshotSyncError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

export async function fetchServerSessionSnapshot({
  sessionId,
  signal,
  fetchImpl = fetch,
  pageSize = DEFAULT_SNAPSHOT_PAGE_SIZE,
  revisionAttempts = DEFAULT_SNAPSHOT_REVISION_ATTEMPTS,
}) {
  const safePageSize = Math.max(1, Math.min(2000, Number(pageSize) || DEFAULT_SNAPSHOT_PAGE_SIZE))
  const safeAttempts = Math.max(1, Number(revisionAttempts) || DEFAULT_SNAPSHOT_REVISION_ATTEMPTS)

  for (let attempt = 0; attempt < safeAttempts; attempt += 1) {
    let offset = 0
    let revision = null
    let totalMessages = null
    let firstPage = null
    const messages = []

    while (true) {
      const query = new URLSearchParams({ limit: String(safePageSize), offset: String(offset) })
      const response = await fetchImpl(
        `/api/sessions/${encodeURIComponent(sessionId)}/snapshot?${query}`,
        { headers: headers(), signal },
      )
      const page = (await parseResponse(response)).snapshot
      if (!page || !Array.isArray(page.messages) || !Number.isInteger(page.revision)) {
        throw snapshotSyncError('INVALID_SESSION_SNAPSHOT', 'Server returned an invalid session snapshot page')
      }

      if (revision === null) {
        revision = page.revision
        totalMessages = Number.isInteger(page.totalMessages) ? page.totalMessages : null
        firstPage = page
      } else if (page.revision !== revision
        || (Number.isInteger(page.totalMessages) && totalMessages !== page.totalMessages)) {
        break
      }

      messages.push(...page.messages)
      if (page.complete === true) {
        if (totalMessages !== null && messages.length !== totalMessages) {
          throw snapshotSyncError(
            'INCOMPLETE_SESSION_SNAPSHOT',
            `Server completed a session snapshot with ${messages.length} of ${totalMessages} messages`,
          )
        }
        return normalizeServerSessionSnapshot({
          ...firstPage,
          ...page,
          session: firstPage.session || page.session,
          messages,
          revision,
          totalMessages: totalMessages ?? messages.length,
          offset: 0,
          nextOffset: null,
          complete: true,
        })
      }

      const nextOffset = Number(page.nextOffset)
      if (!Number.isInteger(nextOffset) || nextOffset <= offset) {
        throw snapshotSyncError('INVALID_SESSION_SNAPSHOT_PAGE', 'Session snapshot pagination did not advance')
      }
      offset = nextOffset
    }
  }

  throw snapshotSyncError(
    'SESSION_SNAPSHOT_CHANGED',
    'Session changed while its snapshot was being downloaded',
  )
}

