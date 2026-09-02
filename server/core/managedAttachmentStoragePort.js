import { types as utilTypes } from 'node:util'

import {
  MANAGED_ATTACHMENT_PUBLIC_FIELDS,
  projectManagedAttachmentDto,
  projectManagedAttachmentList,
} from './managedAttachmentDtos.js'

export const MANAGED_ATTACHMENT_STORAGE_PORT_VERSION = 1

export const MANAGED_ATTACHMENT_STORAGE_PORT_METHODS = Object.freeze([
  'create',
  'list',
  'get',
  'delete',
  'deleteForSession',
  'cleanup',
  'openContent',
])

const TRUSTED_PORTS = new WeakSet()
const PORT_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/u
const CLEANUP_FIELDS = Object.freeze([
  'removedRows',
  'removedFiles',
  'skippedForUserDataClear',
])
const INPUT_FIELDS = Object.freeze({
  create: Object.freeze([
    'userId',
    'name',
    'mimeType',
    'sessionId',
    'messageId',
    'source',
    'contentLength',
  ]),
  list: Object.freeze(['userId', 'sessionId', 'messageId', 'limit']),
  get: Object.freeze(['userId', 'id']),
  delete: Object.freeze(['userId', 'id']),
  deleteForSession: Object.freeze(['userId', 'sessionId']),
  cleanup: Object.freeze(['userId', 'now', 'maxRows']),
  openContent: Object.freeze(['userId', 'id', 'range', 'expected']),
})

function portError(code, message, extras = {}) {
  return Object.assign(new TypeError(message), { code, retryable: false, ...extras })
}

function invalidPort(message) {
  return portError('MANAGED_ATTACHMENT_STORAGE_PORT_INVALID', message)
}

function invalidInput(method, message) {
  return portError(
    'MANAGED_ATTACHMENT_STORAGE_PORT_INPUT_INVALID',
    `ManagedAttachmentStoragePort ${method} ${message}`,
    { statusCode: 400 },
  )
}

function ownDataValue(candidate, field) {
  let descriptor
  try {
    descriptor = Object.getOwnPropertyDescriptor(candidate, field)
  } catch {
    throw invalidPort('ManagedAttachmentStoragePort adapter could not be inspected safely')
  }
  if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
    throw invalidPort(`ManagedAttachmentStoragePort adapter ${field} must be an enumerable own data property`)
  }
  return descriptor.value
}

function normalizeAdapter(candidate) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)
    || utilTypes.isProxy(candidate)) {
    throw invalidPort('ManagedAttachmentStoragePort adapter must be a non-Proxy object')
  }
  if (ownDataValue(candidate, 'apiVersion') !== MANAGED_ATTACHMENT_STORAGE_PORT_VERSION) {
    throw portError(
      'MANAGED_ATTACHMENT_STORAGE_PORT_VERSION_UNSUPPORTED',
      `ManagedAttachmentStoragePort adapter apiVersion must be ${MANAGED_ATTACHMENT_STORAGE_PORT_VERSION}`,
    )
  }
  const id = ownDataValue(candidate, 'id')
  if (typeof id !== 'string' || !PORT_ID_PATTERN.test(id)) {
    throw invalidPort('ManagedAttachmentStoragePort adapter id is invalid')
  }
  const methods = {}
  for (const method of MANAGED_ATTACHMENT_STORAGE_PORT_METHODS) {
    const implementation = ownDataValue(candidate, method)
    if (typeof implementation !== 'function' || utilTypes.isProxy(implementation)) {
      throw invalidPort(`ManagedAttachmentStoragePort adapter is missing ${method}()`)
    }
    methods[method] = implementation
  }
  return { candidate, id, methods }
}

