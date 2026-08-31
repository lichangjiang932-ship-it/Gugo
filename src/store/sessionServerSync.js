import { removeVerifiedLocalFilesFromRetained } from '../lib/localFileReferences.js'

const SERVER_MUTATION_TYPES = new Set([
  'DELETE_SESSION',
  'CLEAR_CURRENT_SESSION',
  'DELETE_MESSAGE',
  'TRUNCATE_MESSAGES',
  'COMPRESS_CURRENT_SESSION',
  'COMPACT_SESSION',
  'EXPAND_COMPACTED',
])

const ACTIVE_SESSION_MUTATION_TYPES = new Set([
  'CLEAR_CURRENT_SESSION',
  'DELETE_MESSAGE',
  'TRUNCATE_MESSAGES',
  'COMPRESS_CURRENT_SESSION',
])

export function isServerSessionMutation(action) {
  return !!action && SERVER_MUTATION_TYPES.has(action.type)
}

export function resolveSessionMutationTarget(state, action) {
  if (!isServerSessionMutation(action)) return null
  if (action.type === 'DELETE_SESSION') {
    return typeof action.payload === 'string' ? action.payload : null
  }
  if (action.type === 'COMPACT_SESSION' || action.type === 'EXPAND_COMPACTED') {
    return action.payload?.sessionId || state?.activeSessionId || null
  }
  return state?.activeSessionId || null
}

export function isServerBackedSession(session) {
  return Number.isInteger(session?.serverRevision)
}

function hasIncompleteTaskDiagnosticGap(message) {
  const failure = message?.meta?.serverFailure
  if (!failure || typeof failure !== 'object' || Array.isArray(failure)) return false
  const code = String(failure.code || '').trim().toUpperCase()
  const incompleteReason = String(failure.incompleteReason || '').trim().toLowerCase()
  if (code !== 'TURN_INCOMPLETE' && !incompleteReason) return false
  if (!incompleteReason
    || !Array.isArray(failure.missingRequirements)
    || typeof failure.retryable !== 'boolean') return true
  if (['task_verification_repair_exhausted', 'task_verification_repair_pending'].includes(incompleteReason)) {
    const verification = failure.taskVerification
    if (!verification || typeof verification !== 'object' || !Array.isArray(verification.checks)) return true
  }
  const blocked = message?.meta?.serverConnectionState === 'blocked'
    || code === 'TURN_RECOVERY_BLOCKED'
  return blocked && typeof failure.manualRetryable !== 'boolean'
}

export function needsServerTranscriptHydration(session) {
  const messages = Array.isArray(session?.messages) ? session.messages : []
  // Older browser records may predate serverRevision while the same session
  // already exists in the durable store. A generic TURN_INCOMPLETE card is a
  // narrow, safe reason to probe that exact session id for richer diagnostics.
  if (messages.some(hasIncompleteTaskDiagnosticGap)) return true
  if (!isServerBackedSession(session)) return false
  return messages.length === 0
    || messages.every((message) => (
      message?.meta?.pendingServerSync === true || message?.meta?.streaming === true
    ))
}

export function needsServerSessionSnapshot(session, hydratedRevision) {
  return needsServerTranscriptHydration(session)
    && (!isServerBackedSession(session) || hydratedRevision !== session.serverRevision)
}

function normalizedArtifactIds(artifacts) {
  return [...new Set((Array.isArray(artifacts) ? artifacts : [])
    .map((artifact) => String(artifact?.id || '').trim())
    .filter(Boolean))].sort()
}

function sameArtifactCollection(left, right) {
  const leftIds = normalizedArtifactIds(left)
  const rightIds = normalizedArtifactIds(right)
  return leftIds.length === rightIds.length
    && leftIds.every((id, index) => id === rightIds[index])
}

function hasMeaningfulEvidence(value) {
  if (Array.isArray(value)) return value.length > 0
  if (value && typeof value === 'object') return Object.keys(value).length > 0
  return value !== undefined && value !== null && value !== ''
}

