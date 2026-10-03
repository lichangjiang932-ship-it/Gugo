import { TurnEngineError } from './turnResolutionRuntime.js'

/** Execution directories and durable session grouping are separate decisions. */
export function normalizeSessionWorkspaceMode(value = 'follow-turn') {
  if (value === 'follow-turn' || value === 'create-only') return value
  throw new TurnEngineError('TURN_SESSION_WORKSPACE_MODE_INVALID',
    'sessionWorkspaceMode must be follow-turn or create-only')
}

/** Run inside the start transaction, after the event's idempotency check. */
export function persistTurnSessionWorkspace({ userId, event, createdSession, writeSessionWorkspace }) {
  const payload = event.payload || {}
  if (!Object.hasOwn(payload, 'workspacePath')) return
  const mode = normalizeSessionWorkspaceMode(payload.sessionWorkspaceMode)
  // Decide against the session actually created in this transaction, never
  // against a possibly stale preflight read or the supplied creation receipt.
  if (mode === 'create-only' && !createdSession) return
  const updated = writeSessionWorkspace({ userId, sessionId: event.sessionId, workspacePath: payload.workspacePath })
  if (!updated) {
    throw Object.assign(new Error('session workspace scope does not match event scope'), {
      code: 'TURN_STORAGE_SCOPE_MISMATCH', status: 409, retryable: false,
    })
  }
}
