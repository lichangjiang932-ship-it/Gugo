/**
 * 后端工具代理:把模型 tool_call 在服务端实际执行,返回结果给前端再喂回模型。
 *
 * 为什么放后端:
 *   - 浏览器调 DuckDuckGo / 任意第三方网站会 CORS 失败
 *   - 抓回来的 HTML 要在服务端剥脚本/广告/转 markdown,前端做不便
 *   - 保留对 outbound 请求的速率/超时/UA 控制
 *
 * 当前支持的工具:
 *   - web_search(query, max_results?) 走当前用户在“联网搜索”中配置的服务
 *   - fetch_url(url) 抓正文 + 转 markdown(jsdom + 朴素正文提取)
 */

import { JSDOM } from 'jsdom'
import https from 'node:https'
import http from 'node:http'
import net from 'node:net'
import { randomUUID } from 'node:crypto'
import { URL as NodeURL } from 'node:url'
import { readJson } from '../utils.js'
import { getPublicAccount } from './authAccount.js'
import { getSessionByToken } from '../db.js'
import { dispatchHooks } from '../services/hooksService.js'
import {
  requestApproval,
  revalidateHookAuthorization,
  revalidateToolPermission,
} from '../services/approvalGate.js'
import { searchWeb } from '../services/webSearchService.js'
import { resolveClientId } from '../utils/loginGuard.js'
import {
  assertSafeOutboundUrl as assertUnifiedOutboundUrl,
  isUnsafeIp as isUnifiedUnsafeIp,
} from '../utils/outboundNetworkGuard.js'

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' }
const SEARCH_TIMEOUT_MS = 12000
const FETCH_TIMEOUT_MS = 15000
const MAX_FETCH_BYTES = 1.5 * 1024 * 1024
const MAX_MARKDOWN_CHARS = 12000

// 简单的搜索结果缓存:DDG 偶尔 503/反爬,缓存 10 分钟可让连续相似查询不爆。
// LRU 大小 64 条,够单用户使用。
const SEARCH_CACHE = new Map()
const SEARCH_CACHE_TTL_MS = 10 * 60 * 1000
const SEARCH_CACHE_MAX = 64

function cacheGet(key) {
  const hit = SEARCH_CACHE.get(key)
  if (!hit) return null
  if (Date.now() - hit.t > SEARCH_CACHE_TTL_MS) { SEARCH_CACHE.delete(key); return null }
  // LRU 触发:重新插入到末尾
  SEARCH_CACHE.delete(key); SEARCH_CACHE.set(key, hit)
  return hit.v
}
function cacheSet(key, value) {
  SEARCH_CACHE.set(key, { v: value, t: Date.now() })
  while (SEARCH_CACHE.size > SEARCH_CACHE_MAX) {
    const firstKey = SEARCH_CACHE.keys().next().value
    SEARCH_CACHE.delete(firstKey)
  }
}

export function isUnsafeIp(ip) {
  return isUnifiedUnsafeIp(ip)
}

export async function assertSafeOutboundUrl(rawUrl) {
  try {
    return await assertUnifiedOutboundUrl(rawUrl)
  } catch (error) {
    const message = {
      OUTBOUND_URL_INVALID: 'url 无效',
      OUTBOUND_PROTOCOL_DENIED: '仅支持 http/https',
      OUTBOUND_CREDENTIALS_DENIED: 'URL 不允许携带用户名或密码',
      OUTBOUND_METADATA_DENIED: '禁止访问云元数据地址',
      OUTBOUND_HOST_INVALID: '目标主机无效',
      OUTBOUND_DNS_FAILED: 'DNS 解析失败',
      OUTBOUND_DNS_EMPTY: 'DNS 无解析结果',
      OUTBOUND_ADDRESS_DENIED: '禁止访问内网 / loopback 地址',
    }[error?.code] || error?.message || '出站 URL 被拒绝'
    const wrapped = new Error(message, { cause: error })
    wrapped.code = error?.code || 'OUTBOUND_DENIED'
    wrapped.retryable = false
    throw wrapped
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, JSON_HEADERS)
  res.end(JSON.stringify(body))
}

