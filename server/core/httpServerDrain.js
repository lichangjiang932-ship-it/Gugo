const DEFAULT_FORCE_AFTER_MS = 2_000

const controllers = new WeakMap()

function isServerSentEvents(response, recordedContentType = '') {
  const contentType = String(recordedContentType || response?.getHeader?.('content-type') || '').toLowerCase()
  return contentType.includes('text/event-stream')
}

function contentTypeFromHeaders(headers) {
  if (!headers || typeof headers !== 'object') return ''
  if (typeof headers.get === 'function') return String(headers.get('content-type') || '')
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === 'content-type') return String(value || '')
  }
  return ''
}

function closeServerSentEvent(response) {
  if (!response || response.destroyed || response.writableEnded) return
  const socket = response.socket
  try { response.write(': server shutdown\n\n') } catch { /* connection already closed */ }
  try { response.end() } catch { /* connection already closed */ }
  // An SSE request deliberately never becomes idle. Close its HTTP/1 socket
  // after the final frame so request-scoped subscriptions receive `close`.
  try { socket?.end?.() } catch { /* best-effort drain */ }
}

function closeWebSocket(client, { force = false } = {}) {
  try {
    if (force) client.terminate?.()
    else if (client.readyState === 0 || client.readyState === 1) client.close?.(1001, 'Server shutting down')
  } catch {
    if (!force) {
      try { client.terminate?.() } catch { /* already closed */ }
    }
  }
}

/**
 * Track the resources that Node's `server.close()` cannot drain by itself:
 * long-lived SSE responses and upgraded WebSocket connections.
 */
export function installHttpServerDrain(server, {
  webSocketServer = null,
  forceAfterMs = DEFAULT_FORCE_AFTER_MS,
} = {}) {
  if (!server || typeof server.on !== 'function') return null
  const existing = controllers.get(server)
  if (existing) {
    if (webSocketServer) existing.webSocketServers.add(webSocketServer)
    return existing
  }

  const sockets = new Set()
  const responses = new Map()
  const webSocketServers = new Set(webSocketServer ? [webSocketServer] : [])
  let draining = false
  let drainPromise = null

  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  server.on('request', (_request, response) => {
    const record = { contentType: String(response.getHeader?.('content-type') || '') }
    responses.set(response, record)
    const originalWriteHead = response.writeHead
    response.writeHead = function trackedWriteHead(statusCode, statusMessage, headers) {
      const suppliedHeaders = typeof statusMessage === 'object' && statusMessage !== null
        ? statusMessage
        : headers
      record.contentType = contentTypeFromHeaders(suppliedHeaders)
        || String(this.getHeader?.('content-type') || record.contentType || '')
      return originalWriteHead.apply(this, arguments)
    }
    const release = () => responses.delete(response)
    response.once('finish', release)
    response.once('close', release)
  })

  const controller = {
    sockets,
    responses,
    webSocketServers,
    get draining() { return draining },
    drain({ forceAfterMs: requestedForceAfterMs = forceAfterMs } = {}) {
      if (drainPromise) return drainPromise
      draining = true

      drainPromise = new Promise((resolve) => {
        let httpClosed = false
        let settled = false
        let forced = false
        let forceTimer = null
        const watchedClients = new Set()

        const activeClients = () => {
          const clients = new Set()
          for (const wss of webSocketServers) {
            for (const client of wss?.clients || []) {
              if (client.readyState !== 3) clients.add(client)
            }
          }
          return clients
        }
        const maybeFinish = () => {
          if (settled || !httpClosed || activeClients().size > 0 || sockets.size > 0) return
          settled = true
          if (forceTimer) clearTimeout(forceTimer)
          resolve({ forced })
        }
        const watchAndCloseClients = () => {
          for (const client of activeClients()) {
            if (!watchedClients.has(client)) {
              watchedClients.add(client)
              client.once?.('close', maybeFinish)
            }
            closeWebSocket(client)
          }
        }

        for (const socket of sockets) socket.once?.('close', maybeFinish)
        for (const [response, record] of responses) {
          if (isServerSentEvents(response, record.contentType)) closeServerSentEvent(response)
        }
        watchAndCloseClients()

        const forceClose = () => {
          if (settled) return
          forced = true
          for (const client of activeClients()) closeWebSocket(client, { force: true })
          try { server.closeAllConnections?.() } catch { /* unsupported or already closed */ }
          // closeAllConnections intentionally excludes upgraded sockets. The
          // tracked set covers those as well as older Node releases.
          for (const socket of sockets) {
            try { socket.destroy?.() } catch { /* already closed */ }
          }
          httpClosed = true
          queueMicrotask(maybeFinish)
        }

        const delay = Math.max(0, Number(requestedForceAfterMs) || 0)
        forceTimer = setTimeout(forceClose, delay)
        forceTimer.unref?.()

        try {
          server.close((error) => {
            // ERR_SERVER_NOT_RUNNING is already in the desired state.
            if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') forced = true
            httpClosed = true
            maybeFinish()
          })
          try { server.closeIdleConnections?.() } catch { /* optional API */ }
        } catch {
          httpClosed = true
          maybeFinish()
        }
      })
      return drainPromise
    },
  }
  controllers.set(server, controller)
  return controller
}

export function isHttpServerDraining(server) {
  return controllers.get(server)?.draining === true
}

export function drainHttpServer(server, options) {
  if (!server || typeof server.close !== 'function') return Promise.resolve({ forced: false })
  const controller = controllers.get(server)
  if (controller) return controller.drain(options)

  // Compatibility for tests and embedders that provide a minimal server.
  return new Promise((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      resolve({ forced: false })
    }
    try {
      server.close(finish)
      try { server.closeIdleConnections?.() } catch { /* optional API */ }
    } catch {
      finish()
    }
  })
}