function mergeTerminalFailureDiagnostics(serverFailure, localFailure) {
  if (!serverFailure || typeof serverFailure !== 'object' || Array.isArray(serverFailure)) return serverFailure
  if (!localFailure || typeof localFailure !== 'object' || Array.isArray(localFailure)) return serverFailure
  const merged = { ...localFailure, ...serverFailure }
  for (const key of ['reason', 'incompleteReason', 'nextAction']) {
    const serverValue = String(serverFailure[key] || '').trim()
    const localValue = String(localFailure[key] || '').trim()
    if (serverValue || localValue) merged[key] = serverValue || localValue
  }
  for (const key of ['missingRequirements', 'taskVerification']) {
    if (!hasMeaningfulEvidence(serverFailure[key]) && hasMeaningfulEvidence(localFailure[key])) {
      merged[key] = localFailure[key]
    }
  }
  return merged
}

function terminalOutcomeState(meta) {
  if (!meta || typeof meta !== 'object') return ''
  if (meta.serverConnectionState === 'blocked' || meta.serverRecoveryBlocked === true) return 'blocked'
  if (meta.cancelled === true) return 'cancelled'
  if (meta.interrupted === true) return 'interrupted'
  if (meta.failed === true) return 'failed'
  return ''
}

function normalizedMessageContent(value) {
  if (typeof value === 'string') return value
  if (value == null) return ''
  try { return JSON.stringify(value) } catch { return String(value) }
}

function sameSessionTranscript(serverMessages, projectedMessages) {
  if (!Array.isArray(serverMessages) || !Array.isArray(projectedMessages)) return false
  if (serverMessages.length !== projectedMessages.length) return false
  return serverMessages.every((serverMessage, index) => {
    const projectedMessage = projectedMessages[index]
    return String(serverMessage?.id || '') === String(projectedMessage?.id || '')
      && String(serverMessage?.role || '') === String(projectedMessage?.role || '')
      && normalizedMessageContent(serverMessage?.content)
        === normalizedMessageContent(projectedMessage?.content)
  })
}

function canConfirmReplacementAfterError(error) {
  return error?.status === 409
    || error?.status === 500
    || error?.code === 'SESSION_REVISION_CONFLICT'
    || error?.code === 'SESSION_ADMIN_RESULT_INVALID'
}

