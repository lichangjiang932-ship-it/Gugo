import { types as utilTypes } from 'node:util'
import { projectManagedAttachmentDto } from '../core/managedAttachmentDtos.js'
import { prepareManagedAttachmentsForModel } from '../services/managedAttachmentContent.js'
import {
  bindManagedAttachmentsToMessage,
  validateManagedAttachmentsForTurn,
} from '../services/managedAttachmentStore.js'

export const SQLITE_FILE_MANAGED_ATTACHMENT_RUNTIME_ADAPTER_ID = 'builtin.sqlite-file'

const MANAGED_ATTACHMENT_RUNTIME_PORT_VERSION = 1

function adapterError(message) {
  const error = new TypeError(message)
  error.code = 'MANAGED_ATTACHMENT_RUNTIME_ADAPTER_INVALID'
  error.retryable = false
  return error
}

function assertRecord(value, label) {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || utilTypes.isProxy(value)
  ) {
    throw adapterError(`${label} must be an object`)
  }
  return value
}

function ownDataDescriptor(value, field, label, { optional = false } = {}) {
  let descriptor
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, field)
  } catch {
    throw adapterError(`${label}.${field} cannot be inspected safely`)
  }
  if (!descriptor) {
    if (optional) return null
    throw adapterError(`${label}.${field} must be an own data property`)
  }
  if (!Object.hasOwn(descriptor, 'value')) {
    throw adapterError(`${label}.${field} must be an own data property`)
  }
  return descriptor
}

function ownDataValue(value, field, label) {
  return ownDataDescriptor(value, field, label).value
}

function arrayDataValues(value, label) {
  if (utilTypes.isProxy(value) || !Array.isArray(value)) {
    throw adapterError(`${label} must be an array`)
  }
  const lengthDescriptor = ownDataDescriptor(value, 'length', label)
  const length = lengthDescriptor.value
  if (!Number.isSafeInteger(length) || length < 0) {
    throw adapterError(`${label}.length must be a non-negative safe integer`)
  }
  const items = []
  for (let index = 0; index < length; index += 1) {
    const descriptor = ownDataDescriptor(value, String(index), label)
    if (descriptor.enumerable !== true) {
      throw adapterError(`${label}[${index}] must be an enumerable own data property`)
    }
    items.push(descriptor.value)
  }
  return items
}

function publicAttachmentDto(value, index) {
  const label = `managed attachment result[${index}]`
  assertRecord(value, label)
  try {
    return projectManagedAttachmentDto(value, { label })
  } catch (error) {
    throw adapterError(error?.message || `${label} is invalid`)
  }
}

function publicAttachmentList(value) {
  return Object.freeze(
    arrayDataValues(value, 'managed attachment result').map(publicAttachmentDto),
  )
}

function publicContentPart(value, index) {
  const label = `managed attachment content[${index}]`
  const part = assertRecord(value, label)
  const type = ownDataValue(part, 'type', label)
  if (type === 'text') {
    return Object.freeze({
      type: 'text',
      text: ownDataValue(part, 'text', label),
    })
  }
  if (type === 'image_url') {
    const imageUrl = assertRecord(
      ownDataValue(part, 'image_url', label),
      `${label}.image_url`,
    )
    return Object.freeze({
      type: 'image_url',
      image_url: Object.freeze({
        url: ownDataValue(imageUrl, 'url', `${label}.image_url`),
      }),
    })
  }
  if (type === 'yma_pdf') {
    return Object.freeze({
      type: 'yma_pdf',
      filename: ownDataValue(part, 'filename', label),
      file_data: ownDataValue(part, 'file_data', label),
      fallback_text: ownDataValue(part, 'fallback_text', label),
    })
  }
  throw adapterError(`managed attachment content[${index}] has unsupported type`)
}

function publicPreparedAttachments(value) {
  const label = 'prepared managed attachment result'
  const prepared = assertRecord(value, label)
  const attachments = ownDataValue(prepared, 'attachments', label)
  const content = ownDataValue(prepared, 'content', label)
  if (typeof content !== 'string' && !Array.isArray(content)) {
    throw adapterError('prepared managed attachment content must be a string or array')
  }
  return Object.freeze({
    attachments: publicAttachmentList(attachments),
    content: typeof content === 'string'
      ? content
      : Object.freeze(
        arrayDataValues(content, 'prepared managed attachment content').map(publicContentPart),
      ),
  })
}

function normalizeResult(value, normalize) {
  if (utilTypes.isPromise(value)) {
    if (utilTypes.isProxy(value)) {
      throw adapterError('managed attachment result cannot be a Proxy')
    }
    let prototype
    try {
      prototype = Object.getPrototypeOf(value)
    } catch {
      throw adapterError('managed attachment Promise cannot be inspected safely')
    }
    if (prototype !== Promise.prototype) {
      throw adapterError('managed attachment result must be a native Promise')
    }
    const constructorDescriptor = ownDataDescriptor(
      value,
      'constructor',
      'managed attachment Promise',
      { optional: true },
    )
    if (constructorDescriptor) {
      throw adapterError('managed attachment Promise must not override constructor')
    }
    return Promise.prototype.then.call(value, normalize)
  }
  if (value && (typeof value === 'object' || typeof value === 'function')) {
    if (utilTypes.isProxy(value)) {
      throw adapterError('managed attachment result cannot be a Proxy')
    }
    const descriptor = ownDataDescriptor(value, 'then', 'managed attachment result', {
      optional: true,
    })
    if (descriptor) {
      if (typeof descriptor.value !== 'function') {
        throw adapterError('managed attachment result.then must be an own data function')
      }
      return new Promise((resolve, reject) => {
        try {
          descriptor.value.call(value, resolve, reject)
        } catch (error) {
          reject(error)
        }
      }).then(normalize)
    }
  }
  return normalize(value)
}

function requireDependency(value, label) {
  if (typeof value !== 'function') {
    throw adapterError(`sqlite-file managed attachment adapter requires ${label}`)
  }
  return value
}

export function createSqliteFileManagedAttachmentRuntimeAdapter({
  validate = validateManagedAttachmentsForTurn,
  bind = bindManagedAttachmentsToMessage,
  prepare = prepareManagedAttachmentsForModel,
} = {}) {
  const validateRuntimeAttachments = requireDependency(validate, 'validate')
  const bindRuntimeAttachments = requireDependency(bind, 'bind')
  const prepareRuntimeAttachments = requireDependency(prepare, 'prepare')

  return Object.freeze({
    apiVersion: MANAGED_ATTACHMENT_RUNTIME_PORT_VERSION,
    id: SQLITE_FILE_MANAGED_ATTACHMENT_RUNTIME_ADAPTER_ID,

    validateAttachments(input) {
      return normalizeResult(validateRuntimeAttachments(input), publicAttachmentList)
    },

    bindAttachments(input) {
      return normalizeResult(bindRuntimeAttachments(input), publicAttachmentList)
    },

    prepareAttachments(input) {
      return normalizeResult(prepareRuntimeAttachments(input), publicPreparedAttachments)
    },
  })
}
