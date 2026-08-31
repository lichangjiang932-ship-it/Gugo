import { extractVerifiedLocalFiles, recoverLegacyVerifiedLocalFiles } from './turnMessageContext.js'
import {
  missingRequirementsForIncompleteReason,
  normalizeIncompleteReason,
  normalizeTurnFailure,
} from './turnTerminalProjection.js'
import {
  isSuccessfulTurnCompletedEvent,
  projectTurnEventForClient,
} from '../../shared/turnEventProjection.js'

function parseModelContext(value) {
  if (!value) return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0 ? parsed : null
  } catch {
    return null
  }
}

export function withRecoveredVerifiedLocalFiles(message) {
  const context = message?.modelContext
  if (message?.role !== 'assistant'
    || !context
    || typeof context !== 'object'
    || Object.hasOwn(context, 'verifiedLocalFiles')) {
    return message
  }
  const options = {
    userId: message.userId,
    verifiedAt: context.turnCompletedAt || message.updatedAt || message.createdAt,
  }
  const verifiedLocalFiles = extractVerifiedLocalFiles(context.toolTrace, options)
  const compatibleVerifiedLocalFiles = verifiedLocalFiles.length > 0
    ? verifiedLocalFiles
    : recoverLegacyVerifiedLocalFiles(context.toolTrace, options)
  if (compatibleVerifiedLocalFiles.length === 0) return message
  // Older messages predate persisted receipts. Enrich only this read response;
  // the database remains unchanged and the download route independently
  // reconstructs and authorizes the same deterministic receipt.
  return {
    ...message,
    modelContext: { ...context, verifiedLocalFiles: compatibleVerifiedLocalFiles },
  }
}

function incompleteCheckpointMetadata(stateJson) {
  const state = parseModelContext(stateJson)
  const final = state?.final
  if (!final || typeof final !== 'object' || Array.isArray(final) || final.incomplete !== true) {
    return null
  }
  const budgetExceeded = typeof final.budgetExceeded === 'boolean'
    ? final.budgetExceeded
    : undefined
  const noProgress = typeof final.noProgress === 'boolean'
    ? final.noProgress
    : undefined
  const rawReason = String(final.reason || '').trim().toLowerCase()
  const incompleteReason = budgetExceeded === true
    ? 'execution_budget_exhausted'
    : noProgress === true
      ? 'tool_no_progress'
      : (rawReason ? normalizeIncompleteReason(rawReason, '') : '')
  const recordedMissingRequirements = [...new Set(
    (Array.isArray(final.missingRequirements) ? final.missingRequirements : [])
      .map((value) => String(value || '').trim().toLowerCase())
      .filter((value) => /^[a-z][a-z0-9_]{1,95}$/u.test(value)),
  )].slice(0, 16)
  const rawNextAction = String(final.nextAction || '').trim().toLowerCase().slice(0, 80)
  const nextAction = /^[a-z][a-z0-9_]{0,79}$/u.test(rawNextAction) ? rawNextAction : ''
  return {
    ...(incompleteReason
      ? {
          incompleteReason,
          missingRequirements: recordedMissingRequirements.length > 0
            ? recordedMissingRequirements
            : missingRequirementsForIncompleteReason(incompleteReason),
        }
      : {}),
    ...(typeof final.retryable === 'boolean' ? { retryable: final.retryable } : {}),
    ...(typeof final.manualRetryable === 'boolean'
      ? { manualRetryable: final.manualRetryable }
      : {}),
    ...(nextAction ? { nextAction } : {}),
    ...(final.taskVerification && typeof final.taskVerification === 'object'
      ? { taskVerification: final.taskVerification }
      : {}),
  }
}

export function loadIncompleteCheckpointMetadata(db, { userId, sessionId, messages }) {
  const turnIds = [...new Set((Array.isArray(messages) ? messages : [])
    .filter((message) => (
      message?.role === 'assistant'
      && message?.modelContext?.turnEvidence === true
      && message.modelContext.evidenceState === 'failed'
      && message.modelContext.error
      && typeof message.modelContext.error === 'object'
      && !Array.isArray(message.modelContext.error)
      && ['incompleteReason', 'missingRequirements', 'retryable', 'manualRetryable', 'nextAction', 'taskVerification']
        .some((field) => !Object.hasOwn(message.modelContext.error, field))
    ))
    .map((message) => String(message.modelContext.turnId || '').trim())
    .filter(Boolean))]
  if (turnIds.length === 0) return new Map()

  const metadataByTurn = new Map()
  const chunkSize = 250
  for (let index = 0; index < turnIds.length; index += chunkSize) {
    const chunk = turnIds.slice(index, index + chunkSize)
    const placeholders = chunk.map(() => '?').join(', ')
    const rows = db.prepare(`
      SELECT turn_id, state_json
      FROM turn_checkpoints
      WHERE user_id = ? AND session_id = ? AND turn_id IN (${placeholders})
    `).all(userId, sessionId, ...chunk)
    for (const row of rows) {
      const metadata = incompleteCheckpointMetadata(row.state_json)
      if (metadata) metadataByTurn.set(String(row.turn_id), metadata)
    }
  }
  return metadataByTurn
}