/**
 * 用 node:https / node:http 直发请求
 * 用 node:https / node:http 直发请求(node 内置 fetch 会被 DuckDuckGo 反爬识别为 bot 拦截,
 * 回 14kb 的占位页;https module 直发回真正的 25kb 结果页)。
 *
 * lockedIp:可选,指定一个已经解析+审核过的 IP,通过 socket lookup hook 强制 connect 到该 IP,
 * 避免 SSRF DNS rebinding (第二次解析换成内网 IP 的 TOCTOU 攻击)。
 *
 * ★ batchF P2a: 按 protocol 分流到 https / http,默认端口也跟着 protocol 走.
 *   原实现固定 https.request + 默认 443,导致 fetch_url 宣称支持 http/https
 *   但实际只能访问 https 站点.
 */
function safeRequest({ url, method = 'GET', headers = {}, body, timeoutMs = 12000, lockedIp = null }) {
  return new Promise((resolve, reject) => {
    const u = new NodeURL(url)
    const isHttps = u.protocol === 'https:'
    const transport = isHttps ? https : http
    const defaultPort = isHttps ? 443 : 80
    const opts = {
      hostname: u.hostname,
      port: u.port || defaultPort,
      path: u.pathname + u.search,
      method,
      headers: { ...headers },
    }
    if (body) {
      opts.headers['Content-Length'] = Buffer.byteLength(body)
    }
    if (lockedIp) {
      // 用 fake lookup 把 DNS 固定到已审核 IP;TLS 仍按 hostname 校验 (servername=hostname).
      // ★ batchF P2a: node 18+ 的 net.connect 会传 { all: true },回调期待数组而不是单个 (addr,family).
      //   原写法 cb(null, lockedIp, family) 在 all 模式下会让内层 emitLookup 把 lockedIp 当成 array,
      //   从而抛 ERR_INVALID_IP_ADDRESS: undefined.
      const family = net.isIPv6(lockedIp) ? 6 : 4
      opts.lookup = (_h, o, cb) => {
        if (o && o.all) cb(null, [{ address: lockedIp, family }])
        else cb(null, lockedIp, family)
      }
      if (isHttps) opts.servername = u.hostname
    }
    const req = transport.request(opts, (res) => {
      // follow 1 redirect (重定向后会重新走 assertSafeOutboundUrl,所以仍然安全)
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume()
        const next = new NodeURL(res.headers.location, url).toString()
        // 重定向不复用 lockedIp,新 host 要重新解析+审核 — 让上层走 fetchSafe 再调一次
        return resolve({ status: res.statusCode, headers: res.headers, body: '', _redirectTo: next })
      }
      const chunks = []
      let total = 0
      res.on('data', (c) => {
        chunks.push(c)
        total += c.length
        if (total > MAX_FETCH_BYTES * 2) {
          // 防御性截断:就算单页 3MB 我们也只读这么多
          req.destroy(new Error('响应体过大'))
        }
      })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    const t = setTimeout(() => { req.destroy(new Error('请求超时')) }, timeoutMs)
    req.on('close', () => clearTimeout(t))
    if (body) req.write(body)
    req.end()
  })
}

/**
 * 安全外发请求:先解析+审核 URL,再带 lockedIp 直连.
 * 自动跟随最多 3 次重定向(每次重新审核).
 */
export async function fetchSafe({
  url,
  method = 'GET',
  headers = {},
  body,
  timeoutMs = 12000,
  maxRedirects = 3,
  requireHttps = false,
  validateUrl = assertSafeOutboundUrl,
  requestImpl = safeRequest,
}) {
  let current = url
  for (let i = 0; i <= maxRedirects; i += 1) {
    const target = await validateUrl(current)
    if (requireHttps && target.protocol !== 'https:') throw new Error('outbound request requires https')
    // ★ C-P2.2: 复用 assertSafeOutboundUrl 已审核并返回的具体 IP,不再独立解析一次
    //   (消除审核与使用之间的 DNS rebinding 窗口)。
    const lockedIp = net.isIP(target.hostname) ? target.hostname : target.lockedIp || null
    const resp = await requestImpl({
      url: target.toString(),
      method,
      headers: { ...headers, Host: target.host },
      body,
      timeoutMs,
      lockedIp,
    })
    if (resp._redirectTo && i < maxRedirects) {
      current = resp._redirectTo
      continue
    }
    return resp
  }
  throw new Error('重定向次数超限')
}

/* ── web_search via DuckDuckGo HTML, Bing 兜底, LRU 缓存 ── */

function parseDdgHtml(html, limit) {
  const dom = new JSDOM(html)
  const doc = dom.window.document
  const items = []
  const links = doc.querySelectorAll('a.result-link')
  for (const a of links) {
    if (items.length >= limit) break
    let href = a.getAttribute('href') || ''
    try {
      if (href.startsWith('//')) href = 'https:' + href
      const u = new URL(href, 'https://duckduckgo.com')
      const real = u.searchParams.get('uddg')
      if (real) href = decodeURIComponent(real)
    } catch { /* keep raw */ }
    const title = (a.textContent || '').trim()
    let snippet = ''
    const row = a.closest('tr')
    const next = row?.nextElementSibling
    const snippetEl = next?.querySelector?.('.result-snippet') || next?.querySelector?.('td.result-snippet')
    if (snippetEl) snippet = (snippetEl.textContent || '').trim().replace(/\s+/g, ' ')
    if (!title || !href || !href.startsWith('http')) continue
    items.push({ title, url: href, snippet: snippet.slice(0, 280) })
  }
  return items
}

function parseBingHtml(html, limit) {
  const dom = new JSDOM(html)
  const doc = dom.window.document
  const items = []
  for (const li of doc.querySelectorAll('li.b_algo')) {
    if (items.length >= limit) break
    const a = li.querySelector('h2 a')
    if (!a) continue
    const href = a.getAttribute('href') || ''
    const title = (a.textContent || '').trim()
    const snippetEl = li.querySelector('.b_caption p, .b_lineclamp1, .b_lineclamp2, .b_lineclamp3, .b_lineclamp4')
    const snippet = (snippetEl?.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 280)
    if (title && href.startsWith('http')) items.push({ title, url: href, snippet })
  }
  return items
}

async function searchWithDdg(query, limit) {
  const resp = await fetchSafe({
    url: 'https://lite.duckduckgo.com/lite/',
    method: 'POST',
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: `q=${encodeURIComponent(query)}&kl=us-en`,
    timeoutMs: SEARCH_TIMEOUT_MS,
  })
  if (resp.status !== 200) throw new Error(`DDG HTTP ${resp.status}`)
  return parseDdgHtml(resp.body, limit)
}

async function searchWithBing(query, limit) {
  const resp = await fetchSafe({
    url: `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${limit}`,
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      // ★ #28: 加 Referer + Sec-Fetch-* 让请求更像真实浏览器,避免 Bing 反爬给空页
      'Referer': 'https://www.bing.com/',
      'Sec-Fetch-Site': 'same-origin',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1',
    },
    timeoutMs: SEARCH_TIMEOUT_MS,
  })
  if (resp.status !== 200) throw new Error(`Bing HTTP ${resp.status}`)
  return parseBingHtml(resp.body, limit)
}

