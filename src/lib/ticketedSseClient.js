const noop = () => {}

function retryDelay(attempt, baseMs, maxMs) {
  const base = Math.max(0, Number(baseMs) || 0)
  const max = Math.max(base, Number(maxMs) || base)
  return Math.min(max, base * (2 ** attempt))
}

/**
 * Opens an SSE stream through a short-lived, one-time ticket so the durable
 * account token never appears in the EventSource URL.
 */
export function subscribeToTicketedSse({
  ticketUrl,
  streamUrl,
  eventName,
  onEvent,
  headers = noop,
  fetchImpl = globalThis.fetch,
  EventSourceImpl = globalThis.EventSource,
  AbortControllerImpl = globalThis.AbortController,
  setTimeoutImpl = globalThis.setTimeout,
  clearTimeoutImpl = globalThis.clearTimeout,
  retryBaseMs = 1_000,
  retryMaxMs = 15_000,
  onConnectionChange = noop,
} = {}) {
  if (
    !ticketUrl
    || typeof streamUrl !== 'function'
    || !eventName
    || typeof onEvent !== 'function'
    || typeof fetchImpl !== 'function'
    || typeof EventSourceImpl !== 'function'
  ) return noop

  let stopped = false
  let stream = null
  let retryTimer = null
  let retryAttempt = 0
  let requestController = null
  let requestGeneration = 0

  const reportConnection = (state, detail = {}) => {
    try { onConnectionChange({ state, ...detail }) } catch { /* observer only */ }
  }

  const closeStream = () => {
    const current = stream
    stream = null
    try { current?.close() } catch { /* already closed */ }
  }

  const clearRetry = () => {
    if (retryTimer !== null && typeof clearTimeoutImpl === 'function') {
      clearTimeoutImpl(retryTimer)
    }
    retryTimer = null
  }

  const invalidateTicketRequest = () => {
    requestGeneration += 1
    const controller = requestController
    requestController = null
    try { controller?.abort() } catch { /* already settled */ }
  }

  const scheduleReconnect = () => {
    if (stopped || retryTimer !== null || typeof setTimeoutImpl !== 'function') return
    closeStream()
    invalidateTicketRequest()
    const delay = retryDelay(retryAttempt, retryBaseMs, retryMaxMs)
    retryAttempt += 1
    reportConnection('retrying', { delay })
    retryTimer = setTimeoutImpl(() => {
      retryTimer = null
      void connect()
    }, delay)
  }

  const openStream = (ticket) => {
    if (stopped) return
    const nextStream = new EventSourceImpl(streamUrl(ticket))
    stream = nextStream
    nextStream.addEventListener('ready', () => {
      if (stopped || stream !== nextStream) return
      retryAttempt = 0
      reportConnection('open')
    })
    nextStream.addEventListener(eventName, (event) => {
      if (stopped || stream !== nextStream) return
      try { onEvent(event) } catch { /* one bad event must not kill the stream */ }
    })
    nextStream.addEventListener('error', () => {
      if (stopped || stream !== nextStream) return
      scheduleReconnect()
    })
  }

  const connect = async () => {
    if (stopped) return
    const generation = ++requestGeneration
    const controller = typeof AbortControllerImpl === 'function'
      ? new AbortControllerImpl()
      : null
    requestController = controller
    reportConnection('connecting')

    try {
      const resolvedHeaders = typeof headers === 'function' ? headers() : headers
      const response = await fetchImpl(ticketUrl, {
        method: 'POST',
        headers: resolvedHeaders || {},
        ...(controller ? { signal: controller.signal } : {}),
      })
      if (stopped || generation !== requestGeneration || controller?.signal?.aborted) return
      if (!response?.ok) {
        const status = Number(response?.status)
        if (status === 401 || status === 403) {
          stopped = true
          clearRetry()
          closeStream()
          reportConnection('unauthorized', { status })
          return
        }
        throw new Error(`stream ticket request failed: ${response?.status || 'unknown'}`)
      }

      const payload = await response.json()
      if (stopped || generation !== requestGeneration || controller?.signal?.aborted) return
      const ticket = String(payload?.ticket || '').trim()
      if (!ticket) throw new Error('stream ticket missing')
      openStream(ticket)
    } catch (error) {
      if (stopped || generation !== requestGeneration || error?.name === 'AbortError') return
      scheduleReconnect()
    } finally {
      if (requestController === controller) requestController = null
    }
  }

  void connect()

  return () => {
    if (stopped) return
    stopped = true
    clearRetry()
    invalidateTicketRequest()
    closeStream()
    reportConnection('closed')
  }
}
