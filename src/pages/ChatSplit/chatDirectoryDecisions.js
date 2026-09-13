import { authorizeChatDirectoryRequest } from '../../lib/chatDirectoryRequest.js'
import { cancelServerTurn, dispatchTurnEvent } from '../../lib/turnClient.js'
import { parseTurnEvent } from '../../../shared/turnEvents.js'
import { streamResumeOwnerScope } from '../../lib/streamResumeDismissals.js'
import { buildServerTurnResumeMeta } from './pausedTurnResume.js'

export function isPausedDirectoryMessage(message) {
  const meta = message?.meta || {}
  const request = meta.serverClarification || {}
  return message?.role === 'assistant' && (request.request_type || request.requestType) === 'directory'
    && (meta.paused === true || meta.serverConnectionState === 'paused')
    && meta.cancelled !== true && meta.failed !== true && meta.streaming !== true
    && !['reconnecting', 'cancelling', 'cancelled'].includes(meta.serverConnectionState)
    && meta.directoryAuthorizationPending !== true && !meta.serverResumeResolution
}

function staleDirectoryRequest() {
  return Object.assign(new Error('The directory request changed. Refresh the current task before deciding.'), {
    code: 'TURN_DIRECTORY_PAUSE_STALE', status: 409,
  })
}

function assertScope(state, ownerScope, scope) {
  if (!ownerScope || ownerScope !== scope.ownerScope || streamResumeOwnerScope(state) !== ownerScope
    || !scope.sessionId || state?.activeSessionId !== scope.sessionId
    || !scope.messageId || !scope.turnId || !Number.isSafeInteger(scope.sequence) || scope.sequence < 0) {
    throw staleDirectoryRequest()
  }
  const session = state.sessions?.find((item) => item.id === scope.sessionId)
  const message = session?.messages?.find((item) => item.id === scope.messageId)
  if (!isPausedDirectoryMessage(message) || message.meta.serverTurnId !== scope.turnId
    || message.meta.serverLastSequence !== scope.sequence) throw staleDirectoryRequest()
  return message.meta.serverClarification
}

function checkSignal(signal) {
  if (signal?.aborted) throw signal.reason || Object.assign(new Error('Directory decision cancelled'), { name: 'AbortError' })
}

/** Bind both decisions to the captured pause, never whichever task is active later. */
export async function decideChatDirectory({ kind, input, stateRef, ownerScope, dispatch, toast, t }, {
  authorize = authorizeChatDirectoryRequest, cancel = cancelServerTurn, dispatchEvent = dispatchTurnEvent,
} = {}) {
  const scope = Object.freeze({ ownerScope: input.ownerScope, sessionId: input.sessionId,
    messageId: input.message?.id, turnId: input.message?.meta?.serverTurnId,
    sequence: input.message?.meta?.serverLastSequence })
  checkSignal(input.signal)
  const request = assertScope(stateRef.current, ownerScope, scope)
  const messageTarget = { sessionId: scope.sessionId, messageId: scope.messageId }
  if (kind === 'grant') {
    const accessMode = (request.access_mode || request.accessMode) === 'read_write' ? 'read_write' : 'read_only'
    if (input.accessMode !== accessMode) throw staleDirectoryRequest()
    const result = await authorize({ sessionId: scope.sessionId, turnId: scope.turnId,
      pausedSequence: scope.sequence, path: input.path, accessMode, scope: input.authorizationScope,
      purpose: request.purpose || request.why || '', signal: input.signal })
    checkSignal(input.signal)
    assertScope(stateRef.current, ownerScope, scope)
    if (result?.resolution?.type !== 'directory_authorization' || result.resolution.approved !== true
      || result.resolution.paused_sequence !== scope.sequence || result.resolution.access_mode !== accessMode) {
      throw staleDirectoryRequest()
    }
    dispatch({ type: 'UPDATE_LAST_MESSAGE_META', ...messageTarget, payload: buildServerTurnResumeMeta(result.resolution) })
    toast?.success?.({ title: t('taskSteering.directoryGranted'), body: result.path })
    return result
  }
  if (kind !== 'reject') throw staleDirectoryRequest()
  const turn = await cancel({ sessionId: scope.sessionId, turnId: scope.turnId,
    directoryPausedSequence: scope.sequence, signal: input.signal })
  checkSignal(input.signal)
  assertScope(stateRef.current, ownerScope, scope)
  if (turn?.status !== 'cancelled' || turn.sessionId !== scope.sessionId || turn.turnId !== scope.turnId
    || turn.lastEvent?.type !== 'turn.cancelled') throw staleDirectoryRequest()
  const event = parseTurnEvent(turn.lastEvent)
  if (event.sessionId !== scope.sessionId || event.turnId !== scope.turnId || event.sequence <= scope.sequence) {
    throw staleDirectoryRequest()
  }
  // Only durable cancellation updates the message; the canonical projection
  // retains partial output/files and clears the directory clarification.
  await dispatchEvent(event, { dispatch, messageTarget })
  return { cancelled: true, turn }
}