export async function searchDuckDuckGo({ query, maxResults = 6 }) {
  if (!query || typeof query !== 'string' || !query.trim()) {
    throw new Error('搜索 query 不能为空')
  }
  const q = query.trim()
  const limit = Math.max(1, Math.min(10, Number(maxResults) || 6))
  const cacheKey = `${limit}:${q.toLowerCase()}`
  const cached = cacheGet(cacheKey)
  if (cached) return { ok: true, query: q, results: cached, cached: true }

  let results = []
  let lastErr = null
  // 主路:DDG lite
  try { results = await searchWithDdg(q, limit) }
  catch (e) { lastErr = e }
  // 兜底:Bing (DDG 有时反爬到结果页 0 条)
  if (!results.length) {
    try { results = await searchWithBing(q, limit) }
    catch (e) { lastErr = e }
  }
  if (!results.length) {
    // 两路全挂,缓存空结果 1 分钟避免雪崩,但带 degraded:true 标识
    cacheSet(cacheKey, [])
    return {
      ok: true,
      query: q,
      results: [],
      degraded: true,
      message: `搜索引擎暂时不可用 (${lastErr?.message || '未知'}),已缓存空结果 10 分钟`,
    }
  }
  cacheSet(cacheKey, results)
  return { ok: true, query: q, results }
}

