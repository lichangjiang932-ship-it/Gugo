import { getLocalFileAccessApi } from './localFileAccessClient.js'
import { buildLocalPathPreflight, isLocalPathAuthorized } from './localPathPreflight.js'
import { getAuthToken } from './accountClient.js'

export const DEFAULT_LOCAL_PATH_PROBE_TIMEOUT_MS = 4000
export const DEFAULT_LOCAL_PATH_STATUS_TIMEOUT_MS = 2500

function createAbortError() {
  const error = new Error('Local path probe aborted')
  error.name = 'AbortError'
  return error
}

function responseErrorMessage(data, fallback) {
  if (typeof data?.error === 'string' && data.error) return data.error
  if (typeof data?.error?.message === 'string' && data.error.message) return data.error.message
  return fallback
}

async function executeLocalPathProbeCall(call, { signal } = {}) {
  const routes = {
    list_directory: '/api/tools/fs/list',
    read_file: '/api/tools/fs/read',
  }
  const route = routes[call?.name]
  if (!route) return { ok: false, content: JSON.stringify({ code: 'UNKNOWN_PROBE_TOOL', error: String(call?.name || '') }) }

  let args
  try {
    args = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : (call.arguments || {})
  } catch (error) {
    return { ok: false, content: JSON.stringify({ code: 'INVALID_PROBE_ARGUMENTS', error: error?.message || String(error) }) }
  }

  const headers = { 'Content-Type': 'application/json' }
  const token = getAuthToken?.()
  if (token) headers.Authorization = `Bearer ${token}`
  const response = await fetch(route, {
    method: 'POST',
    headers,
    body: JSON.stringify(args),
    signal,
  })
  const text = await response.text()
  let data
  try { data = text ? JSON.parse(text) : {} } catch { data = { raw: text } }
  if (!response.ok || data?.ok === false) {
    return {
      ok: false,
      content: JSON.stringify({
        code: data?.error?.code || data?.code || 'LOCAL_PATH_PROBE_FAILED',
        error: responseErrorMessage(data, `HTTP ${response.status}`),
        path: data?.error?.path || data?.path || args.path,
        status: response.status,
      }),
    }
  }
  return { ok: true, content: JSON.stringify(data) }
}

function probeFailure(path, code, message) {
  return {
    path,
    tool: 'local_path_probe',
    ok: false,
    content: JSON.stringify({ code, error: message }),
  }
}

async function runWithProbeDeadline(path, operation, { signal, timeoutMs }) {
  if (signal?.aborted) throw createAbortError()
  const controller = new AbortController()
  let timer = null
  let abortListener = null
  let notifyAbort = null
  const externalAbort = new Promise((resolve) => { notifyAbort = resolve })
  if (signal) {
    abortListener = () => {
      controller.abort()
      notifyAbort({ kind: 'aborted' })
    }
    signal.addEventListener('abort', abortListener, { once: true })
  }

  const duration = Math.max(1, Number(timeoutMs) || DEFAULT_LOCAL_PATH_PROBE_TIMEOUT_MS)
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      controller.abort()
      resolve({ kind: 'timeout' })
    }, duration)
  })
  const pending = Promise.resolve()
    .then(() => operation(controller.signal))
    .then((value) => ({ kind: 'value', value }), (error) => ({ kind: 'error', error }))

  try {
    const outcome = await Promise.race([pending, timeout, externalAbort])
    if (outcome.kind === 'aborted' || signal?.aborted) throw createAbortError()
    if (outcome.kind === 'timeout') {
      return probeFailure(path, 'LOCAL_PATH_PROBE_TIMEOUT', `Local path probe exceeded ${duration} ms`)
    }
    if (outcome.kind === 'error') {
      return probeFailure(path, 'LOCAL_PATH_PROBE_FAILED', outcome.error?.message || String(outcome.error))
    }
    return outcome.value
  } finally {
    if (timer) clearTimeout(timer)
    if (abortListener) signal?.removeEventListener('abort', abortListener)
  }
}

function probeResultCode(result) {
  const payload = parseProbeContent(result?.content)
  return String(payload?.code || payload?.error?.code || '').trim()
}

function shouldStopAfterListFailure(result) {
  return ['PATH_NOT_AUTHORIZED', 'UNAUTHORIZED', 'ABSOLUTE_PATH_REQUIRED'].includes(probeResultCode(result))
}

