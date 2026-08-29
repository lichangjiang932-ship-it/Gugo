/**
 * Provider-neutral, read-only language-server capability registry.
 *
 * Providers own transport and process lifecycle details. This service validates
 * their public registration, selects one by the queried file's final extension,
 * and publishes immutable semantic results to callers.
 */

export const LSP_OPERATIONS = Object.freeze([
  'goToDefinition',
  'findReferences',
  'goToImplementation',
  'hover',
])

const LSP_OPERATION_SET = new Set(LSP_OPERATIONS)
const NAVIGATION_OPERATIONS = new Set(LSP_OPERATIONS.slice(0, 3))
const EXTENSION_RE = /^\.[^./\\\s]+$/u

export class LspError extends Error {
  constructor(code, message, { cause } = {}) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'LspError'
    this.code = code
    this.retryable = false
  }
}

function lspError(code, message, cause) {
  return new LspError(code, message, cause === undefined ? undefined : { cause })
}

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function requiredString(value, label, code) {
  if (typeof value !== 'string' || !value.trim()) {
    throw lspError(code, `${label} must be a non-empty string`)
  }
  return value
}

function normalizeExtension(value) {
  const raw = requiredString(value, 'LSP provider extension', 'LSP_INVALID_PROVIDER')
  const lower = raw.trim().toLowerCase()
  const extension = lower.startsWith('.') ? lower : `.${lower}`
  if (!EXTENSION_RE.test(extension)) {
    throw lspError(
      'LSP_INVALID_PROVIDER',
      `LSP provider extension is invalid: ${raw}`,
    )
  }
  return extension
}

function finalExtension(filePath) {
  const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  const basename = lastSlash >= 0 ? filePath.slice(lastSlash + 1) : filePath
  const dot = basename.lastIndexOf('.')
  return dot <= 0 ? '' : basename.slice(dot).toLowerCase()
}

function snapshotProvider(provider) {
  if (!isRecord(provider)) {
    throw lspError('LSP_INVALID_PROVIDER', 'LSP provider must be an object')
  }
  let id
  let extensionToLanguage
  let query
  let close
  try {
    id = requiredString(provider.id, 'LSP provider id', 'LSP_INVALID_PROVIDER').trim()
    extensionToLanguage = provider.extensionToLanguage
    query = provider.query
    close = provider.close
  } catch (error) {
    if (error instanceof LspError) throw error
    throw lspError('LSP_INVALID_PROVIDER', 'LSP provider could not be inspected', error)
  }
  if (!isRecord(extensionToLanguage)) {
    throw lspError(
      'LSP_INVALID_PROVIDER',
      `LSP provider ${id} extensionToLanguage must be an object`,
    )
  }
  if (typeof query !== 'function') {
    throw lspError('LSP_INVALID_PROVIDER', `LSP provider ${id} query must be a function`)
  }
  if (close !== undefined && close !== null && typeof close !== 'function') {
    throw lspError('LSP_INVALID_PROVIDER', `LSP provider ${id} close must be a function`)
  }

  let entries
  try {
    entries = Object.entries(extensionToLanguage)
  } catch (error) {
    throw lspError(
      'LSP_INVALID_PROVIDER',
      `LSP provider ${id} extension mappings could not be inspected`,
      error,
    )
  }
  if (entries.length === 0) {
    throw lspError('LSP_INVALID_PROVIDER', `LSP provider ${id} must map at least one extension`)
  }
  const mappings = new Map()
  for (const [rawExtension, rawLanguageId] of entries) {
    const extension = normalizeExtension(rawExtension)
    const languageId = requiredString(
      rawLanguageId,
      `LSP provider ${id} language id for ${extension}`,
      'LSP_INVALID_PROVIDER',
    ).trim()
    if (mappings.has(extension)) {
      throw lspError(
        'LSP_INVALID_PROVIDER',
        `LSP provider ${id} maps extension ${extension} more than once`,
      )
    }
    mappings.set(extension, languageId)
  }
  return {
    id,
    mappings,
    query: query.bind(provider),
    close: typeof close === 'function' ? close.bind(provider) : null,
    disposed: false,
    closePromise: null,
  }
}

function normalizePosition(value, label, code = 'LSP_MALFORMED_RESPONSE') {
  if (!isRecord(value)
    || !Number.isSafeInteger(value.line)
    || value.line < 0
    || !Number.isSafeInteger(value.character)
    || value.character < 0) {
    throw lspError(code, `${label} must contain zero-based non-negative integer line and character`)
  }
  return Object.freeze({ line: value.line, character: value.character })
}

function comparePositions(left, right) {
  if (left.line !== right.line) return left.line - right.line
  return left.character - right.character
}

function normalizeRange(value, label) {
  if (!isRecord(value)) {
    throw lspError('LSP_MALFORMED_RESPONSE', `${label} must be an object`)
  }
  const start = normalizePosition(value.start, `${label}.start`)
  const end = normalizePosition(value.end, `${label}.end`)
  if (comparePositions(start, end) > 0) {
    throw lspError('LSP_MALFORMED_RESPONSE', `${label} end precedes start`)
  }
  return Object.freeze({ start, end })
}

function normalizeLocation(value, index) {
  if (!isRecord(value)) {
    throw lspError('LSP_MALFORMED_RESPONSE', `LSP location ${index} must be an object`)
  }
  const uri = requiredString(
    value.uri,
    `LSP location ${index} uri`,
    'LSP_MALFORMED_RESPONSE',
  )
  return Object.freeze({
    uri,
    range: normalizeRange(value.range, `LSP location ${index} range`),
  })
}

