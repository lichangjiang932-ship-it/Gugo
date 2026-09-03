import { JSDOM } from 'jsdom'

const MAX_NODE_DEPTH = 128
const MAX_MARKDOWN_CHARS = 12000

export function parseDdgHtml(html, limit) {
  const dom = new JSDOM(html)
  const doc = dom.window.document
  const items = []
  const links = doc.querySelectorAll('a.result-link')
  for (const a of links) {
    if (items.length >= limit) break
    let href = a.getAttribute('href') || ''
    try {
      if (href.startsWith('//')) href = `https:${href}`
      const url = new URL(href, 'https://duckduckgo.com')
      const realUrl = url.searchParams.get('uddg')
      if (realUrl) href = decodeURIComponent(realUrl)
    } catch { /* keep raw */ }
    const title = (a.textContent || '').trim()
    const row = a.closest('tr')
    const next = row?.nextElementSibling
    const snippetElement = next?.querySelector?.('.result-snippet')
      || next?.querySelector?.('td.result-snippet')
    const snippet = (snippetElement?.textContent || '').trim().replace(/\s+/g, ' ')
    if (!title || !href.startsWith('http')) continue
    items.push({ title, url: href, snippet: snippet.slice(0, 280) })
  }
  return items
}

export function parseBingHtml(html, limit) {
  const dom = new JSDOM(html)
  const doc = dom.window.document
  const items = []
  for (const item of doc.querySelectorAll('li.b_algo')) {
    if (items.length >= limit) break
    const link = item.querySelector('h2 a')
    if (!link) continue
    const href = link.getAttribute('href') || ''
    const title = (link.textContent || '').trim()
    const snippetElement = item.querySelector('.b_caption p, .b_lineclamp1, .b_lineclamp2, .b_lineclamp3, .b_lineclamp4')
    const snippet = (snippetElement?.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 280)
    if (title && href.startsWith('http')) items.push({ title, url: href, snippet })
  }
  return items
}

function extractMainContent(doc) {
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
  let best = null
  let bestLen = 0
  for (const node of candidates) {
    const len = (node.textContent || '').replace(/\s+/g, ' ').trim().length
    if (len > bestLen) { best = node; bestLen = len }
  }
  return best || doc.body
}

function nodeToMarkdown(node, depth = 0) {
  if (!node || depth > MAX_NODE_DEPTH) return ''
  if (node.nodeType === 3) return node.textContent || ''
  if (node.nodeType !== 1) return ''
  const tag = node.tagName?.toLowerCase()
  if (['script', 'style', 'noscript', 'svg', 'iframe', 'header', 'footer', 'nav', 'aside', 'form'].includes(tag)) return ''
  const cls = (node.getAttribute?.('class') || '').toLowerCase()
  if (/(advert|sidebar|menu|popup|cookie|comment|share|related)/i.test(cls)) return ''

  const inner = [...node.childNodes].map((child) => nodeToMarkdown(child, depth + 1)).join('')
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

export function extractHtmlToMarkdown({ html, url }) {
  const dom = new JSDOM(html, { url })
  const doc = dom.window.document
  const title = doc.querySelector('title')?.textContent?.trim()
    || doc.querySelector('h1')?.textContent?.trim()
    || url
  const main = extractMainContent(doc)
  let markdown = nodeToMarkdown(main)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  let truncated = false
  if (markdown.length > MAX_MARKDOWN_CHARS) {
    markdown = `${markdown.slice(0, MAX_MARKDOWN_CHARS)}\n\n[...内容已截断...]`
    truncated = true
  }
  return { ok: true, url, title: title.slice(0, 200), markdown, truncated }
}
