import path from 'node:path'
import { isSuccessfulTurnCompletedEvent } from '../../shared/turnEventProjection.js'

const TURN_RESOLUTION_MARKER = '[TURN_RESOLUTION:'
export const MAX_DIRECTORY_AUTHORIZATION_RESOLUTIONS = 8

export class TurnEngineError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.name = 'TurnEngineError'
    this.code = code
    this.status = status
  }
}

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function defaultDirectoryPathIdentity(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  const windowsPath = path.win32.isAbsolute(raw)
  const api = windowsPath ? path.win32 : path.posix
  const normalized = api.normalize(raw).replace(/[\\/]+$/, '').replace(/\\/g, '/')
  return windowsPath || process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function isDirectoryAuthorizationResolution(value) {
  return isRecord(value)
    && value.type === 'directory_authorization'
    && value.approved === true
}

/**
 * Checkpoints before multi-directory resume stored one resolution object.
 * Normalize both that legacy shape and the current bounded list without
 * retaining duplicate grants or duplicate canonical directory identities.
 */
export function normalizeDirectoryAuthorizationResolutions(value, {
  normalizePath = defaultDirectoryPathIdentity,
  limit = MAX_DIRECTORY_AUTHORIZATION_RESOLUTIONS,
} = {}) {
  const boundedLimit = Math.max(1, Math.min(
    MAX_DIRECTORY_AUTHORIZATION_RESOLUTIONS,
    Math.floor(Number(limit)) || MAX_DIRECTORY_AUTHORIZATION_RESOLUTIONS,
  ))
  const candidates = Array.isArray(value) ? value : (isRecord(value) ? [value] : [])
  const normalized = []
  for (const candidate of candidates) {
    if (!isDirectoryAuthorizationResolution(candidate)) continue
    const grantId = String(candidate.grant_id || candidate.grantId || '').trim()
    const pathIdentity = normalizePath(candidate.path)
    if (!pathIdentity) continue
    const duplicateIndex = normalized.findIndex((entry) => (
      (grantId && entry.grantId === grantId) || entry.pathIdentity === pathIdentity
    ))
    if (duplicateIndex >= 0) normalized.splice(duplicateIndex, 1)
    normalized.push({
      grantId,
      pathIdentity,
      resolution: { ...candidate },
    })
    if (normalized.length > boundedLimit) normalized.shift()
  }
  return normalized.map(({ resolution }) => resolution)
}

export function mergeDirectoryAuthorizationResolutions(current, resolution, options = {}) {
  return normalizeDirectoryAuthorizationResolutions([
    ...normalizeDirectoryAuthorizationResolutions(current, options),
    resolution,
  ], options)
}

function hasMatchingDirectoryGrant(grants, resolution, normalizePath) {
  const expectedPath = normalizePath(resolution?.path)
  return (Array.isArray(grants) ? grants : []).some((grant) => {
    if (String(grant?.id || '').trim() !== String(resolution?.grant_id || '').trim()) return false
    if (grant?.resourceType !== 'directory') return false
    if (String(grant?.scope || '').trim() !== String(resolution?.authorization_scope || '').trim()) return false
    if (grant.available === false) return false
    if (normalizePath(grant.path) !== expectedPath) return false
    return resolution?.access_mode !== 'read_write' || grant.accessMode === 'read_write'
  })
}

export function filterAuthorizedDirectoryResolutions(value, grants, {
  normalizePath = defaultDirectoryPathIdentity,
} = {}) {
  return normalizeDirectoryAuthorizationResolutions(value, { normalizePath })
    .filter((resolution) => hasMatchingDirectoryGrant(grants, resolution, normalizePath))
}

/**
 * Pure pause/resume policy for a Turn.
 *
 * Path identity is injected because the host owns platform-specific grant
 * normalization. The returned runtime has no storage, model, or event-writer
 * dependencies and can be exercised independently from TurnEngine.
 */
export function createTurnResolutionRuntime({ normalizePath } = {}) {
  if (typeof normalizePath !== 'function') {
    throw new TypeError('normalizePath is required')
  }

  const normalizeResolution = (value) => {
    if (!isRecord(value)) {
      throw new TurnEngineError('TURN_RESOLUTION_INVALID', 'resolution must be a structured object', 400)
    }
    const pausedSequence = Number(value.paused_sequence ?? value.pausedSequence)
    if (!Number.isInteger(pausedSequence) || pausedSequence < 0) {
      throw new TurnEngineError(
        'TURN_RESOLUTION_SEQUENCE_REQUIRED',
        'resolution must include the pending turn.paused sequence',
        400,
      )
    }
    const type = String(value.type || '').trim()
    const rawPath = String(value.path || '').trim()
    const resourceType = String(value.resource_type || value.resourceType || '').trim()
    const directoryResolution = type === 'directory_authorization'
      || resourceType === 'directory'
      || !!rawPath
    if (directoryResolution) {
      const accessMode = String(value.access_mode || value.accessMode || '').trim()
      const authorizationScope = String(
        value.authorization_scope || value.authorizationScope || '',
      ).trim()
      const grantId = String(value.grant_id || value.grantId || '').trim()
      if (type && type !== 'directory_authorization') {
        throw new TurnEngineError('TURN_RESOLUTION_INVALID', 'directory resolution type must be directory_authorization', 400)
      }
      if (value.approved !== true) {
        throw new TurnEngineError('TURN_RESOLUTION_NOT_APPROVED', 'directory authorization must be explicitly approved', 400)
      }
      if (!rawPath || (!path.win32.isAbsolute(rawPath) && !path.posix.isAbsolute(rawPath))) {
        throw new TurnEngineError('TURN_RESOLUTION_PATH_REQUIRED', 'directory authorization requires an absolute path', 400)
      }
      if (!['read_only', 'read_write'].includes(accessMode)) {
        throw new TurnEngineError('TURN_RESOLUTION_ACCESS_MODE_INVALID', 'directory authorization requires read_only or read_write access_mode', 400)
      }
      if (!['session', 'persistent'].includes(authorizationScope)) {
        throw new TurnEngineError(
          'TURN_RESOLUTION_AUTHORIZATION_SCOPE_INVALID',
          'directory authorization requires session or persistent authorization_scope',
          400,
        )
      }
      if (!grantId) {
        throw new TurnEngineError(
          'TURN_RESOLUTION_GRANT_ID_REQUIRED',
          'directory authorization requires the persisted grant id',
          400,
        )
      }
      return {
        type: 'directory_authorization',
        approved: true,
        path: rawPath,
        access_mode: accessMode,
        authorization_scope: authorizationScope,
        grant_id: grantId,
        resource_type: 'directory',
        paused_sequence: pausedSequence,
        ...(String(value.purpose || '').trim() ? { purpose: String(value.purpose).trim() } : {}),
      }
    }
    const response = String(value.response ?? value.answer ?? value.content ?? '').trim()
    if (!response) {
      throw new TurnEngineError('TURN_RESOLUTION_RESPONSE_REQUIRED', 'clarification resolution requires a response', 400)
    }
    return { type: type || 'clarification_response', response, paused_sequence: pausedSequence }
  }

  const validateForPause = (resolution, pausedEvent) => {
    if (resolution.paused_sequence !== pausedEvent.sequence) {
      throw new TurnEngineError(
        'TURN_RESOLUTION_STALE',
        'resolution does not match the latest pending pause',
        409,
      )
    }
    const clarification = pausedEvent.payload?.clarification
    const requestType = isRecord(clarification)
      ? String(clarification.request_type || clarification.requestType || '').trim()
      : ''
    const directoryRequest = requestType === 'directory'
    const directoryResolution = resolution.type === 'directory_authorization'
    if (directoryRequest !== directoryResolution) {
      throw new TurnEngineError(
        'TURN_RESOLUTION_TYPE_MISMATCH',
        'resolution type does not match the pending clarification',
        409,
      )
    }
    if (!directoryRequest) return
    const requiredMode = String(
      clarification.access_mode || clarification.accessMode || 'read_only',
    ).trim()
    if (resolution.access_mode !== requiredMode) {
      throw new TurnEngineError(
        'TURN_RESOLUTION_ACCESS_MODE_MISMATCH',
        'directory resolution access mode does not match the pending request',
        409,
      )
    }
  }

  const hasSufficientDirectoryGrant = (grants, resolution) => (
    hasMatchingDirectoryGrant(grants, resolution, normalizePath)
  )

  const resolutionPrompt = (resolution, pausedSequence) => {
    const marker = `${TURN_RESOLUTION_MARKER}${pausedSequence}]`
    if (resolution.type === 'directory_authorization') {
      return [
        marker,
        'The requested local directory authorization is already persisted and verified.',
        `Continue the original task using the exact authorized path ${JSON.stringify(resolution.path)} with ${resolution.access_mode} access.`,
        'Do not call request_directory again for this same path and access mode.',
        'If a later operation fails, handle the concrete new error instead of treating this verified grant as missing.',
      ].join(' ')
    }
    return [
      marker,
      `The user answered the pending clarification: ${JSON.stringify(resolution.response)}.`,
      'Continue the original task from the durable checkpoint and do not repeat the same clarification request.',
    ].join(' ')
  }

  const applyToCheckpoint = (state, resumeContext) => {
    if (!isRecord(state) || !resumeContext?.resolution) return state || null
    const marker = `${TURN_RESOLUTION_MARKER}${resumeContext.pausedSequence}]`
    const messages = Array.isArray(state.messages)
      ? state.messages.map((message) => ({ ...message }))
      : []
    const resolutionRole = resumeContext.resolution.type === 'directory_authorization'
      ? 'system'
      : 'user'
    if (!messages.some((message) => (
      message?.role === resolutionRole && String(message?.content || '').includes(marker)
    ))) {
      messages.push({
        role: resolutionRole,
        content: resolutionPrompt(resumeContext.resolution, resumeContext.pausedSequence),
      })
    }
    const restored = { ...state, messages }
    if (resumeContext.resolution.type === 'directory_authorization'
      && resumeContext.resolution.approved === true) {
      const directoryResolution = {
        ...resumeContext.resolution,
        paused_sequence: resumeContext.pausedSequence,
      }
      restored.directoryAuthorizationResolution = mergeDirectoryAuthorizationResolutions(
        state.directoryAuthorizationResolution,
        directoryResolution,
        { normalizePath },
      )
    }
    if (isRecord(restored.final) && restored.final.paused === true) delete restored.final
    return restored
  }

  const pauseState = (events) => {
    const paused = events.filter((event) => event.type === 'turn.paused').at(-1) || null
    if (!paused) return { paused: null, resumed: null, pending: false }
    const resumed = events
      .filter((event) => event.type === 'turn.resumed' && event.sequence > paused.sequence)
      .at(-1) || null
    return { paused, resumed, pending: !resumed }
  }

  const publicStatus = (lastEvent, running = false) => {
    if (!lastEvent) return 'not_found'
    if (lastEvent.type === 'turn.paused') return 'paused'
    if (lastEvent.type === 'turn.blocked') return 'blocked'
    if (running) return 'running'
    if (lastEvent.type === 'turn.completed') {
      return isSuccessfulTurnCompletedEvent(lastEvent) ? 'completed' : 'incomplete'
    }
    if (lastEvent.type === 'turn.cancelled') return 'cancelled'
    if (lastEvent.type === 'turn.failed') return 'failed'
    if (lastEvent.type === 'turn.interrupted') return 'interrupted'
    if (lastEvent.type === 'approval.required') return 'awaiting_approval'
    return 'paused'
  }

  return Object.freeze({
    applyToCheckpoint,
    hasSufficientDirectoryGrant,
    normalizeResolution,
    pauseState,
    publicStatus,
    validateForPause,
  })
}
