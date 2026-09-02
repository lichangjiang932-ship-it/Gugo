import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { LspError } from '../services/lspService.js'
import { terminateProcessTree } from '../utils/processGroup.js'
import { sanitizeChildEnv } from '../utils/sensitiveEnv.js'
import {
  MAX_LSP_MESSAGE_BYTES,
  lspSignalError,
  lspStdioError,
} from './lspStdioProtocol.js'
import {
  DEFAULT_LSP_CRASH_BACKOFF_MS,
  DEFAULT_LSP_IDLE_TIMEOUT_MS,
  DEFAULT_LSP_MAX_PROCESSES,
  createLspWorkspacePool,
} from './lspWorkspacePool.js'

const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 20_000
const MAX_CONCURRENT_QUERIES = 4

const METHOD_BY_OPERATION = Object.freeze({
  goToDefinition: 'textDocument/definition',
  findReferences: 'textDocument/references',
  goToImplementation: 'textDocument/implementation',
  hover: 'textDocument/hover',
})

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function requiredString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw lspStdioError('LSP_INVALID_PROVIDER', `${label} must be a non-empty string`)
  }
  if (value.includes('\0')) throw lspStdioError('LSP_INVALID_PROVIDER', `${label} contains a null byte`)
  return value.trim()
}

function normalizeConfig(input) {
  if (!isRecord(input)) {
    throw lspStdioError('LSP_INVALID_PROVIDER', 'LSP stdio provider config must be an object')
  }
  const id = requiredString(input.id, 'LSP provider id')
  const command = requiredString(input.command, 'LSP provider command')
  if (!Array.isArray(input.args)
    || input.args.some((value) => typeof value !== 'string' || value.includes('\0'))) {
    throw lspStdioError('LSP_INVALID_PROVIDER', `LSP provider ${id} args must be an array of strings`)
  }
  if (!isRecord(input.env)) {
    throw lspStdioError('LSP_INVALID_PROVIDER', `LSP provider ${id} env must be an object`)
  }
  const env = {}
  for (const [key, value] of Object.entries(input.env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(key)
      || typeof value !== 'string'
      || value.includes('\0')) {
      throw lspStdioError('LSP_INVALID_PROVIDER', `LSP provider ${id} env is invalid`)
    }
    env[key] = value
  }
  if (!isRecord(input.extensionToLanguage)) {
    throw lspStdioError(
      'LSP_INVALID_PROVIDER',
      `LSP provider ${id} extensionToLanguage must be an object`,
    )
  }
  const timeoutMs = Number(input.timeoutMs)
  return Object.freeze({
    id,
    command,
    args: Object.freeze([...input.args]),
    env: Object.freeze(env),
    extensionToLanguage: Object.freeze({ ...input.extensionToLanguage }),
    cwd: input.cwd === undefined ? null : requiredString(input.cwd, `LSP provider ${id} cwd`),
    timeoutMs: Number.isSafeInteger(timeoutMs) && timeoutMs >= 1_000 && timeoutMs <= 120_000
      ? timeoutMs
      : DEFAULT_TIMEOUT_MS,
  })
}

