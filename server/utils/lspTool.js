import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { getLspService } from '../services/lspRuntime.js'
import { resolveAuthorizedLocalPath } from '../services/localFileAccessService.js'
import { assertWorkspaceCapability } from '../services/workspaceTrustService.js'

const MAX_LOCATIONS = 100
const MAX_RESULT_BYTES = 16_000
const MAX_SOURCE_BYTES = 2 * 1024 * 1024
const OPERATIONS = Object.freeze([
  'goToDefinition',
  'findReferences',
  'goToImplementation',
  'hover',
])

export const LSP_TOOL_SPEC = {
  type: 'function',
  function: Object.freeze({
    name: 'lsp',
    description: 'Use a configured read-only language server for precise definition, reference, implementation, or hover navigation. line and character are 1-based; character counts UTF-16 code units.',
    parameters: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        operation: Object.freeze({ type: 'string', enum: OPERATIONS }),
        file: Object.freeze({ type: 'string', description: 'Authorized source file path.' }),
        line: Object.freeze({ type: 'integer', minimum: 1, description: '1-based source line.' }),
        character: Object.freeze({ type: 'integer', minimum: 1, description: '1-based UTF-16 character offset.' }),
        workspace_root: Object.freeze({ type: 'string', description: 'Optional authorized workspace root. Defaults to the narrowest authorized project root.' }),
      }),
      required: Object.freeze(['operation', 'file', 'line', 'character']),
      additionalProperties: false,
    }),
  }),
}

export const LSP_TOOL_SPECS = Object.freeze([LSP_TOOL_SPEC])

function toolError(code, message, statusCode = 400, cause = undefined) {
  const result = new Error(message, cause === undefined ? undefined : { cause })
  result.code = code
  result.statusCode = statusCode
  result.retryable = statusCode >= 500
  return result
}

