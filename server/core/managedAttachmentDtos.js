import { types as utilTypes } from 'node:util'

export const MANAGED_ATTACHMENT_PUBLIC_FIELDS = Object.freeze([
  'id',
  'name',
  'mimeType',
  'size',
  'sha256',
  'status',
  'sessionId',
  'messageId',
  'uri',
  'downloadUrl',
  'createdAt',
  'updatedAt',
])

function invalidDto(message) {
  const error = new TypeError(message)
  error.code = 'MANAGED_ATTACHMENT_DTO_INVALID'
  return error
}

function assertRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value)) {
    throw invalidDto(`${label} must be a non-Proxy object`)
  }
}

function ownDataDescriptor(value, field, label) {
  let descriptor
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, field)
  } catch {
    throw invalidDto(`${label}.${field} cannot be inspected safely`)
  }
  if (descriptor && !Object.hasOwn(descriptor, 'value')) {
    throw invalidDto(`${label}.${field} must be an own data property`)
  }
  return descriptor
}

export function projectManagedAttachmentDto(value, {
  label = 'managed attachment',
} = {}) {
  if (value == null) return null
  assertRecord(value, label)
  const projected = {}
  for (const field of MANAGED_ATTACHMENT_PUBLIC_FIELDS) {
    const descriptor = ownDataDescriptor(value, field, label)
    if (descriptor) projected[field] = descriptor.value
  }
  return Object.freeze(projected)
}

export function projectManagedAttachmentList(value, {
  label = 'managed attachment list',
} = {}) {
  if (!Array.isArray(value) || utilTypes.isProxy(value)) {
    throw invalidDto(`${label} must be a non-Proxy array`)
  }
  const lengthDescriptor = ownDataDescriptor(value, 'length', label)
  const length = lengthDescriptor?.value
  if (!Number.isSafeInteger(length) || length < 0) {
    throw invalidDto(`${label}.length must be a non-negative safe integer`)
  }
  const projected = []
  for (let index = 0; index < length; index += 1) {
    const descriptor = ownDataDescriptor(value, String(index), label)
    if (!descriptor) throw invalidDto(`${label}[${index}] must be present`)
    projected.push(projectManagedAttachmentDto(descriptor.value, {
      label: `${label}[${index}]`,
    }))
  }
  return Object.freeze(projected)
}
