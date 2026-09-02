import path from 'node:path'

import { LspError } from '../services/lspService.js'

export const MAX_LSP_HEADER_BYTES = 8 * 1024
export const MAX_LSP_MESSAGE_BYTES = 1024 * 1024

export function lspStdioError(code, message, cause = undefined, retryable = false) {
  const result = new LspError(code, message, cause === undefined ? {} : { cause })
  result.retryable = retryable
  return result
}

export function lspSignalError(signal) {
  return signal?.reason instanceof LspError
    ? signal.reason
    : lspStdioError('LSP_ABORTED', 'LSP query was aborted', signal?.reason, true)
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function writeMessage(child, message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii')
  return new Promise((resolve, reject) => {
    if (!child?.stdin || child.stdin.destroyed) {
      reject(lspStdioError('LSP_PROCESS_EXITED', 'LSP server stdin is unavailable', undefined, true))
      return
    }
    child.stdin.write(Buffer.concat([header, body]), (cause) => {
      if (cause) reject(lspStdioError('LSP_TRANSPORT_FAILED', 'Could not write to LSP server', cause, true))
      else resolve()
    })
  })
}

export function createLspStdioRpc(child, { rootUri, onFatal = () => {} }) {
  let buffer = Buffer.alloc(0)
  let nextId = 1
  let closed = false
  let closeReason = null
  const pending = new Map()

  const settle = (id, action, value) => {
    const entry = pending.get(id)
    if (!entry) return false
    pending.delete(id)
    entry.signal?.removeEventListener?.('abort', entry.onAbort)
    entry[action](value)
    return true
  }

  const detach = () => {
    child.stdout?.off?.('data', onData)
    child.stdin?.off?.('error', onStdinError)
    child.stdin?.off?.('close', onStdinClose)
    child.stdout?.off?.('error', onStdoutError)
    child.stdout?.off?.('end', onStdoutEnd)
    child.stderr?.off?.('error', onStderrError)
    child.off?.('error', onError)
    child.off?.('exit', onExit)
  }

  const fail = (reason, notify = true) => {
    if (closed) return
    closed = true
    closeReason = reason
    detach()
    for (const id of [...pending.keys()]) settle(id, 'reject', reason)
    if (notify) onFatal(reason)
  }

  const send = async (message) => {
    if (closed) throw closeReason
    try {
      await writeMessage(child, message)
    } catch (cause) {
      const failure = cause instanceof LspError
        ? cause
        : lspStdioError('LSP_TRANSPORT_FAILED', 'Could not write to LSP server', cause, true)
      fail(failure)
      throw failure
    }
  }

  const respondToServer = (message) => {
    let result
    if (message.method === 'workspace/configuration') {
      const count = Array.isArray(message.params?.items) ? message.params.items.length : 0
      result = Array.from({ length: count }, () => null)
    } else if (message.method === 'workspace/workspaceFolders') {
      result = [{ uri: rootUri, name: path.basename(new URL(rootUri).pathname) || 'workspace' }]
    } else {
      void send({
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: -32601,
          message: `Unsupported server request: ${String(message.method || '')}`,
        },
      }).catch(() => {})
      return
    }
    void send({ jsonrpc: '2.0', id: message.id, result }).catch(() => {})
  }

  const dispatch = (message) => {
    if (!isRecord(message)) {
      throw lspStdioError('LSP_MALFORMED_RESPONSE', 'LSP server sent a non-object message')
    }
    if (message.id !== undefined && message.method) {
      respondToServer(message)
      return
    }
    if (message.id === undefined || !pending.has(message.id)) return
    if (message.error) {
      settle(message.id, 'reject', lspStdioError(
        'LSP_SERVER_ERROR',
        typeof message.error.message === 'string'
          ? message.error.message
          : 'LSP server returned an error',
        undefined,
        true,
      ))
    } else {
      settle(message.id, 'resolve', message.result)
    }
  }

  function onData(chunk) {
    if (closed) return
    try {
      buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)])
      if (buffer.length > MAX_LSP_MESSAGE_BYTES + MAX_LSP_HEADER_BYTES) {
        throw lspStdioError('LSP_RESPONSE_TOO_LARGE', 'LSP response buffer exceeded its limit')
      }
      while (buffer.length > 0) {
        const headerEnd = buffer.indexOf('\r\n\r\n')
        if (headerEnd < 0) {
          if (buffer.length > MAX_LSP_HEADER_BYTES) {
            throw lspStdioError('LSP_MALFORMED_RESPONSE', 'LSP header exceeded its limit')
          }
          return
        }
        if (headerEnd > MAX_LSP_HEADER_BYTES) {
          throw lspStdioError('LSP_MALFORMED_RESPONSE', 'LSP header exceeded its limit')
        }
        const headers = buffer.subarray(0, headerEnd).toString('ascii').split('\r\n')
        const lengthHeader = headers.find((line) => /^content-length\s*:/iu.test(line))
        const length = Number(lengthHeader?.split(':', 2)[1]?.trim())
        if (!Number.isSafeInteger(length) || length < 0 || length > MAX_LSP_MESSAGE_BYTES) {
          throw lspStdioError('LSP_MALFORMED_RESPONSE', 'LSP Content-Length is invalid')
        }
        const messageEnd = headerEnd + 4 + length
        if (buffer.length < messageEnd) return
        const body = buffer.subarray(headerEnd + 4, messageEnd).toString('utf8')
        buffer = buffer.subarray(messageEnd)
        let message
        try { message = JSON.parse(body) } catch (cause) {
          throw lspStdioError('LSP_MALFORMED_RESPONSE', 'LSP server sent invalid JSON', cause)
        }
        dispatch(message)
      }
    } catch (cause) {
      fail(cause instanceof LspError
        ? cause
        : lspStdioError('LSP_TRANSPORT_FAILED', 'LSP parser failed', cause, true))
    }
  }

  function onError(cause) {
    fail(lspStdioError('LSP_PROCESS_FAILED', 'LSP server process failed', cause, true))
  }

  function onStdinError(cause) {
    fail(lspStdioError('LSP_TRANSPORT_FAILED', 'LSP server stdin failed', cause, true))
  }

  function onStdinClose() {
    fail(lspStdioError('LSP_TRANSPORT_FAILED', 'LSP server stdin closed', undefined, true))
  }

  function onStdoutError(cause) {
    fail(lspStdioError('LSP_TRANSPORT_FAILED', 'LSP server stdout failed', cause, true))
  }

  function onStdoutEnd() {
    fail(lspStdioError('LSP_TRANSPORT_FAILED', 'LSP server stdout ended', undefined, true))
  }

  function onStderrError(cause) {
    fail(lspStdioError('LSP_TRANSPORT_FAILED', 'LSP server stderr failed', cause, true))
  }

  function onExit(code, exitSignal) {
    fail(lspStdioError(
      'LSP_PROCESS_EXITED',
      `LSP server exited (code=${code}, signal=${exitSignal})`,
      undefined,
      true,
    ))
  }

  child.stdin?.on?.('error', onStdinError)
  child.stdin?.on?.('close', onStdinClose)
  child.stdout.on('data', onData)
  child.stdout.on('error', onStdoutError)
  child.stdout.on('end', onStdoutEnd)
  child.stderr?.on?.('error', onStderrError)
  child.once('error', onError)
  child.once('exit', onExit)

  const request = async (method, params, signal = undefined) => {
    if (closed) throw closeReason
    if (signal?.aborted) throw lspSignalError(signal)
    const id = nextId++
    let onAbort = null
    const result = new Promise((resolve, reject) => {
      onAbort = () => {
        if (!settle(id, 'reject', lspSignalError(signal))) return
        void send({
          jsonrpc: '2.0',
          method: '$/cancelRequest',
          params: { id },
        }).catch(() => {})
      }
      pending.set(id, { resolve, reject, signal, onAbort })
      signal?.addEventListener?.('abort', onAbort, { once: true })
    })
    try {
      await send({ jsonrpc: '2.0', id, method, params })
    } catch (cause) {
      settle(id, 'reject', cause)
    }
    return result
  }

  const notify = (method, params = undefined) => send({
    jsonrpc: '2.0',
    method,
    ...(params === undefined ? {} : { params }),
  })

  const close = (reason) => fail(reason, false)

  return Object.freeze({ request, notify, close })
}
