import fs from 'node:fs'
import path from 'node:path'
import { grantLocalPath, getPersistentGrantRows } from './localFileAccessGrantStore.js'
import { readTurnInteractionBoundary, runWithTurnInteractionBoundary } from './turnInteractionBoundary.js'

function interactionError(message, stale = false) {
  return Object.assign(new Error(message), {
    code: stale ? 'TURN_INTERACTION_STALE' : 'TURN_DIRECTORY_AUTHORIZATION_INVALID',
    statusCode: stale ? 409 : 400,
    retryable: false,
  })
}

function canonicalDirectory(rootPath) {
  if (typeof rootPath !== 'string' || !path.isAbsolute(rootPath.trim())) {
    throw interactionError('Directory authorization requires an absolute directory path.')
  }
  let canonical
  try { canonical = fs.realpathSync(rootPath.trim()) } catch {
    throw interactionError('The selected directory does not exist or is unavailable.')
  }
  if (!fs.statSync(canonical).isDirectory()) {
    throw interactionError('The selected path must be a directory.')
  }
  return canonical
}

/** Grant only while this exact authenticated directory pause is still current. */
export function grantTurnDirectory({
  userId, sessionId, turnId, pausedSequence, rootPath,
  accessMode = 'read_only', scope = 'session',
} = {}) {
  if (!Number.isSafeInteger(pausedSequence) || pausedSequence < 0
    || !['read_only', 'read_write'].includes(accessMode)
    || !['session', 'persistent'].includes(scope)) {
    throw interactionError('Confirm the exact directory pause, access mode and authorization lifetime.')
  }
  const identity = { userId, sessionId, turnId }
  const boundary = readTurnInteractionBoundary(identity)
  if (boundary.type !== 'turn.paused' || boundary.sequence !== pausedSequence) {
    throw interactionError('This directory request is no longer the current task boundary.', true)
  }
  return runWithTurnInteractionBoundary({ ...identity, boundary }, ({ payload }) => {
    const requestedMode = payload.clarification.access_mode || payload.clarification.accessMode || 'read_only'
    if (accessMode !== requestedMode) {
      throw interactionError('The access mode must match the pending directory request.')
    }
    const canonical = canonicalDirectory(rootPath)
    const prior = getPersistentGrantRows(userId)
    const grant = grantLocalPath({ userId, rootPath: canonical, accessMode, scope })
    const preexisting = scope === 'session' && grant.scope === 'persistent'
      ? prior.find(row => row.id === grant.id) : null
    return {
      grant,
      boundary,
      interaction: { sessionId, turnId, pausedSequence, requestedPath: rootPath.trim(),
        canonicalPath: canonical, accessMode, scope },
      ...(preexisting ? { preexistingPermission: {
        id: preexisting.id, path: preexisting.root_path,
        accessMode: preexisting.access_mode, scope: 'persistent',
      } } : {}),
    }
  })
}
