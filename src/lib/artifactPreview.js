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
 * ★ batchF P2b: 嗅探阈值之前太激进 — 3 个编号小节就当 PPT,
 *   2 行 markdown 表格就当 Excel,普通问答里常见的对比表/步骤清单全被误判.
 *   现在统一抬高门槛,并且 ChatMessages 不再用卡片替代正文 — 卡片只作为
 *   辅助 CTA 出现,用户始终能看到完整答案.
 *
 * ★ batchG G4: 同时返回 confidence (0..1).调用方可用阈值筛掉低置信度命中.
 *   返回旧形式 (字符串) 由 detectArtifactType 兼容,新接口走 detectArtifactWithConfidence.
 *
 * 返回值: 'html' | 'pptx' | 'xlsx' | 'docx' | null
 */
export function detectArtifactWithConfidence(content = '') {
  const text = String(content || '')
  if (text.length < 60) return { type: null, confidence: 0 }

  // ── HTML: 完整 html 代码块 或 以 <!doctype html> / <html 开头 ──
  const htmlFence = text.match(/```html\s*\n([\s\S]*?)```/i)
  if (htmlFence && /<\w+[\s>]/.test(htmlFence[1])) return { type: 'html', confidence: 0.95 }
  if (/^\s*(?:<!doctype\s+html|<html[\s>])/i.test(text)) return { type: 'html', confidence: 0.95 }

  // ── PPTX: 至少 3 张 --- 分隔的幻灯片, 或 ≥6 条 "数字." 大纲 ──
  const dashSlideCount = (text.match(/^\s*---+\s*$/gm) || []).length
  if (dashSlideCount >= 3) {
    const slides = parseMarkdownSlides(text)
    if (slides.length >= 3) {
      const conf = Math.min(0.95, 0.6 + slides.length * 0.05)
      return { type: 'pptx', confidence: conf }
    }
  }
  const numberedHeads = (text.match(/^(?:#{1,4}\s*)?\d{1,2}[.、]\s+\S/gm) || []).length
  if (numberedHeads >= 6) {
    const slides = parseMarkdownSlides(text)
    if (slides.length >= 6) {
      const conf = Math.min(0.85, 0.55 + slides.length * 0.04)
      return { type: 'pptx', confidence: conf }
    }
  }

  // ── XLSX: csv 代码块 或 真·markdown 表格 (含分隔行 + ≥4 数据行) ──
  if (/```(?:csv|tsv)\s*\n[\s\S]*?```/i.test(text)) return { type: 'xlsx', confidence: 0.9 }
  const tableLines = text.split('\n').filter((l) => /^\s*\|.+\|\s*$/.test(l))
  const hasSeparatorRow = text.split('\n').some((l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(l))
  if (tableLines.length >= 6 && hasSeparatorRow) {
    const conf = Math.min(0.9, 0.6 + tableLines.length * 0.03)
    return { type: 'xlsx', confidence: conf }
  }

  // ── DOCX: 至少 3 个 markdown 标题 + 一定字数 ──
  const headingCount = (text.match(/^#{1,6}\s+\S/gm) || []).length
  if (headingCount >= 3 && text.length >= 400) {
    const doc = parseMarkdownDocument(text)
    if (doc.blocks.length >= 5) {
      const conf = Math.min(0.85, 0.5 + headingCount * 0.05 + Math.min(0.2, text.length / 4000))
      return { type: 'docx', confidence: conf }
    }
  }

  return { type: null, confidence: 0 }
}

// 阈值低于该值的嗅探结果不会触发自动右栏弹出.
// 用户主动点击 artifact 卡片仍然能预览 — 只是不会无邀请弹出来打扰.
export const ARTIFACT_AUTO_OPEN_CONFIDENCE = 0.7

export function detectArtifactType(content = '') {
  return detectArtifactWithConfidence(content).type
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
  let inferred = false
  let confidence = 1
  if (shouldOfferPptxExport(meta)) resolvedType = 'pptx'
  else if (meta?.artifactType === 'react') resolvedType = 'react'
  else {
    const officeType = shouldOfferOfficeExport(meta)
    if (officeType) resolvedType = officeType
  }
  // 没有显式 meta 时, 按内容嗅探 fallback
  // ★ batchF P2b: 嗅探出来的 artifact 不再替代正文,只在正文下追加一个
  //   "在右侧打开预览" CTA;通过返回 inferred:true 让 ChatMessages 区分.
  // ★ batchG G4: 同时返回置信度,UI 可只对 ≥ ARTIFACT_AUTO_OPEN_CONFIDENCE 的命中弹右栏.
  if (!resolvedType) {
    const probe = detectArtifactWithConfidence(content)
    if (probe.type) {
      resolvedType = probe.type
      inferred = true
      confidence = probe.confidence
    }
  }
  if (!resolvedType) return null

  const base = { inferred, confidence }

  if (resolvedType === 'html') {
    const html = extractHtmlSource(content)
    if (!html) return null
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i) || html.match(/<h1[^>]*>([^<]+)<\/h1>/i)
    const title = (titleMatch?.[1] || meta.artifactTitle || 'preview').trim()
    return {
      ...base,
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
      ...base,
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
      ...base,
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
      ...base,
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

  if (resolvedType === 'react') {
    // ★ batchH H1: React 沙箱 — 源就是单文件组件代码,在 RightPreviewPane
    //   里用 iframe + babel-standalone 实时编译并渲染.
    const title = (meta.artifactTitle || 'react-component').toString().trim() || 'react-component'
    const description = meta.artifactDescription ? String(meta.artifactDescription).trim() : ''
    return {
      ...base,
      type: 'react',
      title,
      label: 'React',
      filename: buildOfficeFilename(title, 'jsx'),
      summary: description || `${content.length} 字符组件`,
      description,
      previewable: true,
    }
  }

  return null
}