/* ── fetch_url:抓页面 + 朴素正文提取 + 转简化 markdown ── */

function extractMainContent(doc) {
  // 优先级:<article> > <main> > id=content/main > body
  const candidates = [
    ...doc.querySelectorAll('article'),
    ...doc.querySelectorAll('main'),
    doc.querySelector('#content'),
    doc.querySelector('#main'),
    doc.querySelector('.content'),
    doc.querySelector('.post'),
    doc.querySelector('.article'),
    doc.body,
  ].filter(Boolean)
  // 选文本最多的那个
  let best = null
  let bestLen = 0
  for (const node of candidates) {
    const len = (node.textContent || '').replace(/\s+/g, ' ').trim().length
    if (len > bestLen) { best = node; bestLen = len }
  }
  return best || doc.body
}

const MAX_NODE_DEPTH = 128

function nodeToMarkdown(node, depth = 0) {
  if (!node) return ''
  if (depth > MAX_NODE_DEPTH) return ''
  if (node.nodeType === 3) return node.textContent || '' // text
  if (node.nodeType !== 1) return ''
  const tag = node.tagName?.toLowerCase()
  // 过滤:脚本、样式、广告、导航
  if (['script', 'style', 'noscript', 'svg', 'iframe', 'header', 'footer', 'nav', 'aside', 'form'].includes(tag)) return ''
  const cls = (node.getAttribute?.('class') || '').toLowerCase()
  if (/(advert|sidebar|menu|popup|cookie|comment|share|related)/i.test(cls)) return ''

  const inner = [...node.childNodes].map((c) => nodeToMarkdown(c, depth + 1)).join('')
  const trimmed = inner.replace(/\n{3,}/g, '\n\n')

  switch (tag) {
    case 'h1': return `\n\n# ${trimmed.trim()}\n\n`
    case 'h2': return `\n\n## ${trimmed.trim()}\n\n`
    case 'h3': return `\n\n### ${trimmed.trim()}\n\n`
    case 'h4': case 'h5': case 'h6': return `\n\n#### ${trimmed.trim()}\n\n`
    case 'p': return `\n\n${trimmed.trim()}\n\n`
    case 'br': return '\n'
    case 'hr': return '\n\n---\n\n'
    case 'strong': case 'b': return `**${trimmed.trim()}**`
    case 'em': case 'i': return `*${trimmed.trim()}*`
    case 'code':
      if (node.parentElement?.tagName?.toLowerCase() === 'pre') return trimmed
      return `\`${trimmed.trim()}\``
    case 'pre': return `\n\n\`\`\`\n${trimmed.trim()}\n\`\`\`\n\n`
    case 'a': {
      const href = node.getAttribute('href') || ''
      const text = trimmed.trim()
      if (!text) return ''
      if (!href || href.startsWith('javascript:')) return text
      return `[${text}](${href})`
    }
    case 'li': return `\n- ${trimmed.trim()}`
    case 'ul': case 'ol': return `\n\n${trimmed.trim()}\n\n`
    case 'blockquote': return `\n\n> ${trimmed.replace(/\n/g, '\n> ').trim()}\n\n`
    case 'img': {
      const src = node.getAttribute('src') || ''
      const alt = node.getAttribute('alt') || ''
      return src ? `![${alt}](${src})` : ''
    }
    default: return trimmed
  }
}

export async function fetchAndExtract({ url }) {
  if (!url || typeof url !== 'string') throw new Error('url 不能为空')
  // SSRF 防护交给 fetchSafe (DNS 解析 + IP 段审核 + lockedIp 防 rebinding)
  const resp = await fetchSafe({
    url,
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    timeoutMs: FETCH_TIMEOUT_MS,
  })
  if (resp.status !== 200) throw new Error(`HTTP ${resp.status}`)
  const finalUrl = url // fetchSafe 内部已跟随重定向,这里用入参作为展示
  const ct = (resp.headers['content-type'] || '').toString()
  if (!/text\/html|application\/xhtml/.test(ct)) {
    return { ok: true, url: finalUrl, title: finalUrl, markdown: resp.body.slice(0, 4096), contentType: ct }
  }
  let html = resp.body
  if (Buffer.byteLength(html) > MAX_FETCH_BYTES) {
    html = html.slice(0, MAX_FETCH_BYTES)
  }
  const dom = new JSDOM(html, { url: finalUrl })
  const doc = dom.window.document
  const title = doc.querySelector('title')?.textContent?.trim() ||
                doc.querySelector('h1')?.textContent?.trim() ||
                finalUrl
  const main = extractMainContent(doc)
  let md = nodeToMarkdown(main)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  let truncated = false
  if (md.length > MAX_MARKDOWN_CHARS) {
    md = md.slice(0, MAX_MARKDOWN_CHARS) + '\n\n[...内容已截断...]'
    truncated = true
  }
  return { ok: true, url: finalUrl, title: title.slice(0, 200), markdown: md, truncated }
}

