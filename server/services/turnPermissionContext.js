import { AsyncLocalStorage } from 'node:async_hooks'
import { PERMISSION_MODES } from '../utils/approvalPolicy.js'

const contexts = new AsyncLocalStorage()
const MODE_RANK = Object.freeze({ plan: 0, normal: 1, acceptEdits: 2, bypass: 3 })

function invalidContext(message) {
  const error = new TypeError(message)
  error.code = 'TURN_PERMISSION_CONTEXT_INVALID'
  throw error
}

function mode(value) {
  if (typeof value !== 'string' || !PERMISSION_MODES.includes(value)) invalidContext('Invalid turn permission mode')
  return value
}

function identity(value) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > 512) {
    invalidContext('Turn permissions require an exact non-empty owner, session, and turn identity')
  }
  return value
}

function ownValue(record, key) {
  const descriptor = record && typeof record === 'object' && !Array.isArray(record)
    ? Object.getOwnPropertyDescriptor(record, key) : null
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalidContext(`Missing own permission context field: ${key}`)
  return descriptor.value
}

function accountSnapshot(value) {
  const accountMode = mode(ownValue(value, 'mode'))
  const revision = ownValue(value, 'revision')
  if (!Number.isSafeInteger(revision) || revision < 0) invalidContext('Invalid account permission revision')
  return { mode: accountMode, revision }
}

export function narrowerPermissionMode(left, right) {
  return MODE_RANK[mode(left)] <= MODE_RANK[mode(right)] ? left : right
}

function restoredContext(value, scope) {
  if (value == null) return null
  if (ownValue(value, 'version') !== 1) invalidContext('Unsupported turn permission context version')
  for (const key of ['userId', 'sessionId', 'turnId']) {
    if (identity(ownValue(value, key)) !== scope[key]) invalidContext('Restored turn permission context owner mismatch')
  }
  return {
    permissionMode: mode(ownValue(value, 'permissionMode')),
    account: accountSnapshot({ mode: ownValue(value, 'accountMode'), revision: ownValue(value, 'accountRevision') }),
  }
}

/** Host-only scope. JSON tool arguments never establish a permission context. */
export async function withTurnPermissionContext({
  userId, sessionId, turnId, permissionMode, account, checkpointMode = null,
  restored = null, resuming = false,
} = {}, operation) {
  if (typeof operation !== 'function') invalidContext('Turn permission operation is required')
  const scope = { userId: identity(userId), sessionId: identity(sessionId), turnId: identity(turnId) }
  const current = accountSnapshot(account)
  const previous = restoredContext(restored, scope)
  let selected = mode(permissionMode)
  if (checkpointMode != null) selected = narrowerPermissionMode(selected, checkpointMode)
  if (previous) selected = narrowerPermissionMode(selected, previous.permissionMode)
  else if (resuming) selected = narrowerPermissionMode(selected, current.mode)
  const parent = contexts.getStore()
  if (parent?.active && parent.userId === userId) selected = narrowerPermissionMode(selected, parent.permissionMode)
  const state = { ...scope, permissionMode: selected, account: previous?.account || current, active: true }
  return contexts.run(state, async () => {
    try {
      resolveTurnPermissionMode({ userId, account: current })
      return await operation()
    } finally {
      // Detached async descendants must not retain bypass after this turn ends.
      state.active = false
    }
  })
}

/** Read fresh account state on every check; later account changes can only tighten this turn. */
export function resolveTurnPermissionMode({ userId, account } = {}) {
  const current = accountSnapshot(account)
  const state = contexts.getStore()
  if (!state || state.userId !== userId) return current.mode
  if (!state.active) return 'plan'
  if (current.revision !== state.account.revision || current.mode !== state.account.mode) {
    state.permissionMode = narrowerPermissionMode(state.permissionMode, current.mode)
  }
  return state.permissionMode
}

export function getTurnPermissionContextSnapshot({ userId, sessionId, turnId } = {}) {
  const state = contexts.getStore()
  if (!state?.active || state.userId !== userId || state.sessionId !== sessionId || state.turnId !== turnId) return null
  return Object.freeze({
    version: 1, userId, sessionId, turnId, permissionMode: state.permissionMode,
    accountMode: state.account.mode, accountRevision: state.account.revision,
  })
}
