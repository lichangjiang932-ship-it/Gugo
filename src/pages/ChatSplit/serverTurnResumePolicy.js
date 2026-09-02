import { isSideEffectOutcomeUnknownRecoveryKind } from '../../lib/turnClient/turnEventDispatch.js'
import { getVisibleTurnClarification } from '../../lib/chatFlowGuards.js'
import { mergeAssistantText, missingAssistantTextSuffix } from '../../lib/assistantTextContinuity.js'
import { hasTurnRun } from './turnRunRegistry.js'

function nonEmptyTaskVerification(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0
    ? value
    : null
}

export function reduceResumedAssistantText(currentText, event) {
  if (event?.type === 'turn.attempt' && event.payload?.resetStreaming) {
    return String(event.payload?.assistantText || '')
  }
  if (event?.type === 'assistant.delta' && event.payload?.text) {
    return `${String(currentText || '')}${String(event.payload.text)}`
  }
  if (event?.type === 'turn.interrupted'
    || event?.type === 'turn.blocked'
    || event?.type === 'turn.failed') {
    return mergeAssistantText(currentText, event.payload?.partialText ?? event.payload?.text ?? '')
  }
  return String(currentText || '')
}

export function terminalResumeText(currentText, terminal, t) {
  const terminalText = terminal?.payload?.text
    || (terminal?.type === 'turn.paused'
      ? getVisibleTurnClarification(terminal.payload?.clarification, t)
      : '')
  return missingAssistantTextSuffix(currentText, terminalText)
}

export function failedRetryFailureFromError(error, previousFailure = null) {
  const previous = previousFailure && typeof previousFailure === 'object'
    ? previousFailure
    : {}
  const current = error?.serverFailure && typeof error.serverFailure === 'object'
    ? error.serverFailure
    : error || {}
  const code = String(error?.serverFailure?.code || error?.code || 'TURN_REQUEST_FAILED')
    .trim().toUpperCase() || 'TURN_REQUEST_FAILED'
  const status = Number(error?.serverFailure?.status ?? error?.status)
  const retryable = error?.serverFailure?.retryable ?? error?.retryable
  const manualRetryable = error?.serverFailure?.manualRetryable ?? error?.manualRetryable
  const incompleteReason = String(
    current.incompleteReason || error?.incompleteReason || previous.incompleteReason || '',
  ).trim()
  const currentMissingRequirements = Array.isArray(current.missingRequirements)
    ? current.missingRequirements
    : []
  const outerMissingRequirements = Array.isArray(error?.missingRequirements)
    ? error.missingRequirements
    : []
  const missingRequirements = [...new Set((currentMissingRequirements.length > 0
    ? currentMissingRequirements
    : outerMissingRequirements.length > 0
      ? outerMissingRequirements
      : Array.isArray(previous.missingRequirements) ? previous.missingRequirements : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean))].slice(0, 16)
  const taskVerification = nonEmptyTaskVerification(current.taskVerification)
    || nonEmptyTaskVerification(error?.taskVerification)
    || nonEmptyTaskVerification(previous.taskVerification)
  const reason = String(current.reason || error?.reason || previous.reason || '').trim()
  const nextAction = String(current.nextAction || error?.nextAction || previous.nextAction || '').trim()
  return {
    code,
    retryable: retryable === true,
    ...(Number.isInteger(status) && status >= 100 && status <= 599 ? { status } : {}),
    ...(typeof manualRetryable === 'boolean' ? { manualRetryable } : {}),
    ...(incompleteReason ? { incompleteReason } : {}),
    ...(reason ? { reason } : {}),
    ...(nextAction ? { nextAction } : {}),
    ...(missingRequirements.length > 0 ? { missingRequirements } : {}),
    ...(taskVerification ? { taskVerification } : {}),
  }
}