function isInside(rootPath, filePath) {
  const relative = path.relative(rootPath, filePath)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function statPath(target, label) {
  try { return fs.statSync(target) } catch (cause) {
    throw toolError('LSP_SOURCE_UNAVAILABLE', `${label} is unavailable`, 404, cause)
  }
}

function authorize({ userId, rawPath }) {
  const resolved = resolveAuthorizedLocalPath({ userId, rawPath, write: false })
  if (resolved.source === 'workspace') {
    assertWorkspaceCapability({
      userId,
      rootPath: resolved.rootPath,
      capability: 'fileSystem',
    })
  }
  return resolved
}

function resolveWorkspace({ userId, fileAuthorization, requestedRoot }) {
  if (typeof requestedRoot === 'string' && requestedRoot.trim()) {
    const authorized = authorize({ userId, rawPath: requestedRoot })
    if (!statPath(authorized.fullPath, 'LSP workspace root').isDirectory()) {
      throw toolError('LSP_INVALID_WORKSPACE', 'LSP workspace root must be a directory')
    }
    if (!isInside(authorized.fullPath, fileAuthorization.fullPath)) {
      throw toolError('LSP_PATH_OUTSIDE_WORKSPACE', 'LSP source file is outside workspace_root', 403)
    }
    return authorized
  }

  const rootCandidate = fileAuthorization.rootPath
  if (fileAuthorization.source !== 'all_files'
    && fileAuthorization.source !== 'bypass'
    && typeof rootCandidate === 'string') {
    try {
      if (fs.statSync(rootCandidate).isDirectory() && isInside(rootCandidate, fileAuthorization.fullPath)) {
        return { ...fileAuthorization, fullPath: rootCandidate, displayPath: rootCandidate }
      }
    } catch { /* use the source file's parent */ }
  }
  const parent = path.dirname(fileAuthorization.fullPath)
  return { ...fileAuthorization, fullPath: parent, displayPath: parent }
}

function validatePosition(filePath, line, character) {
  if (!Number.isSafeInteger(line) || line < 1 || !Number.isSafeInteger(character) || character < 1) {
    throw toolError('LSP_INVALID_POSITION', 'LSP line and character must be positive integers')
  }
  const info = statPath(filePath, 'LSP source file')
  if (!info.isFile()) throw toolError('LSP_SOURCE_UNAVAILABLE', 'LSP source path must be a regular file')
  if (info.size > MAX_SOURCE_BYTES) {
    throw toolError('LSP_SOURCE_TOO_LARGE', `LSP source file exceeds ${MAX_SOURCE_BYTES} bytes`, 413)
  }
  let source
  try { source = fs.readFileSync(filePath, 'utf8') } catch (cause) {
    throw toolError('LSP_SOURCE_UNAVAILABLE', 'LSP source file cannot be read', 404, cause)
  }
  const lines = source.split(/\r?\n/u)
  if (line > lines.length || character > lines[line - 1].length + 1) {
    throw toolError('LSP_INVALID_POSITION', 'LSP position is outside the source file')
  }
  return Object.freeze({ line: line - 1, character: character - 1 })
}

function authorizedLocation(location, { userId, workspaceRoot }) {
  try {
    const url = new URL(location.uri)
    if (url.protocol !== 'file:') return null
    const localPath = fileURLToPath(url)
    const authorized = authorize({ userId, rawPath: localPath })
    if (!isInside(workspaceRoot, authorized.fullPath)) return null
    return {
      file: authorized.displayPath,
      line: location.range.start.line + 1,
      character: location.range.start.character + 1,
      end_line: location.range.end.line + 1,
      end_character: location.range.end.character + 1,
    }
  } catch {
    return null
  }
}

function resultBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

function boundLocationResult(base, rawLocations) {
  const locations = rawLocations.slice(0, MAX_LOCATIONS)
  const result = { ...base, locations, truncated: rawLocations.length > locations.length }
  while (locations.length > 0 && resultBytes(result) > MAX_RESULT_BYTES) {
    locations.pop()
    result.truncated = true
  }
  return result
}

function boundHoverResult(base, hover) {
  if (!hover) return { ...base, hover: null, truncated: false }
  const range = hover.range
    ? {
        line: hover.range.start.line + 1,
        character: hover.range.start.character + 1,
        end_line: hover.range.end.line + 1,
        end_character: hover.range.end.character + 1,
      }
    : undefined
  let contents = String(hover.contents || '')
  let result = { ...base, hover: { contents, ...(range ? { range } : {}) }, truncated: false }
  if (resultBytes(result) > MAX_RESULT_BYTES) {
    const build = (value) => ({
      ...base,
      hover: { contents: value, ...(range ? { range } : {}) },
      truncated: true,
    })
    const boundaries = [0]
    for (let index = 0; index < contents.length;) {
      index += contents.codePointAt(index) > 0xFFFF ? 2 : 1
      boundaries.push(index)
    }
    let low = 0
    let high = boundaries.length - 1
    result = build('')
    while (low <= high) {
      const middle = Math.floor((low + high) / 2)
      const candidate = build(contents.slice(0, boundaries[middle]))
      if (resultBytes(candidate) <= MAX_RESULT_BYTES) {
        result = candidate
        low = middle + 1
      } else {
        high = middle - 1
      }
    }
  }
  return result
}

export async function dispatchLspTool(args = {}, {
  userId = null,
  signal = undefined,
  service = getLspService(),
} = {}) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw toolError('LSP_INVALID_REQUEST', 'LSP tool arguments must be an object')
  }
  if (!OPERATIONS.includes(args.operation)) {
    throw toolError('LSP_UNSUPPORTED_OPERATION', `Unsupported LSP operation: ${args.operation || ''}`)
  }
  if (typeof args.file !== 'string' || !args.file.trim()) {
    throw toolError('LSP_INVALID_REQUEST', 'LSP file is required')
  }
  if (!service || typeof service.query !== 'function' || typeof service.hasProviderForFile !== 'function') {
    throw toolError('LSP_UNAVAILABLE', 'No LSP provider is configured', 503)
  }

  const fileAuthorization = authorize({ userId, rawPath: args.file })
  const workspace = resolveWorkspace({
    userId,
    fileAuthorization,
    requestedRoot: args.workspace_root,
  })
  if (!service.hasProviderForFile(fileAuthorization.fullPath)) {
    throw toolError('LSP_UNAVAILABLE', 'No configured LSP provider handles this file type', 503)
  }
  const position = validatePosition(fileAuthorization.fullPath, args.line, args.character)
  const response = await service.query({
    operation: args.operation,
    filePath: fileAuthorization.fullPath,
    workspaceRoot: workspace.fullPath,
    position,
  }, signal)
  const base = {
    ok: true,
    operation: args.operation,
    file: fileAuthorization.displayPath,
    position: { line: args.line, character: args.character },
  }
  if (response.kind === 'hover') return boundHoverResult(base, response.hover)
  const locations = response.locations
    .map((location) => authorizedLocation(location, { userId, workspaceRoot: workspace.fullPath }))
    .filter(Boolean)
  return boundLocationResult(base, locations)
}

export const _testing = Object.freeze({
  MAX_LOCATIONS,
  MAX_RESULT_BYTES,
  validatePosition,
  boundHoverResult,
  boundLocationResult,
})
