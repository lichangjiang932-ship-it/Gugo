/**
 * 后端工具代理:把模型 tool_call 在服务端实际执行,返回结果给前端再喂回模型。
 *
 * 为什么放后端:
 *   - 浏览器调 DuckDuckGo / 任意第三方网站会 CORS 失败
 *   - 抓回来的 HTML 要在服务端剥脚本/广告/转 markdown,前端做不便
 *   - 保留对 outbound 请求的速率/超时/UA 控制
 *
 * 当前支持的工具:
 *   - web_search(query, max_results?) 走 DuckDuckGo HTML 端点(无 key)
 *   - fetch_url(url) 抓正文 + 转 markdown(jsdom + 朴素正文提取)
 */

import { JSDOM } from 'jsdom'
import https from 'node:https'
import { URL as NodeURL } from 'node:url'

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' }
const UA = 'Mozilla/5.0 (X11; Linux x86_64; Your-Model-Atelier) AppleWebKit/537.36'
const SEARCH_TIMEOUT_MS = 12000
const FETCH_TIMEOUT_MS = 15000
const MAX_FETCH_BYTES = 1.5 * 1024 * 1024
const MAX_MARKDOWN_CHARS = 12000

function sendJson(res, status, body) {
  res.writeHead(status, JSON_HEADERS)
  res.end(JSON.stringify(body))
}

async function readJson(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw.trim()) return {}
  return JSON.parse(raw)
}

function withTimeout(ms) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), ms)
  return { signal: ctrl.signal, cancel: () => clearTimeout(t) }
}

/**
 * 用 node:https 直发请求(node 内置 fetch 会被 DuckDuckGo 反爬识别为 bot 拦截,
 * 回 14kb 的占位页;https module 直发回真正的 25kb 结果页)。
 */
function httpsRequest({ url, method = 'GET', headers = {}, body, timeoutMs = 12000 }) {
  return new Promise((resolve, reject) => {
    const u = new NodeURL(url)
    const opts = {
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method,
      headers: { ...headers },
    }
    if (body) {
      opts.headers['Content-Length'] = Buffer.byteLength(body)
    }
    const req = https.request(opts, (res) => {
      // follow 1 redirect
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume()
        const next = new NodeURL(res.headers.location, url).toString()
        return resolve(httpsRequest({ url: next, method, headers, body, timeoutMs }))
      }
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    const t = setTimeout(() => { req.destroy(new Error('请求超时')) }, timeoutMs)
    req.on('close', () => clearTimeout(t))
    if (body) req.write(body)
    req.end()
  })
}

/* ── web_search via DuckDuckGo HTML ── */

export async function searchDuckDuckGo({ query, maxResults = 6 }) {
  if (!query || typeof query !== 'string' || !query.trim()) {
    throw new Error('搜索 query 不能为空')
  }
  const limit = Math.max(1, Math.min(10, Number(maxResults) || 6))
  // 走 node:https 而不是 fetch — node 的 fetch 会被 DDG 反爬识别成 bot
  const resp = await httpsRequest({
    url: 'https://lite.duckduckgo.com/lite/',
    method: 'POST',
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: `q=${encodeURIComponent(query.trim())}&kl=us-en`,
    timeoutMs: SEARCH_TIMEOUT_MS,
  })
  if (resp.status !== 200) {
    throw new Error(`DuckDuckGo HTTP ${resp.status}`)
  }
  const html = resp.body
  const dom = new JSDOM(html)
  const doc = dom.window.document
  const items = []
  // lite 端点结构:<a class='result-link'> 列表,后续 td.result-snippet
  const links = doc.querySelectorAll('a.result-link')
  for (const a of links) {
    if (items.length >= limit) break
    let href = a.getAttribute('href') || ''
    try {
      if (href.startsWith('//')) href = 'https:' + href
      const u = new URL(href, 'https://duckduckgo.com')
      const real = u.searchParams.get('uddg')
      if (real) href = decodeURIComponent(real)
    } catch {
      // 保留原样
    }
    const title = (a.textContent || '').trim()
    let snippet = ''
    const row = a.closest('tr')
    const next = row?.nextElementSibling
    const snippetEl = next?.querySelector?.('.result-snippet') || next?.querySelector?.('td.result-snippet')
    if (snippetEl) snippet = (snippetEl.textContent || '').trim().replace(/\s+/g, ' ')
    if (!title || !href || !href.startsWith('http')) continue
    items.push({ title, url: href, snippet: snippet.slice(0, 280) })
  }
  return { ok: true, query, results: items }
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

function nodeToMarkdown(node, depth = 0) {
  if (!node) return ''
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
  let target
  try { target = new URL(url) } catch { throw new Error('url 无效') }
  if (!['http:', 'https:'].includes(target.protocol)) throw new Error('仅支持 http/https')
  // 防 SSRF:禁止内网/loopback
  const host = target.hostname
  if (
    host === 'localhost' ||
    host.startsWith('127.') ||
    host.startsWith('10.') ||
    host.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host === '::1'
  ) {
    throw new Error('禁止访问内网地址')
  }

  const resp = await httpsRequest({
    url: target.toString(),
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    timeoutMs: FETCH_TIMEOUT_MS,
  })
  if (resp.status !== 200) throw new Error(`HTTP ${resp.status}`)
  const ct = (resp.headers['content-type'] || '').toString()
  if (!/text\/html|application\/xhtml/.test(ct)) {
    return { ok: true, url: target.toString(), title: target.toString(), markdown: resp.body.slice(0, 4096), contentType: ct }
  }
  let html = resp.body
  if (Buffer.byteLength(html) > MAX_FETCH_BYTES) {
    html = html.slice(0, MAX_FETCH_BYTES)
  }
  const dom = new JSDOM(html, { url: target.toString() })
  const doc = dom.window.document
  const title = doc.querySelector('title')?.textContent?.trim() ||
                doc.querySelector('h1')?.textContent?.trim() ||
                target.toString()
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
  return { ok: true, url: target.toString(), title: title.slice(0, 200), markdown: md, truncated }
}

/* ── HTTP 路由 ── */

export async function handleToolProxyRequest(req, res) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: '仅支持 POST' })
    return
  }
  const url = req.url || ''
  try {
    const body = await readJson(req)
    if (url.startsWith('/api/tools/search')) {
      const result = await searchDuckDuckGo({ query: body.query, maxResults: body.maxResults })
      sendJson(res, 200, result)
      return
    }
    if (url.startsWith('/api/tools/fetch')) {
      const result = await fetchAndExtract({ url: body.url })
      sendJson(res, 200, result)
      return
    }
    sendJson(res, 404, { ok: false, error: '未知的工具端点' })
  } catch (err) {
    sendJson(res, 502, { ok: false, error: err?.message || '工具调用失败' })
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
