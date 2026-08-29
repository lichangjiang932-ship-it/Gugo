import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { LspError } from '../services/lspService.js'
import { terminateProcessTree } from '../utils/processGroup.js'
import { sanitizeChildEnv } from '../utils/sensitiveEnv.js'

const MAX_HEADER_BYTES = 8 * 1024
const MAX_MESSAGE_BYTES = 1024 * 1024
const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 20_000
const MAX_CONCURRENT_QUERIES = 4

const METHOD_BY_OPERATION = Object.freeze({
  goToDefinition: 'textDocument/definition',
  findReferences: 'textDocument/references',
  goToImplementation: 'textDocument/implementation',
  hover: 'textDocument/hover',
})

function error(code, message, cause = undefined, retryable = false) {
  const result = new LspError(code, message, cause === undefined ? {} : { cause })
  result.retryable = retryable
  return result
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function requiredString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw error('LSP_INVALID_PROVIDER', `${label} must be a non-empty string`)
  }
  if (value.includes('\0')) throw error('LSP_INVALID_PROVIDER', `${label} contains a null byte`)
  return value.trim()
}

function normalizeConfig(input) {
  if (!isRecord(input)) throw error('LSP_INVALID_PROVIDER', 'LSP stdio provider config must be an object')
  const id = requiredString(input.id, 'LSP provider id')
  const command = requiredString(input.command, 'LSP provider command')
  if (!Array.isArray(input.args) || input.args.some((value) => typeof value !== 'string' || value.includes('\0'))) {
    throw error('LSP_INVALID_PROVIDER', `LSP provider ${id} args must be an array of strings`)
  }
  if (!isRecord(input.env)) {
    throw error('LSP_INVALID_PROVIDER', `LSP provider ${id} env must be an object`)
  }
  const env = {}
  for (const [key, value] of Object.entries(input.env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(key) || typeof value !== 'string' || value.includes('\0')) {
      throw error('LSP_INVALID_PROVIDER', `LSP provider ${id} env is invalid`)
    }
    env[key] = value
  }
  if (!isRecord(input.extensionToLanguage)) {
    throw error('LSP_INVALID_PROVIDER', `LSP provider ${id} extensionToLanguage must be an object`)
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
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

async function readDocument(filePath, workspaceRoot, readFile, stat, realpath) {
  let rootReal
  let fileReal
  try {
    [rootReal, fileReal] = await Promise.all([realpath(workspaceRoot), realpath(filePath)])
  } catch (cause) {
    throw error('LSP_SOURCE_UNAVAILABLE', 'LSP source file or workspace is unavailable', cause)
  }
  if (!isInside(rootReal, fileReal)) {
    throw error('LSP_PATH_OUTSIDE_WORKSPACE', 'LSP source file is outside the resolved workspace')
  }
  let info
  try {
    info = await stat(fileReal)
  } catch (cause) {
    throw error('LSP_SOURCE_UNAVAILABLE', 'LSP source file cannot be inspected', cause)
  }
  if (!info.isFile()) throw error('LSP_SOURCE_UNAVAILABLE', 'LSP source path must be a regular file')
  if (info.size > MAX_DOCUMENT_BYTES) {
    throw error('LSP_SOURCE_TOO_LARGE', `LSP source file exceeds ${MAX_DOCUMENT_BYTES} bytes`)
  }
  let source
  try {
    source = await readFile(fileReal, 'utf8')
  } catch (cause) {
    throw error('LSP_SOURCE_UNAVAILABLE', 'LSP source file cannot be read', cause)
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
    const range = normalizeRange(candidate.range || candidate.targetSelectionRange || candidate.targetRange)
    if (!uri || !range) continue
    locations.push({ uri, range })
  }
  return locations
}

function hoverContents(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(hoverContents).filter(Boolean).join('\n\n')
  if (!isRecord(value)) return ''
  if (typeof value.value === 'string') return value.value
  return ''
}

function normalizeHover(value) {
  if (value == null) return null
  if (!isRecord(value)) throw error('LSP_MALFORMED_RESPONSE', 'LSP hover response is malformed')
  const contents = hoverContents(value.contents).slice(0, 64 * 1024)
  if (!contents) return null
  const range = value.range === undefined ? null : normalizeRange(value.range)
  return { contents, ...(range ? { range } : {}) }
}

function abortReason(signal) {
  return error('LSP_ABORTED', 'LSP query was aborted', signal?.reason, true)
}

function writeMessage(child, message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii')
  return new Promise((resolve, reject) => {
    if (!child?.stdin || child.stdin.destroyed) {
      reject(error('LSP_PROCESS_EXITED', 'LSP server stdin is unavailable', undefined, true))
      return
    }
    child.stdin.write(Buffer.concat([header, body]), (cause) => {
      if (cause) reject(error('LSP_TRANSPORT_FAILED', 'Could not write to LSP server', cause, true))
      else resolve()
    })
  })
}

function createRpc(child, { rootUri, signal }) {
  let buffer = Buffer.alloc(0)
  let nextId = 1
  let closed = false
  const pending = new Map()

  const rejectAll = (reason) => {
    if (closed) return
    closed = true
    for (const entry of pending.values()) entry.reject(reason)
    pending.clear()
  }

  const respondToServer = (message) => {
    let result
    if (message.method === 'workspace/configuration') {
      const count = Array.isArray(message.params?.items) ? message.params.items.length : 0
      result = Array.from({ length: count }, () => null)
    } else if (message.method === 'workspace/workspaceFolders') {
      result = [{ uri: rootUri, name: path.basename(new URL(rootUri).pathname) || 'workspace' }]
    } else {
      void writeMessage(child, {
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: -32601,
          message: `Unsupported server request: ${String(message.method || '')}`,
        },
      }).catch(rejectAll)
      return
    }
    void writeMessage(child, { jsonrpc: '2.0', id: message.id, result }).catch(rejectAll)
  }

  const dispatch = (message) => {
    if (!isRecord(message)) throw error('LSP_MALFORMED_RESPONSE', 'LSP server sent a non-object message')
    if (message.id !== undefined && message.method) {
      respondToServer(message)
      return
    }
    if (message.id === undefined || !pending.has(message.id)) return
    const entry = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) {
      entry.reject(error(
        'LSP_SERVER_ERROR',
        typeof message.error.message === 'string' ? message.error.message : 'LSP server returned an error',
        undefined,
        true,
      ))
    } else {
      entry.resolve(message.result)
    }
  }

  const onData = (chunk) => {
    if (closed) return
    try {
      buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)])
      if (buffer.length > MAX_MESSAGE_BYTES + MAX_HEADER_BYTES) {
        throw error('LSP_RESPONSE_TOO_LARGE', 'LSP response buffer exceeded its limit')
      }
      while (buffer.length > 0) {
        const headerEnd = buffer.indexOf('\r\n\r\n')
        if (headerEnd < 0) {
          if (buffer.length > MAX_HEADER_BYTES) throw error('LSP_MALFORMED_RESPONSE', 'LSP header exceeded its limit')
          return
        }
        if (headerEnd > MAX_HEADER_BYTES) throw error('LSP_MALFORMED_RESPONSE', 'LSP header exceeded its limit')
        const headers = buffer.subarray(0, headerEnd).toString('ascii').split('\r\n')
        const lengthHeader = headers.find((line) => /^content-length\s*:/iu.test(line))
        const length = Number(lengthHeader?.split(':', 2)[1]?.trim())
        if (!Number.isSafeInteger(length) || length < 0 || length > MAX_MESSAGE_BYTES) {
          throw error('LSP_MALFORMED_RESPONSE', 'LSP Content-Length is invalid')
        }
        const messageEnd = headerEnd + 4 + length
        if (buffer.length < messageEnd) return
        const body = buffer.subarray(headerEnd + 4, messageEnd).toString('utf8')
        buffer = buffer.subarray(messageEnd)
        let message
        try { message = JSON.parse(body) } catch (cause) {
          throw error('LSP_MALFORMED_RESPONSE', 'LSP server sent invalid JSON', cause)
        }
        dispatch(message)
      }
    } catch (cause) {
      rejectAll(cause instanceof LspError ? cause : error('LSP_TRANSPORT_FAILED', 'LSP parser failed', cause, true))
    }
  }

  child.stdout.on('data', onData)
  child.once('error', (cause) => rejectAll(error('LSP_PROCESS_FAILED', 'LSP server failed to start', cause, true)))
  child.once('exit', (code, exitSignal) => rejectAll(error(
    'LSP_PROCESS_EXITED',
    `LSP server exited (code=${code}, signal=${exitSignal})`,
    undefined,
    true,
  )))
  signal.addEventListener('abort', () => rejectAll(abortReason(signal)), { once: true })

  const request = async (method, params) => {
    if (closed) throw abortReason(signal)
    const id = nextId++
    const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
    try {
      await writeMessage(child, { jsonrpc: '2.0', id, method, params })
    } catch (cause) {
      pending.delete(id)
      throw cause
    }
    return result
  }

  const notify = (method, params) => writeMessage(child, { jsonrpc: '2.0', method, params })

  return Object.freeze({ request, notify, close: rejectAll })
}

