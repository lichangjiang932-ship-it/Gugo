import { createHash } from 'node:crypto'
import { types as utilTypes } from 'node:util'
import { managedAttachmentBoundaryError } from './managedAttachmentRuntimeErrors.js'
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, MAX_CONTENT_PARTS, MAX_INLINE_BYTES, MAX_TEXT_CHARS, MAX_TOTAL_CONTENT_CHARS } from './managedAttachmentRuntimeLimits.js'

export { MANAGED_ATTACHMENT_RUNTIME_BOUNDARY_LIMITS } from './managedAttachmentRuntimeLimits.js'

const ATTACHMENT_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/u
const MIME_TYPE_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u
const SHA256_PATTERN = /^[a-f0-9]{64}$/u
const HOST_PATH_PATTERN = /(?:(?:^|[^a-zA-Z0-9])[a-zA-Z]:[\\/]|\\\\|file:\/\/|https?:\/\/|\/(?:home|Users|private|var|tmp)\/)/u
const MAX_BASE64_CHARS = Math.ceil(MAX_INLINE_BYTES / 3) * 4

const ATTACHMENT_FIELDS = Object.freeze([
  'id', 'name', 'mimeType', 'size', 'sha256', 'status', 'sessionId', 'messageId',
  'uri', 'downloadUrl', 'createdAt', 'updatedAt',
])
const EXPECTED_ATTACHMENT_FIELDS = Object.freeze([
  'id', 'name', 'mimeType', 'size', 'sha256', 'status', 'sessionId', 'messageId',
  'uri', 'downloadUrl',
])
const VALIDATE_INPUT_FIELDS = Object.freeze(['userId', 'sessionId', 'attachmentIds'])
const BIND_INPUT_FIELDS = Object.freeze([
  'userId',
  'sessionId',
  'messageId',
  'attachmentIds',
  'now',
])
const PREPARE_INPUT_FIELDS = Object.freeze([
  'userId',
  'sessionId',
  'attachmentIds',
  'expectedAttachments',
  'text',
  'maxAttachmentTokens',
])

function boundaryError(message) {
  return managedAttachmentBoundaryError(message)
}

function identityError(message) {
  return managedAttachmentBoundaryError(message, {
    code: 'MANAGED_ATTACHMENT_RUNTIME_PORT_IDENTITY_MISMATCH',
  })
}

function rejectProxy(value, label) {
  let proxy
  try {
    proxy = utilTypes.isProxy(value)
  } catch {
    throw boundaryError(`${label} could not be safely inspected`)
  }
  if (proxy) throw boundaryError(`${label} must not be a Proxy`)
}

function hasAsciiControl(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

function ownDescriptor(value, field, label, { optional = false, enumerable = true } = {}) {
  let descriptor
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, field)
  } catch {
    throw boundaryError(`${label} could not be safely inspected`)
  }
  if (!descriptor) {
    if (optional) return null
    throw boundaryError(`${label} must contain the required own data fields`)
  }
  if (!Object.hasOwn(descriptor, 'value') || (enumerable && descriptor.enumerable !== true)) {
    throw boundaryError(`${label} fields must be enumerable own data properties`)
  }
  return descriptor
}

function ownDataValue(value, field, label, options) {
  return ownDescriptor(value, field, label, options)?.value
}

function ownKeys(value, label) {
  try {
    return Reflect.ownKeys(value)
  } catch {
    throw boundaryError(`${label} could not be safely inspected`)
  }
}

function assertRecord(value, label) {
  if (!value || typeof value !== 'object') {
    throw boundaryError(`${label} must be a plain object`)
  }
  rejectProxy(value, label)
  if (Array.isArray(value)) throw boundaryError(`${label} must be a plain object`)
  let prototype
  try {
    prototype = Object.getPrototypeOf(value)
  } catch {
    throw boundaryError(`${label} could not be safely inspected`)
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw boundaryError(`${label} must be a plain object`)
  }
  return value
}

function assertAllowedFields(value, fields, label) {
  const allowed = new Set(fields)
  for (const field of ownKeys(value, label)) {
    if (typeof field !== 'string' || !allowed.has(field)) {
      throw boundaryError(`${label} contains an unsupported field`)
    }
    ownDescriptor(value, field, label)
  }
}

