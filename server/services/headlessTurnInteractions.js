import path from 'node:path'

function interactionError(code, message) {
  return Object.assign(new Error(message), { code, exitCode: 1 })
}

function exactId(value) {
  return typeof value === 'string' && value.length > 0 && value === value.trim()
}

function frozenSnapshot(value) {
  if (value == null) return null
  const copied = JSON.parse(JSON.stringify(value))
  const freeze = (entry) => {
    if (!entry || typeof entry !== 'object') return entry
    for (const child of Object.values(entry)) freeze(child)
    return Object.freeze(entry)
  }
  return freeze(copied)
}

function samePath(left, right) {
  const values = [left, right].map((value) => path.resolve(value))
  return process.platform === 'win32' ? values[0].toLowerCase() === values[1].toLowerCase() : values[0] === values[1]
}

function boundaryFor(event) {
  return Object.freeze({ id: event.id, sequence: event.sequence, type: event.type })
}

function directoryRequest(event) {
  const request = event?.payload?.clarification
  return event?.type === 'turn.paused' && (request?.request_type || request?.requestType) === 'directory'
    ? request : null
}

function sideEffectRequest(event) {
  const payload = event?.payload
  return event?.type === 'turn.blocked' && payload?.code === 'SIDE_EFFECT_OUTCOME_UNKNOWN'
    && payload.requiresUserVerification === true && payload.recoveryKind === 'side_effect_outcome_unknown'
    ? payload : null
}

function assertEventOwner(event, scope) {
  if (event?.sessionId !== scope.sessionId || event?.turnId !== scope.turnId
    || !exactId(event?.id) || !Number.isInteger(event?.sequence) || event.sequence < 0) {
    throw interactionError('CLI_RECOVERY_SCOPE_MISMATCH', 'The interaction does not belong to the current CLI turn.')
  }
}

function assertRecordOwner(record, scope, toolCallId, { pending = true } = {}) {
  if (!record || record.scopeKind !== 'turn' || record.sessionId !== scope.sessionId
    || record.turnId !== scope.turnId || record.toolCallId !== toolCallId
    || record.scopeKey !== JSON.stringify(['turn', scope.sessionId, scope.turnId])
    || (pending && record.status !== 'unknown')) {
    throw interactionError('CLI_RECOVERY_SCOPE_MISMATCH', 'The recovery record does not match the exact pending operation.')
  }
}

async function directoryResolution({ input, scope, ports, workspace }, event, request) {
  const accessMode = request.access_mode || request.accessMode || 'read_only'
  if (!['read_only', 'read_write'].includes(accessMode)) {
    throw interactionError('CLI_DIRECTORY_REQUEST_INVALID', 'The requested directory access mode is invalid.')
  }
  const boundary = boundaryFor(event)
  const decision = await input.onDirectoryRequest({ event, request, workspace,
    canonicalizeDirectory: (selectedPath) => ports.canonicalizeDirectory({ ...scope, boundary, path: selectedPath }),
  })
  if (input.signal?.aborted || decision?.approved !== true) return null
  const selectedPath = decision.path
  if (typeof selectedPath !== 'string' || !path.isAbsolute(selectedPath)
    || decision.accessMode !== accessMode) {
    throw interactionError('CLI_DIRECTORY_CONFIRMATION_MISMATCH', 'Confirm the exact absolute directory and requested access mode.')
  }
  const grant = await ports.grantDirectory({ ...scope, boundary, path: selectedPath, accessMode, scope: 'session' })
  if (input.signal?.aborted) return null
  if (!grant || grant.resourceType !== 'directory' || !exactId(grant.id) || !path.isAbsolute(grant.path || '')
    || !samePath(grant.path, selectedPath) || !['session', 'persistent'].includes(grant.scope)) {
    throw interactionError('CLI_DIRECTORY_GRANT_INVALID', 'The host did not return a sufficient directory grant.')
  }
  const existing = grant.preexistingPermission
  const reusesExisting = grant.scope === 'persistent' && existing?.id === grant.id
    && existing.scope === grant.scope && existing.path === grant.path && existing.accessMode === grant.accessMode
  if ((grant.scope === 'persistent' && !reusesExisting)
    || (grant.accessMode !== accessMode && !(reusesExisting && grant.accessMode === 'read_write'))) {
    throw interactionError('CLI_DIRECTORY_GRANT_INVALID', 'The grant must not widen the confirmed access mode or create persistent authority.')
  }
  return { resolution: {
    type: 'directory_authorization', approved: true, path: grant.path, access_mode: accessMode,
    authorization_scope: grant.scope, grant_id: grant.id, resource_type: 'directory',
    paused_sequence: event.sequence, purpose: String(request.purpose || request.why || '').trim(),
  } }
}

