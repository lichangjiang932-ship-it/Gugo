/**
 * pptxParse · 把 .pptx (zip) 拆成每页文字摘要.
 *
 * 不渲染版式 / 图形 / 主题色 —— P2 范围内只抽 <a:t> 文本,
 * 让 ArtifactPane 能展示 "第 N 页标题 + 前两行正文" 的文字摘要卡.
 *
 * 同构: 前端 (JSZip + DOMParser) 与后端 (JSZip + 字符串正则)
 * 都能用. 这里走纯字符串路径, 不依赖 DOMParser, Node 也能跑.
 *
 * 安全:
 *   - 输入 ArrayBuffer / Buffer, 强制 size 上限 (默认 50MB)
 *   - JSZip 解包后只读 ppt/slides/slide*.xml, 不展开其他条目
 *   - 任意 XML 异常一律降级为 "无法解析的页", 不抛
 */

import JSZip from 'jszip'

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024
const SLIDE_RE = /^ppt\/slides\/slide(\d+)\.xml$/

// 去 XML 标签 + 实体解码 (够用就行)
function decodeEntities(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n)
      return Number.isFinite(code) ? String.fromCodePoint(code) : ''
    })
}

/**
 * 从 slide XML 抽出有序的 <a:t> 文本片段, 每段一行.
 * 同一个 <a:p> 内的多个 <a:t> 合并为一行 (PPT 文本框语义).
 */
export function extractSlideTexts(slideXml) {
  if (typeof slideXml !== 'string' || !slideXml) return []
  const paragraphs = []
  // 按 <a:p> 切段; 在每段内拿所有 <a:t>...</a:t>
  const pSplit = slideXml.split(/<a:p\b[^>]*>/)
  for (let i = 1; i < pSplit.length; i++) {
    const block = pSplit[i].split('</a:p>')[0] || ''
    const runs = []
    const tRe = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g
    for (let m; (m = tRe.exec(block)); ) {
      runs.push(decodeEntities(m[1]))
    }
    const line = runs.join('').trim()
    if (line) paragraphs.push(line)
  }
  return paragraphs
}

/**
 * 主入口: 解析 .pptx 二进制 → [{idx, title, lines, lineCount}]
 *
 * @param {Uint8Array|ArrayBuffer|Buffer} data
 * @param {{maxBytes?: number}} opts
 */
export async function parsePptx(data, opts = {}) {
  const maxBytes = Number(opts.maxBytes) || DEFAULT_MAX_BYTES
  const size = data?.byteLength ?? data?.length ?? 0
  if (!size) throw new Error('empty pptx data')
  if (size > maxBytes) {
    const mb = (size / 1024 / 1024).toFixed(1)
    throw new Error(`pptx too large: ${mb} MB exceeds limit`)
  }
  let zip
  try {
    zip = await JSZip.loadAsync(data)
  } catch {
    throw new Error('not a valid pptx (zip parse failed)')
  }

  // 收集 slide*.xml 按编号排序
  const entries = []
  zip.forEach((relPath, entry) => {
    const m = SLIDE_RE.exec(relPath)
    if (m) entries.push({ idx: Number(m[1]), entry })
  })
  if (!entries.length) throw new Error('no slides found in pptx')
  entries.sort((a, b) => a.idx - b.idx)

  const slides = []
  for (const { idx, entry } of entries) {
    let lines
    try {
      const xml = await entry.async('string')
      lines = extractSlideTexts(xml)
    } catch {
      lines = []
    }
    const title = lines[0] || `第 ${idx} 页`
    slides.push({
      idx,
      title,
      lines,
      lineCount: lines.length,
    })
  }
  return slides
}