function arrayValues(value, label, maxLength) {
  if (!value || typeof value !== 'object') throw boundaryError(`${label} must be an array`)
  rejectProxy(value, label)
  if (!Array.isArray(value)) throw boundaryError(`${label} must be an array`)
  const length = ownDataValue(value, 'length', label, { enumerable: false })
  if (!Number.isSafeInteger(length) || length < 0 || length > maxLength) {
    throw boundaryError(`${label} exceeds its allowed length`)
  }
  const expectedKeys = new Set(['length'])
  const result = []
  for (let index = 0; index < length; index += 1) {
    const field = String(index)
    expectedKeys.add(field)
    result.push(ownDataValue(value, field, `${label}[${index}]`))
  }
  for (const field of ownKeys(value, label)) {
    if (typeof field !== 'string' || !expectedKeys.has(field)) {
      throw boundaryError(`${label} contains an unsupported array property`)
    }
  }
  return result
}

function normalizedIdentity(value, label, maxLength = 512) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > maxLength
    || value.trim() !== value
    || hasAsciiControl(value)
  ) {
    throw boundaryError(`${label} must be a normalized identifier`)
  }
  return value
}

function attachmentId(value, label) {
  if (typeof value !== 'string' || !ATTACHMENT_ID_PATTERN.test(value)) {
    throw boundaryError(`${label} must be a valid attachment identifier`)
  }
  return value
}

function nullableIdentity(value, label) {
  return value === null ? null : normalizedIdentity(value, label)
}

function boundedString(value, label, { nonEmpty = false, maxLength = MAX_TEXT_CHARS } = {}) {
  if (
    typeof value !== 'string'
    || value.length > maxLength
    || (nonEmpty && value.length === 0)
  ) {
    throw boundaryError(`${label} must be a bounded string`)
  }
  return value
}

function filename(value, label, { pdf = false } = {}) {
  const name = boundedString(value, label, { nonEmpty: true, maxLength: 240 })
  if (
    name.trim() !== name
    || name.normalize('NFC') !== name
    || name === '.'
    || name === '..'
    || /[\\/:]/u.test(name)
    || hasAsciiControl(name)
    || HOST_PATH_PATTERN.test(name)
    || (pdf && !name.toLowerCase().endsWith('.pdf'))
  ) {
    throw boundaryError(`${label} must be a safe basename`)
  }
  return name
}

function mimeType(value, label) {
  if (
    typeof value !== 'string'
    || value.length > 160
    || value !== value.toLowerCase()
    || !MIME_TYPE_PATTERN.test(value)
  ) {
    throw boundaryError(`${label} must be a normalized MIME type`)
  }
  return value
}

function nonNegativeInteger(value, label, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw boundaryError(`${label} must be a bounded non-negative safe integer`)
  }
  return value
}

function attachmentIds(value, label) {
  const raw = arrayValues(value, label, MAX_ATTACHMENTS)
  const seen = new Set()
  const ids = raw.map((item, index) => {
    const id = attachmentId(item, `${label}[${index}]`)
    if (seen.has(id)) throw boundaryError(`${label} must not contain duplicate identifiers`)
    seen.add(id)
    return id
  })
  return Object.freeze(ids)
}

function safeUri(value, id, label) {
  const uri = boundedString(value, label, { nonEmpty: true, maxLength: 256 })
  if (uri !== `attachment://${id}` || HOST_PATH_PATTERN.test(uri)) {
    throw boundaryError(`${label} must be the canonical attachment URI`)
  }
  return uri
}

function safeDownloadUrl(value, id, label) {
  const url = boundedString(value, label, { nonEmpty: true, maxLength: 512 })
  if (
    url !== `/api/attachments/${encodeURIComponent(id)}/content`
    || url.includes('\\')
    || HOST_PATH_PATTERN.test(url)
  ) {
    throw boundaryError(`${label} must be the canonical local attachment route`)
  }
  return url
}

function digest(value, label) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw boundaryError(`${label} must be a lowercase sha256 digest`)
  }
  return value
}