export function mergeServerSessionMessages(localMessages, serverMessages) {
  const localById = new Map(
    (Array.isArray(localMessages) ? localMessages : [])
      .filter((message) => message?.id)
      .map((message) => [message.id, message]),
  )
  const serverIds = new Set()
  const mergedMessages = (Array.isArray(serverMessages) ? serverMessages : []).map((serverMessage) => {
    if (serverMessage?.id) serverIds.add(serverMessage.id)
    const localMessage = localById.get(serverMessage?.id)
    if (!localMessage) return serverMessage
    const serverMeta = serverMessage?.meta && typeof serverMessage.meta === 'object'
      ? serverMessage.meta
      : {}
    const localMeta = localMessage?.meta && typeof localMessage.meta === 'object'
      ? localMessage.meta
      : {}
    const serverPauseSequence = Number.isInteger(serverMeta.serverLastSequence)
      ? serverMeta.serverLastSequence
      : null
    const localSequence = Number.isInteger(localMeta.serverLastSequence)
      ? localMeta.serverLastSequence
      : null
    const localHasNewerTurnState = serverPauseSequence !== null
      && localSequence !== null
      && localSequence > serverPauseSequence
    const merged = {
      ...serverMessage,
      ...localMessage,
      id: serverMessage.id,
      role: serverMessage.role,
      // A completed snapshot should be authoritative, but an unexpectedly empty
      // assistant row must not erase text already received over the live stream.
      // Conversely, a snapshot behind the live event cursor must never roll
      // newer partial/final model output back to an older persisted body.
      content: localHasNewerTurnState
        ? localMessage.content || serverMessage.content || ''
        : serverMessage.content || localMessage.content || '',
      timestamp: serverMessage.timestamp ?? localMessage.timestamp,
    }
    if (Object.keys(serverMeta).length || Object.keys(localMeta).length) {
      merged.meta = { ...serverMeta, ...localMeta }
      delete merged.meta.pendingServerSync
      if (serverMessage.role === 'assistant') {
        const serverOutcomeState = terminalOutcomeState(serverMeta)
        const preserveLocalTerminalEvidence = !!serverOutcomeState
          && serverOutcomeState === terminalOutcomeState(localMeta)
        for (const key of ['turnStartedAt', 'turnCompletedAt', 'latency']) {
          if (localHasNewerTurnState) {
            if (Object.hasOwn(localMeta, key)) merged.meta[key] = localMeta[key]
            else delete merged.meta[key]
          } else if (Object.hasOwn(serverMeta, key)) {
            merged.meta[key] = serverMeta[key]
          }
        }
        const recoveryStub = serverMeta.serverRecoveryStub === true
        const canonicalTextChanged = !recoveryStub && merged.content !== localMessage.content
        if (canonicalTextChanged) {
          if (Array.isArray(serverMeta.toolCalls) && !localHasNewerTurnState) {
            // Live text offsets are coordinates into the local streamed body.
            // Once an authoritative snapshot replaces that body, only the
            // snapshot's tool calls are safe to use for timeline slicing.
            merged.meta.toolCalls = serverMeta.toolCalls
          } else if (Array.isArray(localMeta.toolCalls)) {
            merged.meta.toolCalls = localMeta.toolCalls.map((call) => {
              if (!call || typeof call !== 'object' || !Object.hasOwn(call, 'textOffset')) return call
              const normalized = { ...call }
              delete normalized.textOffset
              return normalized
            })
          }
        }
        merged.meta.serverTurnId = serverMeta.serverTurnId ?? localMeta.serverTurnId ?? null
        merged.meta.streaming = localHasNewerTurnState
          ? localMeta.streaming === true
          : recoveryStub || serverMeta.streaming === true
        merged.meta.serverAuthoritative = !recoveryStub
        if (recoveryStub) merged.meta.serverRecoveryStub = true
        else delete merged.meta.serverRecoveryStub
        // The persisted terminal projection is authoritative unless a later
        // live event has already advanced this Turn. In particular, an older
        // local TURN_INCOMPLETE object must not erase structured diagnostics
        // recovered by the server from the scoped checkpoint.
        const terminalEvidenceKeys = [
          'serverFailure',
          'serverPartialText',
          'serverArtifactIds',
          'serverIterations',
        ]
        if (localHasNewerTurnState) {
          for (const key of terminalEvidenceKeys) {
            if (Object.hasOwn(localMeta, key)) merged.meta[key] = localMeta[key]
            else delete merged.meta[key]
          }
        } else if (!recoveryStub) {
          for (const key of terminalEvidenceKeys) {
            if (Object.hasOwn(serverMeta, key)) {
              // Compatibility snapshots can expose an empty outer field while
              // a newer live terminal event already supplied durable evidence.
              // Keep the richer value unless the snapshot carries meaningful
              // replacement data.
              if (!preserveLocalTerminalEvidence
                || hasMeaningfulEvidence(serverMeta[key])
                || !hasMeaningfulEvidence(localMeta[key])) {
                merged.meta[key] = key === 'serverFailure'
                  ? mergeTerminalFailureDiagnostics(serverMeta[key], localMeta[key])
                  : serverMeta[key]
              }
            } else if (key === 'serverFailure') {
              delete merged.meta[key]
            }
          }
        }
        // A completed snapshot is the source of truth for persisted files.
        // Keep local artifacts only when an older server response does not
        // expose the field at all; an explicit server list must replace an
        // empty or partial list left behind by a missed live tool event.
        for (const key of ['serverArtifacts', 'serverDeliveryArtifactIds']) {
          if (localHasNewerTurnState) {
            if (Object.hasOwn(localMeta, key)) merged.meta[key] = localMeta[key]
            else delete merged.meta[key]
          } else if (Object.hasOwn(serverMeta, key)) {
            if (!preserveLocalTerminalEvidence
              || hasMeaningfulEvidence(serverMeta[key])
              || !hasMeaningfulEvidence(localMeta[key])) {
              merged.meta[key] = serverMeta[key]
            }
          }
        }
        if (!localHasNewerTurnState && Object.hasOwn(serverMeta, 'serverDeliveryArtifactIds')) {
          if (!preserveLocalTerminalEvidence
            || hasMeaningfulEvidence(serverMeta.serverDeliveryArtifactIds)
            || !hasMeaningfulEvidence(localMeta.serverDeliveryArtifactIds)) {
            merged.meta.serverDeliveryArtifactIds = serverMeta.serverDeliveryArtifactIds
          }
        } else if (!preserveLocalTerminalEvidence
          && !localHasNewerTurnState
          && !recoveryStub
          && Object.hasOwn(serverMeta, 'serverArtifacts')
          && Object.hasOwn(localMeta, 'serverDeliveryArtifactIds')
          && !sameArtifactCollection(localMeta.serverArtifacts, serverMeta.serverArtifacts)) {
          // A delivery selection is valid only for the artifact collection it
          // was made against. If an authoritative snapshot exposes a different
          // collection but predates the delivery field, retaining the local
          // IDs can revive a draft that the current turn already invalidated.
          merged.meta.serverDeliveryArtifactIds = []
        }
        for (const key of ['verifiedLocalFiles', 'retainedLocalFiles']) {
          if (localHasNewerTurnState) {
            if (Object.hasOwn(localMeta, key)) merged.meta[key] = localMeta[key]
            else delete merged.meta[key]
          } else if (Object.hasOwn(serverMeta, key)) {
            if (!preserveLocalTerminalEvidence
              || hasMeaningfulEvidence(serverMeta[key])
              || !hasMeaningfulEvidence(localMeta[key])) {
              merged.meta[key] = serverMeta[key]
            }
          }
        }
        if (Object.hasOwn(merged.meta, 'retainedLocalFiles')) {
          merged.meta.retainedLocalFiles = removeVerifiedLocalFilesFromRetained(
            merged.meta.retainedLocalFiles,
            merged.meta.verifiedLocalFiles,
          )
        }

        const localResumeInFlight = localMeta.directoryAuthorizationPending === true
          || localMeta.serverResumeResolution != null

        const recoveryMetaKeys = [
          'serverRecoveryKind',
          'serverRecoveryToolCallId',
          'serverRecoveryModelRequestId',
          'serverRecoveryActionPath',
        ]
        const serverRecoveryBlocked = serverMeta.serverConnectionState === 'blocked'
          || serverMeta.serverRecoveryBlocked === true
        if (serverRecoveryBlocked && !localHasNewerTurnState) {
          merged.meta.failed = false
          merged.meta.cancelled = false
          merged.meta.interrupted = false
          merged.meta.paused = false
          merged.meta.streaming = false
          merged.meta.serverConnectionState = 'blocked'
          merged.meta.serverRecoveryBlocked = true
          for (const key of recoveryMetaKeys) {
            merged.meta[key] = serverMeta[key] ?? null
          }
          if (serverPauseSequence !== null) {
            merged.meta.serverLastSequence = serverPauseSequence
          }
        } else if (serverMeta.failed === true && !localHasNewerTurnState) {
          merged.meta.failed = true
          merged.meta.cancelled = false
          merged.meta.interrupted = false
          merged.meta.paused = false
          merged.meta.streaming = false
          merged.meta.serverConnectionState = serverMeta.serverConnectionState ?? null
          merged.meta.serverRecoveryBlocked = false
          for (const key of recoveryMetaKeys) merged.meta[key] = null
          if (serverPauseSequence !== null) {
            merged.meta.serverLastSequence = serverPauseSequence
          }
        } else if (serverMeta.cancelled === true && !localHasNewerTurnState) {
          merged.meta.cancelled = true
          merged.meta.failed = false
          merged.meta.interrupted = false
          merged.meta.paused = false
          merged.meta.streaming = false
          merged.meta.serverConnectionState = 'cancelled'
          if (serverPauseSequence !== null) {
            merged.meta.serverLastSequence = serverPauseSequence
          }
        } else if (serverMeta.interrupted === true && !localHasNewerTurnState) {
          merged.meta.failed = false
          merged.meta.cancelled = false
          merged.meta.interrupted = true
          merged.meta.paused = false
          merged.meta.streaming = true
          merged.meta.turnCompletedAt = null
          merged.meta.latency = null
          merged.meta.serverConnectionState = 'interrupted'
          if (serverPauseSequence !== null) {
            merged.meta.serverLastSequence = serverPauseSequence
          }
        } else if (serverMeta.paused === true && (localResumeInFlight || localHasNewerTurnState)) {
          // A snapshot may race with the user's authorization or with newer
          // streamed events. Retain that newer local lifecycle state. While an
          // authorization is in flight, the server clarification is still the
          // canonical request shown by the busy inline card.
          merged.meta.streaming = localMeta.streaming === true
          if (localResumeInFlight
            && localMeta.serverClarification == null
            && serverMeta.serverClarification != null) {
            merged.meta.serverClarification = serverMeta.serverClarification
          }
        } else if (serverMeta.paused === true) {
          // Persisted pause state is authoritative over stale live metadata.
          // In particular, a local `serverClarification: null` must not erase
          // the directory request before MessageRow can render its inline card.
          merged.meta.failed = false
          merged.meta.cancelled = false
          merged.meta.interrupted = false
          merged.meta.paused = true
          merged.meta.streaming = false
          merged.meta.serverConnectionState = serverMeta.serverConnectionState || 'paused'
          merged.meta.serverClarification = serverMeta.serverClarification ?? null
          merged.meta.directoryAuthorizationPending = false
          merged.meta.serverResumeResolution = null
          if (serverPauseSequence !== null) {
            merged.meta.serverLastSequence = serverPauseSequence
          }
        } else if (!localHasNewerTurnState
          && !recoveryStub
          && serverMeta.serverAuthoritative === true
          && serverMeta.streaming !== true) {
          // A canonical completed assistant row must clear every lifecycle bit
          // inherited from an older local failure/pause/interruption. Without
          // this branch the final text can be complete while the UI still
          // renders the task as unfinished.
          merged.meta.failed = false
          merged.meta.cancelled = false
          merged.meta.interrupted = false
          merged.meta.paused = false
          merged.meta.streaming = false
          merged.meta.serverConnectionState = null
          merged.meta.serverRecoveryBlocked = false
          merged.meta.serverClarification = null
          merged.meta.directoryAuthorizationPending = false
          merged.meta.serverResumeResolution = null
          for (const key of recoveryMetaKeys) merged.meta[key] = null
          if (!Object.hasOwn(serverMeta, 'serverPartialText')) {
            delete merged.meta.serverPartialText
          }
          if (serverPauseSequence !== null) {
            merged.meta.serverLastSequence = serverPauseSequence
          }
        }
      }
    }
    return merged
  })
  const pendingLocal = (Array.isArray(localMessages) ? localMessages : []).filter((message) => (
    message?.id && !serverIds.has(message.id)
    && (message?.meta?.pendingServerSync === true || message?.meta?.streaming === true)
  ))
  return [...mergedMessages, ...pendingLocal].sort((left, right) => (
    Number(left?.timestamp || 0) - Number(right?.timestamp || 0)
  ))
}

