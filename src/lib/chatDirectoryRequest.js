import { grantTurnDirectoryApi } from './localFileAccessClient.js'

const VALID_ACCESS_MODES = new Set(['read_only', 'read_write'])
const VALID_SCOPES = new Set(['session', 'persistent'])

export async function authorizeChatDirectoryRequest({
  sessionId,
  turnId,
  pausedSequence,
  path = '',
  accessMode = 'read_only',
  scope = 'session',
  purpose = '',
  signal,
} = {}, {
  grantPath = grantTurnDirectoryApi,
} = {}) {
  if (!sessionId) throw new Error('sessionId is required')
  if (!turnId) throw new Error('turnId is required')
  if (!Number.isSafeInteger(pausedSequence) || pausedSequence < 0) {
    throw new Error('pausedSequence is required')
  }
  if (!VALID_ACCESS_MODES.has(accessMode)) throw new Error('invalid directory access mode')
  if (!VALID_SCOPES.has(scope)) throw new Error('invalid directory authorization scope')

  const selectedPath = String(path || '').trim()
  if (!selectedPath) throw new Error('directory path is required')

  const grantResult = await grantPath({
    sessionId, turnId, pausedSequence, path: selectedPath, accessMode, scope,
  }, { signal })
  if (signal?.aborted) throw signal.reason || Object.assign(new Error('Directory confirmation was cancelled.'), { name: 'AbortError' })
  const grant = grantResult?.grant
  const grantedPath = String(grant?.path || selectedPath).trim()
  // A stronger pre-existing grant must not rewrite this pause's requested mode.
  const grantedAccessMode = accessMode
  const grantId = String(grant?.id || '').trim()
  if (!grantId) throw new Error('directory grant id is required')

  return {
    cancelled: false,
    path: grantedPath,
    accessMode: grantedAccessMode,
    scope: grant?.scope || scope,
    resolution: {
      type: 'directory_authorization',
      approved: true,
      path: grantedPath,
      access_mode: grantedAccessMode,
      authorization_scope: grant?.scope || scope,
      grant_id: grantId,
      paused_sequence: pausedSequence,
      purpose: String(purpose || '').trim(),
    },
  }
}
