import { buildOfficeFilename, parseMarkdownDocument, parseSpreadsheetRows, shouldOfferOfficeExport } from './officeExport.js'
import { buildPresentationFilename, parseMarkdownSlides, shouldOfferPptxExport } from './presentationExport.js'

const MAX_PREVIEW_SLIDES = 12
const MAX_PREVIEW_BLOCKS = 20
const MAX_PREVIEW_ROWS = 18
const MAX_PREVIEW_COLUMNS = 8

function inferSpreadsheetTitle(rows, fallback = 'spreadsheet') {
  return rows[0]?.find((cell) => String(cell || '').trim()) || fallback
}

/**
 * 内容嗅探 — 在没有 /ppt /doc /excel /html 斜杠命令时,根据消息正文自动判别要不要做成"文件卡片"。
 * 优先级: html > pptx > xlsx > docx
 *
 * 返回值: 'html' | 'pptx' | 'xlsx' | 'docx' | null
 */
export function detectArtifactType(content = '') {
  const text = String(content || '')
  if (text.length < 60) return null

  // ── HTML: 完整 html 代码块 或 以 <!doctype html> / <html 开头 ──
  const htmlFence = text.match(/```html\s*\n([\s\S]*?)```/i)
  if (htmlFence && /<\w+[\s>]/.test(htmlFence[1])) return 'html'
  if (/^\s*(?:<!doctype\s+html|<html[\s>])/i.test(text)) return 'html'

  // ── PPTX: 至少 2 张 --- 分隔的幻灯片, 或 ≥3 条 "数字." 大纲 ──
  const dashSlideCount = (text.match(/^\s*---+\s*$/gm) || []).length
  if (dashSlideCount >= 2) {
    const slides = parseMarkdownSlides(text)
    if (slides.length >= 2) return 'pptx'
  }
  const numberedHeads = (text.match(/^(?:#{1,4}\s*)?\d{1,2}[.、]\s+\S/gm) || []).length
  if (numberedHeads >= 3) {
    const slides = parseMarkdownSlides(text)
    if (slides.length >= 3) return 'pptx'
  }

  // ── XLSX: csv 代码块 或 真·markdown 表格 (含分隔行) ──
  if (/```(?:csv|tsv)\s*\n[\s\S]*?```/i.test(text)) return 'xlsx'
  const tableLines = text.split('\n').filter((l) => /^\s*\|.+\|\s*$/.test(l))
  const hasSeparatorRow = text.split('\n').some((l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(l))
  if (tableLines.length >= 2 && hasSeparatorRow) return 'xlsx'

  // ── DOCX: 至少 1 个 markdown 标题 + 一定字数 ──
  const headingCount = (text.match(/^#{1,6}\s+\S/gm) || []).length
  if (headingCount >= 1 && text.length >= 80) {
    const doc = parseMarkdownDocument(text)
    if (doc.blocks.length >= 3) return 'docx'
  }

  return null
}

/**
 * 取出消息里的 HTML 源 — 优先用 ```html``` 代码块, fallback 到整段文本。
 */
export function extractHtmlSource(content = '') {
  const text = String(content || '')
  const fence = text.match(/```html\s*\n([\s\S]*?)```/i)
  if (fence) return fence[1].trim()
  return text.trim()
}

/**
 * 把 HTML 源包装成可放进 iframe srcdoc 的完整文档 — 缺 doctype 时补全。
 */
export function buildHtmlDocument(htmlSource = '') {
  const src = String(htmlSource || '').trim()
  if (/^\s*(?:<!doctype\s+html|<html[\s>])/i.test(src)) return src
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>预览</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:16px;color:#26211C;background:#F8F4EC;line-height:1.6}</style>
</head>
<body>
${src}
</body>
</html>`
}

export function buildArtifactPreview({ content = '', meta = {} } = {}) {
  // 先按 meta 的显式声明走 (slash 命令路径)
  let resolvedType = ''
  if (shouldOfferPptxExport(meta)) resolvedType = 'pptx'
  else {
    const officeType = shouldOfferOfficeExport(meta)
    if (officeType) resolvedType = officeType
  }
  // 没有显式 meta 时, 按内容嗅探 fallback
  if (!resolvedType) resolvedType = detectArtifactType(content) || ''
  if (!resolvedType) return null

  if (resolvedType === 'html') {
    const html = extractHtmlSource(content)
    if (!html) return null
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i) || html.match(/<h1[^>]*>([^<]+)<\/h1>/i)
    const title = (titleMatch?.[1] || meta.artifactTitle || 'preview').trim()
    return {
      type: 'html',
      title,
      label: 'HTML',
      filename: buildOfficeFilename(title, 'html'),
      summary: `${html.length} 字符`,
      html,
      previewable: true,
    }
  }

  if (resolvedType === 'pptx') {
    const slides = parseMarkdownSlides(content)
    if (!slides.length) return null
    const title = slides[0]?.title || meta.artifactTitle || 'presentation'
    return {
      type: 'pptx',
      title,
      label: 'PowerPoint',
      filename: buildPresentationFilename(title),
      summary: `${slides.length} 页幻灯片`,
      slides: slides.slice(0, MAX_PREVIEW_SLIDES),
      totalCount: slides.length,
      previewable: true,
    }
  }

  if (resolvedType === 'docx') {
    const doc = parseMarkdownDocument(content)
    if (!doc.blocks.length) return null
    return {
      type: 'docx',
      title: doc.title,
      label: 'Word',
      filename: buildOfficeFilename(doc.title, 'docx'),
      summary: `${doc.blocks.length} 个内容块`,
      blocks: doc.blocks.slice(0, MAX_PREVIEW_BLOCKS),
      totalCount: doc.blocks.length,
      previewable: true,
    }
  }

  if (resolvedType === 'xlsx') {
    const rows = parseSpreadsheetRows(content)
    if (!rows.length) return null
    const title = inferSpreadsheetTitle(rows, meta.artifactTitle || 'spreadsheet')
    return {
      type: 'xlsx',
      title,
      label: 'Excel',
      filename: buildOfficeFilename(title, 'xlsx'),
      summary: `${rows.length} 行数据`,
      rows: rows.slice(0, MAX_PREVIEW_ROWS).map((row) => row.slice(0, MAX_PREVIEW_COLUMNS)),
      totalCount: rows.length,
      totalColumns: Math.max(...rows.map((row) => row.length)),
      previewable: true,
    }
  }

  return null
}