function attachmentDto(value, label, { expected = false } = {}) {
  assertRecord(value, label)
  assertAllowedFields(value, expected ? EXPECTED_ATTACHMENT_FIELDS : ATTACHMENT_FIELDS, label)
  const id = attachmentId(ownDataValue(value, 'id', label), `${label}.id`)
  const status = boundedString(ownDataValue(value, 'status', label), `${label}.status`, {
    nonEmpty: true,
    maxLength: 32,
  })
  if (status !== 'ready') throw boundaryError(`${label}.status must be ready`)
  const result = {
    id,
    name: filename(ownDataValue(value, 'name', label), `${label}.name`),
    mimeType: mimeType(ownDataValue(value, 'mimeType', label), `${label}.mimeType`),
    size: nonNegativeInteger(
      ownDataValue(value, 'size', label),
      `${label}.size`,
      MAX_ATTACHMENT_BYTES,
    ),
    sha256: digest(ownDataValue(value, 'sha256', label), `${label}.sha256`),
    status,
    sessionId: nullableIdentity(
      ownDataValue(value, 'sessionId', label),
      `${label}.sessionId`,
    ),
    messageId: nullableIdentity(
      ownDataValue(value, 'messageId', label),
      `${label}.messageId`,
    ),
    uri: safeUri(ownDataValue(value, 'uri', label), id, `${label}.uri`),
    downloadUrl: safeDownloadUrl(
      ownDataValue(value, 'downloadUrl', label),
      id,
      `${label}.downloadUrl`,
    ),
  }
  if (!expected) {
    result.createdAt = nonNegativeInteger(
      ownDataValue(value, 'createdAt', label),
      `${label}.createdAt`,
    )
    result.updatedAt = nonNegativeInteger(
      ownDataValue(value, 'updatedAt', label),
      `${label}.updatedAt`,
    )
    if (result.updatedAt < result.createdAt) {
      throw boundaryError(`${label} timestamps are inconsistent`)
    }
  }
  return Object.freeze(result)
}

function attachmentList(output, input, method, {
  expected = false,
  requireBoundMessage = false,
} = {}) {
  const raw = arrayValues(output, `${method} output`, MAX_ATTACHMENTS)
  if (raw.length !== input.attachmentIds.length) {
    throw identityError(`${method} output must contain exactly the requested attachments`)
  }
  const result = raw.map((value, index) => {
    const item = attachmentDto(value, `${method} output[${index}]`, { expected })
    if (item.id !== input.attachmentIds[index]) {
      throw identityError(`${method} output attachment identity does not match its input`)
    }
    if (method === 'validateAttachments') {
      if (item.sessionId !== null && item.sessionId !== input.sessionId) {
        throw identityError(`${method} output session identity does not match its input`)
      }
    } else if (item.sessionId !== input.sessionId) {
      throw identityError(`${method} output session identity does not match its input`)
    }
    if (method === 'bindAttachments' && item.messageId !== input.messageId) {
      throw identityError(`${method} output message identity does not match its input`)
    }
    if (requireBoundMessage && item.messageId === null) {
      throw identityError(`${method} output must retain a bound message identity`)
    }
    return item
  })
  return Object.freeze(result)
}

function expectedAttachmentList(value, input) {
  return attachmentList(value, input, 'prepareAttachments', { expected: true })
}

export function normalizeManagedAttachmentValidateInput(input) {
  const label = 'validateAttachments input'
  assertRecord(input, label)
  assertAllowedFields(input, VALIDATE_INPUT_FIELDS, label)
  return Object.freeze({
    userId: normalizedIdentity(ownDataValue(input, 'userId', label), `${label}.userId`),
    sessionId: normalizedIdentity(ownDataValue(input, 'sessionId', label), `${label}.sessionId`),
    attachmentIds: attachmentIds(
      ownDataValue(input, 'attachmentIds', label),
      `${label}.attachmentIds`,
    ),
  })
}

export function normalizeManagedAttachmentBindInput(input) {
  const label = 'bindAttachments input'
  assertRecord(input, label)
  assertAllowedFields(input, BIND_INPUT_FIELDS, label)
  return Object.freeze({
    userId: normalizedIdentity(ownDataValue(input, 'userId', label), `${label}.userId`),
    sessionId: normalizedIdentity(ownDataValue(input, 'sessionId', label), `${label}.sessionId`),
    messageId: normalizedIdentity(ownDataValue(input, 'messageId', label), `${label}.messageId`),
    attachmentIds: attachmentIds(
      ownDataValue(input, 'attachmentIds', label),
      `${label}.attachmentIds`,
    ),
    now: nonNegativeInteger(ownDataValue(input, 'now', label), `${label}.now`),
  })
}