export function withRecoveredIncompleteFailure(message, metadataByTurn) {
  const context = message?.modelContext
  const failure = context?.error
  if (message?.role !== 'assistant'
    || context?.turnEvidence !== true
    || context.evidenceState !== 'failed'
    || !failure
    || typeof failure !== 'object'
    || Array.isArray(failure)) {
    return message
  }
  const turnId = String(context.turnId || '').trim()
  const recovered = metadataByTurn.get(turnId)
  if (!recovered) return message
  const fields = [
    'incompleteReason',
    'missingRequirements',
    'retryable',
    'manualRetryable',
    'nextAction',
    'taskVerification',
  ]
  const additions = Object.fromEntries(fields
    .filter((field) => !Object.hasOwn(failure, field) && Object.hasOwn(recovered, field))
    .map((field) => [field, recovered[field]]))
  if (Object.keys(additions).length === 0) return message

  // Compatibility for older terminal evidence: enrich only the snapshot
  // response. Newer persisted diagnostics and the database row remain the
  // source of truth and are never overwritten here.
  return {
    ...message,
    modelContext: {
      ...context,
      error: {
        ...failure,
        ...additions,
      },
    },
  }
}

const SNAPSHOT_BOUNDARY_TYPES = new Set([
  'turn.completed',
  'turn.cancelled',
  'turn.failed',
  'turn.interrupted',
  'turn.blocked',
  'turn.paused',
])

const SNAPSHOT_FAILURE_BOUNDARY_TYPES = new Set([
  'turn.failed',
  'turn.interrupted',
  'turn.blocked',
  'turn.cancelled',
])

export function latestTurnBoundaries(db, { userId, sessionId, turnIds = null }) {
  const scopedTurnIds = Array.isArray(turnIds)
    ? [...new Set(turnIds.map((value) => String(value || '').trim()).filter(Boolean))]
    : null
  if (scopedTurnIds && scopedTurnIds.length === 0) return []
  const turnFilter = scopedTurnIds
    ? ` AND event.turn_id IN (${scopedTurnIds.map(() => '?').join(', ')})`
    : ''
  return db.prepare(`
    SELECT event.turn_id, event.sequence, event.type, event.payload_json,
      event.created_at,
      EXISTS(
        SELECT 1 FROM messages
        WHERE messages.user_id = event.user_id
          AND messages.session_id = event.session_id
          AND (
            messages.id = event.turn_id || ':assistant'
            OR (
              messages.role = 'assistant'
              AND json_valid(messages.model_context_json)
              AND json_extract(messages.model_context_json, '$.turnId') = event.turn_id
            )
          )
      ) AS has_evidence_message,
      COALESCE(
        (
          SELECT anchor.id
          FROM messages AS anchor
          WHERE anchor.user_id = event.user_id
            AND anchor.session_id = event.session_id
            AND anchor.id = event.turn_id || ':user'
          LIMIT 1
        ),
        (
          SELECT anchor.id
          FROM messages AS anchor
          WHERE anchor.user_id = event.user_id
            AND anchor.session_id = event.session_id
            AND json_valid(anchor.model_context_json)
            AND json_extract(anchor.model_context_json, '$.turnId') = event.turn_id
          ORDER BY anchor.created_at ASC, anchor.rowid ASC
          LIMIT 1
        )
      ) AS evidence_anchor_id
    FROM turn_events AS event
    WHERE event.user_id = ? AND event.session_id = ?${turnFilter}
      AND event.sequence = (
        SELECT MAX(latest.sequence)
        FROM turn_events AS latest
        WHERE latest.user_id = event.user_id
          AND latest.session_id = event.session_id
          AND latest.turn_id = event.turn_id
      )
  `).all(userId, sessionId, ...(scopedTurnIds || []))
    .filter((row) => SNAPSHOT_BOUNDARY_TYPES.has(row.type))
}

