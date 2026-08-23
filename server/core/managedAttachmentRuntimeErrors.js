import { types as utilTypes } from 'node:util'

const boundaryErrors = new WeakSet()
const SAFE_OPERATION_CODES = new Set([
  'ATTACHMENT_ARCHIVE_UNSAFE',
  'ATTACHMENT_BODY_REQUIRED',
  'ATTACHMENT_CONTENT_MISSING',
  'ATTACHMENT_COUNT_EXCEEDED',
  'ATTACHMENT_EMPTY',
  'ATTACHMENT_ERROR',
  'ATTACHMENT_MESSAGE_CONFLICT',
  'ATTACHMENT_MESSAGE_NOT_FOUND',
  'ATTACHMENT_NAME_REQUIRED',
  'ATTACHMENT_NOT_FOUND',
  'ATTACHMENT_NOT_READY',
  'ATTACHMENT_READ_ONLY',
  'ATTACHMENT_SESSION_CONFLICT',
  'ATTACHMENT_SESSION_NOT_FOUND',
  'ATTACHMENT_STORAGE_INVALID',
  'ATTACHMENT_TOO_LARGE',
  'ATTACHMENT_USER_QUOTA_EXCEEDED',
  'ATTACHMENT_WRITE_FAILED',
  'INVALID_ATTACHMENT_ID',
  'INVALID_ATTACHMENT_MIME',
])

function staticError(message, properties) {
  const error = Object.assign(new TypeError(message), properties)
  Object.defineProperty(error, 'stack', {
    configurable: true,
    enumerable: false,
    value: `TypeError: ${message}`,
    writable: true,
  })
  return error
}

export function managedAttachmentBoundaryError(message, {
  code = 'MANAGED_ATTACHMENT_RUNTIME_PORT_BOUNDARY_INVALID',
  statusCode,
} = {}) {
  const error = staticError(message, {
    code,
    retryable: false,
    ...(statusCode === undefined ? {} : { statusCode }),
  })
  boundaryErrors.add(error)
  return error
}

function ownDataValue(value, field) {
  const descriptor = Object.getOwnPropertyDescriptor(value, field)
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined
}

export function normalizeManagedAttachmentOperationError(error) {
  if (error && (typeof error === 'object' || typeof error === 'function')) {
    if (boundaryErrors.has(error)) return error
    try {
      if (!utilTypes.isProxy(error)) {
        const code = ownDataValue(error, 'code')
        if (typeof code === 'string' && SAFE_OPERATION_CODES.has(code)) {
          const candidateStatus = ownDataValue(error, 'statusCode')
          const statusCode = Number.isInteger(candidateStatus)
            && candidateStatus >= 400
            && candidateStatus <= 599
            ? candidateStatus
            : undefined
          return staticError(`Managed attachment operation failed (${code})`, {
            code,
            retryable: false,
            ...(statusCode === undefined ? {} : { statusCode }),
          })
        }
      }
    } catch {
      // Use a static boundary error below. Never expose adapter error fields.
    }
  }
  return managedAttachmentBoundaryError('managed attachment runtime failed at its boundary')
}
