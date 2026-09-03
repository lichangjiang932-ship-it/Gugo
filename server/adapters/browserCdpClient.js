import WebSocket from 'ws'

export const START_TIMEOUT_MS = 15000
export const ACTION_TIMEOUT_MS = 15000

export function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason
  return Object.assign(new Error('Browser action cancelled'), { name: 'AbortError' })
}

export function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal)
}

export function abortableDelay(ms, signal = null) {
  throwIfAborted(signal)
  return new Promise((resolve, reject) => {
    let timer = null
    const cleanup = () => {
      if (timer) clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
    }
    const onAbort = () => {
      cleanup()
      reject(abortError(signal))
    }
    timer = setTimeout(() => {
      cleanup()
      resolve()
    }, Math.max(0, Number(ms) || 0))
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

export class CdpClient {
  constructor(url) {
    this.url = url
    this.ws = null
    this.nextId = 1
    this.pending = new Map()
    this.events = []
    this.requests = new Map()
    this.closing = false
  }

  async connect({ signal = null } = {}) {
    throwIfAborted(signal)
    this.ws = new WebSocket(this.url)
    await new Promise((resolve, reject) => {
      let settled = false
      const finish = (callback, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener?.('abort', onAbort)
        this.ws?.removeEventListener?.('open', onOpen)
        this.ws?.removeEventListener?.('error', onError)
        callback(value)
      }
      const onOpen = () => finish(resolve)
      const onError = () => finish(reject, new Error('无法连接浏览器 DevTools'))
      const onAbort = () => {
        try { this.ws?.close() } catch { /* best effort */ }
        finish(reject, abortError(signal))
      }
      const timer = setTimeout(
        () => finish(reject, new Error('连接浏览器 DevTools 超时')),
        START_TIMEOUT_MS,
      )
      this.ws.addEventListener('open', onOpen, { once: true })
      this.ws.addEventListener('error', onError, { once: true })
      signal?.addEventListener?.('abort', onAbort, { once: true })
    })
    this.ws.addEventListener('message', (event) => {
      let message
      try { message = JSON.parse(String(event.data || '')) } catch { return }
      if (!message.id) {
        if (message.method === 'Network.requestWillBeSent') {
          this.requests.set(message.params?.requestId, message.params?.request?.url || '')
          return
        }
        if (message.method === 'Network.responseReceived' && Number(message.params?.response?.status) < 400) return
        if (['Runtime.consoleAPICalled', 'Runtime.exceptionThrown', 'Log.entryAdded', 'Network.loadingFailed', 'Network.responseReceived'].includes(message.method)) {
          this.events.push(message)
          if (this.events.length > 500) this.events.splice(0, this.events.length - 500)
        }
        return
      }
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error) pending.reject(new Error(message.error.message || 'DevTools 请求失败'))
      else pending.resolve(message.result || {})
    })
    this.ws.addEventListener('close', () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer)
        if (this.closing) pending.resolve({})
        else pending.reject(new Error(`浏览器连接已关闭（等待 ${pending.method}）`))
      }
      this.pending.clear()
    })
  }

  isOpen() {
    return this.ws?.readyState === WebSocket.OPEN
  }

  request(method, params = {}, sessionId = null, timeoutMs = ACTION_TIMEOUT_MS, signal = null) {
    if (signal?.aborted) return Promise.reject(abortError(signal))
    if (!this.isOpen()) return Promise.reject(new Error('浏览器未连接'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const cleanup = () => signal?.removeEventListener?.('abort', onAbort)
      const resolvePending = (value) => { cleanup(); resolve(value) }
      const rejectPending = (error) => { cleanup(); reject(error) }
      const onAbort = () => {
        this.pending.delete(id)
        clearTimeout(timer)
        rejectPending(abortError(signal))
      }
      const timer = setTimeout(() => {
        this.pending.delete(id)
        rejectPending(new Error(`Browser action timeout: ${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolvePending, reject: rejectPending, timer, method })
      signal?.addEventListener?.('abort', onAbort, { once: true })
      try {
        this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
      } catch (error) {
        this.pending.delete(id)
        clearTimeout(timer)
        rejectPending(error)
      }
    })
  }

  close() {
    this.closing = true
    try { this.ws?.close() } catch { /* ignore */ }
  }
}