export function mergeFailureDiagnostics(currentFailure, previousFailure) {
  const current = currentFailure && typeof currentFailure === 'object' ? currentFailure : null
  const previous = previousFailure && typeof previousFailure === 'object' ? previousFailure : null
  if (!current) return previous
  if (!previous) return current
  const currentMissing = Array.isArray(current.missingRequirements)
    ? current.missingRequirements.filter(Boolean)
    : []
  const taskVerification = nonEmptyTaskVerification(current.taskVerification)
    || nonEmptyTaskVerification(previous.taskVerification)
  const reason = String(current.reason || previous.reason || '').trim()
  const nextAction = String(current.nextAction || previous.nextAction || '').trim()
  return {
    ...previous,
    ...current,
    ...(current.incompleteReason || previous.incompleteReason
      ? { incompleteReason: current.incompleteReason || previous.incompleteReason }
      : {}),
    ...(reason ? { reason } : {}),
    ...(nextAction ? { nextAction } : {}),
    ...(currentMissing.length > 0 || Array.isArray(previous.missingRequirements)
      ? { missingRequirements: currentMissing.length > 0 ? currentMissing : previous.missingRequirements }
      : {}),
    ...(taskVerification ? { taskVerification } : {}),
  }
}

export function isRecoverableServerMessage(message) {
  const connectionState = message?.meta?.serverConnectionState
  return Boolean(message?.meta?.streaming)
    || ['interrupted', 'reconnecting', 'cancelling'].includes(connectionState)
}

function sameNonEmptyId(left, right) {
  return typeof left === 'string'
    && left.length > 0
    && typeof right === 'string'
    && right.length > 0
    && left === right
}

export function matchesManualRecoveryResume(session, message, resume) {
  return resume?.kind === 'turn'
    && sameNonEmptyId(resume.sessionId, session?.id)
    && sameNonEmptyId(resume.turnId, message?.meta?.serverTurnId)
    && sameNonEmptyId(resume.toolCallId, message?.meta?.serverRecoveryToolCallId)
    && message?.meta?.serverRecoveryBlocked === true
    && isSideEffectOutcomeUnknownRecoveryKind(message?.meta?.serverRecoveryKind)
    && message?.meta?.serverConnectionState === 'blocked'
}

export function matchesFailedTurnRetryResume(session, message, retry) {
  const failure = message?.meta?.serverFailure
  const sameFailureCode = typeof retry?.code === 'string'
    && retry.code.length > 0
    && retry.code === failure?.code
  return sameNonEmptyId(retry?.sessionId, session?.id)
    && sameNonEmptyId(retry?.turnId, message?.meta?.serverTurnId)
    && message?.meta?.failed === true
    && sameFailureCode
    && (
      (retry.code === 'TURN_INCOMPLETE' && failure.retryable === true)
      || (retry.manualRetryable === true && failure.manualRetryable === true)
    )
}

function serverTurnResumeClaimKey(sessionId, turnId) {
  return `${String(sessionId || '')}\u0000${String(turnId || '')}`
}

export function claimServerTurnResume(
  claims,
  sessionId,
  turnId,
  hasActiveTurn = hasTurnRun,
) {
  if (!(claims instanceof Set) || !sameNonEmptyId(sessionId, sessionId) || !sameNonEmptyId(turnId, turnId)) {
    return false
  }
  const key = serverTurnResumeClaimKey(sessionId, turnId)
  if (claims.has(key) || hasActiveTurn(sessionId, turnId)) return false
  claims.add(key)
  return true
}

export function releaseServerTurnResume(claims, sessionId, turnId) {
  claims.delete(serverTurnResumeClaimKey(sessionId, turnId))
}

export function shouldKeepResumePending({ resumeResolution, resumeAccepted, stopped }) {
  return Boolean(resumeResolution) && resumeAccepted !== true && stopped !== true
}

export function serverResumeAfterSequence(message) {
  const sequence = message?.meta?.serverLastSequence
  return Number.isInteger(sequence) && sequence >= -1 ? sequence : -1
}