function boundaryInput(input, method) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || utilTypes.isProxy(input)) {
    throw invalidInput(method, 'input must be a non-Proxy object')
  }
  let prototype
  let keys
  try {
    prototype = Object.getPrototypeOf(input)
    keys = Reflect.ownKeys(input)
  } catch {
    throw invalidInput(method, 'input could not be inspected safely')
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw invalidInput(method, 'input must be a plain object')
  }
  const allowed = INPUT_FIELDS[method]
  const copy = {}
  for (const field of keys) {
    if (typeof field !== 'string' || !allowed.includes(field)) {
      throw invalidInput(method, 'input contains an unsupported field')
    }
    let descriptor
    try { descriptor = Object.getOwnPropertyDescriptor(input, field) } catch {
      throw invalidInput(method, `input.${field} could not be inspected safely`)
    }
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
      throw invalidInput(method, `input.${field} must be an enumerable own data property`)
    }
    copy[field] = descriptor.value
  }
  if (typeof copy.userId !== 'string'
    || !copy.userId
    || copy.userId !== copy.userId.trim()) {
    throw invalidInput(method, 'input.userId is required')
  }
  if (['get', 'delete', 'openContent'].includes(method)
    && (typeof copy.id !== 'string' || !copy.id || copy.id !== copy.id.trim())) {
    throw invalidInput(method, 'input.id is required')
  }
  if (method === 'deleteForSession'
    && (typeof copy.sessionId !== 'string'
      || !copy.sessionId
      || copy.sessionId !== copy.sessionId.trim())) {
    throw invalidInput(method, 'input.sessionId is required')
  }
  if (method === 'create') {
    if (typeof copy.name !== 'string' || !copy.name.trim()) {
      throw invalidInput(method, 'input.name is required')
    }
    if (!copy.source || !dataMethod(copy.source, Symbol.asyncIterator)) {
      throw invalidInput(method, 'input.source must be an async iterable')
    }
  }
  if (copy.range !== undefined && copy.range !== null) {
    const range = copy.range
    if (!range || typeof range !== 'object' || Array.isArray(range) || utilTypes.isProxy(range)) {
      throw invalidInput(method, 'input.range must be an object')
    }
    let rangePrototype
    let rangeKeys
    try {
      rangePrototype = Object.getPrototypeOf(range)
      rangeKeys = Reflect.ownKeys(range)
    } catch {
      throw invalidInput(method, 'input.range could not be inspected safely')
    }
    if (rangePrototype !== Object.prototype && rangePrototype !== null) {
      throw invalidInput(method, 'input.range must be a plain object')
    }
    if (rangeKeys.length !== 2 || !rangeKeys.includes('start') || !rangeKeys.includes('end')) {
      throw invalidInput(method, 'input.range must contain start and end')
    }
    const rangeValue = (field) => {
      let descriptor
      try { descriptor = Object.getOwnPropertyDescriptor(range, field) } catch {
        throw invalidInput(method, `input.range.${field} could not be inspected safely`)
      }
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
        throw invalidInput(method, `input.range.${field} must be an enumerable own data property`)
      }
      return descriptor.value
    }
    const start = rangeValue('start')
    const end = rangeValue('end')
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
      || start < 0 || end < start) {
      throw invalidInput(method, 'input.range is invalid')
    }
    copy.range = Object.freeze({ start, end })
  }
  if (copy.expected !== undefined) {
    const expected = copy.expected
    if (!expected || typeof expected !== 'object' || Array.isArray(expected)
      || utilTypes.isProxy(expected) || Object.getPrototypeOf(expected) !== Object.prototype) {
      throw invalidInput(method, 'input.expected must be a plain object')
    }
    const expectedKeys = Reflect.ownKeys(expected)
    if (expectedKeys.length !== 2
      || !expectedKeys.includes('size')
      || !expectedKeys.includes('sha256')) {
      throw invalidInput(method, 'input.expected must contain size and sha256')
    }
    const size = Object.getOwnPropertyDescriptor(expected, 'size')
    const sha256 = Object.getOwnPropertyDescriptor(expected, 'sha256')
    if (!size || !Object.hasOwn(size, 'value') || size.enumerable !== true
      || !Number.isSafeInteger(size.value) || size.value < 0
      || !sha256 || !Object.hasOwn(sha256, 'value') || sha256.enumerable !== true
      || typeof sha256.value !== 'string' || !/^[a-f0-9]{64}$/u.test(sha256.value)) {
      throw invalidInput(method, 'input.expected is invalid')
    }
    copy.expected = Object.freeze({ size: size.value, sha256: sha256.value })
  }
  return Object.freeze(copy)
}