function eventFailure(payload, type) {
  const nested = payload?.error && typeof payload.error === 'object' && !Array.isArray(payload.error)
    ? payload.error
    : {}
  const source = { ...payload, ...nested }
  if ((!Array.isArray(nested.missingRequirements) || nested.missingRequirements.length === 0)
    && Array.isArray(payload?.missingRequirements)) {
    source.missingRequirements = payload.missingRequirements
  }
  if ((!nested.taskVerification || Object.keys(nested.taskVerification).length === 0)
    && payload?.taskVerification && typeof payload.taskVerification === 'object') {
    source.taskVerification = payload.taskVerification
  }
  return normalizeTurnFailure(source, {
    code: type === 'turn.interrupted'
      ? 'TURN_INTERRUPTED'
      : type === 'turn.blocked'
        ? 'TURN_RECOVERY_BLOCKED'
        : type === 'turn.cancelled' ? 'TURN_CANCELLED' : 'TURN_FAILED',
    retryable: type === 'turn.interrupted',
  })
}

function terminalEventEvidence(payload, key) {
  if (payload && typeof payload === 'object' && Object.hasOwn(payload, key)) return payload[key]
  const nested = payload?.error
  if (nested && typeof nested === 'object' && !Array.isArray(nested) && Object.hasOwn(nested, key)) {
    return nested[key]
  }
  return undefined
}

function projectTerminalEvidence(message, row, { userId, sessionId }) {
  const payload = parseModelContext(row.payload_json) || {}
  const context = message?.modelContext && typeof message.modelContext === 'object'
    ? message.modelContext
    : {}
  const invalidCompletion = row.type === 'turn.completed'
    && !isSuccessfulTurnCompletedEvent({ type: row.type, payload })
  const projectedCompletion = invalidCompletion
    ? projectTurnEventForClient({ type: row.type, payload })
    : null
  const failureType = projectedCompletion?.type || row.type
  const failurePayload = invalidCompletion
    ? {
        ...(projectedCompletion?.payload || payload),
        code: projectedCompletion?.payload?.code
          || projectedCompletion?.payload?.error?.code
          || 'TURN_INCOMPLETE',
      }
    : payload
  const failureBoundary = SNAPSHOT_FAILURE_BOUNDARY_TYPES.has(row.type) || invalidCompletion
  const state = invalidCompletion ? 'incomplete' : row.type.slice('turn.'.length)
  const artifactIds = terminalEventEvidence(payload, 'artifactIds')
  const deliveryArtifactIds = terminalEventEvidence(payload, 'deliveryArtifactIds')
  const verifiedLocalFiles = terminalEventEvidence(payload, 'verifiedLocalFiles')
  const retainedLocalFiles = terminalEventEvidence(payload, 'retainedLocalFiles')
  const iterations = terminalEventEvidence(payload, 'iterations')
  const usage = terminalEventEvidence(payload, 'usage')
  const turnModelUsage = terminalEventEvidence(payload, 'turnModelUsage')
  const estimatedPromptTokens = terminalEventEvidence(payload, 'estimatedPromptTokens')
  const failedRetryRejection = context.failedRetryRejection
  const preservedFailedRetryRejection = row.type === 'turn.failed'
    && context.turnEvidence === true
    && context.evidenceState === 'failed'
    && context.serverLastSequence === row.sequence
    && failedRetryRejection && typeof failedRetryRejection === 'object'
    && !Array.isArray(failedRetryRejection)
    && failedRetryRejection.failureSequence === row.sequence
    && failedRetryRejection.code === context.error?.code
    && context.error?.retryable === false
      ? failedRetryRejection
      : null
  const terminalContextBase = { ...context }
  for (const key of [
    'error',
    'recovery',
    'failedRetryRejection',
    'paused',
    'clarification',
    'pausedSequence',
    'paused_sequence',
  ]) delete terminalContextBase[key]
  const recoveryKind = String(terminalEventEvidence(payload, 'recoveryKind') || '').trim()
  const recoveryToolCallId = String(terminalEventEvidence(payload, 'toolCallId') || '').trim()
  const recoveryModelRequestId = String(terminalEventEvidence(payload, 'modelRequestId') || '').trim()
  const recoveryAction = terminalEventEvidence(payload, 'recoveryAction')
  const recovery = row.type === 'turn.blocked'
    && terminalEventEvidence(payload, 'requiresUserVerification') === true
    && recoveryKind
    ? {
        recoveryKind,
        requiresUserVerification: true,
        ...(recoveryToolCallId ? { toolCallId: recoveryToolCallId } : {}),
        ...(recoveryModelRequestId ? { modelRequestId: recoveryModelRequestId } : {}),
        ...(recoveryAction && typeof recoveryAction === 'object' && !Array.isArray(recoveryAction)
          ? { recoveryAction }
          : {}),
      }
    : null
  const terminalContext = {
    ...terminalContextBase,
    turnId: row.turn_id,
    turnEvidence: true,
    evidenceState: state,
    serverLastSequence: row.sequence,
    turnCompletedAt: row.created_at,
    ...(Array.isArray(artifactIds)
      ? { artifactIds }
      : {}),
    ...(Array.isArray(deliveryArtifactIds)
      ? { deliveryArtifactIds }
      : {}),
    ...(Array.isArray(verifiedLocalFiles)
      ? { verifiedLocalFiles }
      : {}),
    ...(Array.isArray(retainedLocalFiles)
      ? { retainedLocalFiles }
      : {}),
    ...(Number.isInteger(iterations) && iterations >= 0
      ? { iterations }
      : {}),
    ...(usage && typeof usage === 'object' && !Array.isArray(usage) ? { usage } : {}),
    ...(turnModelUsage && typeof turnModelUsage === 'object' && !Array.isArray(turnModelUsage)
      ? { turnModelUsage }
      : {}),
    ...(Number.isInteger(estimatedPromptTokens) && estimatedPromptTokens >= 0
      ? { estimatedPromptTokens }
      : {}),
    ...(failureBoundary ? {
      error: preservedFailedRetryRejection
        ? context.error
        : eventFailure(failurePayload, failureType),
    } : {}),
    ...(preservedFailedRetryRejection
      ? { failedRetryRejection: preservedFailedRetryRejection }
      : {}),
    ...(recovery ? { recovery } : {}),
    ...(row.type === 'turn.paused'
      ? {
          paused: true,
          pausedSequence: row.sequence,
          ...(payload.clarification ? { clarification: payload.clarification } : {}),
        }
      : {}),
  }
  const eventText = String(
    terminalEventEvidence(payload, 'partialText')
      ?? terminalEventEvidence(payload, 'text')
      ?? '',
  )
  return {
    ...(message || {}),
    id: message?.id || `${row.turn_id}:assistant`,
    userId,
    sessionId,
    role: 'assistant',
    content: eventText || String(message?.content || ''),
    modelContext: terminalContext,
    createdAt: message?.createdAt ?? row.created_at,
    updatedAt: Math.max(Number(message?.updatedAt) || 0, Number(row.created_at) || 0),
  }
}