function bindActionToSession(action, sessionId) {
  if (action.type !== 'COMPACT_SESSION' && action.type !== 'EXPAND_COMPACTED') return action
  return {
    ...action,
    payload: {
      ...(action.payload || {}),
      sessionId,
    },
  }
}

export function projectSessionMutation({ state, action, sessionId, reduceState }) {
  const session = state?.sessions?.find((candidate) => candidate.id === sessionId)
  if (!session || !isServerBackedSession(session)) return null
  if (action.type === 'DELETE_SESSION') {
    return {
      kind: 'delete',
      sessionId,
      expectedRevision: session.serverRevision,
    }
  }

  const projectionState = ACTIVE_SESSION_MUTATION_TYPES.has(action.type)
    ? { ...state, activeSessionId: sessionId }
    : state
  const projectedState = reduceState(projectionState, bindActionToSession(action, sessionId))
  const projectedSession = projectedState?.sessions?.find((candidate) => candidate.id === sessionId)
  if (!projectedSession || projectedSession.messages === session.messages) return null
  return {
    kind: 'replace',
    sessionId,
    expectedRevision: session.serverRevision,
    sourceMessages: session.messages,
    messages: projectedSession.messages,
  }
}

export function createSessionMutationDispatcher({
  getState,
  reduceState,
  dispatchImmediate,
  applyServerAction,
  replaceMessages,
  deleteSession,
  canFetchSessionSnapshot = () => true,
  fetchSessionSnapshot = null,
  resolveSessionMetadata = null,
  onError = () => {},
}) {
  const queues = new Map()
  const snapshotRequests = new Map()
  const hydratedRevisions = new Map()

  const applyCompleteSessionSnapshot = (sessionId, snapshot) => {
    if (snapshot?.complete !== true || !Array.isArray(snapshot.messages) || !Number.isInteger(snapshot.revision)) {
      const error = new Error('Server returned an invalid complete session snapshot')
      error.code = 'INVALID_SESSION_SNAPSHOT'
      throw error
    }
    if (snapshot.messages.length === 0) hydratedRevisions.set(sessionId, snapshot.revision)
    else hydratedRevisions.delete(sessionId)
    applyServerAction({
      type: 'APPLY_SERVER_SESSION_SNAPSHOT',
      payload: { sessionId, snapshot },
    })
    return snapshot
  }

  const hydrateSessionSnapshot = (session, action) => {
    if (typeof fetchSessionSnapshot !== 'function' || !canFetchSessionSnapshot()) return undefined
    const sessionId = session?.id
    const revision = isServerBackedSession(session) ? session.serverRevision : null
    if (!needsServerSessionSnapshot(session, hydratedRevisions.get(sessionId))) return undefined

    const pending = snapshotRequests.get(sessionId)
    if (pending && (pending.revision === revision || pending.revision === null || revision === null)) {
      return pending.promise
    }

    const operation = Promise.resolve()
      .then(async () => {
        if (!isServerBackedSession(session)) {
          if (typeof resolveSessionMetadata !== 'function') return false
          const metadata = await resolveSessionMetadata({ sessionId })
          if (!metadata) return false
          if (!Number.isInteger(metadata.revision)) {
            const error = new Error('Session metadata is missing a valid revision')
            error.code = 'INVALID_SESSION_REVISION'
            throw error
          }
          applyServerAction({
            type: 'APPLY_SERVER_SESSION_METADATA',
            payload: { sessionId, session: metadata },
          })
        }
        const snapshot = await fetchSessionSnapshot({ sessionId })
        applyCompleteSessionSnapshot(sessionId, snapshot)
        return true
      })
      .catch((error) => {
        onError(error, { action, sessionId })
        return false
      })

    const tracked = operation.finally(() => {
      if (snapshotRequests.get(sessionId)?.promise === tracked) snapshotRequests.delete(sessionId)
    })
    snapshotRequests.set(sessionId, { revision, promise: tracked })
    return tracked
  }

  return function dispatchWithSessionSync(action) {
    if (action?.type === 'SWITCH_SESSION' || action?.type === 'HYDRATE_SERVER_SESSION') {
      const sessionId = typeof action.payload === 'string' ? action.payload : action.payload?.sessionId
      const storedSession = getState()?.sessions?.find((candidate) => candidate.id === sessionId)
      const session = action.type === 'HYDRATE_SERVER_SESSION' && Number.isInteger(action.payload?.revision)
        ? { ...(storedSession || {}), id: sessionId, serverRevision: action.payload.revision, messages: [] }
        : storedSession
      if (action.type === 'SWITCH_SESSION') dispatchImmediate(action)
      return session ? hydrateSessionSnapshot(session, action) : undefined
    }

    if (!isServerSessionMutation(action)) {
      dispatchImmediate(action)
      return undefined
    }

    const initialState = getState()
    const sessionId = resolveSessionMutationTarget(initialState, action)
    const initialSession = initialState?.sessions?.find((candidate) => candidate.id === sessionId)
    if (!sessionId || !initialSession) {
      dispatchImmediate(action)
      return undefined
    }
    if (!isServerBackedSession(initialSession) && typeof resolveSessionMetadata !== 'function') {
      dispatchImmediate(action)
      return undefined
    }

    const previous = queues.get(sessionId) || Promise.resolve()
    const operation = previous.catch(() => false).then(async () => {
      try {
        const currentSession = getState()?.sessions?.find((candidate) => candidate.id === sessionId)
        if (currentSession && !isServerBackedSession(currentSession)) {
          const metadata = await resolveSessionMetadata({ sessionId })
          if (!metadata) {
            dispatchImmediate(action)
            return true
          }
          if (!Number.isInteger(metadata.revision)) {
            const error = new Error('Session metadata is missing a valid revision')
            error.code = 'INVALID_SESSION_REVISION'
            throw error
          }
          applyServerAction({
            type: 'APPLY_SERVER_SESSION_METADATA',
            payload: { sessionId, session: metadata },
          })
        }
        const plan = projectSessionMutation({
          state: getState(),
          action,
          sessionId,
          reduceState,
        })
        if (!plan) return false

        if (plan.kind === 'delete') {
          await deleteSession({
            sessionId: plan.sessionId,
            expectedRevision: plan.expectedRevision,
          })
          applyServerAction({
            type: 'APPLY_SERVER_SESSION_DELETE',
            payload: { sessionId: plan.sessionId },
          })
          return true
        }

        let committedMessages = plan.messages
        let result
        try {
          result = await replaceMessages({
            sessionId: plan.sessionId,
            expectedRevision: plan.expectedRevision,
            messages: plan.messages,
          })
        } catch (error) {
          const canConfirmCommit = canConfirmReplacementAfterError(error)
            && typeof fetchSessionSnapshot === 'function'
            && canFetchSessionSnapshot()
          if (!canConfirmCommit) throw error

          const snapshot = await fetchSessionSnapshot({ sessionId })
          applyCompleteSessionSnapshot(sessionId, snapshot)
          if (sameSessionTranscript(snapshot.messages, plan.messages)) return true

          // Replaying a destructive action against a genuinely newer transcript
          // can erase messages written by another tab. Retry only when the full
          // snapshot proves that the source transcript itself is unchanged, and
          // derive the retry payload from that canonical snapshot rather than
          // from the stale local projection.
          const sourceIsStillCurrent = snapshot.revision >= plan.expectedRevision
            && sameSessionTranscript(snapshot.messages, plan.sourceMessages)
          if (!sourceIsStillCurrent) throw error

          const currentState = getState()
          const retryState = {
            ...currentState,
            sessions: (currentState?.sessions || []).map((session) => (
              session.id === sessionId
                ? { ...session, messages: snapshot.messages, serverRevision: snapshot.revision }
                : session
            )),
          }
          const retryPlan = projectSessionMutation({
            state: retryState,
            action,
            sessionId,
            reduceState,
          })
          if (!retryPlan || retryPlan.kind !== 'replace') throw error

          committedMessages = retryPlan.messages
          result = await replaceMessages({
            sessionId: retryPlan.sessionId,
            expectedRevision: retryPlan.expectedRevision,
            messages: retryPlan.messages,
          })
        }
        applyServerAction({
          type: 'APPLY_SERVER_SESSION_MESSAGES',
          payload: {
            sessionId: plan.sessionId,
            messages: committedMessages,
            revision: result.revision,
          },
        })
        return true
      } catch (error) {
        onError(error, { action, sessionId })
        return false
      }
    })

    const tracked = operation.finally(() => {
      if (queues.get(sessionId) === tracked) queues.delete(sessionId)
    })
    queues.set(sessionId, tracked)
    return operation
  }
}