async function waitForSpawn(child, signal) {
  if (signal.aborted) throw abortReason(signal)
  if (child.pid) return
  await new Promise((resolve, reject) => {
    const cleanup = () => {
      child.off('spawn', onSpawn)
      child.off('error', onError)
      signal.removeEventListener('abort', onAbort)
    }
    const onSpawn = () => { cleanup(); resolve() }
    const onError = (cause) => { cleanup(); reject(error('LSP_PROCESS_FAILED', 'LSP server failed to start', cause, true)) }
    const onAbort = () => { cleanup(); reject(abortReason(signal)) }
    child.once('spawn', onSpawn)
    child.once('error', onError)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

async function terminateChild(child, terminate) {
  if (!child) return
  try { child.stdin?.end() } catch { /* already closed */ }
  if (!Number.isInteger(child.pid) || child.pid <= 0) return
  try { await terminate({ pid: child.pid, child }) } catch { /* best effort */ }
}

export function createLspStdioProvider(config, {
  spawnImpl = spawn,
  terminateProcessTreeFn = terminateProcessTree,
  readFile = fs.promises.readFile.bind(fs.promises),
  stat = fs.promises.stat.bind(fs.promises),
  realpath = fs.promises.realpath.bind(fs.promises),
  platform = process.platform,
} = {}) {
  const normalized = normalizeConfig({ args: [], env: {}, ...config })
  const activeChildren = new Set()
  const activeQueries = new Set()
  let closed = false

  const query = async (request, upstreamSignal = undefined) => {
    if (closed) throw error('LSP_DISPOSED', `LSP provider ${normalized.id} is closed`)
    if (activeQueries.size >= MAX_CONCURRENT_QUERIES) {
      throw error('LSP_BUSY', `LSP provider ${normalized.id} is at its concurrency limit`, undefined, true)
    }
    if (!isRecord(request) || !METHOD_BY_OPERATION[request.operation]) {
      throw error('LSP_INVALID_REQUEST', 'LSP stdio query operation is invalid')
    }
    if (upstreamSignal?.aborted) throw abortReason(upstreamSignal)
    const controller = new AbortController()
    const queryRecord = Object.freeze({ controller })
    activeQueries.add(queryRecord)
    const onAbort = () => controller.abort(upstreamSignal.reason)
    upstreamSignal?.addEventListener?.('abort', onAbort, { once: true })
    const timeout = setTimeout(() => controller.abort(error(
      'LSP_TIMEOUT',
      `LSP provider ${normalized.id} timed out after ${normalized.timeoutMs}ms`,
      undefined,
      true,
    )), normalized.timeoutMs)
    timeout.unref?.()
    let child = null
    let rpc = null
    try {
      const document = await readDocument(request.filePath, request.workspaceRoot, readFile, stat, realpath)
      if (controller.signal.aborted) {
        const reason = controller.signal.reason
        if (reason instanceof LspError) throw reason
        throw abortReason(controller.signal)
      }
      if (closed) throw error('LSP_DISPOSED', `LSP provider ${normalized.id} is closed`)
      const rootUri = pathToFileURL(document.rootReal).href
      const documentUri = pathToFileURL(document.fileReal).href
      child = spawnImpl(normalized.command, normalized.args, {
        cwd: normalized.cwd || document.rootReal,
        env: sanitizeChildEnv(normalized.env, { allowExtraKeys: Object.keys(normalized.env) }),
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
        detached: platform !== 'win32',
      })
      activeChildren.add(child)
      child.stderr?.resume?.()
      await waitForSpawn(child, controller.signal)
      rpc = createRpc(child, { rootUri, signal: controller.signal })
      await rpc.request('initialize', {
        processId: null,
        clientInfo: { name: 'Gugo', version: '1' },
        rootUri,
        capabilities: {
          workspace: { workspaceFolders: true },
          textDocument: { definition: {}, references: {}, implementation: {}, hover: {} },
        },
        workspaceFolders: [{ uri: rootUri, name: path.basename(document.rootReal) || 'workspace' }],
      })
      await rpc.notify('initialized', {})
      await rpc.notify('textDocument/didOpen', {
        textDocument: {
          uri: documentUri,
          languageId: request.languageId,
          version: 1,
          text: document.source,
        },
      })
      const params = {
        textDocument: { uri: documentUri },
        position: request.position,
        ...(request.operation === 'findReferences' ? { context: { includeDeclaration: true } } : {}),
      }
      const rawResult = await rpc.request(METHOD_BY_OPERATION[request.operation], params)
      const result = request.operation === 'hover'
        ? { kind: 'hover', hover: normalizeHover(rawResult) }
        : { kind: 'locations', locations: normalizeLocations(rawResult), resolvedWorkspaceUri: rootUri }
      await rpc.notify('textDocument/didClose', { textDocument: { uri: documentUri } }).catch(() => {})
      await rpc.request('shutdown', null).catch(() => null)
      await rpc.notify('exit').catch(() => {})
      return result
    } catch (cause) {
      if (controller.signal.aborted) {
        const reason = controller.signal.reason
        if (reason instanceof LspError) throw reason
        throw abortReason(controller.signal)
      }
      if (cause instanceof LspError) throw cause
      throw error('LSP_PROVIDER_FAILED', `LSP provider ${normalized.id} failed`, cause, true)
    } finally {
      clearTimeout(timeout)
      upstreamSignal?.removeEventListener?.('abort', onAbort)
      rpc?.close(error('LSP_PROCESS_EXITED', 'LSP query transport closed', undefined, true))
      await terminateChild(child, terminateProcessTreeFn)
      if (child) activeChildren.delete(child)
      activeQueries.delete(queryRecord)
    }
  }

  const close = async () => {
    if (closed) return
    closed = true
    const closeReason = error('LSP_DISPOSED', `LSP provider ${normalized.id} is closed`)
    for (const { controller } of activeQueries) controller.abort(closeReason)
    await Promise.allSettled([...activeChildren].map((child) => terminateChild(child, terminateProcessTreeFn)))
    activeChildren.clear()
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
  MAX_MESSAGE_BYTES,
  METHOD_BY_OPERATION,
  normalizeLocations,
  normalizeHover,
})
