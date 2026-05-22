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

export function shouldCollapseArtifactPreview(preview) {
  return !!preview
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

export function isHtmlDeckLike(htmlSource = '') {
  const src = String(htmlSource || '')
  if (!src.trim()) return false
  const sectionCount = (src.match(/<section\b/gi) || []).length
  const explicitSlideCount = (src.match(/\bclass\s*=\s*["'][^"']*\bslide\b[^"']*["']/gi) || []).length
  const dataSlideCount = (src.match(/\bdata-slide\s*=/gi) || []).length
  const pageClassCount = (src.match(/\bclass\s*=\s*["'][^"']*\b(?:page|deck-page|presentation-slide|deck-slide)\b[^"']*["']/gi) || []).length
  return explicitSlideCount >= 2 || dataSlideCount >= 2 || sectionCount >= 2 || pageClassCount >= 2
}

const HTML_DECK_ENHANCER_CSS = `
html.yma-deck-active, html.yma-deck-active body {
  margin: 0 !important;
  width: 100% !important;
  height: 100% !important;
  overflow: hidden !important;
}
html.yma-deck-active .slide {
  width: 100vw !important;
  height: 100vh !important;
  min-height: 100vh !important;
  position: relative !important;
  overflow: hidden !important;
}
html.yma-deck-active .slide:not(.active) {
  display: none !important;
  opacity: 0 !important;
  pointer-events: none !important;
}
.yma-deck-controls {
  position: fixed;
  right: 18px;
  bottom: 18px;
  z-index: 2147483647;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid rgba(255,255,255,.22);
  border-radius: 999px;
  color: #fff;
  background: rgba(10,10,14,.58);
  box-shadow: 0 16px 48px rgba(0,0,0,.28);
  backdrop-filter: blur(16px);
  font: 12px/1 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.yma-deck-controls button {
  width: 28px;
  height: 28px;
  border: 0;
  border-radius: 50%;
  color: inherit;
  background: rgba(255,255,255,.16);
  cursor: pointer;
}
.yma-deck-controls button:hover { background: rgba(255,255,255,.26); }
.yma-deck-controls .yma-deck-count { min-width: 54px; text-align: center; opacity: .86; }
`

const HTML_DECK_ENHANCER_SCRIPT = `
;(() => {
  if (window.__ymaDeck?.ready) return;
  const selector = '.slide,[data-slide],section,.page,.deck-page,.deck-slide,.presentation-slide';
  const raw = Array.from(document.querySelectorAll(selector));
  const slides = raw
    .filter((el, index, all) => el && el !== document.body && all.indexOf(el) === index)
    .filter((el, _, all) => !all.some((other) => other !== el && other.contains(el)));
  if (slides.length < 2) return;
  document.documentElement.classList.add('yma-deck-active');
  slides.forEach((slide, index) => {
    slide.classList.add('slide');
    slide.dataset.ymaSlide = String(index + 1);
    if (!slide.querySelector(':scope > .pager')) {
      const pager = document.createElement('div');
      pager.className = 'pager';
      pager.textContent = String(index + 1).padStart(2, '0') + ' / ' + String(slides.length).padStart(2, '0');
      slide.appendChild(pager);
    }
  });
  let current = Math.max(0, slides.findIndex((slide) => slide.classList.contains('active')));
  function render() {
    slides.forEach((slide, index) => {
      const active = index === current;
      slide.classList.toggle('active', active);
      slide.setAttribute('aria-hidden', active ? 'false' : 'true');
      if (active) {
        slide.style.display = '';
        slide.style.opacity = '';
        slide.style.pointerEvents = '';
      }
    });
    const count = document.querySelector('.yma-deck-count');
    if (count) count.textContent = String(current + 1).padStart(2, '0') + ' / ' + String(slides.length).padStart(2, '0');
  }
  function goTo(index) {
    const next = Math.max(0, Math.min(slides.length - 1, Number(index) || 0));
    current = next;
    render();
  }
  const api = {
    ready: true,
    count: slides.length,
    get current() { return current; },
    next: () => goTo(current + 1),
    prev: () => goTo(current - 1),
    goTo,
  };
  window.__ymaDeck = api;
  if (!document.querySelector('.yma-deck-controls')) {
    const controls = document.createElement('div');
    controls.className = 'yma-deck-controls';
    controls.innerHTML = '<button type="button" data-yma-prev aria-label="上一页">‹</button><span class="yma-deck-count"></span><button type="button" data-yma-next aria-label="下一页">›</button>';
    controls.querySelector('[data-yma-prev]').addEventListener('click', api.prev);
    controls.querySelector('[data-yma-next]').addEventListener('click', api.next);
    document.body.appendChild(controls);
  }
  document.addEventListener('keydown', (event) => {
    const key = event.key;
    if (['ArrowRight', 'PageDown', ' '].includes(key)) { event.preventDefault(); api.next(); }
    else if (['ArrowLeft', 'PageUp'].includes(key)) { event.preventDefault(); api.prev(); }
    else if (key === 'Home') { event.preventDefault(); api.goTo(0); }
    else if (key === 'End') { event.preventDefault(); api.goTo(slides.length - 1); }
    else if (/^[1-9]$/.test(key)) { event.preventDefault(); api.goTo(Number(key) - 1); }
  });
  window.addEventListener('message', (event) => {
    const data = event.data || {};
    if (data.type === 'yma-deck-next') api.next();
    if (data.type === 'yma-deck-prev') api.prev();
    if (data.type === 'yma-deck-goto') api.goTo(data.index);
  });
  render();
})();`

function injectBeforeCloseTag(documentHtml, tag, injection) {
  const close = new RegExp(`</${tag}>`, 'i')
  if (close.test(documentHtml)) return documentHtml.replace(close, `${injection}</${tag}>`)
  return `${documentHtml}\n${injection}`
}

export function enhanceHtmlDeckDocument(documentHtml = '') {
  const doc = String(documentHtml || '')
  if (!isHtmlDeckLike(doc) || doc.includes('data-yma-deck-enhancer')) return doc
  const withCss = injectBeforeCloseTag(
    doc,
    'head',
    `<style data-yma-deck-enhancer="style">${HTML_DECK_ENHANCER_CSS}</style>`
  )
  return injectBeforeCloseTag(
    withCss,
    'body',
    `<script data-yma-deck-enhancer="script">${HTML_DECK_ENHANCER_SCRIPT.replace(/<\/script>/gi, '<\\/script>')}</script>`
  )
}

/**
 * 把 HTML 源包装成可放进 iframe srcdoc 的完整文档 — 缺 doctype 时补全。
 */
export function buildHtmlDocument(htmlSource = '') {
  const src = String(htmlSource || '').trim()
  if (/^\s*(?:<!doctype\s+html|<html[\s>])/i.test(src)) return enhanceHtmlDeckDocument(src)
  return enhanceHtmlDeckDocument(`<!doctype html>
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
</html>`)
}

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function stripDangerousMarkup(value = '') {
  return String(value || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/\son\w+\s*=\s*(['"]).*?\1/gi, '')
    .replace(/\s(?:href|src)\s*=\s*(['"])\s*javascript:[\s\S]*?\1/gi, '')
}

export function parseMultiHtmlSource(source = '') {
  if (source && typeof source === 'object') return source
  try {
    const parsed = JSON.parse(String(source || '{}'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return { 'index.html': String(source || '') }
  }
}

export function buildMultiHtmlDocument(source = '') {
  const files = parseMultiHtmlSource(source)
  const index = stripDangerousMarkup(files['index.html'] || '')
  const css = Object.entries(files)
    .filter(([name]) => /\.css$/i.test(name))
    .map(([, content]) => String(content || ''))
    .join('\n\n')
  const js = Object.entries(files)
    .filter(([name]) => /\.js$/i.test(name))
    .map(([, content]) => String(content || '').replace(/<\/script>/gi, '<\\/script>'))
    .join('\n;\n')

  let html = index || '<main id="app"></main>'
  if (css) {
    html = html.includes('</head>')
      ? html.replace('</head>', `<style>${css}</style></head>`)
      : `<style>${css}</style>${html}`
  }
  if (js) {
    html = html.includes('</body>')
      ? html.replace('</body>', `<script>${js}</script></body>`)
      : `${html}<script>${js}</script>`
  }
  return buildHtmlDocument(html)
}

export function buildMermaidDocument(diagram = '', theme = 'default') {
  const safeDiagram = escapeHtml(diagram)
  const safeTheme = ['default', 'neutral', 'dark', 'forest', 'base'].includes(theme) ? theme : 'default'
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
<style>
html,body{margin:0;min-height:100%;background:radial-gradient(circle at top left,#fff7ed,#eef2ff 42%,#f8fafc);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#111827}
.wrap{min-height:100vh;display:grid;place-items:center;padding:32px}
.card{width:min(1080px,100%);border:1px solid rgba(17,24,39,.12);border-radius:24px;background:rgba(255,255,255,.78);box-shadow:0 24px 80px rgba(15,23,42,.14);backdrop-filter:blur(16px);padding:28px;overflow:auto}
</style>
</head>
<body>
<div class="wrap"><div class="card"><pre class="mermaid">${safeDiagram}</pre></div></div>
<script>mermaid.initialize({startOnLoad:true,theme:${JSON.stringify(safeTheme)},securityLevel:'strict'});</script>
</body>
</html>`
}

export function buildChartDocument(configSource = '') {
  const config = (() => {
    try { return typeof configSource === 'string' ? JSON.parse(configSource) : configSource }
    catch { return {} }
  })()
  const safeConfig = JSON.stringify(config).replace(/<\/script>/gi, '<\\/script>')
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
<style>
html,body{margin:0;height:100%;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:linear-gradient(135deg,#0f172a,#312e81 45%,#7c2d12);color:white}
.wrap{height:100%;display:grid;place-items:center;padding:32px;box-sizing:border-box}
.card{width:min(980px,100%);height:min(640px,82vh);padding:28px;border-radius:28px;background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.2);box-shadow:0 30px 90px rgba(0,0,0,.35);backdrop-filter:blur(18px)}
</style>
</head>
<body>
<div class="wrap"><div class="card"><canvas id="chart"></canvas></div></div>
<script>
const config = ${safeConfig};
new Chart(document.getElementById('chart'), config);
</script>
</body>
</html>`
}

export function buildSvgDocument(svgSource = '') {
  const svg = stripDangerousMarkup(svgSource)
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
html,body{margin:0;height:100%;background:conic-gradient(from 180deg at 50% 50%,#fff7ed,#f1f5f9,#eef2ff,#fff7ed);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.wrap{height:100%;display:grid;place-items:center;padding:28px;box-sizing:border-box}
.card{max-width:min(1000px,92vw);max-height:84vh;border-radius:28px;background:rgba(255,255,255,.82);border:1px solid rgba(15,23,42,.12);box-shadow:0 24px 80px rgba(15,23,42,.16);padding:28px;overflow:auto}
svg{max-width:100%;height:auto;display:block}
</style>
</head>
<body><div class="wrap"><div class="card">${svg}</div></div></body>
</html>`
}

export function buildArtifactPreview({ content = '', meta = {} } = {}) {
  // 先按 meta 的显式声明走 (slash 命令路径)
  let resolvedType = ''
  let inferred = false
  let confidence = 1
  if (shouldOfferPptxExport(meta)) resolvedType = 'pptx'
  else if (meta?.artifactType === 'html' || meta?.skillId === 'htmlppt') resolvedType = 'html'
  else if (meta?.artifactType === 'react') resolvedType = 'react'
  else if (['mermaid', 'chart', 'svg', 'html_multi'].includes(meta?.artifactType)) resolvedType = meta.artifactType
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

  if (resolvedType === 'mermaid') {
    const title = (meta.artifactTitle || 'diagram').toString().trim() || 'diagram'
    return {
      ...base,
      type: 'mermaid',
      title,
      label: 'Mermaid',
      filename: buildOfficeFilename(title, 'mmd'),
      summary: `${content.length} characters`,
      html: buildMermaidDocument(content, meta.artifactDescription || 'default'),
      previewable: true,
    }
  }

  if (resolvedType === 'chart') {
    const title = (meta.artifactTitle || 'chart').toString().trim() || 'chart'
    return {
      ...base,
      type: 'chart',
      title,
      label: 'Chart',
      filename: buildOfficeFilename(title, 'json'),
      summary: 'Chart.js preview',
      html: buildChartDocument(content),
      previewable: true,
    }
  }

  if (resolvedType === 'svg') {
    const title = (meta.artifactTitle || 'vector').toString().trim() || 'vector'
    return {
      ...base,
      type: 'svg',
      title,
      label: 'SVG',
      filename: buildOfficeFilename(title, 'svg'),
      summary: `${content.length} characters`,
      html: buildSvgDocument(content),
      previewable: true,
    }
  }

  if (resolvedType === 'html_multi') {
    const title = (meta.artifactTitle || 'html-app').toString().trim() || 'html-app'
    const files = parseMultiHtmlSource(content)
    return {
      ...base,
      type: 'html_multi',
      title,
      label: 'HTML App',
      filename: buildOfficeFilename(title, 'html'),
      summary: `${Object.keys(files).length || 1} files`,
      html: buildMultiHtmlDocument(files),
      previewable: true,
    }
  }

  if (resolvedType === 'pptx') {
    const slides = parseMarkdownSlides(content)
    const title = slides[0]?.title || meta.artifactTitle || 'presentation'
    // ★ 关键修复: 即使 slides 解析为 0（模型输出格式不标准），只要 meta.artifactType
    //   显式声明为 pptx（来自 create_pptx 工具成功调用），仍然创建预览卡片。
    //   否则 artifact 不显示 → 右侧预览不打开 → 用户看到的是原始文本。
    if (!slides.length && meta.artifactType !== 'pptx') return null
    return {
      ...base,
      type: 'pptx',
      title,
      label: 'PowerPoint',
      filename: buildPresentationFilename(title),
      summary: slides.length ? `${slides.length} 页幻灯片` : `${content.length} 字符内容`,
      slides: slides.length ? slides.slice(0, MAX_PREVIEW_SLIDES) : [{ title, body: content.slice(0, 500) }],
      totalCount: slides.length || 1,
      previewable: true,
    }
  }

  if (resolvedType === 'docx') {
    const doc = parseMarkdownDocument(content)
    if (!doc.blocks.length && meta.artifactType !== 'docx') return null
    return {
      ...base,
      type: 'docx',
      title: doc.title || meta.artifactTitle || 'document',
      label: 'Word',
      filename: buildOfficeFilename(doc.title || meta.artifactTitle || 'document', 'docx'),
      summary: doc.blocks.length ? `${doc.blocks.length} 个内容块` : `${content.length} 字符内容`,
      blocks: doc.blocks.length ? doc.blocks.slice(0, MAX_PREVIEW_BLOCKS) : [{ title: '内容', body: content.slice(0, 500) }],
      totalCount: doc.blocks.length || 1,
      previewable: true,
    }
  }

  if (resolvedType === 'xlsx') {
    const rows = parseSpreadsheetRows(content)
    const title = inferSpreadsheetTitle(rows.length ? rows : [], meta.artifactTitle || 'spreadsheet')
    if (!rows.length && meta.artifactType !== 'xlsx') return null
    return {
      ...base,
      type: 'xlsx',
      title,
      label: 'Excel',
      filename: buildOfficeFilename(title, 'xlsx'),
      summary: rows.length ? `${rows.length} 行数据` : `${content.length} 字符内容`,
      rows: rows.length ? rows.slice(0, MAX_PREVIEW_ROWS).map((row) => row.slice(0, MAX_PREVIEW_COLUMNS)) : [['内容', content.slice(0, 200)]],
      totalCount: rows.length || 1,
      totalColumns: rows.length ? Math.max(...rows.map((row) => row.length)) : 1,
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