/* ── HTTP 路由 ── */

// 简易 in-memory 速率窗口:每个客户端每分钟最多 20 次工具调用
// (避免模型不断 search/fetch 把 outbound 跑爆)
const TOOL_RATE = new Map()
const TOOL_RATE_WINDOW_MS = 60 * 1000
const TOOL_RATE_MAX = Number(process.env.TOOL_RATE_MAX || 20)

function checkToolRate(req) {
  const id = resolveClientId(req)
  const now = Date.now()
  const arr = TOOL_RATE.get(id) || []
  // 剔除窗口外
  const fresh = arr.filter((t) => now - t < TOOL_RATE_WINDOW_MS)
  if (fresh.length >= TOOL_RATE_MAX) {
    return { allowed: false, remaining: 0, resetMs: TOOL_RATE_WINDOW_MS - (now - fresh[0]) }
  }
  fresh.push(now)
  TOOL_RATE.set(id, fresh)
  return { allowed: true, remaining: TOOL_RATE_MAX - fresh.length }
}

// ★ batchF P1: 从 Authorization: Bearer <token> 抽 token,
//   /api/tools/* 不允许匿名调用,前端必须先登录才能用搜索/抓取.
function authToken(req) {
  const auth = req.headers?.authorization || ''
  if (!auth.startsWith('Bearer ')) return ''
  return auth.slice(7).trim()
}

