import { findAuthorizedDirectoryGrantByIdAndScope } from './localFileAccessService.js'
import {
  filterAuthorizedDirectoryResolutions,
  normalizeDirectoryAuthorizationResolutions,
} from './turnResolutionRuntime.js'

const JOB_DIRECTORY_RESOLUTION_MARKER_RE = /\[JOB_DIRECTORY_RESOLUTION:([^\]\r\n]+)\]/u

export function filterLiveJobDirectoryAuthorizationCheckpoint(checkpoint, {
  userId,
  findGrant = findAuthorizedDirectoryGrantByIdAndScope,
} = {}) {
  if (!checkpoint?.state || typeof checkpoint.state !== 'object') return checkpoint
  const hasResolutionField = Object.hasOwn(
    checkpoint.state,
    'directoryAuthorizationResolution',
  )
  const resolutions = normalizeDirectoryAuthorizationResolutions(
    hasResolutionField ? checkpoint.state.directoryAuthorizationResolution : null,
  )
  const grants = []
  for (const resolution of resolutions) {
    try {
      const grant = findGrant({
        userId,
        grantId: resolution.grant_id,
        authorizationScope: resolution.authorization_scope,
        rawPath: resolution.path,
        accessMode: resolution.access_mode,
      })
      if (grant) {
        // The exact bound grant already proved it still covers this requested
        // path. Project that proof onto the checkpoint path so a parent grant
        // remains valid for its child without weakening identity or scope.
        grants.push({ ...grant, path: resolution.path })
      }
    } catch {
      // A checkpoint is never authority. An unreadable current grant fails closed.
    }
  }
  const liveResolutions = filterAuthorizedDirectoryResolutions(resolutions, grants)
  const liveEventIds = new Set(liveResolutions
    .map((resolution) => String(resolution.awaiting_event_id || '').trim())
    .filter(Boolean))
  const messages = Array.isArray(checkpoint.state.messages)
    ? checkpoint.state.messages.filter((message) => {
        if (message?.role !== 'system') return true
        const marker = String(message.content || '').match(JOB_DIRECTORY_RESOLUTION_MARKER_RE)
        return !marker || liveEventIds.has(String(marker[1] || '').trim())
      })
    : checkpoint.state.messages
  if (!hasResolutionField
      && (!Array.isArray(messages) || messages.length === checkpoint.state.messages.length)) {
    return checkpoint
  }
  return {
    ...checkpoint,
    state: {
      ...checkpoint.state,
      ...(hasResolutionField
        ? { directoryAuthorizationResolution: liveResolutions }
        : {}),
      ...(Array.isArray(messages) ? { messages } : {}),
    },
  }
}