export function normalizeManagedAttachmentPrepareInput(input) {
  const label = 'prepareAttachments input'
  assertRecord(input, label)
  assertAllowedFields(input, PREPARE_INPUT_FIELDS, label)
  const ids = attachmentIds(ownDataValue(input, 'attachmentIds', label), `${label}.attachmentIds`)
  const base = {
    userId: normalizedIdentity(ownDataValue(input, 'userId', label), `${label}.userId`),
    sessionId: normalizedIdentity(ownDataValue(input, 'sessionId', label), `${label}.sessionId`),
    attachmentIds: ids,
  }
  const rawExpected = ownDataValue(input, 'expectedAttachments', label, { optional: true })
  if (ids.length > 0 && rawExpected === undefined) {
    throw identityError(`${label} requires complete expected attachment receipts`)
  }
  const expectedAttachments = rawExpected === undefined
    ? Object.freeze([])
    : expectedAttachmentList(rawExpected, base)
  const maxAttachmentTokens = ownDataValue(
    input,
    'maxAttachmentTokens',
    label,
    { optional: true },
  )
  if (
    maxAttachmentTokens !== undefined
    && maxAttachmentTokens !== Number.POSITIVE_INFINITY
    && (
      !Number.isFinite(maxAttachmentTokens)
      || maxAttachmentTokens < 0
      || maxAttachmentTokens > Number.MAX_SAFE_INTEGER
    )
  ) {
    throw boundaryError(`${label}.maxAttachmentTokens must be a bounded non-negative number`)
  }
  return Object.freeze({
    ...base,
    expectedAttachments,
    text: boundedString(ownDataValue(input, 'text', label), `${label}.text`),
    ...(maxAttachmentTokens === undefined ? {} : { maxAttachmentTokens }),
  })
}

function sameAttachmentReceipt(actual, expected) {
  return [
    'id',
    'name',
    'mimeType',
    'size',
    'sha256',
    'status',
    'sessionId',
    'uri',
    'downloadUrl',
  ].every((field) => actual[field] === expected[field])
    && (expected.messageId === null || actual.messageId === expected.messageId)
}

function validateBase64(value, label) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_BASE64_CHARS
    || value.length % 4 !== 0
  ) {
    throw boundaryError(`${label} must contain bounded canonical base64 data`)
  }
  let padding = 0
  if (value.endsWith('==')) padding = 2
  else if (value.endsWith('=')) padding = 1
  const contentLength = value.length - padding
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    const alphaNumeric = (code >= 48 && code <= 57)
      || (code >= 65 && code <= 90)
      || (code >= 97 && code <= 122)
    if (index < contentLength) {
      if (!alphaNumeric && code !== 43 && code !== 47) {
        throw boundaryError(`${label} must contain bounded canonical base64 data`)
      }
    } else if (code !== 61) {
      throw boundaryError(`${label} must contain bounded canonical base64 data`)
    }
  }
  const decodedBytes = (value.length / 4) * 3 - padding
  if (decodedBytes <= 0 || decodedBytes > MAX_INLINE_BYTES) {
    throw boundaryError(`${label} exceeds the inline media limit`)
  }
  return decodedBytes
}

function dataUrl(value, label, { pdf = false } = {}) {
  const url = boundedString(value, label, {
    nonEmpty: true,
    maxLength: MAX_BASE64_CHARS + 128,
  })
  if (!url.startsWith('data:') || HOST_PATH_PATTERN.test(url.slice(0, 256))) {
    throw boundaryError(`${label} must be an inline data URL`)
  }
  const comma = url.indexOf(',')
  if (comma < 0 || comma > 192) throw boundaryError(`${label} must be an inline data URL`)
  const metadata = url.slice(5, comma)
  if (!metadata.endsWith(';base64')) throw boundaryError(`${label} must use base64 encoding`)
  const mediaType = mimeType(metadata.slice(0, -7), `${label} MIME type`)
  if (pdf ? mediaType !== 'application/pdf' : !mediaType.startsWith('image/')) {
    throw boundaryError(`${label} uses an unsupported media type`)
  }
  const payload = url.slice(comma + 1)
  const decodedBytes = validateBase64(payload, label)
  const buffer = Buffer.from(payload, 'base64')
  if (buffer.length !== decodedBytes) throw boundaryError(`${label} base64 length is inconsistent`)
  return Object.freeze({
    url,
    mediaType,
    decodedBytes,
    sha256: createHash('sha256').update(buffer).digest('hex'),
  })
}

