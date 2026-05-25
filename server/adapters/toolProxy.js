/**
 * 后端工具代理:把模型 tool_call 在服务端实际执行,返回结果给前端再喂回模型。
 *
 * 为什么放后端:
 *   - 浏览器调 DuckDuckGo / 任意第三方网站会 CORS 失败
 *   - 抓回来的 HTML 要在服务端剥脚本/广告/转 markdown,前端做不便
 *   - 保留对 outbound 请求的速率/超时/UA 控制
 *
 * 当前支持的工具:
 *   - web_search(query, max_results?) 走 DuckDuckGo HTML 端点(无 key) + Bing 兜底
 *   - fetch_url(url) 抓正文 + 转 markdown(jsdom + 朴素正文提取)
 */

import { JSDOM } from 'jsdom'
import https from 'node:https'
import http from 'node:http'
import dns from 'node:dns/promises'
import net from 'node:net'
import { URL as NodeURL } from 'node:url'
import { readJson } from '../utils.js'
import {
  chargeForToolUse,
  getPublicAccount,
  getToolCost,
} from './billingAuth.js'
import { getSessionByToken } from '../db.js'
import { dispatchHooks } from '../hooksService.js'

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

/* ── SSRF 防护:解析目标域名,拒绝任何指向私有 / loopback / link-local / 多播的 IP ── */

// IPv4 私有/特殊段 (RFC 1918 / 6890 等)
function isPrivateV4(ip) {
  // 形如 a.b.c.d
  const m = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (!m) return false
  const a = +m[1], b = +m[2]
  if (a === 10) return true                       // 10.0.0.0/8
  if (a === 127) return true                      // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true         // 169.254.0.0/16 link-local (含 AWS metadata 169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return true// 172.16.0.0/12
  if (a === 192 && b === 168) return true         // 192.168.0.0/16
  if (a === 0) return true                        // 0.0.0.0/8
  if (a >= 224) return true                       // 多播/保留 224+
  if (a === 100 && b >= 64 && b <= 127) return true // 100.64.0.0/10 CGNAT
  return false
}

// IPv6 危险段:::1 / fe80::/10 link-local / fc00::/7 unique-local / ::ffff:<v4-private> mapped
function isPrivateV6(ip) {
  const lower = ip.toLowerCase()
  if (lower === '::' || lower === '::1') return true
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return true   // fe80::/10
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true   // fc00::/7
  if (/^ff[0-9a-f]{2}:/.test(lower)) return true      // ff00::/8 多播
  // ::ffff:a.b.c.d 形式映射 IPv4
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped && isPrivateV4(mapped[1])) return true
  return false
}

export function isUnsafeIp(ip) {
  if (net.isIPv4(ip)) return isPrivateV4(ip)
  if (net.isIPv6(ip)) return isPrivateV6(ip)
  return true // 解析不出来认为不安全
}

export async function assertSafeOutboundUrl(rawUrl) {
  let target
  try { target = new NodeURL(rawUrl) } catch { throw new Error('url 无效') }
  if (!['http:', 'https:'].includes(target.protocol)) throw new Error('仅支持 http/https')
  // URL.hostname 对 IPv6 会保留方括号,要剥掉再交给 net.isIP / dns.lookup
  let host = target.hostname
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  // 主机名形如 IP 时直接判
  if (net.isIP(host)) {
    if (isUnsafeIp(host)) throw new Error('禁止访问内网 / loopback 地址')
    return target
  }
  // 域名:解析所有 A/AAAA,任何一个落在内网都拒绝 (防 DNS rebinding 把外网域名解析到内网)
  let records
  try {
    records = await dns.lookup(host, { all: true, verbatim: true })
  } catch {
    throw new Error('DNS 解析失败')
  }
  if (!records?.length) throw new Error('DNS 无解析结果')
  for (const r of records) {
    if (isUnsafeIp(r.address)) {
      throw new Error(`目标域名解析到内网地址 ${r.address}`)
    }
  }
  return target
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
async function fetchSafe({ url, method = 'GET', headers = {}, body, timeoutMs = 12000, maxRedirects = 3 }) {
  let current = url
  for (let i = 0; i <= maxRedirects; i += 1) {
    const target = await assertSafeOutboundUrl(current)
    // 取第一条解析结果作为 lockedIp (assertSafeOutboundUrl 已经审核所有解析结果)
    let lockedIp = null
    if (!net.isIP(target.hostname)) {
      const records = await dns.lookup(target.hostname, { all: true, verbatim: true })
      lockedIp = records[0]?.address || null
    }
    const resp = await safeRequest({
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
  const id = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown'
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

  // ★ batchF P1: 鉴权 + 估算 + 余额检查.先做这三步再读 body 之外的逻辑,
  //   未登录或余额不足直接拒绝,不消耗后端 outbound 配额.
  const token = authToken(req)
  if (!token) {
    sendJson(res, 401, { ok: false, error: '请先登录后再使用工具' })
    return
  }
  let account
  try {
    account = getPublicAccount({ token })
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
  const cost = getToolCost()
  if ((account?.credits ?? 0) < cost) {
    sendJson(res, 402, {
      ok: false,
      error: `积分不足,工具调用需要 ${cost} 积分,当前余额 ${account?.credits ?? 0}.请先充值.`,
      requiredCredits: cost,
      credits: account?.credits ?? 0,
    })
    return
  }

  const url = req.url || ''
  try {
    const body = await readJson(req)
    let result
    let toolName
    let toolArgs = body
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
      const pre = await dispatchHooks({ userId, event: 'pre_tool_use', tool: toolName, args: toolArgs })
      if (!pre.allow) {
        sendJson(res, 403, { ok: false, error: pre.reason || 'hook 拒绝该工具调用' })
        return
      }
      if (pre.replacementArgs && typeof pre.replacementArgs === 'object') {
        toolArgs = pre.replacementArgs
      }
    }

    if (toolName === 'web_search') {
      result = await searchDuckDuckGo({ query: toolArgs.query, maxResults: toolArgs.maxResults })
    } else {
      result = await fetchAndExtract({ url: toolArgs.url })
    }

    // post_tool_use hook (非阻塞观察)
    if (userId) {
      dispatchHooks({ userId, event: 'post_tool_use', tool: toolName, args: { input: toolArgs, output: result } }).catch((err) => {
        console.warn('[hooks] post_tool_use hook 失败:', err?.message || err)
      })
    }

    // 只有真正成功才扣费;失败不扣,避免 SSRF 探测/上游不稳定还吃用户积分.
    let billing = null
    if (result?.ok !== false) {
      try {
        const charged = chargeForToolUse({ token, toolName, cost })
        billing = {
          creditsCharged: cost,
          credits: charged?.user?.credits ?? null,
        }
      } catch (err) {
        billing = { error: err?.message || '扣费失败' }
      }
    }
    sendJson(res, 200, { ...result, billing })
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
