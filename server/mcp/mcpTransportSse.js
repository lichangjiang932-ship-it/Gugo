/**
 * Feature 1: MCP HTTP/SSE transport
 *
 * 协议（streamable HTTP，2024-11-05 后）:
 *   - 客户端 POST /endpoint，body = JSON-RPC 请求
 *   - 服务端可返回 application/json（单条响应）
 *     或返回 text/event-stream（流式：服务端不断 push event:message data:{...} ）
 *
 * 我们的简化实现:
 *   - 所有请求都 POST 到同一 URL
 *   - 如果 Content-Type 是 application/json → 直接 parse
 *   - 如果是 text/event-stream → 逐 event 解析 data: 行，按 id 匹配到 pending
 *
 * 安全:
 *   - 强制 HTTPS（生产）
 *   - 可附自定义 headers（鉴权 token）
 *   - 每个请求自带超时
 *
 * NB: 本实现不支持服务端主动 server-initiated streams（实测大多数 MCP server 也未实现）。
 */

import { fetchSafeOutbound } from '../utils/outboundNetworkGuard.js'

function isLoopbackUrl(raw) {
  try {
    const url = new URL(raw)
    return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname)
  } catch {
    return false
  }
}

function isLoopbackHttpUrl(raw) {
  try {
    const url = new URL(raw)
    return url.protocol === 'http:' && isLoopbackUrl(raw)
  } catch {
    return false
  }
}

function mcpRpcError(message) {
  const error = new Error(message || 'MCP error')
  error.isMcpRpcError = true
  return error
}

export class SseTransport {
  constructor({
    url,
    headers = {},
    getHeaders,
    label = 'mcp',
    timeoutMs = 30000,
    fetchImpl = globalThis.fetch,
    lookup,
    resolveDns,
  }) {
    if (!url || !/^https?:\/\//.test(url)) throw new Error('SSE transport 需要 http/https url')
    if (process.env.NODE_ENV === 'production' && !url.startsWith('https://') && !isLoopbackHttpUrl(url)) {
      throw new Error('生产环境 MCP SSE 必须 https')
    }
    this.url = url
    this.headers = headers
    this.getHeaders = typeof getHeaders === 'function' ? getHeaders : null
    this.label = label
    this.timeoutMs = timeoutMs
    this.fetchImpl = fetchImpl
    this.lookup = lookup
    this.resolveDns = resolveDns ?? (typeof lookup === 'function' || fetchImpl === globalThis.fetch)
    this.closed = false
    this.sessionId = null
    this.notificationHandlers = new Set()
    this.errorHandlers = new Set()
    this.closeHandlers = new Set()
    this.closeEmitted = false
  }

  start() { /* no-op for HTTP */ }

  onNotification(fn) { this.notificationHandlers.add(fn); return () => this.notificationHandlers.delete(fn) }
  onError(fn) { this.errorHandlers.add(fn); return () => this.errorHandlers.delete(fn) }
  onClose(fn) { this.closeHandlers.add(fn); return () => this.closeHandlers.delete(fn) }
  _emitError(err) { for (const fn of this.errorHandlers) { try { fn(err) } catch { /* ignore */ } } }
  _emitClose(details) {
    if (this.closeEmitted) return
    this.closeEmitted = true
    for (const fn of this.closeHandlers) { try { fn(details) } catch { /* ignore */ } }
  }

  send(message) {
    // 通知（无 id）：fire-and-forget POST
    return this._post(message).then(() => {}).catch((err) => this._emitError(err))
  }

  async _headers() {
    const dynamicHeaders = this.getHeaders ? await this.getHeaders() : {}
    return {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-03-26',
      ...(this.sessionId ? { 'MCP-Session-Id': this.sessionId } : {}),
      ...(this.headers || {}),
      ...(dynamicHeaders || {}),
    }
  }

  _fetch(init) {
    return fetchSafeOutbound(this.url, init, {
      fetchImpl: this.fetchImpl,
      allowLocal: isLoopbackUrl(this.url) ? 'loopback' : false,
      resolveDns: this.resolveDns,
      ...(typeof this.lookup === 'function' ? { lookup: this.lookup } : {}),
    })
  }

  async request(message, { timeoutMs, signal } = {}) {
    if (this.closed) throw new Error(`MCP "${this.label}" 已关闭`)
    if (signal?.aborted) throw signal.reason || new DOMException('MCP request cancelled', 'AbortError')
    const ctrl = new AbortController()
    const abortFromCaller = () => ctrl.abort(signal.reason)
    signal?.addEventListener?.('abort', abortFromCaller, { once: true })
    const t = setTimeout(() => ctrl.abort(), timeoutMs || this.timeoutMs)
    try {
      const resp = await this._fetch({
        method: 'POST',
        headers: await this._headers(),
        body: JSON.stringify(message),
        signal: ctrl.signal,
      })
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '')
        throw new Error(`MCP HTTP ${resp.status}: ${errText.slice(0, 200)}`)
      }
      this.sessionId = resp.headers.get('mcp-session-id') || this.sessionId
      const ct = resp.headers.get('content-type') || ''
      if (ct.includes('text/event-stream')) {
        return this._parseSseResponse(resp, message.id)
      }
      const text = await resp.text()
      const data = text ? JSON.parse(text) : {}
      if (data.error) throw mcpRpcError(data.error.message)
      return data.result
    } catch (error) {
      if (signal?.aborted) throw signal.reason || error
      if (!error?.isMcpRpcError) this._emitError(error)
      throw error
    } finally {
      clearTimeout(t)
      signal?.removeEventListener?.('abort', abortFromCaller)
    }
  }

  async _post(message) {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs)
    try {
      const resp = await this._fetch({
        method: 'POST',
        headers: await this._headers(),
        body: JSON.stringify(message),
        signal: ctrl.signal,
      })
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '')
        throw new Error(`MCP HTTP ${resp.status}: ${errText.slice(0, 200)}`)
      }
      this.sessionId = resp.headers.get('mcp-session-id') || this.sessionId
    } finally {
      clearTimeout(t)
    }
  }

  async _parseSseResponse(resp, expectedId) {
    const reader = resp.body.getReader()
    const decoder = new TextDecoder('utf-8')
    let buffer = ''
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
      let idx
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const evt = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        const dataLines = evt.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim())
        if (!dataLines.length) continue
        const payload = dataLines.join('\n')
        let msg
        try { msg = JSON.parse(payload) } catch { continue }
        if (msg.id !== undefined && msg.id === expectedId) {
          if (msg.error) throw mcpRpcError(msg.error.message)
          // 关掉 reader,后续 event 丢弃
          try { await reader.cancel() } catch { /* ignore */ }
          return msg.result
        }
        if (msg.method && msg.id === undefined) {
          for (const fn of this.notificationHandlers) { try { fn(msg) } catch { /* ignore */ } }
        }
      }
    }
    throw new Error(`MCP "${this.label}" SSE 流结束但未收到 id=${expectedId} 的响应`)
  }

  stop() {
    if (this.closed) return
    this.closed = true
    this._emitClose({ reason: new Error(`MCP "${this.label}" 主动关闭`), intentional: true })
  }

  isAlive() {
    return !this.closed
  }
}

export const _sseTransportInternals = { isLoopbackHttpUrl, isLoopbackUrl }