function cleanupReceipt(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value)) {
    throw invalidPort('ManagedAttachmentStoragePort cleanup output must be an object')
  }
  const receipt = {}
  for (const field of CLEANUP_FIELDS) {
    let descriptor
    try { descriptor = Object.getOwnPropertyDescriptor(value, field) } catch {
      throw invalidPort(`ManagedAttachmentStoragePort cleanup output.${field} is invalid`)
    }
    if (!descriptor) continue
    if (!Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
      throw invalidPort(`ManagedAttachmentStoragePort cleanup output.${field} must be an own data property`)
    }
    const fieldValue = descriptor.value
    if (field === 'skippedForUserDataClear') {
      if (typeof fieldValue !== 'boolean') {
        throw invalidPort(`ManagedAttachmentStoragePort cleanup output.${field} must be a boolean`)
      }
    } else if (!Number.isSafeInteger(fieldValue) || fieldValue < 0) {
      throw invalidPort(`ManagedAttachmentStoragePort cleanup output.${field} must be a non-negative integer`)
    }
    receipt[field] = fieldValue
  }
  if (!Object.hasOwn(receipt, 'removedRows') || !Object.hasOwn(receipt, 'removedFiles')) {
    throw invalidPort('ManagedAttachmentStoragePort cleanup output must include removal counts')
  }
  return Object.freeze(receipt)
}

function dataMethod(value, method) {
  try {
    let cursor = value
    while (cursor) {
      const descriptor = Object.getOwnPropertyDescriptor(cursor, method)
      if (descriptor) {
        if (!Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function'
          || utilTypes.isProxy(descriptor.value)) return null
        return descriptor.value
      }
      cursor = Object.getPrototypeOf(cursor)
    }
  } catch {
    return null
  }
  return null
}

function contentStream(value) {
  let leakedPath = false
  if (value && typeof value === 'object' && !utilTypes.isProxy(value)) {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(value, 'path')
      leakedPath = Boolean(descriptor && (
        !Object.hasOwn(descriptor, 'value')
        || (descriptor.value !== undefined
          && descriptor.value !== null
          && descriptor.value !== '')
      ))
    } catch {
      leakedPath = true
    }
  }
  if (!value || typeof value !== 'object' || utilTypes.isProxy(value) || leakedPath
    || !dataMethod(value, 'pipe')
    || !dataMethod(value, 'once')
    || !dataMethod(value, 'destroy')) {
    const destroy = value && typeof value === 'object' && !utilTypes.isProxy(value)
      ? dataMethod(value, 'destroy')
      : null
    if (destroy) {
      try { destroy.call(value) } catch { /* best effort after boundary rejection */ }
    }
    throw invalidPort('ManagedAttachmentStoragePort openContent output must be a readable stream')
  }
  return value
}

function attachmentDto(value, method, input) {
  if (value == null) {
    if (method === 'get') return null
    throw invalidPort(`ManagedAttachmentStoragePort ${method} output must be an attachment`)
  }
  const projected = projectManagedAttachmentDto(value)
  for (const field of MANAGED_ATTACHMENT_PUBLIC_FIELDS) {
    if (!Object.hasOwn(projected, field)) {
      throw invalidPort(`ManagedAttachmentStoragePort ${method} output.${field} is required`)
    }
  }
  for (const field of ['id', 'name', 'mimeType', 'sha256', 'status', 'uri', 'downloadUrl']) {
    if (typeof projected[field] !== 'string' || !projected[field]) {
      throw invalidPort(`ManagedAttachmentStoragePort ${method} output.${field} must be a string`)
    }
  }
  for (const field of ['size', 'createdAt', 'updatedAt']) {
    if (!Number.isSafeInteger(projected[field]) || projected[field] < 0) {
      throw invalidPort(`ManagedAttachmentStoragePort ${method} output.${field} must be a non-negative integer`)
    }
  }
  for (const field of ['sessionId', 'messageId']) {
    if (projected[field] !== null && typeof projected[field] !== 'string') {
      throw invalidPort(`ManagedAttachmentStoragePort ${method} output.${field} must be a string or null`)
    }
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/u.test(projected.id)
    || !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u.test(projected.mimeType)
    || projected.status !== 'ready'
    || projected.name.includes('/')
    || projected.name.includes('\\')
    || projected.updatedAt < projected.createdAt
    || !/^[a-f0-9]{64}$/u.test(projected.sha256)
    || projected.uri !== `attachment://${projected.id}`
    || projected.downloadUrl !== `/api/attachments/${encodeURIComponent(projected.id)}/content`) {
    throw invalidPort(`ManagedAttachmentStoragePort ${method} output identity is invalid`)
  }
  if (['get', 'openContent'].includes(method) && projected.id !== input.id) {
    throw portError(
      'MANAGED_ATTACHMENT_STORAGE_PORT_IDENTITY_MISMATCH',
      'ManagedAttachmentStoragePort get output id does not match its input',
    )
  }
  return projected
}

