import { grantLocalPathApi } from './localFileAccessClient.js'

const VALID_ACCESS_MODES = new Set(['read_only', 'read_write'])

export async function authorizeChatDirectoryRequest({
  sessionId,
  turnId,
  pausedSequence,
  path = '',
  accessMode = 'read_only',
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

  const selectedPath = String(path || '').trim()
  if (!selectedPath) throw new Error('directory path is required')

  const grantResult = await grantPath({ path: selectedPath, accessMode })
  const grant = grantResult?.grant
  const grantedPath = String(grant?.path || selectedPath).trim()
  const grantedAccessMode = grant?.accessMode === 'read_write' ? 'read_write' : accessMode

  return {
    cancelled: false,
    path: grantedPath,
    accessMode: grantedAccessMode,
    resolution: {
      type: 'directory_authorization',
      approved: true,
      path: grantedPath,
      access_mode: grantedAccessMode,
      paused_sequence: pausedSequence,
      purpose: String(purpose || '').trim(),
    },
  }
}