async function readAccessStatusWithDeadline(getAccessStatus, timeoutMs) {
  const controller = new AbortController()
  const duration = Math.max(1, Number(timeoutMs) || DEFAULT_LOCAL_PATH_STATUS_TIMEOUT_MS)
  let timer = null
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      controller.abort()
      resolve({ kind: 'timeout' })
    }, duration)
  })
  const pending = Promise.resolve()
    .then(() => getAccessStatus({ signal: controller.signal }))
    .then((value) => ({ kind: 'value', value }), (error) => ({ kind: 'error', error }))

  try {
    const outcome = await Promise.race([pending, timeout])
    return outcome.kind === 'value' ? outcome.value : null
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export function createLocalPathAccessEnsurer(requestDirectoryApproval, {
  getAccessStatus = getLocalFileAccessApi,
  statusTimeoutMs = DEFAULT_LOCAL_PATH_STATUS_TIMEOUT_MS,
} = {}) {
  return async function ensureLocalPathAccess(content) {
    const request = buildLocalPathPreflight(content)
    if (!request.paths.length) return { proceed: true, ...request }

    let status = null
    try {
      status = await readAccessStatusWithDeadline(getAccessStatus, statusTimeoutMs)
    } catch {
      // A successful grant below remains authoritative when lookup is unavailable.
    }

    for (const path of request.paths) {
      if (isLocalPathAuthorized(path, status, request.accessMode)) continue
      const decision = await requestDirectoryApproval({
        path,
        suggestGrantPath: path,
        requiredAccessMode: request.accessMode,
        source: 'message_preflight',
      })
      if (!decision?.approved) return { proceed: false, ...request }
      status = {
        ...(status || {}),
        grants: [...(status?.grants || []), {
          path: decision.path || path,
          accessMode: decision.accessMode || request.accessMode,
          resourceType: decision.resourceType || 'directory',
          available: true,
        }],
      }
    }
    return { proceed: true, ...request }
  }
}

export function createLocalPathAccessProbe(lang, {
  execute = executeLocalPathProbeCall,
  timeoutMs: configuredTimeoutMs = DEFAULT_LOCAL_PATH_PROBE_TIMEOUT_MS,
} = {}) {
  return async function probeLocalPathAccess(localPathAccess, {
    signal,
    timeoutMs = configuredTimeoutMs,
  } = {}) {
    const paths = Array.isArray(localPathAccess?.paths) ? localPathAccess.paths.slice(0, 3) : []
    return Promise.all(paths.map((path, index) => runWithProbeDeadline(path, async (probeSignal) => {
      const options = { maxRetries: 0, lang, signal: probeSignal, suppressDirectoryApproval: true }
      const listResult = await execute({
        id: `local-path-list-${index}`,
        name: 'list_directory',
        arguments: JSON.stringify({ path, limit: 200 }),
      }, options)
      if (listResult.ok) return { path, tool: 'list_directory', ok: true, content: listResult.content }
      if (shouldStopAfterListFailure(listResult)) {
        return { path, tool: 'list_directory', ok: false, content: listResult.content }
      }

      const readResult = await execute({
        id: `local-path-read-${index}`,
        name: 'read_file',
        arguments: JSON.stringify({ path, offset: 0, limit: 240 }),
      }, options)
      if (readResult.ok) return { path, tool: 'read_file', ok: true, content: readResult.content }
      return {
        path,
        tool: 'local_path_probe',
        ok: false,
        content: JSON.stringify({
          listDirectoryError: listResult.content,
          readFileError: readResult.content,
        }),
      }
    }, { signal, timeoutMs })))
  }
}

function parseProbeContent(value) {
  try {
    const parsed = JSON.parse(String(value || ''))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

export function buildLocalFilePreviewArtifact(results, { messageId = '' } = {}) {
  const successful = (Array.isArray(results) ? results : []).filter((item) => item?.ok !== false)
  const fileResult = successful.find((item) => item?.tool === 'read_file')
  const filePayload = fileResult ? parseProbeContent(fileResult.content) : null
  if (filePayload && typeof filePayload.content === 'string') {
    const filePath = String(filePayload.path || fileResult.path || '').trim()
    const filename = filePath.split(/[\\/]/u).filter(Boolean).at(-1) || 'local-file.txt'
    const returnedLines = Math.max(0, Number(filePayload.returnedLines) || filePayload.content.split('\n').length)
    const totalLines = Math.max(returnedLines, Number(filePayload.totalLines) || returnedLines)
    return {
      messageId: String(messageId || ''),
      content: filePayload.content,
      preview: {
        type: 'text',
        title: filename,
        label: 'FILE',
        summary: returnedLines < totalLines
          ? [returnedLines, totalLines].join('/') + ' lines'
          : totalLines + ' lines',
        filename,
        path: filePath,
        truncated: returnedLines < totalLines,
      },
    }
  }

  const directoryResult = successful.find((item) => item?.tool === 'list_directory')
  const directoryPayload = directoryResult ? parseProbeContent(directoryResult.content) : null
  if (!directoryPayload || !Array.isArray(directoryPayload.entries)) return null
  const directoryPath = String(directoryPayload.path || directoryResult.path || '').trim()
  const directoryName = directoryPath.split(/[\\/]/u).filter(Boolean).at(-1) || 'directory'
  const totalEntries = Math.max(directoryPayload.entries.length, Number(directoryPayload.total) || 0)
  const truncated = directoryPayload.truncated === true || directoryPayload.entries.length < totalEntries
  const rows = directoryPayload.entries.map((entry) => {
    const type = entry?.type === 'directory' ? 'DIR ' : entry?.type === 'file' ? 'FILE' : String(entry?.type || 'ITEM').toUpperCase().slice(0, 4).padEnd(4)
    const name = String(entry?.name || '').replace(/[\r\n]+/gu, ' ')
    const size = entry?.type === 'file' && Number.isFinite(Number(entry?.size)) ? `  ${Number(entry.size)} bytes` : ''
    return `[${type}] ${name}${size}`
  })
  const content = [
    `Directory: ${directoryPath}`,
    `Entries: ${directoryPayload.entries.length}${truncated ? ` of ${totalEntries}` : ''}`,
    '',
    ...rows,
  ].join('\n')
  return {
    messageId: String(messageId || ''),
    content,
    preview: {
      type: 'text',
      title: directoryName,
      label: 'DIR',
      summary: truncated ? `${directoryPayload.entries.length}/${totalEntries} entries` : `${totalEntries} entries`,
      filename: `${directoryName}-listing.txt`,
      path: directoryPath,
      truncated,
    },
  }
}
