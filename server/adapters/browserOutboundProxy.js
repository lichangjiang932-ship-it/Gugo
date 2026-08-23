import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'

import {
  assertSafeOutboundUrl,
  pinnedLookup,
} from '../utils/outboundNetworkGuard.js'

const CONNECT_TIMEOUT_MS = 15_000

function bareHostname(value) {
  return String(value || '').replace(/^\[|\]$/g, '')
}

function proxyHeaders(headers, target) {
  const result = { ...headers, host: target.host }
  delete result['proxy-authorization']
  delete result['proxy-connection']
  return result
}

function sendProxyError(target, status, code) {
  if (!target || target.destroyed) return
  const body = `${code}\n`
  if (typeof target.writeHead === 'function') {
    if (!target.headersSent) {
      target.writeHead(status, {
        'content-type': 'text/plain; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        connection: 'close',
      })
    }
    target.end(body)
    return
  }
  try {
    target.end(
      `HTTP/1.1 ${status} ${status === 403 ? 'Forbidden' : 'Bad Gateway'}\r\n`
      + 'Connection: close\r\n'
      + `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    )
  } catch { target.destroy() }
}

function requestUrl(req) {
  const raw = String(req?.url || '')
  if (/^https?:\/\//i.test(raw)) return raw
  const host = String(req?.headers?.host || '')
  if (!host || !raw.startsWith('/')) return ''
  return `http://${host}${raw}`
}

function connectUrl(authority) {
  const raw = String(authority || '').trim()
  if (!raw || /[\s/?#]/.test(raw)) return ''
  return `https://${raw}/`
}

function guardOptions(options) {
  return {
    lookup: options.lookup,
    allowLocal: options.allowLocal,
    resolveDns: true,
  }
}

async function forwardHttp(req, res, options) {
  let target
  try {
    target = await assertSafeOutboundUrl(requestUrl(req), guardOptions(options))
  } catch (error) {
    sendProxyError(res, 403, error?.code || 'BROWSER_OUTBOUND_DENIED')
    return
  }
  const transport = target.protocol === 'https:' ? https : http
  const upstream = transport.request({
    protocol: target.protocol,
    hostname: bareHostname(target.hostname),
    port: target.port || (target.protocol === 'https:' ? 443 : 80),
    method: req.method,
    path: `${target.pathname}${target.search}`,
    headers: proxyHeaders(req.headers, target),
    lookup: pinnedLookup(target.lockedIp),
    ...(target.protocol === 'https:' ? { servername: bareHostname(target.hostname) } : {}),
  }, (upstreamResponse) => {
    res.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers)
    upstreamResponse.pipe(res)
  })
  upstream.setTimeout(CONNECT_TIMEOUT_MS, () => upstream.destroy(new Error('browser proxy upstream timeout')))
  upstream.once('error', () => sendProxyError(res, 502, 'BROWSER_OUTBOUND_FAILED'))
  req.once('aborted', () => upstream.destroy())
  req.pipe(upstream)
}

async function forwardConnect(req, clientSocket, head, options) {
  let target
  try {
    target = await assertSafeOutboundUrl(connectUrl(req.url), guardOptions(options))
  } catch (error) {
    sendProxyError(clientSocket, 403, error?.code || 'BROWSER_OUTBOUND_DENIED')
    return
  }
  const upstream = net.connect({
    host: target.lockedIp,
    port: Number(target.port) || 443,
  })
  upstream.setTimeout(CONNECT_TIMEOUT_MS, () => upstream.destroy(new Error('browser proxy connect timeout')))
  upstream.once('connect', () => {
    upstream.setTimeout(0)
    clientSocket.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: Gugo\r\n\r\n')
    if (head?.length) upstream.write(head)
    upstream.pipe(clientSocket)
    clientSocket.pipe(upstream)
  })
  upstream.once('error', () => sendProxyError(clientSocket, 502, 'BROWSER_OUTBOUND_FAILED'))
  clientSocket.once('error', () => upstream.destroy())
  clientSocket.once('close', () => upstream.destroy())
}

function serializedUpgradeRequest(req, target) {
  const lines = [`${req.method || 'GET'} ${target.pathname}${target.search} HTTP/${req.httpVersion || '1.1'}`]
  for (const [name, value] of Object.entries(proxyHeaders(req.headers, target))) {
    if (Array.isArray(value)) {
      for (const item of value) lines.push(`${name}: ${item}`)
    } else if (value != null) lines.push(`${name}: ${value}`)
  }
  return `${lines.join('\r\n')}\r\n\r\n`
}

async function forwardUpgrade(req, clientSocket, head, options) {
  let target
  try {
    const raw = String(req.url || '')
    const parsed = new URL(raw)
    const guardUrl = new URL(raw)
    guardUrl.protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:'
    target = await assertSafeOutboundUrl(guardUrl, guardOptions(options))
    target.protocol = parsed.protocol
  } catch (error) {
    sendProxyError(clientSocket, 403, error?.code || 'BROWSER_OUTBOUND_DENIED')
    return
  }
  const secure = target.protocol === 'wss:'
  const connectOptions = {
    host: target.lockedIp,
    port: Number(target.port) || (secure ? 443 : 80),
    ...(secure ? { servername: bareHostname(target.hostname) } : {}),
  }
  const upstream = secure ? tls.connect(connectOptions) : net.connect(connectOptions)
  upstream.setTimeout(CONNECT_TIMEOUT_MS, () => upstream.destroy(new Error('browser proxy upgrade timeout')))
  const readyEvent = secure ? 'secureConnect' : 'connect'
  upstream.once(readyEvent, () => {
    upstream.setTimeout(0)
    upstream.write(serializedUpgradeRequest(req, target))
    if (head?.length) upstream.write(head)
    upstream.pipe(clientSocket)
    clientSocket.pipe(upstream)
  })
  upstream.once('error', () => sendProxyError(clientSocket, 502, 'BROWSER_OUTBOUND_FAILED'))
  clientSocket.once('error', () => upstream.destroy())
  clientSocket.once('close', () => upstream.destroy())
}

export async function startBrowserOutboundProxy({
  host = '127.0.0.1',
  lookup,
  allowLocal = false,
  signal = null,
} = {}) {
  if (signal?.aborted) throw signal.reason || new Error('Browser proxy start cancelled')
  const options = { lookup, allowLocal }
  const sockets = new Set()
  const server = http.createServer((req, res) => { void forwardHttp(req, res, options) })
  server.on('connect', (req, socket, head) => { void forwardConnect(req, socket, head, options) })
  server.on('upgrade', (req, socket, head) => { void forwardUpgrade(req, socket, head, options) })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })

  await new Promise((resolve, reject) => {
    const onAbort = () => {
      server.close()
      reject(signal.reason || new Error('Browser proxy start cancelled'))
    }
    const cleanup = () => signal?.removeEventListener?.('abort', onAbort)
    server.once('error', (error) => { cleanup(); reject(error) })
    server.listen(0, host, () => { cleanup(); resolve() })
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })

  const address = server.address()
  let closed = false
  return {
    url: `http://${host}:${address.port}`,
    port: address.port,
    get closed() { return closed },
    close() {
      if (closed) return Promise.resolve(false)
      closed = true
      for (const socket of sockets) socket.destroy()
      return new Promise((resolve) => server.close(() => resolve(true)))
    },
  }
}

export const _browserProxyInternals = {
  connectUrl,
  requestUrl,
}