export async function handleToolProxyRequest(req, res) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: '仅支持 POST' })
    return
  }

  // 先鉴权再进入限流和 outbound 工具逻辑。
  const token = authToken(req)
  if (!token) {
    sendJson(res, 401, { ok: false, error: '请先登录后再使用工具' })
    return
  }
  try {
    getPublicAccount({ token })
  } catch {
    sendJson(res, 401, { ok: false, error: '登录已失效,请重新登录' })
    return
  }
  const rate = checkToolRate(req)
  res.setHeader('X-RateLimit-Limit', String(TOOL_RATE_MAX))
  res.setHeader('X-RateLimit-Remaining', String(rate.remaining))
  if (!rate.allowed) {
    sendJson(res, 429, { ok: false, error: `工具调用过于频繁,请 ${Math.ceil(rate.resetMs / 1000)}s 后再试` })
    return
  }
  const url = req.url || ''
  try {
    const body = await readJson(req)
    let result
    let toolName
    let toolArgs = body
    let hookToolCallId = null
    const requestIdHeader = req.headers?.['idempotency-key']
    const hookRequestId = String(
      (Array.isArray(requestIdHeader) ? requestIdHeader[0] : requestIdHeader) || randomUUID(),
    ).trim()
    if (url.startsWith('/api/tools/search')) {
      toolName = 'web_search'
    } else if (url.startsWith('/api/tools/fetch')) {
      toolName = 'fetch_url'
    } else {
      sendJson(res, 404, { ok: false, error: '未知的工具端点' })
      return
    }

    // Feature 7: pre_tool_use hook —  可拒绝或重写 args
    const session = getSessionByToken(token)
    const userId = session?.user_id
    if (userId) {
      const toolCallId = randomUUID()
      hookToolCallId = toolCallId
      const hookScope = {
        userId,
        origin: 'chat',
        jobId: null,
        stepId: null,
        sessionId: null,
        requestId: toolCallId,
        toolCallId,
        toolName,
      }
      const pre = await dispatchHooks({
        userId,
        event: 'pre_tool_use',
        tool: toolName,
        args: toolArgs,
        origin: hookScope.origin,
        jobId: hookScope.jobId,
        stepId: hookScope.stepId,
        sessionId: hookScope.sessionId,
        requestId: hookScope.requestId,
        toolCallId: hookScope.toolCallId,
        hookInvocationId: `${hookRequestId}:pre_tool_use`,
      })
      if (!pre.allow) {
        sendJson(res, 403, { ok: false, error: pre.reason || 'hook 拒绝该工具调用' })
        return
      }
      if (pre.replacementArgs && typeof pre.replacementArgs === 'object') {
        toolArgs = pre.replacementArgs
      }
      const abortController = new AbortController()
      const abort = () => abortController.abort()
      const abortOnClose = () => {
        if (!res.writableEnded) abort()
      }
      if (typeof req.once === 'function') req.once('aborted', abort)
      if (typeof res.once === 'function') res.once('close', abortOnClose)
      let gate
      try {
        gate = await requestApproval({
          userId,
          origin: 'chat',
          toolName,
          args: toolArgs,
          signal: abortController.signal,
          forceApproval: pre.permissionDecision === 'ask',
          forceApprovalReason: pre.reason,
          hookAuthorizationProvenance: pre.hookAuthorizationProvenance || null,
          requestId: hookScope.requestId,
          toolCallId: hookScope.toolCallId,
        })
      } finally {
        if (typeof req.off === 'function') req.off('aborted', abort)
        if (typeof res.off === 'function') res.off('close', abortOnClose)
      }
      if (abortController.signal.aborted || res.destroyed) return
      if (!gate.proceed) {
        sendJson(res, 403, { ok: false, error: gate.reason || '该工具调用未获批准' })
        return
      }
      toolArgs = gate.args ?? toolArgs

      let verifiedHookAuthorization = false
      if (gate.hookAuthorized) {
        const finalHookAuthorization = revalidateHookAuthorization({
          provenance: gate.hookAuthorizationProvenance,
          ...hookScope,
          args: toolArgs,
          requireLive: true,
        })
        if (!finalHookAuthorization.proceed) {
          sendJson(res, 403, {
            ok: false,
            error: finalHookAuthorization.reason || 'Hook 授权已失效',
          })
          return
        }
        verifiedHookAuthorization = true
      }

      // `await requestApproval()` is a scheduling boundary. Re-check the exact
      // policy identity immediately before the outbound effect so a hot swap
      // or uninstall cannot consume an authorization from the old binding.
      const finalPolicy = revalidateToolPermission({
        userId,
        origin: 'chat',
        toolName,
        args: toolArgs,
        expectedPolicyProvenance: gate.policyProvenance,
        allowAsk: Boolean(gate.approvalId || verifiedHookAuthorization),
      })
      if (!finalPolicy.proceed) {
        sendJson(res, 403, { ok: false, error: finalPolicy.reason || '当前策略拒绝该工具调用' })
        return
      }
    }

    if (toolName === 'web_search') {
      result = await searchWeb({
        userId,
        query: toolArgs.query,
        maxResults: toolArgs.max_results ?? toolArgs.maxResults,
      })
    } else {
      result = await fetchAndExtract({ url: toolArgs.url })
    }

    // post_tool_use hook (非阻塞观察)
    if (userId) {
      dispatchHooks({
        userId,
        event: 'post_tool_use',
        tool: toolName,
        args: { input: toolArgs, output: result },
        requestId: hookToolCallId,
        toolCallId: hookToolCallId,
        hookInvocationId: `${hookRequestId}:post_tool_use`,
      }).catch((err) => {
        console.warn('[hooks] post_tool_use hook 失败:', err?.message || err)
      })
    }

    sendJson(res, 200, { ...result })
  } catch (err) {
    // ★ #36: 尊重 readJson 抛的 statusCode (e.g. 413)
    const status = err?.statusCode || 502
    sendJson(res, status, { ok: false, error: err?.message || '工具调用失败' })
  }
}

export function toolProxyPlugin() {
  return {
    name: 'local-tool-proxy',
    configureServer(server) {
      server.middlewares.use('/api/tools/search', handleToolProxyRequest)
      server.middlewares.use('/api/tools/fetch', handleToolProxyRequest)
    },
  }
}