function isInside(rootPath, filePath) {
  const relative = path.relative(rootPath, filePath)
  return relative === ''
    || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

async function readDocument(filePath, workspaceRoot, readFile, stat, realpath) {
  let rootReal
  let fileReal
  try {
    [rootReal, fileReal] = await Promise.all([realpath(workspaceRoot), realpath(filePath)])
  } catch (cause) {
    throw lspStdioError('LSP_SOURCE_UNAVAILABLE', 'LSP source file or workspace is unavailable', cause)
  }
  if (!isInside(rootReal, fileReal)) {
    throw lspStdioError('LSP_PATH_OUTSIDE_WORKSPACE', 'LSP source file is outside the resolved workspace')
  }
  let info
  try { info = await stat(fileReal) } catch (cause) {
    throw lspStdioError('LSP_SOURCE_UNAVAILABLE', 'LSP source file cannot be inspected', cause)
  }
  if (!info.isFile()) {
    throw lspStdioError('LSP_SOURCE_UNAVAILABLE', 'LSP source path must be a regular file')
  }
  if (info.size > MAX_DOCUMENT_BYTES) {
    throw lspStdioError('LSP_SOURCE_TOO_LARGE', `LSP source file exceeds ${MAX_DOCUMENT_BYTES} bytes`)
  }
  let source
  try { source = await readFile(fileReal, 'utf8') } catch (cause) {
    throw lspStdioError('LSP_SOURCE_UNAVAILABLE', 'LSP source file cannot be read', cause)
  }
  return { rootReal, fileReal, source }
}

function normalizeRange(value) {
  if (!isRecord(value) || !isRecord(value.start) || !isRecord(value.end)) return null
  const numbers = [value.start.line, value.start.character, value.end.line, value.end.character]
  if (numbers.some((number) => !Number.isSafeInteger(number) || number < 0)) return null
  return {
    start: { line: value.start.line, character: value.start.character },
    end: { line: value.end.line, character: value.end.character },
  }
}

function normalizeLocations(value) {
  const values = value == null ? [] : (Array.isArray(value) ? value : [value])
  const locations = []
  for (const candidate of values.slice(0, 500)) {
    if (!isRecord(candidate)) continue
    const uri = typeof candidate.uri === 'string' ? candidate.uri : candidate.targetUri
    const range = normalizeRange(
      candidate.range || candidate.targetSelectionRange || candidate.targetRange,
    )
    if (uri && range) locations.push({ uri, range })
  }
  return locations
}

function hoverContents(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(hoverContents).filter(Boolean).join('\n\n')
  if (!isRecord(value)) return ''
  return typeof value.value === 'string' ? value.value : ''
}

function normalizeHover(value) {
  if (value == null) return null
  if (!isRecord(value)) {
    throw lspStdioError('LSP_MALFORMED_RESPONSE', 'LSP hover response is malformed')
  }
  const contents = hoverContents(value.contents).slice(0, 64 * 1024)
  if (!contents) return null
  const range = value.range === undefined ? null : normalizeRange(value.range)
  return { contents, ...(range ? { range } : {}) }
}

export function createLspStdioProvider(config, {
  spawnImpl = spawn,
  terminateProcessTreeFn = terminateProcessTree,
  readFile = fs.promises.readFile.bind(fs.promises),
  stat = fs.promises.stat.bind(fs.promises),
  realpath = fs.promises.realpath.bind(fs.promises),
  platform = process.platform,
  maxProcesses = DEFAULT_LSP_MAX_PROCESSES,
  idleTimeoutMs = DEFAULT_LSP_IDLE_TIMEOUT_MS,
  crashBackoffMs = DEFAULT_LSP_CRASH_BACKOFF_MS,
  now = Date.now,
} = {}) {
  const normalized = normalizeConfig({ args: [], env: {}, ...config })
  const activeQueries = new Set()
  let documentSnapshotSequence = 0
  let closed = false
  let closePromise = null
  const pool = createLspWorkspacePool({
    config: normalized,
    spawnImpl,
    terminateProcessTreeFn,
    platform,
    maxProcesses,
    idleTimeoutMs,
    crashBackoffMs,
    now,
    childEnv: sanitizeChildEnv(normalized.env, {
      allowExtraKeys: Object.keys(normalized.env),
    }),
  })

  const query = async (request, upstreamSignal = undefined) => {
    if (closed) throw lspStdioError('LSP_DISPOSED', `LSP provider ${normalized.id} is closed`)
    if (activeQueries.size >= MAX_CONCURRENT_QUERIES) {
      throw lspStdioError(
        'LSP_BUSY',
        `LSP provider ${normalized.id} is at its concurrency limit`,
        undefined,
        true,
      )
    }
    if (!isRecord(request) || !METHOD_BY_OPERATION[request.operation]) {
      throw lspStdioError('LSP_INVALID_REQUEST', 'LSP stdio query operation is invalid')
    }
    if (upstreamSignal?.aborted) throw lspSignalError(upstreamSignal)
    const controller = new AbortController()
    let resolveDone
    const queryRecord = {
      controller,
      done: new Promise((resolve) => { resolveDone = resolve }),
    }
    activeQueries.add(queryRecord)
    const snapshotSequence = ++documentSnapshotSequence
    const onAbort = () => controller.abort(upstreamSignal.reason)
    upstreamSignal?.addEventListener?.('abort', onAbort, { once: true })
    const timeout = setTimeout(() => controller.abort(lspStdioError(
      'LSP_TIMEOUT',
      `LSP provider ${normalized.id} timed out after ${normalized.timeoutMs}ms`,
      undefined,
      true,
    )), normalized.timeoutMs)
    timeout.unref?.()
    let lease = null
    try {
      const document = {
        ...await readDocument(
        request.filePath,
        request.workspaceRoot,
        readFile,
        stat,
        realpath,
        ),
        snapshotSequence,
      }
      if (controller.signal.aborted) throw lspSignalError(controller.signal)
      if (closed) throw lspStdioError('LSP_DISPOSED', `LSP provider ${normalized.id} is closed`)
      lease = await pool.acquire(document.rootReal, controller.signal)
      const rawResult = await lease.execute(
        document,
        request,
        METHOD_BY_OPERATION[request.operation],
        controller.signal,
      )
      lease.markHealthy()
      return request.operation === 'hover'
        ? { kind: 'hover', hover: normalizeHover(rawResult) }
        : {
            kind: 'locations',
            locations: normalizeLocations(rawResult),
            resolvedWorkspaceUri: lease.rootUri,
          }
    } catch (cause) {
      if (controller.signal.aborted) throw lspSignalError(controller.signal)
      if (cause instanceof LspError) throw cause
      throw lspStdioError(
        'LSP_PROVIDER_FAILED',
        `LSP provider ${normalized.id} failed`,
        cause,
        true,
      )
    } finally {
      clearTimeout(timeout)
      upstreamSignal?.removeEventListener?.('abort', onAbort)
      lease?.release()
      activeQueries.delete(queryRecord)
      resolveDone()
    }
  }

  const close = () => {
    if (closePromise) return closePromise
    closed = true
    const closeReason = lspStdioError('LSP_DISPOSED', `LSP provider ${normalized.id} is closed`)
    const records = [...activeQueries]
    for (const { controller } of records) controller.abort(closeReason)
    closePromise = (async () => {
      await pool.close()
      await Promise.allSettled(records.map(({ done }) => done))
    })()
    return closePromise
  }

  return Object.freeze({
    id: normalized.id,
    extensionToLanguage: normalized.extensionToLanguage,
    query,
    close,
  })
}

export const _testing = Object.freeze({
  MAX_DOCUMENT_BYTES,
  MAX_MESSAGE_BYTES: MAX_LSP_MESSAGE_BYTES,
  MAX_CONCURRENT_QUERIES,
  DEFAULT_LSP_IDLE_TIMEOUT_MS,
  DEFAULT_LSP_MAX_PROCESSES,
  DEFAULT_LSP_CRASH_BACKOFF_MS,
  METHOD_BY_OPERATION,
  normalizeLocations,
  normalizeHover,
})