function assertMediaReceipt(media, attachments, label) {
  const match = attachments.some((attachment) => (
    attachment.mimeType === media.mediaType
    && attachment.size === media.decodedBytes
    && attachment.sha256 === media.sha256
  ))
  if (!match) throw identityError(`${label} is not linked to a prepared attachment receipt`)
}

function contentPart(value, index, attachments) {
  const label = `prepareAttachments output.content[${index}]`
  assertRecord(value, label)
  const type = ownDataValue(value, 'type', label)
  if (type === 'text') {
    assertAllowedFields(value, ['type', 'text'], label)
    return Object.freeze({
      type,
      text: boundedString(ownDataValue(value, 'text', label), `${label}.text`),
    })
  }
  if (type === 'image_url') {
    assertAllowedFields(value, ['type', 'image_url'], label)
    const image = ownDataValue(value, 'image_url', label)
    assertRecord(image, `${label}.image_url`)
    assertAllowedFields(image, ['url'], `${label}.image_url`)
    const media = dataUrl(
      ownDataValue(image, 'url', `${label}.image_url`),
      `${label}.image_url.url`,
    )
    assertMediaReceipt(media, attachments, `${label}.image_url.url`)
    return Object.freeze({
      type,
      image_url: Object.freeze({ url: media.url }),
    })
  }
  if (type === 'yma_pdf') {
    assertAllowedFields(value, ['type', 'filename', 'file_data', 'fallback_text'], label)
    const media = dataUrl(ownDataValue(value, 'file_data', label), `${label}.file_data`, {
      pdf: true,
    })
    assertMediaReceipt(media, attachments, `${label}.file_data`)
    return Object.freeze({
      type,
      filename: filename(ownDataValue(value, 'filename', label), `${label}.filename`, { pdf: true }),
      file_data: media.url,
      fallback_text: boundedString(
        ownDataValue(value, 'fallback_text', label),
        `${label}.fallback_text`,
      ),
    })
  }
  throw boundaryError(`${label}.type is unsupported`)
}

export function validateManagedAttachmentList(output, input, method) {
  return attachmentList(output, input, method, {
    requireBoundMessage: method === 'prepareAttachments',
  })
}

export function validateManagedAttachmentPreparedOutput(output, input) {
  const label = 'prepareAttachments output'
  assertRecord(output, label)
  assertAllowedFields(output, ['attachments', 'content'], label)
  const attachments = attachmentList(
    ownDataValue(output, 'attachments', label),
    input,
    'prepareAttachments',
    { requireBoundMessage: input.attachmentIds.length > 0 },
  )
  for (let index = 0; index < attachments.length; index += 1) {
    if (!sameAttachmentReceipt(attachments[index], input.expectedAttachments[index])) {
      throw identityError('prepareAttachments output no longer matches its validated receipt')
    }
  }
  const rawContent = ownDataValue(output, 'content', label)
  if (typeof rawContent === 'string') {
    if (attachments.length > 0) {
      throw boundaryError(`${label}.content must be structured when attachments are prepared`)
    }
    return Object.freeze({
      attachments,
      content: boundedString(rawContent, `${label}.content`),
    })
  }
  const rawParts = arrayValues(rawContent, `${label}.content`, MAX_CONTENT_PARTS)
  const parts = []
  let totalChars = 0
  for (let index = 0; index < rawParts.length; index += 1) {
    const part = contentPart(rawParts[index], index, attachments)
    totalChars += part.type === 'text'
      ? part.text.length
      : part.type === 'image_url'
        ? part.image_url.url.length
        : part.file_data.length + part.fallback_text.length
    if (totalChars > MAX_TOTAL_CONTENT_CHARS) {
      throw boundaryError(`${label}.content exceeds its aggregate size limit`)
    }
    parts.push(part)
  }
  return Object.freeze({ attachments, content: Object.freeze(parts) })
}
