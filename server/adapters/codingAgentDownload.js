import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { createHash, randomBytes } from 'node:crypto'

import { assertSafeOutboundUrl } from '../utils/outboundNetworkGuard.js'
import { writeLimiter } from '../utils/rateLimiter.js'
import { resolveForFileTool } from './fsShellTools.js'
import {
  DEFAULT_DOWNLOAD_MAX_BYTES,
  DEFAULT_DOWNLOAD_TIMEOUT_MS,
  HARD_DOWNLOAD_MAX_BYTES,
  MAX_DOWNLOAD_TIMEOUT_MS,
  assertToolPermitted,
  clampInteger,
  toolError,
} from './codingAgentToolSupport.js'

const MAX_REDIRECTS = 5

function requestDownload(target, { headers = {}, timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    const isHttps = target.protocol === 'https:'
    const transport = isHttps ? https : http
    const lockedIp = target.lockedIp || (net.isIP(target.hostname) ? target.hostname : null)
    const options = {
      hostname: target.hostname,
      port: target.port || (isHttps ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method: 'GET',
      headers: {
        'User-Agent': 'Gugo-Coding-Agent/1.0',
        Accept: '*/*',
        ...headers,
        Host: target.host,
      },
    }
    if (lockedIp) {
      const family = net.isIPv6(lockedIp) ? 6 : 4
      options.lookup = (_hostname, lookupOptions, callback) => {
        if (lookupOptions?.all) callback(null, [{ address: lockedIp, family }])
        else callback(null, lockedIp, family)
      }
      if (isHttps) options.servername = target.hostname
    }
    const request = transport.request(options, resolve)
    const abort = () => request.destroy(toolError('下载已取消', 499, 'DOWNLOAD_CANCELLED'))
    request.setTimeout(timeoutMs, () => request.destroy(toolError('下载超时', 408, 'DOWNLOAD_TIMEOUT')))
    request.once('error', reject)
    request.once('close', () => signal?.removeEventListener('abort', abort))
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
    request.end()
  })
}

async function openDownloadResponse(url, options) {
  let current = String(url || '').trim()
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const target = await (options.validateUrl || assertSafeOutboundUrl)(current)
    const response = await (options.requestImpl || requestDownload)(target, options)
    if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers?.location) {
      response.resume?.()
      if (redirect >= MAX_REDIRECTS) throw toolError('下载重定向次数过多', 502, 'DOWNLOAD_REDIRECT_LIMIT')
      current = new URL(response.headers.location, target).toString()
      continue
    }
    return { response, finalUrl: target.toString() }
  }
  throw toolError('下载重定向次数过多', 502, 'DOWNLOAD_REDIRECT_LIMIT')
}

function configuredDownloadLimit() {
  return clampInteger(process.env.FILE_DOWNLOAD_MAX_BYTES, DEFAULT_DOWNLOAD_MAX_BYTES, 1, HARD_DOWNLOAD_MAX_BYTES)
}

async function commitDownloadedFile(tempPath, destination, overwrite) {
  if (overwrite) {
    await fs.promises.rename(tempPath, destination)
    return
  }
  try {
    await fs.promises.link(tempPath, destination)
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw toolError('目标文件已存在；确认需要覆盖后传 overwrite=true', 409, 'DOWNLOAD_TARGET_EXISTS')
    }
    throw error
  }
}

export async function fileDownloadTool({
  url,
  path: rawPath,
  overwrite = false,
  sha256,
  headers = {},
  timeout_ms,
  max_bytes,
} = {}, {
  userId = null,
  signal = null,
  validateUrl = assertSafeOutboundUrl,
  requestImpl = requestDownload,
} = {}) {
  assertToolPermitted(userId, 'file_download')
  if (typeof url !== 'string' || !url.trim()) throw toolError('url 必填', 400, 'DOWNLOAD_URL_REQUIRED')
  const expected = String(sha256 || '').trim().toLowerCase()
  if (expected && !/^[0-9a-f]{64}$/u.test(expected)) {
    throw toolError('sha256 必须是 64 位十六进制字符串', 400, 'DOWNLOAD_CHECKSUM_INVALID')
  }
  if (headers == null || typeof headers !== 'object' || Array.isArray(headers)) {
    throw toolError('headers 必须是对象', 400, 'DOWNLOAD_HEADERS_INVALID')
  }
  for (const key of Object.keys(headers)) {
    if (/^(?:authorization|cookie|proxy-authorization)$/iu.test(key)) {
      throw toolError(`不允许通过 file_download 发送敏感请求头: ${key}`, 400, 'DOWNLOAD_HEADER_DENIED')
    }
  }
  if (userId && !writeLimiter.tryConsume(userId, 'write')) {
    throw toolError('文件写入限流：超过 120 次/分钟', 429, 'DOWNLOAD_RATE_LIMITED')
  }
  const resolved = resolveForFileTool(rawPath, { userId, write: true, allowMissing: true })
  const destination = resolved.fullPath
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  const timeoutMs = clampInteger(timeout_ms, DEFAULT_DOWNLOAD_TIMEOUT_MS, 1000, MAX_DOWNLOAD_TIMEOUT_MS)
  const configuredLimit = configuredDownloadLimit()
  const maxBytes = clampInteger(max_bytes, configuredLimit, 1, configuredLimit)
  const tempPath = path.join(path.dirname(destination), `.gugo-download-${process.pid}-${randomBytes(8).toString('hex')}.part`)
  let response = null
  try {
    const opened = await openDownloadResponse(url, { headers, timeoutMs, signal, validateUrl, requestImpl })
    response = opened.response
    const status = Number(response.statusCode || 0)
    if (status < 200 || status >= 300) {
      response.resume?.()
      throw toolError(`下载失败：HTTP ${status}`, 502, 'DOWNLOAD_HTTP_ERROR')
    }
    const declaredLength = Number(response.headers?.['content-length'])
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      response.destroy?.()
      throw toolError(`远程文件超过大小上限 ${maxBytes} 字节`, 413, 'DOWNLOAD_TOO_LARGE')
    }
    const hash = createHash('sha256')
    let bytes = 0
    const file = await fs.promises.open(tempPath, 'wx')
    try {
      for await (const chunk of response) {
        if (signal?.aborted) throw toolError('下载已取消', 499, 'DOWNLOAD_CANCELLED')
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        bytes += buffer.length
        if (bytes > maxBytes) throw toolError(`远程文件超过大小上限 ${maxBytes} 字节`, 413, 'DOWNLOAD_TOO_LARGE')
        hash.update(buffer)
        await file.write(buffer)
      }
    } catch (error) {
      response.destroy?.()
      throw error
    } finally {
      await file.close()
    }
    const digest = hash.digest('hex')
    if (expected && digest !== expected) throw toolError('下载文件 SHA-256 校验失败', 422, 'DOWNLOAD_CHECKSUM_MISMATCH')
    await commitDownloadedFile(tempPath, destination, overwrite === true)
    return {
      ok: true,
      path: resolved.displayPath,
      scope: resolved.source,
      bytes,
      sha256: digest,
      contentType: String(response.headers?.['content-type'] || ''),
      finalUrl: opened.finalUrl,
      changedPaths: [resolved.displayPath],
    }
  } finally {
    response?.destroy?.()
    try { await fs.promises.rm(tempPath, { force: true }) } catch { /* best-effort cleanup */ }
  }
}

export const codingAgentDownloadInternals = {
  commitDownloadedFile,
  requestDownload,
  openDownloadResponse,
}