function normalizeLocationsResult(result) {
  if (!isRecord(result) || result.kind !== 'locations' || !Array.isArray(result.locations)) {
    throw lspError('LSP_MALFORMED_RESPONSE', 'LSP navigation query must return a locations result')
  }
  const resolvedWorkspaceUri = requiredString(
    result.resolvedWorkspaceUri,
    'LSP locations resolvedWorkspaceUri',
    'LSP_MALFORMED_RESPONSE',
  )
  const locations = Object.freeze(result.locations.map(normalizeLocation))
  return Object.freeze({ kind: 'locations', locations, resolvedWorkspaceUri })
}

function normalizeHoverResult(result) {
  if (!isRecord(result) || result.kind !== 'hover' || !Object.hasOwn(result, 'hover')) {
    throw lspError('LSP_MALFORMED_RESPONSE', 'LSP hover query must return a hover result')
  }
  if (result.hover === null) return Object.freeze({ kind: 'hover', hover: null })
  if (!isRecord(result.hover) || typeof result.hover.contents !== 'string') {
    throw lspError('LSP_MALFORMED_RESPONSE', 'LSP hover must be null or contain string contents')
  }
  const hover = Object.freeze({
    contents: result.hover.contents,
    ...(result.hover.range === undefined
      ? {}
      : { range: normalizeRange(result.hover.range, 'LSP hover range') }),
  })
  return Object.freeze({ kind: 'hover', hover })
}

function normalizeResult(operation, result) {
  return NAVIGATION_OPERATIONS.has(operation)
    ? normalizeLocationsResult(result)
    : normalizeHoverResult(result)
}

function normalizeRequest(input) {
  if (!isRecord(input)) {
    throw lspError('LSP_INVALID_REQUEST', 'LSP query must be an object')
  }
  if (!LSP_OPERATION_SET.has(input.operation)) {
    throw lspError(
      'LSP_UNSUPPORTED_OPERATION',
      `LSP operation must be one of: ${LSP_OPERATIONS.join(', ')}`,
    )
  }
  const filePath = requiredString(input.filePath, 'LSP filePath', 'LSP_INVALID_REQUEST')
  const workspaceRoot = requiredString(
    input.workspaceRoot,
    'LSP workspaceRoot',
    'LSP_INVALID_REQUEST',
  )
  const position = normalizePosition(input.position, 'LSP position', 'LSP_INVALID_REQUEST')
  return Object.freeze({
    operation: input.operation,
    filePath,
    workspaceRoot,
    position,
  })
}

function validateSignal(signal) {
  if (signal === undefined) return
  if (!isRecord(signal)
    || typeof signal.aborted !== 'boolean'
    || typeof signal.addEventListener !== 'function'
    || typeof signal.removeEventListener !== 'function') {
    throw lspError('LSP_INVALID_REQUEST', 'LSP query signal must be an AbortSignal')
  }
}

export function createLspService() {
  const providersById = new Map()
  const routesByExtension = new Map()
  const pendingCloses = new Set()
  let closed = false
  let closePromise = null

  const assertOpen = () => {
    if (closed) throw lspError('LSP_DISPOSED', 'LSP service is disposed')
  }

  const startProviderClose = (record) => {
    if (record.closePromise) return record.closePromise
    let closeResult
    try {
      closeResult = record.close?.()
    } catch {
      closeResult = undefined
    }
    const promise = Promise.resolve(closeResult)
      .catch(() => {})
      .finally(() => pendingCloses.delete(promise))
    record.closePromise = promise
    pendingCloses.add(promise)
    return promise
  }

  const unpublish = (record) => {
    if (record.disposed) return false
    record.disposed = true
    if (providersById.get(record.id) === record) providersById.delete(record.id)
    for (const extension of record.mappings.keys()) {
      if (routesByExtension.get(extension)?.record === record) {
        routesByExtension.delete(extension)
      }
    }
    void startProviderClose(record)
    return true
  }

  const registerProvider = (provider) => {
    assertOpen()
    const record = snapshotProvider(provider)
    if (providersById.has(record.id)) {
      throw lspError('LSP_CONFLICT', `LSP provider id is already registered: ${record.id}`)
    }
    for (const extension of record.mappings.keys()) {
      const current = routesByExtension.get(extension)
      if (current) {
        throw lspError(
          'LSP_CONFLICT',
          `LSP extension ${extension} is already handled by provider ${current.record.id}`,
        )
      }
    }

    providersById.set(record.id, record)
    for (const [extension, languageId] of record.mappings) {
      routesByExtension.set(extension, Object.freeze({ record, languageId }))
    }
    return () => unpublish(record)
  }

  const hasProviderForFile = (filePath) => {
    if (closed || typeof filePath !== 'string' || !filePath.trim()) return false
    return routesByExtension.has(finalExtension(filePath))
  }

  const query = async (input, signal = undefined) => {
    assertOpen()
    const request = normalizeRequest(input)
    validateSignal(signal)
    const route = routesByExtension.get(finalExtension(request.filePath))
    if (!route) {
      throw lspError('LSP_UNAVAILABLE', `No LSP provider handles ${request.filePath}`)
    }
    const providerRequest = Object.freeze({
      ...request,
      languageId: route.languageId,
    })
    const result = await route.record.query(providerRequest, signal)
    if (closed || route.record.disposed) {
      throw lspError('LSP_DISPOSED', 'LSP provider was disposed during the query')
    }
    return normalizeResult(request.operation, result)
  }

  const close = () => {
    if (closePromise) return closePromise
    closed = true
    for (const record of [...providersById.values()]) unpublish(record)
    closePromise = (async () => {
      while (pendingCloses.size > 0) {
        await Promise.allSettled([...pendingCloses])
      }
    })()
    return closePromise
  }

  return Object.freeze({
    registerProvider,
    query,
    hasProviderForFile,
    close,
  })
}