function attachmentList(value, input) {
  const projected = projectManagedAttachmentList(value)
  return Object.freeze(projected.map((attachment) => attachmentDto(attachment, 'list', input)))
}

function openedContent(value, input) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value)) {
    throw invalidPort('ManagedAttachmentStoragePort openContent output must be an object')
  }
  let prototype
  try { prototype = Object.getPrototypeOf(value) } catch {
    throw invalidPort('ManagedAttachmentStoragePort openContent output could not be inspected')
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw invalidPort('ManagedAttachmentStoragePort openContent output must be a plain object')
  }
  const streamDescriptor = Object.getOwnPropertyDescriptor(value, 'stream')
  const attachmentDescriptor = Object.getOwnPropertyDescriptor(value, 'attachment')
  if (!streamDescriptor || !Object.hasOwn(streamDescriptor, 'value')
    || streamDescriptor.enumerable !== true) {
    throw invalidPort('ManagedAttachmentStoragePort openContent output is incomplete')
  }
  const stream = contentStream(streamDescriptor.value)
  try {
    if (!attachmentDescriptor || !Object.hasOwn(attachmentDescriptor, 'value')
      || attachmentDescriptor.enumerable !== true) {
      throw invalidPort('ManagedAttachmentStoragePort openContent output is incomplete')
    }
    const attachment = attachmentDto(attachmentDescriptor.value, 'openContent', input)
    if (input.expected
      && (attachment.size !== input.expected.size
        || attachment.sha256 !== input.expected.sha256)) {
      throw portError(
        'MANAGED_ATTACHMENT_STORAGE_PORT_IDENTITY_MISMATCH',
        'ManagedAttachmentStoragePort openContent output changed after lookup',
      )
    }
    return Object.freeze({ attachment, stream })
  } catch (error) {
    try { stream.destroy() } catch { /* best effort after boundary rejection */ }
    throw error
  }
}

const OUTPUT_NORMALIZERS = Object.freeze({
  create: (value, input) => attachmentDto(value, 'create', input),
  list: attachmentList,
  get: (value, input) => attachmentDto(value, 'get', input),
  delete(value) {
    if (typeof value !== 'boolean') {
      throw invalidPort('ManagedAttachmentStoragePort delete output must be a boolean')
    }
    return value
  },
  deleteForSession(value) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw invalidPort('ManagedAttachmentStoragePort deleteForSession output must be a non-negative integer')
    }
    return value
  },
  cleanup: cleanupReceipt,
  openContent: openedContent,
})

function normalizeResult(value, normalize, input) {
  return utilTypes.isPromise(value)
    ? Promise.prototype.then.call(value, (output) => normalize(output, input))
    : normalize(value, input)
}

export function createManagedAttachmentStoragePort(candidate) {
  const normalized = normalizeAdapter(candidate)
  const methods = Object.fromEntries(MANAGED_ATTACHMENT_STORAGE_PORT_METHODS.map((method) => [
    method,
    (input) => {
      const normalizedInput = boundaryInput(input, method)
      return normalizeResult(
        normalized.methods[method].call(normalized.candidate, normalizedInput),
        OUTPUT_NORMALIZERS[method],
        normalizedInput,
      )
    },
  ]))
  const port = Object.freeze({
    apiVersion: MANAGED_ATTACHMENT_STORAGE_PORT_VERSION,
    id: normalized.id,
    ...methods,
  })
  TRUSTED_PORTS.add(port)
  return port
}

export function assertManagedAttachmentStoragePort(port) {
  if (!port || (typeof port !== 'object' && typeof port !== 'function')
    || !TRUSTED_PORTS.has(port)) {
    throw portError(
      'MANAGED_ATTACHMENT_STORAGE_PORT_UNTRUSTED',
      'ManagedAttachmentStoragePort must be created by the host boundary',
    )
  }
  if (port.apiVersion !== MANAGED_ATTACHMENT_STORAGE_PORT_VERSION) {
    throw portError(
      'MANAGED_ATTACHMENT_STORAGE_PORT_VERSION_UNSUPPORTED',
      `ManagedAttachmentStoragePort v${MANAGED_ATTACHMENT_STORAGE_PORT_VERSION} is required`,
    )
  }
  return port
}
