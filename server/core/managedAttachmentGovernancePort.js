// @ts-check

/** @typedef {import('../../types/kernel-ports.js').ManagedAttachmentGovernanceAdapter} ManagedAttachmentGovernanceAdapter */
/** @typedef {import('../../types/kernel-ports.js').ManagedAttachmentGovernanceError} ManagedAttachmentGovernanceError */
/** @typedef {import('../../types/kernel-ports.js').ManagedAttachmentGovernanceOperationInput} ManagedAttachmentGovernanceOperationInput */
/** @typedef {import('../../types/kernel-ports.js').ManagedAttachmentGovernanceOwnerInput} ManagedAttachmentGovernanceOwnerInput */
/** @typedef {import('../../types/kernel-ports.js').ManagedAttachmentGovernancePort} ManagedAttachmentGovernancePort */
/** @typedef {import('../../types/kernel-ports.js').ManagedAttachmentGovernanceStageHandle} ManagedAttachmentGovernanceStageHandle */

export const MANAGED_ATTACHMENT_GOVERNANCE_PORT_VERSION = 1
/** @type {readonly ('captureUserClearSnapshot' | 'stageUserClear' | 'rollbackUserClear' | 'cleanupUserClear')[]} */
export const MANAGED_ATTACHMENT_GOVERNANCE_METHODS = Object.freeze([
  'captureUserClearSnapshot',
  'stageUserClear',
  'rollbackUserClear',
  'cleanupUserClear',
])

/** @param {string} message @returns {ManagedAttachmentGovernanceError} */
function invalid(message) {
  const error = /** @type {ManagedAttachmentGovernanceError} */ (
    new TypeError(`ManagedAttachmentGovernancePort ${message}`)
  )
  error.code = 'MANAGED_ATTACHMENT_GOVERNANCE_PORT_INVALID'
  error.retryable = false
  return error
}

/** @param {unknown} input @returns {Record<string, unknown>} */
function inputRecord(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw invalid('input must be an object')
  }
  return /** @type {Record<string, unknown>} */ (input)
}

/** @param {unknown} input @returns {ManagedAttachmentGovernanceOwnerInput} */
function ownerInput(input) {
  const source = inputRecord(input)
  const userId = typeof source.userId === 'string' ? source.userId.trim() : ''
  if (!userId) throw invalid('input.userId is required')
  return Object.freeze({
    userId,
    ...(Object.hasOwn(source, 'expectedSnapshot')
      ? { expectedSnapshot: source.expectedSnapshot }
      : {}),
  })
}

/** @param {unknown} input @returns {ManagedAttachmentGovernanceOperationInput} */
function operationInput(input) {
  const source = inputRecord(input)
  const userId = typeof source.userId === 'string' ? source.userId.trim() : ''
  if (!userId) throw invalid('input.userId is required')
  const operationId = typeof source.operationId === 'string' ? source.operationId.trim() : ''
  if (!operationId) throw invalid('input.operationId is required')
  return Object.freeze({
    userId,
    operationId,
    ...(Object.hasOwn(source, 'expectedSnapshot')
      ? { expectedSnapshot: source.expectedSnapshot }
      : {}),
  })
}

/** @param {unknown} value @returns {ManagedAttachmentGovernanceStageHandle} */
function stageHandle(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid('stageUserClear output must be an object')
  }
  const source = /** @type {Record<string, unknown>} */ (value)
  for (const method of ['assertStable', 'cleanup', 'rollback']) {
    if (typeof source[method] !== 'function') {
      throw invalid(`stageUserClear output requires ${method}()`)
    }
  }
  const handle = /** @type {ManagedAttachmentGovernanceStageHandle} */ (source)
  return Object.freeze({
    assertStable: () => handle.assertStable(),
    cleanup: () => handle.cleanup(),
    rollback: () => handle.rollback(),
  })
}

/**
 * @param {ManagedAttachmentGovernanceAdapter} candidate
 * @returns {ManagedAttachmentGovernancePort}
 */
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
      return stageHandle(candidate.stageUserClear(operationInput(input)))
    },
    rollbackUserClear(input) {
      return candidate.rollbackUserClear(operationInput(input))
    },
    cleanupUserClear(input) {
      return candidate.cleanupUserClear(operationInput(input))
    },
  })
}
