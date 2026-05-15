const MAX_BULLETS_PER_SLIDE = 8
const MAX_BULLET_LENGTH = 150
const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'

const SLIDE_W = 13.333
const SLIDE_H = 7.5

const THEME = {
  paper: 'F4EFE5',
  paper2: 'EAE2D2',
  ink: '2A1F17',
  inkSoft: '5E4F40',
  inkFade: '8A7B68',
  ember: 'E86A3C',
  cyan: '2E8FA3',
  white: 'FFFFFF',
  skeleton: 'DBD2BE',
}

function stripMarkdownFence(markdown = '') {
  return String(markdown)
    .replace(/\r\n/g, '\n')
    .replace(/^```(?:markdown|md)?\s*/i, '')
    .replace(/\n```\s*$/i, '')
    .trim()
}

function cleanTitle(line = '') {
  return line
    .replace(/^#{1,6}\s*/, '')
    .replace(/^\d{1,2}[.、]\s*/, '')
    .replace(/^第[一二三四五六七八九十\d]+页[：:、.]?\s*/, '')
    .replace(/^[-*+]\s*/, '')
    .trim()
}

function cleanBullet(line = '') {
  return line
    .replace(/^#{1,6}\s*/, '')
    .replace(/^[-*+]\s*/, '')
    .replace(/^\d{1,2}[.、]\s*/, '')
    .replace(/\*\*/g, '')
    .trim()
}

function chunkToSlide(lines) {
  const cleaned = lines.map((line) => line.trim()).filter(Boolean)
  if (!cleaned.length) return null

  const title = cleanTitle(cleaned[0]) || '未命名页面'
  const rest = cleaned.slice(1)

  const images = []
  const bullets = []

  for (const line of rest) {
    const imgMatch = line.match(/^!\[(.*?)\]\((.*?)\)/)
    if (imgMatch) {
      images.push({ alt: imgMatch[1], src: imgMatch[2] })
      continue
    }
    const cleanedBullet = cleanBullet(line)
    if (cleanedBullet && cleanedBullet !== '---' && !/^目录$/.test(cleanedBullet)) {
      bullets.push(cleanedBullet)
    }
  }

  return {
    title,
    bullets: bullets.slice(0, MAX_BULLETS_PER_SLIDE).map((line) =>
      line.length > MAX_BULLET_LENGTH ? `${line.slice(0, MAX_BULLET_LENGTH)}...` : line
    ),
    images,
  }
}

function parseSeparatedSlides(markdown) {
  return markdown
    .split(/^\s*---+\s*$/m)
    .map((part) => chunkToSlide(part.split('\n')))
    .filter(Boolean)
}

function parseNumberedOutline(markdown) {
  const lines = markdown.split('\n')
  const slides = []
  let preface = []
  let current = null

  const pushCurrent = () => {
    if (current) {
      const slide = chunkToSlide([current.title, ...current.lines])
      if (slide) slides.push(slide)
      current = null
    }
  }

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue
    const numbered = line.match(/^(?:#{1,4}\s*)?(\d{1,2})[.、]\s+(.+)$/)
    if (numbered) {
      if (!current && preface.length) {
        const titleSlide = chunkToSlide(preface.filter((item) => !/^\d{1,2}[.、]/.test(item)))
        if (titleSlide) slides.push(titleSlide)
        preface = []
      }
      pushCurrent()
      current = { title: numbered[2].trim(), lines: [] }
      continue
    }
    if (current) current.lines.push(line)
    else preface.push(line)
  }

  pushCurrent()

  if (!slides.length && preface.length) {
    const slide = chunkToSlide(preface)
    if (slide) slides.push(slide)
  }

  return slides
}

export function parseMarkdownSlides(markdown) {
  const clean = stripMarkdownFence(markdown)
  if (!clean) return []
  const separatedSlides = parseSeparatedSlides(clean)
  if (separatedSlides.length > 1) return separatedSlides
  return parseNumberedOutline(clean)
}

export function shouldOfferPptxExport({ skillId, artifactType } = {}) {
  return skillId === 'ppt' || artifactType === 'pptx'
}

export function buildPresentationFilename(title = 'presentation') {
  const base = String(title)
    .replace(/\.pptx$/i, '')
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)
  return `${base || 'presentation'}.pptx`
}

/* ── Slide type inference ── */

function inferSlideType(slide, index) {
  const title = slide.title || ''
  const bullets = slide.bullets || []

  if (index === 0 && bullets.length <= 2) return 'cover'
  if (/目录|内容概览|大纲|Agenda/i.test(title)) return 'toc'
  if (/感谢|Q&A|问答|总结|结语|结束|Thank/i.test(title)) return 'end'
  if (slide.images && slide.images.length > 0) return 'image'
  return 'content'
}

/* ── Page number helper ── */

function addPageNumber(slide, index, total) {
  const num = String(index + 1).padStart(2, '0')
  const totalStr = String(total).padStart(2, '0')
  slide.addText(`${num} / ${totalStr}`, {
    x: 11.2,
    y: 7.05,
    w: 1.5,
    h: 0.22,
    fontSize: 9,
    color: THEME.inkFade,
    align: 'right',
    margin: 0,
  })
}

/* ── Layout builders ── */

function addCoverSlide(pptx, slideData, index, total) {
  const slide = pptx.addSlide()

  // 渐变背景（用全页矩形实现）
  slide.addShape(pptx.ShapeType.rect, {
    x: 0,
    y: 0,
    w: SLIDE_W,
    h: SLIDE_H,
    fill: {
      type: 'gradient',
      angle: 135,
      stops: [
        { color: THEME.paper, position: 0 },
        { color: THEME.paper2, position: 100 },
      ],
    },
    line: { color: THEME.paper, width: 0 },
  })

  // 顶部粗色条
  slide.addShape(pptx.ShapeType.rect, {
    x: 0,
    y: 0,
    w: SLIDE_W,
    h: 0.35,
    fill: { color: THEME.ember },
    line: { color: THEME.ember, width: 0 },
  })

  // 右上角大圆形装饰
  slide.addShape(pptx.ShapeType.ellipse, {
    x: 10.2,
    y: -1.8,
    w: 4.8,
    h: 4.8,
    fill: { color: THEME.ember, transparency: 85 },
    line: { color: THEME.ember, width: 0 },
  })

  // 左下角小圆装饰
  slide.addShape(pptx.ShapeType.ellipse, {
    x: -0.9,
    y: 5.3,
    w: 2.8,
    h: 2.8,
    fill: { color: THEME.cyan, transparency: 88 },
    line: { color: THEME.cyan, width: 0 },
  })

  // 主标题
  slide.addText(slideData.title, {
    x: 1,
    y: 2.2,
    w: 11.3,
    h: 1.2,
    fontFace: 'Aptos Display',
    fontSize: 44,
    bold: true,
    color: THEME.ink,
    align: 'center',
    margin: 0,
  })

  // 副标题（取 bullets 第一行）
  if (slideData.bullets.length > 0) {
    slide.addText(slideData.bullets[0], {
      x: 1,
      y: 3.6,
      w: 11.3,
      h: 0.6,
      fontFace: 'Aptos',
      fontSize: 20,
      color: THEME.inkSoft,
      align: 'center',
      margin: 0,
    })
  }

  // 日期
  slide.addText(new Date().toLocaleDateString('zh-CN'), {
    x: 1,
    y: 4.4,
    w: 11.3,
    h: 0.4,
    fontFace: 'Aptos',
    fontSize: 12,
    color: THEME.inkFade,
    align: 'center',
    margin: 0,
  })

  // 底部装饰线
  slide.addShape(pptx.ShapeType.line, {
    x: 5.5,
    y: 6.8,
    w: 2.333,
    h: 0,
    line: { color: THEME.ember, width: 2 },
  })

  addPageNumber(slide, index, total)
}

function addTocSlide(pptx, slideData, index, total) {
  const slide = pptx.addSlide()
  slide.background = { color: THEME.paper }

  // 左侧大色块
  slide.addShape(pptx.ShapeType.rect, {
    x: 0,
    y: 0,
    w: 3.6,
    h: SLIDE_H,
    fill: { color: THEME.cyan },
    line: { color: THEME.cyan, width: 0 },
  })

  // 目录标题
  slide.addText('目录', {
    x: 0.5,
    y: 2.8,
    w: 2.6,
    h: 1,
    fontFace: 'Aptos Display',
    fontSize: 32,
    bold: true,
    color: THEME.white,
    margin: 0,
  })
  slide.addText('CONTENTS', {
    x: 0.5,
    y: 3.6,
    w: 2.6,
    h: 0.4,
    fontFace: 'Aptos',
    fontSize: 11,
    color: 'B8D4DB',
    margin: 0,
  })

  // 右侧条目
  slideData.bullets.forEach((bullet, i) => {
    const yBase = 1.2 + i * 0.85
    slide.addText(String(i + 1).padStart(2, '0'), {
      x: 4.2,
      y: yBase,
      w: 0.8,
      h: 0.4,
      fontFace: 'Aptos Display',
      fontSize: 22,
      bold: true,
      color: THEME.ember,
      margin: 0,
    })
    slide.addText(bullet, {
      x: 5.1,
      y: yBase + 0.05,
      w: 7.5,
      h: 0.5,
      fontFace: 'Aptos',
      fontSize: 18,
      color: THEME.ink,
      margin: 0,
    })
    if (i < slideData.bullets.length - 1) {
      slide.addShape(pptx.ShapeType.line, {
        x: 5.1,
        y: yBase + 0.65,
        w: 7.5,
        h: 0,
        line: { color: THEME.skeleton, width: 0.5 },
      })
    }
  })

  addPageNumber(slide, index, total)
}

function addContentSlide(pptx, slideData, index, total) {
  const slide = pptx.addSlide()
  const accentColor = index % 2 === 0 ? THEME.ember : THEME.cyan

  slide.background = { color: THEME.paper }

  // 左侧细竖条
  slide.addShape(pptx.ShapeType.rect, {
    x: 0,
    y: 0,
    w: 0.12,
    h: SLIDE_H,
    fill: { color: accentColor },
    line: { color: accentColor, width: 0 },
  })

  // 标题
  slide.addText(slideData.title, {
    x: 0.7,
    y: 0.5,
    w: 11.8,
    h: 0.7,
    fontFace: 'Aptos Display',
    fontSize: 30,
    bold: true,
    color: THEME.ink,
    margin: 0,
  })

  // 标题下细线
  slide.addShape(pptx.ShapeType.line, {
    x: 0.7,
    y: 1.15,
    w: 2,
    h: 0,
    line: { color: accentColor, width: 2.5 },
  })

  // bullets
  if (slideData.bullets.length) {
    slide.addText(
      slideData.bullets.map((bullet) => ({
        text: bullet,
        options: { bullet: { type: 'bullet' }, breakLine: true, paraSpaceAfterPt: 10 },
      })),
      {
        x: 0.95,
        y: 1.5,
        w: 11.35,
        h: 5.2,
        fontFace: 'Aptos',
        fontSize: 18,
        color: THEME.inkSoft,
        breakLine: false,
        fit: 'shrink',
      }
    )
  }

  // 底部装饰线
  slide.addShape(pptx.ShapeType.line, {
    x: 0.7,
    y: 6.9,
    w: 12,
    h: 0,
    line: { color: THEME.skeleton, width: 0.5 },
  })

  addPageNumber(slide, index, total)
}

function addImageSlide(pptx, slideData, index, total) {
  const slide = pptx.addSlide()

  slide.background = { color: THEME.paper }

  // 标题
  slide.addText(slideData.title, {
    x: 0.7,
    y: 0.5,
    w: 11.8,
    h: 0.7,
    fontFace: 'Aptos Display',
    fontSize: 30,
    bold: true,
    color: THEME.ink,
    margin: 0,
  })

  // 标题下细线
  slide.addShape(pptx.ShapeType.line, {
    x: 0.7,
    y: 1.15,
    w: 2,
    h: 0,
    line: { color: THEME.ember, width: 2.5 },
  })

  // 左侧文字区
  if (slideData.bullets.length) {
    slide.addText(
      slideData.bullets.map((bullet) => ({
        text: bullet,
        options: { bullet: { type: 'bullet' }, breakLine: true, paraSpaceAfterPt: 8 },
      })),
      {
        x: 0.95,
        y: 1.5,
        w: 6.5,
        h: 5.2,
        fontFace: 'Aptos',
        fontSize: 17,
        color: THEME.inkSoft,
        breakLine: false,
        fit: 'shrink',
      }
    )
  }

  // 右侧图片建议区
  const imgX = 7.8
  const imgY = 1.5
  const imgW = 4.8
  const imgH = 4.5

  slide.addShape(pptx.ShapeType.rect, {
    x: imgX,
    y: imgY,
    w: imgW,
    h: imgH,
    fill: { color: 'F8F4EC' },
    line: { color: 'C9BFA8', width: 1.5, dashType: 'dash' },
  })

  const imgAlt = slideData.images?.[0]?.alt || '配图建议'
  slide.addText(`[ ${imgAlt} ]`, {
    x: imgX,
    y: imgY + imgH / 2 - 0.3,
    w: imgW,
    h: 0.6,
    fontFace: 'Aptos',
    fontSize: 14,
    color: THEME.inkFade,
    align: 'center',
    valign: 'middle',
    margin: 0,
  })

  // 底部装饰线
  slide.addShape(pptx.ShapeType.line, {
    x: 0.7,
    y: 6.9,
    w: 12,
    h: 0,
    line: { color: THEME.skeleton, width: 0.5 },
  })

  addPageNumber(slide, index, total)
}

function addEndSlide(pptx, slideData, index, total) {
  const slide = pptx.addSlide()

  // 渐变背景
  slide.addShape(pptx.ShapeType.rect, {
    x: 0,
    y: 0,
    w: SLIDE_W,
    h: SLIDE_H,
    fill: {
      type: 'gradient',
      angle: 315,
      stops: [
        { color: THEME.paper, position: 0 },
        { color: THEME.paper2, position: 100 },
      ],
    },
    line: { color: THEME.paper, width: 0 },
  })

  // 底部粗色条
  slide.addShape(pptx.ShapeType.rect, {
    x: 0,
    y: SLIDE_H - 0.35,
    w: SLIDE_W,
    h: 0.35,
    fill: { color: THEME.cyan },
    line: { color: THEME.cyan, width: 0 },
  })

  // 左上角大圆形装饰
  slide.addShape(pptx.ShapeType.ellipse, {
    x: -1.6,
    y: -1.6,
    w: 4.2,
    h: 4.2,
    fill: { color: THEME.cyan, transparency: 85 },
    line: { color: THEME.cyan, width: 0 },
  })

  // 右下角小圆装饰
  slide.addShape(pptx.ShapeType.ellipse, {
    x: 10.8,
    y: 5.3,
    w: 2.8,
    h: 2.8,
    fill: { color: THEME.ember, transparency: 88 },
    line: { color: THEME.ember, width: 0 },
  })

  // 主标题
  slide.addText(slideData.title, {
    x: 1,
    y: 2.4,
    w: 11.3,
    h: 1.2,
    fontFace: 'Aptos Display',
    fontSize: 40,
    bold: true,
    color: THEME.ink,
    align: 'center',
    margin: 0,
  })

  // 结语
  if (slideData.bullets.length > 0) {
    slide.addText(slideData.bullets[0], {
      x: 1,
      y: 3.7,
      w: 11.3,
      h: 0.6,
      fontFace: 'Aptos',
      fontSize: 18,
      color: THEME.inkSoft,
      align: 'center',
      margin: 0,
    })
  }

  // 底部装饰线
  slide.addShape(pptx.ShapeType.line, {
    x: 5.5,
    y: 4.5,
    w: 2.333,
    h: 0,
    line: { color: THEME.cyan, width: 2 },
  })

  addPageNumber(slide, index, total)
}

/* ── Main builder ── */

async function buildPresentationFromMarkdown(markdown, { title } = {}) {
  const slides = parseMarkdownSlides(markdown)
  if (!slides.length) throw new Error('没有可导出的 PPT 内容')

  const module = await import('pptxgenjs')
  const PptxGenJS = module.default || module
  const pptx = new PptxGenJS()
  pptx.layout = 'LAYOUT_WIDE'
  pptx.author = 'Your Model Atelier'
  pptx.company = 'Your Model Atelier'
  pptx.subject = title || slides[0].title
  pptx.title = title || slides[0].title
  pptx.lang = 'zh-CN'
  pptx.theme = {
    headFontFace: 'Aptos Display',
    bodyFontFace: 'Aptos',
    lang: 'zh-CN',
  }

  const total = slides.length

  slides.forEach((slideData, index) => {
    const type = inferSlideType(slideData, index)
    switch (type) {
      case 'cover':
        addCoverSlide(pptx, slideData, index, total)
        break
      case 'toc':
        addTocSlide(pptx, slideData, index, total)
        break
      case 'image':
        addImageSlide(pptx, slideData, index, total)
        break
      case 'end':
        addEndSlide(pptx, slideData, index, total)
        break
      default:
        addContentSlide(pptx, slideData, index, total)
    }
  })

  return { pptx, slides }
}

function saveBlob(blob, filename) {
  if (typeof document === 'undefined') return
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.dataset.interception = 'off'
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  setTimeout(() => {
    URL.revokeObjectURL(url)
    a.remove()
  }, 100)
}

export async function createPptxBlobFromMarkdown(markdown, { title } = {}) {
  const { pptx } = await buildPresentationFromMarkdown(markdown, { title })
  const content = await pptx.write({ outputType: 'blob' })
  if (content instanceof Blob && content.type === PPTX_MIME) return content
  return new Blob([content], { type: PPTX_MIME })
}

export async function downloadPptxFromMarkdown(markdown, { title, filename } = {}) {
  const slides = parseMarkdownSlides(markdown)
  if (!slides.length) throw new Error('没有可导出的 PPT 内容')

  const blob = await createPptxBlobFromMarkdown(markdown, { title: title || slides[0].title })
  saveBlob(blob, filename || buildPresentationFilename(title || slides[0].title))
  return blob
}

/* ── HTML Preview (iframe-rendered slides) ── */

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const PREVIEW_CSS = `
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  font-family: 'Inter', system-ui, -apple-system, sans-serif;
  background: #EAE2D2;
  padding: 12px;
}
.slide {
  width: 100%;
  max-width: 880px;
  margin: 0 auto 12px;
  aspect-ratio: 16/9;
  position: relative;
  overflow: hidden;
  border-radius: 6px;
  box-shadow: 0 2px 10px rgba(42,31,23,0.08);
  background: #F4EFE5;
}
.slide-number {
  font-family: 'JetBrains Mono', monospace;
  font-size: 8px;
  color: #8A7B68;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  margin-bottom: 6px;
}

/* Cover */
.slide-cover {
  background: linear-gradient(135deg, #F4EFE5 0%, #EAE2D2 100%);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
}
.cover-top-bar {
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 10px;
  background: #E86A3C;
}
.cover-circle {
  position: absolute;
  border-radius: 50%;
}
.cover-circle-1 {
  width: 72px; height: 72px;
  top: 14px; right: 14px;
  background: rgba(232,106,60,0.12);
}
.cover-circle-2 {
  width: 44px; height: 44px;
  bottom: 16px; left: 10px;
  background: rgba(46,143,163,0.12);
}
.cover-content {
  z-index: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 20px;
}
.cover-title {
  font-size: 26px;
  font-weight: 700;
  color: #2A1F17;
  line-height: 1.2;
  max-width: 80%;
}
.cover-subtitle {
  font-size: 13px;
  color: #5E4F40;
}
.cover-date {
  font-size: 9px;
  color: #8A7B68;
}
.cover-bottom-line {
  position: absolute;
  bottom: 16px;
  width: 40px;
  height: 3px;
  background: #E86A3C;
  border-radius: 2px;
}

/* TOC */
.slide-toc {
  display: flex;
  background: #F4EFE5;
}
.toc-sidebar {
  width: 28%;
  background: #2E8FA3;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: white;
  padding: 14px;
}
.toc-title { font-size: 20px; font-weight: 700; }
.toc-subtitle { font-size: 8px; opacity: 0.7; margin-top: 3px; letter-spacing: 0.1em; }
.toc-main {
  flex: 1;
  padding: 16px 20px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 8px;
}
.toc-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-bottom: 6px;
  border-bottom: 1px solid #DBD2BE;
}
.toc-item:last-child { border-bottom: none; }
.toc-num {
  font-size: 16px;
  font-weight: 700;
  color: #E86A3C;
  min-width: 24px;
}
.toc-text {
  font-size: 12px;
  color: #2A1F17;
}

/* Content */
.slide-content { background: #F4EFE5; }
.content-bar {
  position: absolute;
  left: 0; top: 0; bottom: 0;
  width: 4px;
  background: #E86A3C;
}
.content-body {
  padding: 16px 20px 16px 24px;
  height: 100%;
  display: flex;
  flex-direction: column;
}
.content-title {
  font-size: 18px;
  font-weight: 600;
  color: #2A1F17;
  margin-top: 2px;
  line-height: 1.3;
}
.content-line {
  width: 24px;
  height: 2px;
  background: #E86A3C;
  margin-top: 6px;
  border-radius: 1px;
}
.content-bullets {
  list-style: none;
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  overflow: hidden;
}
.content-bullets li {
  font-size: 11px;
  color: #5E4F40;
  line-height: 1.45;
  display: flex;
  gap: 5px;
}
.content-bullets li::before {
  content: '•';
  color: #E86A3C;
  flex-shrink: 0;
}
.content-bottom-line {
  position: absolute;
  bottom: 12px;
  left: 24px;
  right: 16px;
  height: 1px;
  background: #DBD2BE;
}

/* Image */
.slide-image {
  background: #F4EFE5;
  display: flex;
  flex-direction: column;
  padding: 14px 18px;
}
.image-header { margin-bottom: 6px; }
.image-title {
  font-size: 16px;
  font-weight: 600;
  color: #2A1F17;
  margin-top: 2px;
}
.image-line {
  width: 24px;
  height: 2px;
  background: #E86A3C;
  margin-top: 5px;
}
.image-body {
  flex: 1;
  display: flex;
  gap: 14px;
  overflow: hidden;
}
.image-bullets {
  flex: 1;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 5px;
  overflow: hidden;
}
.image-bullets li {
  font-size: 10px;
  color: #5E4F40;
  line-height: 1.35;
  display: flex;
  gap: 4px;
}
.image-bullets li::before {
  content: '•';
  color: #E86A3C;
  flex-shrink: 0;
}
.image-placeholder {
  width: 32%;
  border: 1.5px dashed #C9BFA8;
  background: rgba(234,226,210,0.5);
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 9px;
  color: #8A7B68;
}

/* End */
.slide-end {
  background: linear-gradient(315deg, #F4EFE5 0%, #EAE2D2 100%);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
}
.end-bottom-bar {
  position: absolute;
  bottom: 0; left: 0; right: 0;
  height: 10px;
  background: #2E8FA3;
}
.end-circle {
  position: absolute;
  border-radius: 50%;
}
.end-circle-1 {
  width: 56px; height: 56px;
  top: 10px; left: 10px;
  background: rgba(46,143,163,0.12);
}
.end-circle-2 {
  width: 40px; height: 40px;
  bottom: 20px; right: 14px;
  background: rgba(232,106,60,0.12);
}
.end-content {
  z-index: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 20px;
}
.end-title {
  font-size: 24px;
  font-weight: 700;
  color: #2A1F17;
}
.end-subtitle {
  font-size: 12px;
  color: #5E4F40;
}
`

function buildSlideHtml(slide, index, total) {
  const num = String(index + 1).padStart(2, '0')
  const totalStr = String(total).padStart(2, '0')
  const type = inferSlideType(slide, index)

  switch (type) {
    case 'cover': {
      const subtitle = slide.bullets[0] ? `<p class="cover-subtitle">${escapeHtml(slide.bullets[0])}</p>` : ''
      return `<div class="slide slide-cover">
  <div class="cover-top-bar"></div>
  <div class="cover-circle cover-circle-1"></div>
  <div class="cover-circle cover-circle-2"></div>
  <div class="cover-content">
    <div class="slide-number">SLIDE ${num} / ${totalStr}</div>
    <h1 class="cover-title">${escapeHtml(slide.title)}</h1>
    ${subtitle}
    <p class="cover-date">${new Date().toLocaleDateString('zh-CN')}</p>
  </div>
  <div class="cover-bottom-line"></div>
</div>`
    }
    case 'toc': {
      const items = slide.bullets.map((b, i) => `
  <div class="toc-item">
    <span class="toc-num">${String(i + 1).padStart(2, '0')}</span>
    <span class="toc-text">${escapeHtml(b)}</span>
  </div>`).join('')
      return `<div class="slide slide-toc">
  <div class="toc-sidebar">
    <div class="toc-title">目录</div>
    <div class="toc-subtitle">CONTENTS</div>
  </div>
  <div class="toc-main">
    <div class="slide-number">SLIDE ${num} / ${totalStr}</div>${items}
  </div>
</div>`
    }
    case 'image': {
      const bullets = slide.bullets.slice(0, 4).map(b => `
    <li>${escapeHtml(b)}</li>`).join('')
      return `<div class="slide slide-image">
  <div class="image-header">
    <div class="slide-number">SLIDE ${num} / ${totalStr}</div>
    <h2 class="image-title">${escapeHtml(slide.title)}</h2>
    <div class="image-line"></div>
  </div>
  <div class="image-body">
    <ul class="image-bullets">${bullets}
    </ul>
    <div class="image-placeholder">[ ${escapeHtml(slide.images?.[0]?.alt || '配图')} ]</div>
  </div>
</div>`
    }
    case 'end': {
      const subtitle = slide.bullets[0] ? `<p class="end-subtitle">${escapeHtml(slide.bullets[0])}</p>` : ''
      return `<div class="slide slide-end">
  <div class="end-circle end-circle-1"></div>
  <div class="end-circle end-circle-2"></div>
  <div class="end-bottom-bar"></div>
  <div class="end-content">
    <div class="slide-number">SLIDE ${num} / ${totalStr}</div>
    <h1 class="end-title">${escapeHtml(slide.title)}</h1>
    ${subtitle}
  </div>
</div>`
    }
    default: {
      const bullets = slide.bullets.map(b => `
    <li>${escapeHtml(b)}</li>`).join('')
      return `<div class="slide slide-content">
  <div class="content-bar"></div>
  <div class="content-body">
    <div class="slide-number">SLIDE ${num} / ${totalStr}</div>
    <h2 class="content-title">${escapeHtml(slide.title)}</h2>
    <div class="content-line"></div>
    <ul class="content-bullets">${bullets}
    </ul>
  </div>
  <div class="content-bottom-line"></div>
</div>`
    }
  }
}

export function buildHtmlPreview(markdown) {
  const slides = parseMarkdownSlides(markdown)
  if (!slides.length) return ''

  const total = slides.length
  const slideHtml = slides.map((slide, i) => buildSlideHtml(slide, i, total)).join('')

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>${PREVIEW_CSS}</style>
</head>
<body>${slideHtml}</body>
</html>`
}
