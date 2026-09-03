import { removeVerifiedLocalFilesFromRetained } from '../lib/localFileReferences.js'

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

function stableTerminalFailure(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const failure = { ...value }
  for (const field of ['message', 'hint', 'reason']) delete failure[field]
  if (failure.error && typeof failure.error === 'object' && !Array.isArray(failure.error)) {
    failure.error = stableTerminalFailure(failure.error)
  } else if (Object.hasOwn(failure, 'error')) {
    delete failure.error
  }
  if (failure.cause && typeof failure.cause === 'object' && !Array.isArray(failure.cause)) {
    failure.cause = stableTerminalFailure(failure.cause)
  } else if (Object.hasOwn(failure, 'cause')) {
    delete failure.cause
  }
  if (failure.recovery && typeof failure.recovery === 'object' && !Array.isArray(failure.recovery)) {
    const recovery = { ...failure.recovery }
    for (const field of ['message', 'hint', 'reason', 'errorMessage']) delete recovery[field]
    if (recovery.error && typeof recovery.error === 'object' && !Array.isArray(recovery.error)) {
      recovery.error = stableTerminalFailure(recovery.error)
    } else if (Object.hasOwn(recovery, 'error')) {
      delete recovery.error
    }
    if (recovery.cause && typeof recovery.cause === 'object' && !Array.isArray(recovery.cause)) {
      recovery.cause = stableTerminalFailure(recovery.cause)
    } else if (Object.hasOwn(recovery, 'cause')) {
      delete recovery.cause
    }
    failure.recovery = recovery
  }
  return failure
}

function mergeTerminalFailureDiagnostics(serverFailure, localFailure) {
  const stableServerFailure = stableTerminalFailure(serverFailure)
  const stableLocalFailure = stableTerminalFailure(localFailure)
  if (!stableServerFailure || typeof stableServerFailure !== 'object' || Array.isArray(stableServerFailure)) {
    return stableServerFailure
  }
  if (!stableLocalFailure || typeof stableLocalFailure !== 'object' || Array.isArray(stableLocalFailure)) {
    return stableServerFailure
  }
  const merged = { ...stableLocalFailure, ...stableServerFailure }
  for (const key of ['incompleteReason', 'nextAction']) {
    const serverValue = String(stableServerFailure[key] || '').trim()
    const localValue = String(stableLocalFailure[key] || '').trim()
    if (serverValue || localValue) merged[key] = serverValue || localValue
  }
  for (const key of ['missingRequirements', 'taskVerification']) {
    if (!hasMeaningfulEvidence(stableServerFailure[key]) && hasMeaningfulEvidence(stableLocalFailure[key])) {
      merged[key] = stableLocalFailure[key]
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
            // Presence is the authority boundary for persisted receipts. An
            // explicit empty list means the latest terminal projection found
            // no files in that state and must clear an older live/retry list.
            merged.meta[key] = serverMeta[key]
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