export function recoverTerminalEvidenceMessages(messages, rows, scope, {
  synthesizeMissing = false,
  synthesisAnchorIds = null,
  includeUnanchored = false,
} = {}) {
  const byId = new Map(messages.map((message, index) => [message.id, index]))
  const byAssistantTurnId = new Map()
  messages.forEach((message, index) => {
    if (message?.role !== 'assistant') return
    const turnId = String(message?.modelContext?.turnId || '').trim()
    // Replacement/import flows may contain more than one assistant row for a
    // Turn. The latest row is the visible answer and must own the recovered
    // terminal evidence; projecting onto the first row rewrites stale history.
    if (turnId) byAssistantTurnId.set(turnId, index)
  })
  const recovered = [...messages]
  const missing = []
  let synthesized = 0
  for (const row of rows) {
    const id = `${row.turn_id}:assistant`
    const index = byId.get(id) ?? byAssistantTurnId.get(row.turn_id)
    if (index !== undefined) {
      recovered[index] = projectTerminalEvidence(recovered[index], row, scope)
    } else if (synthesizeMissing
      && !row.has_evidence_message
      && (synthesisAnchorIds === null
        || (row.evidence_anchor_id
          ? synthesisAnchorIds.has(row.evidence_anchor_id)
          : includeUnanchored))) {
      missing.push({ row, message: projectTerminalEvidence(null, row, scope) })
      synthesized += 1
    }
  }
  missing.sort((left, right) => (
    (Number(left.message.createdAt) || 0) - (Number(right.message.createdAt) || 0)
      || left.row.sequence - right.row.sequence
  ))
  for (const entry of missing) {
    const userMessageId = `${entry.row.turn_id}:user`
    const userIndex = recovered.findIndex((message) => message.id === userMessageId)
    if (userIndex >= 0) {
      let insertIndex = userIndex + 1
      while (insertIndex < recovered.length
        && String(recovered[insertIndex]?.modelContext?.turnId || '') === entry.row.turn_id) {
        insertIndex += 1
      }
      recovered.splice(insertIndex, 0, entry.message)
      continue
    }
    const createdAt = Number(entry.message.createdAt) || 0
    const nextIndex = recovered.findIndex((message) => (Number(message.createdAt) || 0) >= createdAt)
    if (nextIndex >= 0) recovered.splice(nextIndex, 0, entry.message)
    else recovered.push(entry.message)
  }
  return { messages: recovered, synthesized }
}

