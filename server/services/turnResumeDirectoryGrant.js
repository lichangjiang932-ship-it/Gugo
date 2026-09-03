import { TurnEngineError } from './turnResolutionRuntime.js'

export function createTurnResumeDirectoryGrantGuard({
  readFileAccessStatus,
  hasSufficientDirectoryGrant,
}) {
  return function assertCurrentDirectoryGrant(userId, resolution) {
    if (resolution?.type !== 'directory_authorization') return
    let grants
    try {
      grants = readFileAccessStatus({ userId })?.grants || []
    } catch (error) {
      const wrapped = new TurnEngineError(
        'TURN_DIRECTORY_GRANT_CHECK_FAILED',
        'failed to verify the persisted directory authorization',
        500,
      )
      wrapped.cause = error
      throw wrapped
    }
    if (!hasSufficientDirectoryGrant(grants, resolution)) {
      throw new TurnEngineError(
        'TURN_DIRECTORY_GRANT_NOT_FOUND',
        'the requested directory authorization is not persisted for this user',
        403,
      )
    }
  }
}
