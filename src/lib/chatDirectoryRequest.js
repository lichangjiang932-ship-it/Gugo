import { grantLocalPathApi } from './localFileAccessClient.js'

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
} = {}, {
  grantPath = grantLocalPathApi,
} = {}) {
  if (!sessionId) throw new Error('sessionId is required')
  if (!turnId) throw new Error('turnId is required')
  if (!Number.isInteger(pausedSequence) || pausedSequence < 0) {
    throw new Error('pausedSequence is required')
  }
  if (!VALID_ACCESS_MODES.has(accessMode)) throw new Error('invalid directory access mode')
  if (!VALID_SCOPES.has(scope)) throw new Error('invalid directory authorization scope')

  const selectedPath = String(path || '').trim()
  if (!selectedPath) throw new Error('directory path is required')

  const grantResult = await grantPath({ path: selectedPath, accessMode, scope })
  const grant = grantResult?.grant
  const grantedPath = String(grant?.path || selectedPath).trim()
  const grantedAccessMode = grant?.accessMode === 'read_write' ? 'read_write' : accessMode
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