async function sideEffectResolution({ input, scope, ports }, event, request) {
  const toolCallId = request.toolCallId
  if (!exactId(toolCallId)) throw interactionError('CLI_RECOVERY_TOOL_CALL_REQUIRED', 'The blocked turn has no exact recoverable tool call ID.')
  const record = frozenSnapshot(await ports.readUnknownSideEffect({ ...scope, toolCallId }))
  assertRecordOwner(record, scope, toolCallId)
  if (input.signal?.aborted) return null
  const decision = await input.onSideEffectRecovery({ event, record })
  if (input.signal?.aborted || decision == null || decision.resolution === 'defer') return null
  if (!['committed', 'failed'].includes(decision.resolution) || decision.verificationConfirmed !== true
    || decision.confirmToolCallId !== toolCallId) {
    throw interactionError('CLI_RECOVERY_CONFIRMATION_REQUIRED', 'Recovery requires a verified outcome for this exact tool call; ordinary approval is insufficient.')
  }
  const resolved = await ports.resolveUnknownSideEffect({
    ...scope, boundary: boundaryFor(event), scopeKey: record.scopeKey, toolCallId, argsDigest: record.argsDigest,
    verificationConfirmed: true, confirmToolCallId: toolCallId, resolution: decision.resolution,
    ...(typeof decision.note === 'string' && decision.note.trim() ? { note: decision.note.trim() } : {}),
  })
  assertRecordOwner(resolved?.record, scope, toolCallId, { pending: false })
  if (resolved.record.scopeKey !== record.scopeKey || resolved.record.status !== decision.resolution
    || resolved.resume?.kind !== 'turn' || resolved.resume.sessionId !== scope.sessionId
    || resolved.resume.turnId !== scope.turnId || resolved.resume.toolCallId !== toolCallId) {
    throw interactionError('CLI_RECOVERY_RESUME_MISMATCH', 'Recovery did not return a matching continuation for this turn.')
  }
  return input.signal?.aborted ? null : { retryRecovery: true }
}

/** Resolve only the current durable boundary; never reinterpret unknown outcome as approval. */
export function createHeadlessTurnInteractions({ input, scope, ports, workspace }) {
  const handled = new Set()
  const kind = (event) => directoryRequest(event) && typeof input.onDirectoryRequest === 'function' ? 'directory'
    : sideEffectRequest(event) && typeof input.onSideEffectRecovery === 'function' ? 'side_effect' : null
  const canHandle = (event) => input.interactive === true && !input.signal?.aborted && kind(event)
    && !handled.has(`${event.type}:${event.sequence}`)
  return {
    canHandle,
    async prepareResume(event) {
      if (!canHandle(event)) return null
      assertEventOwner(event, scope)
      const capturedEvent = frozenSnapshot(event)
      const required = kind(event) === 'directory'
        ? ['canonicalizeDirectory', 'grantDirectory'] : ['readUnknownSideEffect', 'resolveUnknownSideEffect']
      if (required.some((name) => typeof ports?.[name] !== 'function')) {
        throw interactionError('CLI_INTERACTIVE_RECOVERY_UNSUPPORTED', 'This runtime has no scoped recovery capability for the current request.')
      }
      handled.add(`${event.type}:${event.sequence}`)
      const context = { input, scope, ports, workspace }
      return kind(capturedEvent) === 'directory'
        ? directoryResolution(context, capturedEvent, directoryRequest(capturedEvent))
        : sideEffectResolution(context, capturedEvent, sideEffectRequest(capturedEvent))
    },
  }
}
