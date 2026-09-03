export const MANAGED_ATTACHMENT_GOVERNANCE_PORT_VERSION = 1
export const MANAGED_ATTACHMENT_GOVERNANCE_METHODS = Object.freeze([
  'captureUserClearSnapshot',
  'stageUserClear',
  'rollbackUserClear',
  'cleanupUserClear',
])

function invalid(message) {
  const error = new TypeError(`ManagedAttachmentGovernancePort ${message}`)
  error.code = 'MANAGED_ATTACHMENT_GOVERNANCE_PORT_INVALID'
  error.retryable = false
  return error
}

function ownerInput(input, { operation = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('input must be an object')
  const userId = typeof input.userId === 'string' ? input.userId.trim() : ''
  if (!userId) throw invalid('input.userId is required')
  const operationId = operation && typeof input.operationId === 'string'
    ? input.operationId.trim()
    : null
  if (operation && !operationId) throw invalid('input.operationId is required')
  return Object.freeze({
    userId,
    ...(operation ? { operationId } : {}),
    ...(Object.hasOwn(input, 'expectedSnapshot') ? { expectedSnapshot: input.expectedSnapshot } : {}),
  })
}

function stageHandle(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid('stageUserClear output must be an object')
  }
  for (const method of ['assertStable', 'cleanup', 'rollback']) {
    if (typeof value[method] !== 'function') throw invalid(`stageUserClear output requires ${method}()`)
  }
  return Object.freeze({
    assertStable: () => value.assertStable(),
    cleanup: () => value.cleanup(),
    rollback: () => value.rollback(),
  })
}

export function createManagedAttachmentGovernancePort(candidate) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw invalid('adapter must be an object')
  }
  if (candidate.apiVersion !== MANAGED_ATTACHMENT_GOVERNANCE_PORT_VERSION) {
    throw invalid(`adapter apiVersion must be ${MANAGED_ATTACHMENT_GOVERNANCE_PORT_VERSION}`)
  }
  for (const method of MANAGED_ATTACHMENT_GOVERNANCE_METHODS) {
    if (typeof candidate[method] !== 'function') throw invalid(`adapter requires ${method}()`)
  }
  return Object.freeze({
    apiVersion: MANAGED_ATTACHMENT_GOVERNANCE_PORT_VERSION,
    id: String(candidate.id || '').trim(),
    captureUserClearSnapshot(input) {
      return candidate.captureUserClearSnapshot(ownerInput(input))
    },
    stageUserClear(input) {
      return stageHandle(candidate.stageUserClear(ownerInput(input, { operation: true })))
    },
    rollbackUserClear(input) {
      return candidate.rollbackUserClear(ownerInput(input, { operation: true }))
    },
    cleanupUserClear(input) {
      return candidate.cleanupUserClear(ownerInput(input, { operation: true }))
    },
  })
}
