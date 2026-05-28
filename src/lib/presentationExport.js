import { injectEaFont, CJK_FONT } from './pptCore.js'

const MAX_BULLETS_PER_SLIDE = 5
const MAX_BULLET_LENGTH = 80
const MAX_RICH_BULLET_MAIN_LENGTH = 96
const MAX_RICH_BULLET_NOTE_LENGTH = 160
const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'

const SLIDE_W = 13.333
const SLIDE_H = 7.5

const THEMES = {
  warm: {
    id: 'warm',
    paper: 'F4EFE5',
    paper2: 'EAE2D2',
    ink: '2A1F17',
    inkSoft: '5E4F40',
    inkFade: '8A7B68',
    ember: 'E86A3C',
    cyan: '2E8FA3',
    white: 'FFFFFF',
    skeleton: 'DBD2BE',
    glowA: 'F6B26B',
    glowB: 'F08A5D',
  },
  tech: {
    id: 'tech',
    paper: 'EEF2FF',
    paper2: 'E0E7FF',
    ink: '151A2D',
    inkSoft: '334155',
    inkFade: '64748B',
    ember: '6366F1',
    cyan: '06B6D4',
    white: 'FFFFFF',
    skeleton: 'CBD5E1',
    glowA: '818CF8',
    glowB: '22D3EE',
  },
  finance: {
    id: 'finance',
    paper: 'EEF7F1',
    paper2: 'DDEFE4',
    ink: '13261C',
    inkSoft: '315141',
    inkFade: '5F7D6B',
    ember: '0F766E',
    cyan: '65A30D',
    white: 'FFFFFF',
    skeleton: 'C6D8CC',
    glowA: '34D399',
    glowB: 'A3E635',
  },
  consumer: {
    id: 'consumer',
    paper: 'FFF1F2',
    paper2: 'FFE4E6',
    ink: '32121A',
    inkSoft: '6B3240',
    inkFade: '9F5D6F',
    ember: 'F43F5E',
    cyan: 'FB7185',
    white: 'FFFFFF',
    skeleton: 'F4C7CF',
    glowA: 'FDA4AF',
    glowB: 'FBCFE8',
  },
}

let THEME = THEMES.warm

export function resolvePresentationTheme(topic = '') {
  const text = String(topic || '').toLowerCase()
  if (/ai|saas|software|cloud|tech|digital|智能|科技|算法|平台/.test(text)) return THEMES.tech
  if (/bank|finance|fund|insurance|wealth|金融|银行|保险|基金|投研/.test(text)) return THEMES.finance
  if (/consumer|brand|retail|beauty|food|fashion|消费|品牌|零售|美妆|餐饮/.test(text)) return THEMES.consumer
  return THEMES.warm
}

function addAmbientDecor(slide, pptx, index, { dense = false } = {}) {
  slide.addShape(pptx.ShapeType.ellipse, {
    x: index % 2 === 0 ? 10.7 : -1.2,
    y: index % 2 === 0 ? -1.3 : 5.1,
    w: dense ? 3.3 : 2.7,
    h: dense ? 3.3 : 2.7,
    fill: { color: THEME.glowA, transparency: 78 },
    line: { color: THEME.glowA, width: 0 },
  })
  slide.addShape(pptx.ShapeType.ellipse, {
    x: index % 2 === 0 ? -0.8 : 10.8,
    y: index % 2 === 0 ? 5.5 : -1.1,
    w: dense ? 2.5 : 2.1,
    h: dense ? 2.5 : 2.1,
    fill: { color: THEME.glowB, transparency: 84 },
    line: { color: THEME.glowB, width: 0 },
  })
  slide.addShape(pptx.ShapeType.rect, {
    x: 11.55, y: 0.36, w: 1.05, h: 0.22,
    fill: { color: THEME.paper2, transparency: 12 },
    line: { color: THEME.skeleton, width: 0.5 },
  })
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

function truncateBullet(line) {
  return line.length > MAX_BULLET_LENGTH ? `${line.slice(0, MAX_BULLET_LENGTH)}...` : line
}

function clipText(line, maxLength) {
  const text = String(line || '').trim()
  return text.length > maxLength ? `${text.slice(0, maxLength).trim()}...` : text
}

function splitRichBullet(line) {
  const text = String(line || '').trim()
  const parts = text.split(/\s*[;；]\s*/).map((part) => part.trim()).filter(Boolean)
  if (parts.length <= 1) return { main: text, note: '' }
  return { main: parts[0], note: parts.slice(1).join('; ') }
}

function truncateRichBullet(line) {
  const { main, note } = splitRichBullet(line)
  if (!note) return truncateBullet(main)
  const clippedMain = clipText(main, MAX_RICH_BULLET_MAIN_LENGTH)
  const clippedNote = clipText(note, MAX_RICH_BULLET_NOTE_LENGTH)
  return clippedNote ? `${clippedMain}; ${clippedNote}` : clippedMain
}

/* ── Enhanced parser ── */

function parseTypeTag(lines) {
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^<!--\s*(\w+)\s*-->$/)
    if (m) {
      const type = m[1]
      lines.splice(i, 1)
      return type
    }
  }
  return null
}

function parseTableLines(lines) {
  const rows = []
  for (const line of lines) {
    if (!/^\s*\|/.test(line)) continue
    const cells = line.split('|').map((c) => c.trim()).filter((c) => c !== '' && !/^[-:]+$/.test(c))
    if (cells.length) rows.push(cells)
  }
  return rows
}

function parseDataPoint(line) {
  const pipe = line.match(/^(.+?)\s*\|\s*(.+)$/)
  if (pipe) return { value: pipe[1].trim(), label: pipe[2].trim() }
  const colon = line.match(/^(.+?)\s*[:：]\s*(.+)$/)
  if (colon) return { value: colon[2].trim(), label: colon[1].trim() }
  const dash = line.match(/^(.+?)\s*[-—]\s*(.+)$/)
  if (dash) return { value: dash[1].trim(), label: dash[2].trim() }
  return null
}

function parseQuote(lines) {
  if (!lines.length) return null
  const text = cleanBullet(lines[0])
  const source = lines[1] ? cleanBullet(lines[1]) : ''
  return { text, source }
}

function parseSplitColumns(lines) {
  const left = { title: '', bullets: [] }
  const right = { title: '', bullets: [] }
  let target = null
  for (const line of lines) {
    const boldTitle = line.match(/^\*\*(.+?)\*\*$/)
    if (boldTitle) {
      if (!left.title) {
        left.title = boldTitle[1]
        target = left
      } else {
        right.title = boldTitle[1]
        target = right
      }
      continue
    }
    if (!target) continue
    const bullet = cleanBullet(line)
    if (bullet) target.bullets.push(bullet)
  }
  return { left, right }
}

function parseProcessSteps(lines) {
  return lines.map((line) => {
    const m = line.match(/^\d+[.、]\s*(.+?)(?:\s*[-—:：]\s*(.+))?$/)
    if (m) return { name: m[1].trim(), desc: m[2] ? m[2].trim() : '' }
    const bullet = cleanBullet(line)
    if (bullet) return { name: bullet, desc: '' }
    return null
  }).filter(Boolean)
}

// fenced ```chart``` 块或裸 key:value 行,返回 { type, categories, series:[{name, values}] }.
// 容错:无 type 默认 bar;column 视作 bar;无 series 但末尾跟数值行,自动命名"系列 N".
function parseChartBlock(lines) {
  const body = []
  let inFence = false
  let sawFence = false
  for (const raw of lines) {
    const line = raw.trim()
    if (/^```(\s*chart)?\s*$/i.test(line)) { sawFence = true; inFence = !inFence; continue }
    if (sawFence && !inFence) continue
    if (line) body.push(line)
  }

  let type = 'bar'
  let categories = []
  const series = []
  for (const line of body) {
    const mType = line.match(/^type\s*[:=]\s*(.+)$/i)
    if (mType) {
      const v = mType[1].trim().toLowerCase()
      if (v === 'line' || v === 'pie' || v === 'area' || v === 'stacked' || v === 'scatter') type = v
      else if (v === 'column' || v === 'bar') type = 'bar'
      else if (v === 'stack' || v === 'stackedbar' || v === 'stacked_bar') type = 'stacked'
      continue
    }
    const mCat = line.match(/^(?:categories|labels|x|横轴)\s*[:=]\s*(.+)$/i)
    if (mCat) {
      categories = mCat[1].split(/[,，、]/).map((s) => s.trim()).filter(Boolean)
      continue
    }
    if (/^series\s*[:=]?\s*$/i.test(line)) continue
    const mRow = line.match(/^[-*]?\s*(?:["']?(.+?)["']?\s*[:：]\s*)?(.+)$/)
    if (!mRow) continue
    const valuesPart = mRow[2] || ''
    const values = valuesPart.split(/[,，、\s]+/).map((s) => Number(s)).filter((n) => Number.isFinite(n))
    if (values.length === 0) continue
    const name = (mRow[1] || '').trim() || `系列${series.length + 1}`
    series.push({ name, values })
  }
  if (!categories.length && series.length) {
    const len = Math.max(...series.map((s) => s.values.length))
    categories = Array.from({ length: len }, (_, i) => String(i + 1))
  }
  return { type, categories, series }
}

function chunkToSlide(lines, index) {
  const cleaned = lines.map((line) => line.trim()).filter(Boolean)
  if (!cleaned.length) return null

  const title = cleanTitle(cleaned[0]) || '未命名页面'
  let type = parseTypeTag(cleaned) || 'content'

  if (type === 'content') {
    if (index === 0) type = 'cover'
    else if (/目录|内容概览|大纲|Agenda/i.test(title)) type = 'toc'
    else if (/感谢|Q&A|问答|总结|结语|结束|Thank/i.test(title)) type = 'end'
  }

  const rest = cleaned.slice(1)

  if (type === 'chart') {
    const chart = parseChartBlock(rest)
    return { title, type, index, chart }
  }

  const tableRows = parseTableLines(rest)
  if (tableRows.length >= 2 && (type === 'table' || type === 'content')) {
    const nonTable = rest.filter((line) => !/^\s*\|/.test(line))
    return {
      title, type: type === 'content' ? 'table' : type, index,
      table: tableRows,
      bullets: nonTable.map(cleanBullet).filter(Boolean).slice(0, MAX_BULLETS_PER_SLIDE).map(truncateRichBullet),
    }
  }

  if (type === 'split') {
    const split = parseSplitColumns(rest)
    return { title, type, index, leftColumn: split.left, rightColumn: split.right }
  }

  if (type === 'data') {
    const dataPoints = rest.map(parseDataPoint).filter(Boolean)
    return { title, type, index, dataPoints }
  }

  if (type === 'quote') {
    const quote = parseQuote(rest)
    return { title, type, index, quote }
  }

  if (type === 'process') {
    const steps = parseProcessSteps(rest)
    return { title, type, index, processSteps: steps }
  }

  const images = []
  const bullets = []
  for (const line of rest) {
    const imgMatch = line.match(/^!\[(.*?)\]\((.*?)\)/)
    if (imgMatch) {
      images.push({ alt: imgMatch[1], src: imgMatch[2] })
      continue
    }
    const bullet = cleanBullet(line)
    if (bullet && bullet !== '---' && !/^目录$/.test(bullet)) {
      bullets.push(bullet)
    }
  }

  if (type === 'content' && images.length > 0) {
    type = 'image'
  }

  if (type === 'content') {
    const dataPoints = bullets
      .map(parseDataPoint)
      .filter((point) => point && /[\d０-９%％¥￥$万亿kK+\-.]/.test(point.value))
    if (dataPoints.length >= 3) {
      return { title, type: 'data', index, dataPoints }
    }
  }

  return {
    title, type, index,
    bullets: bullets.slice(0, MAX_BULLETS_PER_SLIDE).map(truncateRichBullet),
    images,
  }
}

function parseSeparatedSlides(markdown) {
  const parts = markdown.split(/^\s*---+\s*$/m)
  return parts.map((part, i) => chunkToSlide(part.split('\n'), i)).filter(Boolean)
}

function parseNumberedOutline(markdown) {
  const lines = markdown.split('\n')
  const slides = []
  let preface = []
  let current = null

  const pushCurrent = () => {
    if (current) {
      const slide = chunkToSlide([current.title, ...current.lines], slides.length)
      if (slide) slides.push(slide)
      current = null
    }
  }

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue
    const numbered =
      line.match(/^(?:#{1,4}\s*)?(\d{1,2})(?:\.|\u3001)\s+(.+)$/) ||
      line.match(/^\u7b2c\s*([\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341\d]{1,3})\s*\u9875[\uFF1A:\u3001.]?\s*(.+)$/)
    if (numbered) {
      if (!current && preface.length) {
        const prefaceLines = preface.filter((item) => !/^(?:#{1,4}\s*)?\d{1,2}(?:\.|\u3001)\s+/.test(item))
        const titleSlide = prefaceLines.length >= 2 ? chunkToSlide(prefaceLines, 0) : null
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
    const slide = chunkToSlide(preface, 0)
    if (slide) slides.push(slide)
  }

  slides.forEach((s, i) => { s.index = i })
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

/* ── Layout helpers ── */

function addPageNumber(slide, index, total) {
  const num = String(index + 1).padStart(2, '0')
  const totalStr = String(total).padStart(2, '0')
  slide.addText(`${num} / ${totalStr}`, {
    x: 11.2, y: 7.05, w: 1.5, h: 0.22,
    fontSize: 9, color: THEME.inkFade, align: 'right', margin: 0,
  })
}

function addBottomLine(slide, color = THEME.skeleton) {
  slide.addShape('rect', {
    x: 0.7, y: 6.9, w: 12, h: 0.02,
    fill: { color }, line: { color, width: 0 },
  })
}

/* ── Cover ── */

function addCoverSlide(pptx, slideData, index, total) {
  const slide = pptx.addSlide()
  slide.addShape(pptx.ShapeType.rect, {
    x: 0, y: 0, w: SLIDE_W, h: SLIDE_H,
    fill: {
      type: 'gradient',
      angle: 135,
      stops: [{ color: THEME.paper, position: 0 }, { color: THEME.paper2, position: 100 }],
    },
    line: { color: THEME.paper, width: 0 },
  })
  slide.addShape(pptx.ShapeType.rect, {
    x: 0, y: 0, w: SLIDE_W, h: 0.35,
    fill: { color: THEME.ember },
    line: { color: THEME.ember, width: 0 },
  })
  slide.addShape(pptx.ShapeType.ellipse, {
    x: 10.2, y: -1.8, w: 4.8, h: 4.8,
    fill: { color: THEME.ember, transparency: 85 },
    line: { color: THEME.ember, width: 0 },
  })
  slide.addShape(pptx.ShapeType.ellipse, {
    x: -0.9, y: 5.3, w: 2.8, h: 2.8,
    fill: { color: THEME.cyan, transparency: 88 },
    line: { color: THEME.cyan, width: 0 },
  })
  slide.addText(slideData.title, {
    x: 1, y: 2.2, w: 11.3, h: 1.2,
    fontFace: 'Calibri', fontSize: 44, bold: true, color: THEME.ink,
    align: 'center', margin: 0,
  })
  if (slideData.bullets?.[0]) {
    slide.addText(slideData.bullets[0], {
      x: 1, y: 3.6, w: 11.3, h: 0.6,
      fontFace: 'Calibri', fontSize: 20, color: THEME.inkSoft,
      align: 'center', margin: 0,
    })
  }
  slide.addText(new Date().toLocaleDateString('zh-CN'), {
    x: 1, y: 4.4, w: 11.3, h: 0.4,
    fontFace: 'Calibri', fontSize: 12, color: THEME.inkFade,
    align: 'center', margin: 0,
  })
  slide.addShape(pptx.ShapeType.rect, {
    x: 5.5, y: 6.8, w: 2.333, h: 0.04,
    fill: { color: THEME.ember },
    line: { color: THEME.ember, width: 0 },
  })
  addPageNumber(slide, index, total)
}

/* ── TOC ── */

function addTocSlide(pptx, slideData, index, total) {
  const slide = pptx.addSlide()
  slide.background = { color: THEME.paper }
  slide.addShape(pptx.ShapeType.rect, {
    x: 0, y: 0, w: 3.6, h: SLIDE_H,
    fill: { color: THEME.cyan },
    line: { color: THEME.cyan, width: 0 },
  })
  slide.addText('目录', {
    x: 0.5, y: 2.8, w: 2.6, h: 1,
    fontFace: 'Calibri', fontSize: 32, bold: true, color: THEME.white, margin: 0,
  })
  slide.addText('CONTENTS', {
    x: 0.5, y: 3.6, w: 2.6, h: 0.4,
    fontFace: 'Calibri', fontSize: 11, color: 'B8D4DB', margin: 0,
  })
  slideData.bullets.forEach((bullet, i) => {
    const yBase = 1.2 + i * 0.85
    slide.addText(String(i + 1).padStart(2, '0'), {
      x: 4.2, y: yBase, w: 0.8, h: 0.4,
      fontFace: 'Calibri', fontSize: 22, bold: true, color: THEME.ember, margin: 0,
    })
    slide.addText(bullet, {
      x: 5.1, y: yBase + 0.05, w: 7.5, h: 0.5,
      fontFace: 'Calibri', fontSize: 18, color: THEME.ink, margin: 0,
    })
    if (i < slideData.bullets.length - 1) {
      slide.addShape(pptx.ShapeType.rect, {
        x: 5.1, y: yBase + 0.65, w: 7.5, h: 0.01,
        fill: { color: THEME.skeleton },
        line: { color: THEME.skeleton, width: 0 },
      })
    }
  })
  addPageNumber(slide, index, total)
}

/* ── Content ── */

function addContentSlide(pptx, slideData, index, total) {
  const slide = pptx.addSlide()
  const accentColor = index % 2 === 0 ? THEME.ember : THEME.cyan
  slide.background = { color: THEME.paper }
  addAmbientDecor(slide, pptx, index)
  slide.addShape(pptx.ShapeType.rect, {
    x: 0, y: 0, w: 0.12, h: SLIDE_H,
    fill: { color: accentColor },
    line: { color: accentColor, width: 0 },
  })
  slide.addText(slideData.title, {
    x: 0.7, y: 0.5, w: 11.8, h: 0.7,
    fontFace: 'Calibri', fontSize: 30, bold: true, color: THEME.ink, margin: 0,
  })
  slide.addShape(pptx.ShapeType.rect, {
    x: 0.7, y: 1.15, w: 0.6, h: 0.04,
    fill: { color: accentColor },
    line: { color: accentColor, width: 0 },
  })
  if (slideData.bullets.length) {
    slide.addText(
      slideData.bullets.map((bullet) => ({
        text: bullet,
        options: { bullet: { type: 'bullet' }, breakLine: true, paraSpaceAfterPt: 10 },
      })),
      {
        x: 0.95, y: 1.5, w: 11.35, h: 5.2,
        fontFace: 'Calibri', fontSize: 18, color: THEME.inkSoft,
        breakLine: false, fit: 'shrink',
      }
    )
  }
  addBottomLine(slide)
  addPageNumber(slide, index, total)
}

/* ── Image ── */

function addImageSlide(pptx, slideData, index, total) {
  const slide = pptx.addSlide()
  slide.background = { color: THEME.paper }
  slide.addText(slideData.title, {
    x: 0.7, y: 0.5, w: 11.8, h: 0.7,
    fontFace: 'Calibri', fontSize: 30, bold: true, color: THEME.ink, margin: 0,
  })
  slide.addShape(pptx.ShapeType.rect, {
    x: 0.7, y: 1.15, w: 0.6, h: 0.04,
    fill: { color: THEME.ember },
    line: { color: THEME.ember, width: 0 },
  })
  if (slideData.bullets.length) {
    slide.addText(
      slideData.bullets.map((bullet) => ({
        text: bullet,
        options: { bullet: { type: 'bullet' }, breakLine: true, paraSpaceAfterPt: 8 },
      })),
      {
        x: 0.95, y: 1.5, w: 6.5, h: 5.2,
        fontFace: 'Calibri', fontSize: 17, color: THEME.inkSoft,
        breakLine: false, fit: 'shrink',
      }
    )
  }
  const imgX = 7.8
  const imgY = 1.5
  const imgW = 4.8
  const imgH = 4.5
  slide.addShape(pptx.ShapeType.rect, {
    x: imgX, y: imgY, w: imgW, h: imgH,
    fill: { color: 'F8F4EC' },
    line: { color: 'C9BFA8', width: 1.5, dashType: 'dash' },
  })
  slide.addText(`[ ${slideData.images?.[0]?.alt || '配图建议'} ]`, {
    x: imgX, y: imgY + imgH / 2 - 0.3, w: imgW, h: 0.6,
    fontFace: 'Calibri', fontSize: 14, color: THEME.inkFade,
    align: 'center', valign: 'middle', margin: 0,
  })
  addBottomLine(slide)
  addPageNumber(slide, index, total)
}

/* ── End ── */

function addEndSlide(pptx, slideData, index, total) {
  const slide = pptx.addSlide()
  slide.addShape(pptx.ShapeType.rect, {
    x: 0, y: 0, w: SLIDE_W, h: SLIDE_H,
    fill: {
      type: 'gradient',
      angle: 315,
      stops: [{ color: THEME.paper, position: 0 }, { color: THEME.paper2, position: 100 }],
    },
    line: { color: THEME.paper, width: 0 },
  })
  slide.addShape(pptx.ShapeType.rect, {
    x: 0, y: SLIDE_H - 0.35, w: SLIDE_W, h: 0.35,
    fill: { color: THEME.cyan },
    line: { color: THEME.cyan, width: 0 },
  })
  slide.addShape(pptx.ShapeType.ellipse, {
    x: -1.6, y: -1.6, w: 4.2, h: 4.2,
    fill: { color: THEME.cyan, transparency: 85 },
    line: { color: THEME.cyan, width: 0 },
  })
  slide.addShape(pptx.ShapeType.ellipse, {
    x: 10.8, y: 5.3, w: 2.8, h: 2.8,
    fill: { color: THEME.ember, transparency: 88 },
    line: { color: THEME.ember, width: 0 },
  })
  slide.addText(slideData.title, {
    x: 1, y: 2.4, w: 11.3, h: 1.2,
    fontFace: 'Calibri', fontSize: 40, bold: true, color: THEME.ink,
    align: 'center', margin: 0,
  })
  if (slideData.bullets?.[0]) {
    slide.addText(slideData.bullets[0], {
      x: 1, y: 3.7, w: 11.3, h: 0.6,
      fontFace: 'Calibri', fontSize: 18, color: THEME.inkSoft,
      align: 'center', margin: 0,
    })
  }
  slide.addShape(pptx.ShapeType.rect, {
    x: 5.5, y: 4.5, w: 2.333, h: 0.04,
    fill: { color: THEME.cyan },
    line: { color: THEME.cyan, width: 0 },
  })
  addPageNumber(slide, index, total)
}

/* ── Data ── */

function addDataSlide(pptx, slideData, index, total) {
  const slide = pptx.addSlide()
  const accentColor = index % 3 === 0 ? THEME.ember : index % 3 === 1 ? THEME.cyan : '8A7B68'
  slide.background = { color: THEME.paper }
  addAmbientDecor(slide, pptx, index, { dense: true })
  slide.addText(slideData.title, {
    x: 0.7, y: 0.5, w: 11.8, h: 0.7,
    fontFace: 'Calibri', fontSize: 30, bold: true, color: THEME.ink, margin: 0,
  })
  slide.addShape(pptx.ShapeType.rect, {
    x: 0.7, y: 1.15, w: 0.6, h: 0.04,
    fill: { color: accentColor },
    line: { color: accentColor, width: 0 },
  })

  const points = slideData.dataPoints || []
  const count = Math.min(points.length, 4)
  if (count > 0) {
    const cardW = 11.5 / count
    const startX = 0.7
    const y = 2.0
    points.slice(0, count).forEach((point, i) => {
      const x = startX + i * cardW
      slide.addText(point.value, {
        x, y, w: cardW - 0.3, h: 0.9,
        fontFace: 'Calibri', fontSize: 36, bold: true, color: accentColor,
        align: 'center', margin: 0,
      })
      slide.addText(point.label, {
        x, y: y + 1.0, w: cardW - 0.3, h: 0.8,
        fontFace: 'Calibri', fontSize: 14, color: THEME.inkSoft,
        align: 'center', margin: 0,
      })
      slide.addShape(pptx.ShapeType.rect, {
        x: x + (cardW - 0.3) / 2 - 0.5, y: y + 1.9, w: 1.0, h: 0.03,
        fill: { color: accentColor },
        line: { color: accentColor, width: 0 },
      })
    })
  }
  addBottomLine(slide)
  addPageNumber(slide, index, total)
}

/* ── Quote ── */

function addQuoteSlide(pptx, slideData, index, total) {
  const slide = pptx.addSlide()
  slide.addShape(pptx.ShapeType.rect, {
    x: 0, y: 0, w: SLIDE_W, h: SLIDE_H,
    fill: {
      type: 'gradient',
      angle: 180,
      stops: [{ color: THEME.paper, position: 0 }, { color: THEME.paper2, position: 100 }],
    },
    line: { color: THEME.paper, width: 0 },
  })
  slide.addText('"', {
    x: 0.8, y: 1.2, w: 1.5, h: 1.2,
    fontFace: 'Calibri', fontSize: 72, bold: true, color: THEME.ember, margin: 0,
  })
  if (slideData.quote?.text) {
    slide.addText(slideData.quote.text, {
      x: 1.5, y: 2.2, w: 10.3, h: 2.0,
      fontFace: 'Calibri', fontSize: 24, italic: true, color: THEME.ink,
      align: 'center', margin: 0,
    })
  }
  if (slideData.quote?.source) {
    slide.addText(`— ${slideData.quote.source}`, {
      x: 1.5, y: 4.4, w: 10.3, h: 0.5,
      fontFace: 'Calibri', fontSize: 14, color: THEME.inkFade,
      align: 'right', margin: 0,
    })
  }
  slide.addShape(pptx.ShapeType.rect, {
    x: 5.5, y: 5.2, w: 2.333, h: 0.04,
    fill: { color: THEME.ember },
    line: { color: THEME.ember, width: 0 },
  })
  addPageNumber(slide, index, total)
}

/* ── Split ── */

function addSplitSlide(pptx, slideData, index, total) {
  const slide = pptx.addSlide()
  slide.background = { color: THEME.paper }
  slide.addText(slideData.title, {
    x: 0.7, y: 0.5, w: 11.8, h: 0.7,
    fontFace: 'Calibri', fontSize: 30, bold: true, color: THEME.ink, margin: 0,
  })
  slide.addShape(pptx.ShapeType.rect, {
    x: 0.7, y: 1.15, w: 0.6, h: 0.04,
    fill: { color: THEME.ember },
    line: { color: THEME.ember, width: 0 },
  })

  const left = slideData.leftColumn || { title: '', bullets: [] }
  const right = slideData.rightColumn || { title: '', bullets: [] }

  slide.addShape(pptx.ShapeType.rect, {
    x: 0.5, y: 1.5, w: 5.8, h: 4.8,
    fill: { color: 'F8F4EC' },
    line: { color: THEME.skeleton, width: 0.5 },
  })
  slide.addShape(pptx.ShapeType.rect, {
    x: 6.8, y: 1.5, w: 5.8, h: 4.8,
    fill: { color: 'F8F4EC' },
    line: { color: THEME.skeleton, width: 0.5 },
  })

  if (left.title) {
    slide.addText(left.title, {
      x: 0.7, y: 1.7, w: 5.4, h: 0.5,
      fontFace: 'Calibri', fontSize: 18, bold: true, color: THEME.cyan, margin: 0,
    })
  }
  if (left.bullets.length) {
    slide.addText(
      left.bullets.map((b) => ({ text: b, options: { bullet: { type: 'bullet' }, breakLine: true, paraSpaceAfterPt: 6 } })),
      {
        x: 0.8, y: 2.3, w: 5.2, h: 3.8,
        fontFace: 'Calibri', fontSize: 14, color: THEME.inkSoft,
        breakLine: false, fit: 'shrink',
      }
    )
  }

  if (right.title) {
    slide.addText(right.title, {
      x: 7.0, y: 1.7, w: 5.4, h: 0.5,
      fontFace: 'Calibri', fontSize: 18, bold: true, color: THEME.ember, margin: 0,
    })
  }
  if (right.bullets.length) {
    slide.addText(
      right.bullets.map((b) => ({ text: b, options: { bullet: { type: 'bullet' }, breakLine: true, paraSpaceAfterPt: 6 } })),
      {
        x: 7.1, y: 2.3, w: 5.2, h: 3.8,
        fontFace: 'Calibri', fontSize: 14, color: THEME.inkSoft,
        breakLine: false, fit: 'shrink',
      }
    )
  }

  addBottomLine(slide)
  addPageNumber(slide, index, total)
}

/* ── Table ── */

function addTableSlide(pptx, slideData, index, total) {
  const slide = pptx.addSlide()
  slide.background = { color: THEME.paper }
  slide.addText(slideData.title, {
    x: 0.7, y: 0.5, w: 11.8, h: 0.7,
    fontFace: 'Calibri', fontSize: 30, bold: true, color: THEME.ink, margin: 0,
  })
  slide.addShape(pptx.ShapeType.rect, {
    x: 0.7, y: 1.15, w: 0.6, h: 0.04,
    fill: { color: THEME.cyan },
    line: { color: THEME.cyan, width: 0 },
  })

  const table = slideData.table || []
  if (table.length >= 2) {
    const cols = Math.max(...table.map((r) => r.length))
    const header = table[0]
    const body = table.slice(1)
    const tableData = [
      header.map((cell) => ({ text: cell, options: { bold: true, fill: THEME.cyan, color: THEME.white, fontFace: 'Calibri', fontSize: 13 } })),
      ...body.map((row) => row.map((cell) => ({ text: cell, options: { fill: 'F8F4EC', color: THEME.inkSoft, fontFace: 'Calibri', fontSize: 12 } }))),
    ]
    slide.addTable(tableData, {
      x: 0.7, y: 1.5, w: 12, h: 4.5,
      border: { type: 'solid', pt: 0.5, color: THEME.skeleton },
      colW: Array(cols).fill(12 / cols),
      autoPage: false,
    })
  }
  addBottomLine(slide)
  addPageNumber(slide, index, total)
}

/* ── Process ── */

function addProcessSlide(pptx, slideData, index, total) {
  const slide = pptx.addSlide()
  slide.background = { color: THEME.paper }
  slide.addText(slideData.title, {
    x: 0.7, y: 0.5, w: 11.8, h: 0.7,
    fontFace: 'Calibri', fontSize: 30, bold: true, color: THEME.ink, margin: 0,
  })
  slide.addShape(pptx.ShapeType.rect, {
    x: 0.7, y: 1.15, w: 0.6, h: 0.04,
    fill: { color: THEME.cyan },
    line: { color: THEME.cyan, width: 0 },
  })

  const steps = slideData.processSteps || []
  const count = Math.min(steps.length, 5)
  if (count > 0) {
    const stepW = 11.5 / count
    const startX = 0.7
    const y = 2.2

    steps.slice(0, count).forEach((step, i) => {
      const x = startX + i * stepW

      slide.addShape(pptx.ShapeType.ellipse, {
        x: x + stepW / 2 - 0.3, y, w: 0.6, h: 0.6,
        fill: { color: i % 2 === 0 ? THEME.ember : THEME.cyan },
        line: { color: i % 2 === 0 ? THEME.ember : THEME.cyan, width: 0 },
      })
      slide.addText(String(i + 1), {
        x: x + stepW / 2 - 0.3, y, w: 0.6, h: 0.6,
        fontFace: 'Calibri', fontSize: 16, bold: true, color: THEME.white,
        align: 'center', valign: 'middle', margin: 0,
      })

      slide.addText(step.name, {
        x, y: y + 0.8, w: stepW - 0.2, h: 0.5,
        fontFace: 'Calibri', fontSize: 14, bold: true, color: THEME.ink,
        align: 'center', margin: 0,
      })

      if (step.desc) {
        slide.addText(step.desc, {
          x, y: y + 1.3, w: stepW - 0.2, h: 1.5,
          fontFace: 'Calibri', fontSize: 11, color: THEME.inkSoft,
          align: 'center', margin: 0,
        })
      }

      if (i < count - 1) {
        slide.addShape(pptx.ShapeType.rect, {
          x: x + stepW - 0.15, y: y + 0.25, w: 0.3, h: 0.04,
          fill: { color: THEME.skeleton },
          line: { color: THEME.skeleton, width: 0 },
        })
        slide.addShape(pptx.ShapeType.triangle, {
          x: x + stepW + 0.05, y: y + 0.18, w: 0.12, h: 0.18,
          fill: { color: THEME.skeleton },
          line: { color: THEME.skeleton, width: 0 },
        })
      }
    })
  }
  addBottomLine(slide)
  addPageNumber(slide, index, total)
}

/* ── Chart ── */
// 用 pptxgenjs 原生 addChart 画柱/折/饼.调色板从主题 accent 派生,保持视觉一致.
const CHART_PALETTE = [THEME.ember, THEME.cyan, '8A7B68', '4A6B82', 'C97C5D', '3E7A8C']

function addChartSlide(pptx, slideData, index, total) {
  const slide = pptx.addSlide()
  slide.background = { color: THEME.paper }
  addAmbientDecor(slide, pptx, index)
  slide.addShape(pptx.ShapeType.rect, {
    x: 0, y: 0, w: 0.12, h: SLIDE_H,
    fill: { color: THEME.ember }, line: { color: THEME.ember, width: 0 },
  })
  slide.addText(slideData.title, {
    x: 0.7, y: 0.5, w: 11.8, h: 0.7,
    fontFace: 'Calibri', fontSize: 28, bold: true, color: THEME.ink, margin: 0,
  })
  slide.addShape(pptx.ShapeType.rect, {
    x: 0.7, y: 1.15, w: 0.6, h: 0.04,
    fill: { color: THEME.ember }, line: { color: THEME.ember, width: 0 },
  })

  const chart = slideData.chart || { type: 'bar', categories: [], series: [] }
  // PR4a: 扩展 chart 类型 — area/scatter/stacked 走 pptxgenjs 原生
  const chartType =
    chart.type === 'line' ? pptx.ChartType.line
    : chart.type === 'area' ? pptx.ChartType.area
    : chart.type === 'scatter' ? pptx.ChartType.scatter
    : chart.type === 'pie' ? pptx.ChartType.pie
    : pptx.ChartType.bar
  const isStacked = chart.type === 'stacked'

  let data
  if (chart.type === 'pie') {
    const first = chart.series[0] || { name: '占比', values: [] }
    data = [{
      name: first.name,
      labels: chart.categories.length ? chart.categories : first.values.map((_, i) => `项${i + 1}`),
      values: first.values,
    }]
  } else {
    data = chart.series.map((s) => ({
      name: s.name,
      labels: chart.categories.length ? chart.categories : s.values.map((_, i) => String(i + 1)),
      values: s.values,
    }))
  }

  if (data.length && data.some((d) => d.values && d.values.length)) {
    slide.addChart(isStacked ? pptx.ChartType.bar : chartType, data, {
      x: 0.7, y: 1.55, w: 12, h: 5.1,
      chartColors: CHART_PALETTE.slice(0, Math.max(1, data.length)),
      showLegend: data.length > 1 || chart.type === 'pie',
      legendPos: 'b',
      legendFontFace: 'Calibri',
      legendFontSize: 11,
      legendColor: THEME.inkSoft,
      catAxisLabelFontFace: 'Calibri',
      catAxisLabelFontSize: 10,
      catAxisLabelColor: THEME.inkSoft,
      valAxisLabelFontFace: 'Calibri',
      valAxisLabelFontSize: 10,
      valAxisLabelColor: THEME.inkSoft,
      dataLabelColor: THEME.ink,
      dataLabelFontFace: 'Calibri',
      dataLabelFontSize: 10,
      showValue: chart.type === 'pie',
      barGapWidthPct: 60,
      barGrouping: isStacked ? 'stacked' : 'clustered',
      lineDataSymbol: chart.type === 'line' || chart.type === 'area' ? 'circle' : undefined,
      lineDataSymbolSize: chart.type === 'line' || chart.type === 'area' ? 6 : undefined,
      catGridLine: { style: 'none' },
      valGridLine: { color: THEME.skeleton, style: 'solid', size: 0.5 },
    })
  } else {
    slide.addText('（图表数据缺失）', {
      x: 0.7, y: 3, w: 12, h: 0.5,
      fontFace: 'Calibri', fontSize: 14, color: THEME.inkFade, align: 'center', margin: 0,
    })
  }

  addBottomLine(slide)
  addPageNumber(slide, index, total)
}

/* ── Section ── */

function addSectionSlide(pptx, slideData, index, total) {
  const slide = pptx.addSlide()
  slide.addShape(pptx.ShapeType.rect, {
    x: 0, y: 0, w: SLIDE_W, h: SLIDE_H,
    fill: {
      type: 'gradient',
      angle: 90,
      stops: [{ color: THEME.paper, position: 0 }, { color: THEME.paper2, position: 100 }],
    },
    line: { color: THEME.paper, width: 0 },
  })
  addAmbientDecor(slide, pptx, index, { dense: true })
  const sectionNum = String(index + 1).padStart(2, '0')
  slide.addText(sectionNum, {
    x: 0.5, y: 1.5, w: 4, h: 2,
    fontFace: 'Calibri', fontSize: 96, bold: true, color: THEME.ember, margin: 0,
  })
  slide.addText(slideData.title, {
    x: 0.7, y: 3.5, w: 11, h: 1,
    fontFace: 'Calibri', fontSize: 36, bold: true, color: THEME.ink, margin: 0,
  })
  if (slideData.bullets?.[0]) {
    slide.addText(slideData.bullets[0], {
      x: 0.7, y: 4.6, w: 11, h: 0.6,
      fontFace: 'Calibri', fontSize: 16, color: THEME.inkSoft, margin: 0,
    })
  }
  slide.addShape(pptx.ShapeType.rect, {
    x: 0.7, y: 4.3, w: 2, h: 0.04,
    fill: { color: THEME.ember },
    line: { color: THEME.ember, width: 0 },
  })
  addPageNumber(slide, index, total)
}

/* ── Main builder ── */

async function buildPresentationFromMarkdown(markdown, { title } = {}) {
  const slides = parseMarkdownSlides(markdown)
  if (!slides.length) throw new Error('没有可导出的 PPT 内容')
  THEME = resolvePresentationTheme(`${title || ''} ${slides.map((slide) => slide.title).join(' ')}`)

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
    headFontFace: 'Calibri',
    bodyFontFace: 'Calibri',
    lang: 'zh-CN',
  }

  const total = slides.length

  slides.forEach((slideData, index) => {
    const type = slideData.type
    switch (type) {
      case 'cover': addCoverSlide(pptx, slideData, index, total); break
      case 'toc': addTocSlide(pptx, slideData, index, total); break
      case 'image': addImageSlide(pptx, slideData, index, total); break
      case 'end': addEndSlide(pptx, slideData, index, total); break
      case 'data': addDataSlide(pptx, slideData, index, total); break
      case 'quote': addQuoteSlide(pptx, slideData, index, total); break
      case 'split': addSplitSlide(pptx, slideData, index, total); break
      case 'table': addTableSlide(pptx, slideData, index, total); break
      case 'process': addProcessSlide(pptx, slideData, index, total); break
      case 'chart': addChartSlide(pptx, slideData, index, total); break
      case 'section': addSectionSlide(pptx, slideData, index, total); break
      default: addContentSlide(pptx, slideData, index, total)
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
  const raw = await pptx.write({ outputType: 'blob' })
  const buf = raw instanceof Blob ? new Uint8Array(await raw.arrayBuffer()) : raw
  const injected = await injectEaFont(buf, CJK_FONT)
  return new Blob([injected], { type: PPTX_MIME })
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

/* SVG chart renderer — 共享给 normal HTML 预览和 Premium HTML 截图导出.
   Premium 走深色 bg 与高对比色,普通预览走 paper bg 与柔和坐标轴. */
function niceCeil(v) {
  if (v <= 0) return 1
  const mag = Math.pow(10, Math.floor(Math.log10(v)))
  const norm = v / mag
  const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10
  return nice * mag
}
function formatChartNumber(v) {
  const abs = Math.abs(v)
  if (abs >= 10000) return (v / 1000).toFixed(0) + 'k'
  if (abs >= 1000) return (v / 1000).toFixed(1) + 'k'
  if (Number.isInteger(v)) return String(v)
  return v.toFixed(1)
}
function buildChartSvg(chart, opts) {
  const { palette, axisColor, gridColor, labelColor, valueColor, bg } = opts
  const W = 1080, H = 540
  const PAD = { top: 36, right: 40, bottom: 60, left: 70 }
  const innerW = W - PAD.left - PAD.right
  const innerH = H - PAD.top - PAD.bottom
  const series = (chart?.series || []).filter((s) => s && Array.isArray(s.values) && s.values.length)
  const categories = chart?.categories || []
  if (!series.length) return ''

  const bgRect = bg ? `<rect width="${W}" height="${H}" fill="${bg}"/>` : ''

  if (chart.type === 'pie') {
    const s0 = series[0]
    const total = s0.values.reduce((a, b) => a + Math.max(0, Number(b) || 0), 0)
    if (!total) return ''
    const cx = W / 2 - 120, cy = H / 2 + 10
    const R = Math.min(innerW, innerH) / 2 - 20
    let angle = -Math.PI / 2
    const slices = []
    const legendItems = []
    s0.values.forEach((v, i) => {
      const a = Math.max(0, Number(v) || 0)
      if (a <= 0) return
      const frac = a / total
      const da = frac * Math.PI * 2
      const x1 = cx + R * Math.cos(angle), y1 = cy + R * Math.sin(angle)
      const x2 = cx + R * Math.cos(angle + da), y2 = cy + R * Math.sin(angle + da)
      const large = da > Math.PI ? 1 : 0
      const color = palette[i % palette.length]
      slices.push(`<path d="M ${cx} ${cy} L ${x1.toFixed(1)} ${y1.toFixed(1)} A ${R} ${R} 0 ${large} 1 ${x2.toFixed(1)} ${y2.toFixed(1)} Z" fill="${color}" opacity="0.92"/>`)
      const labelAngle = angle + da / 2
      const labelR = R * 0.62
      const lx = cx + labelR * Math.cos(labelAngle), ly = cy + labelR * Math.sin(labelAngle)
      slices.push(`<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" fill="#fff" font-size="14" font-weight="700" text-anchor="middle" dominant-baseline="middle">${(frac * 100).toFixed(1)}%</text>`)
      legendItems.push({ cat: categories[i] || `项${i + 1}`, color })
      angle += da
    })
    const legendX = cx + R + 60
    const legend = legendItems.map((it, i) => {
      const y = cy - (legendItems.length * 28) / 2 + i * 28
      return `<rect x="${legendX}" y="${y - 10}" width="14" height="14" rx="2" fill="${it.color}"/>` +
        `<text x="${legendX + 22}" y="${y}" fill="${labelColor}" font-size="14" dominant-baseline="middle">${escapeHtml(it.cat)}</text>`
    }).join('')
    return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet" style="width:100%;height:100%;display:block">
${bgRect}${slices.join('')}${legend}</svg>`
  }

  const allValues = series.flatMap((s) => s.values.map((v) => Number(v) || 0))
  const maxV = Math.max(...allValues, 0)
  const minV = Math.min(...allValues, 0)
  const niceMax = niceCeil(maxV || 1)
  const niceMin = minV < 0 ? -niceCeil(-minV) : 0
  const span = niceMax - niceMin || 1
  const yToPx = (v) => PAD.top + innerH - ((v - niceMin) / span) * innerH
  const catCount = Math.max(...series.map((s) => s.values.length), 1)
  const xStep = innerW / catCount

  let grid = ''
  const ticks = 4
  for (let t = 0; t <= ticks; t++) {
    const v = niceMin + (span * t / ticks)
    const y = yToPx(v).toFixed(1)
    grid += `<line x1="${PAD.left}" y1="${y}" x2="${PAD.left + innerW}" y2="${y}" stroke="${gridColor}" stroke-width="0.5"/>` +
      `<text x="${PAD.left - 8}" y="${y}" fill="${labelColor}" font-size="11" text-anchor="end" dominant-baseline="middle">${formatChartNumber(v)}</text>`
  }

  let xLabels = ''
  for (let i = 0; i < catCount; i++) {
    const x = PAD.left + xStep * (i + 0.5)
    const cat = categories[i] || ''
    xLabels += `<text x="${x.toFixed(1)}" y="${(PAD.top + innerH + 22).toFixed(1)}" fill="${labelColor}" font-size="12" text-anchor="middle">${escapeHtml(cat)}</text>`
  }

  let body
  if (chart.type === 'line' || chart.type === 'area') {
    body = series.map((s, sIdx) => {
      const color = palette[sIdx % palette.length]
      const points = s.values.map((v, i) => [PAD.left + xStep * (i + 0.5), yToPx(Number(v) || 0)])
      const path = points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`).join(' ')
      const dots = points.map(([x, y]) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4.5" fill="${color}" stroke="${bg || '#fff'}" stroke-width="2"/>`).join('')
      // PR4a: area = line + 下方填半透明色块
      let area = ''
      if (chart.type === 'area' && points.length) {
        const y0 = yToPx(0).toFixed(1)
        const first = points[0]
        const last = points[points.length - 1]
        const areaPath = `M ${first[0].toFixed(1)} ${y0} ${path} L ${last[0].toFixed(1)} ${y0} Z`
        area = `<path d="${areaPath}" fill="${color}" opacity="0.18" stroke="none"/>`
      }
      return `${area}<path d="${path}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>${dots}`
    }).join('')
  } else if (chart.type === 'scatter') {
    // PR4a: 散点 — 仅圆点,无连线
    body = series.map((s, sIdx) => {
      const color = palette[sIdx % palette.length]
      return s.values.map((v, i) => {
        const x = PAD.left + xStep * (i + 0.5)
        const y = yToPx(Number(v) || 0)
        return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="5.5" fill="${color}" opacity="0.85" stroke="${bg || '#fff'}" stroke-width="1.5"/>`
      }).join('')
    }).join('')
  } else if (chart.type === 'stacked') {
    // PR4a: 堆叠柱 — 同 category 下,各 series 正值依次叠加
    const groupGap = 0.28
    const barW = Math.max(8, xStep * (1 - groupGap))
    const stacks = []
    const catCount = categories.length || Math.max(...series.map((s) => s.values.length))
    for (let i = 0; i < catCount; i++) {
      let cumPos = 0
      let cumNeg = 0
      series.forEach((s, sIdx) => {
        const color = palette[sIdx % palette.length]
        const val = Number(s.values[i]) || 0
        if (val === 0) return
        const x = PAD.left + xStep * i + (xStep * groupGap) / 2
        if (val >= 0) {
          const yTop = yToPx(cumPos + val)
          const yBot = yToPx(cumPos)
          stacks.push(`<rect x="${x.toFixed(1)}" y="${yTop.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(2, yBot - yTop).toFixed(1)}" fill="${color}" rx="2"/>`)
          cumPos += val
        } else {
          const yTop = yToPx(cumNeg)
          const yBot = yToPx(cumNeg + val)
          stacks.push(`<rect x="${x.toFixed(1)}" y="${yTop.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(2, yBot - yTop).toFixed(1)}" fill="${color}" rx="2"/>`)
          cumNeg += val
        }
      })
      if (cumPos > 0) {
        const yTop = yToPx(cumPos)
        const cx = PAD.left + xStep * i + (xStep * groupGap) / 2 + barW / 2
        stacks.push(`<text x="${cx.toFixed(1)}" y="${(yTop - 6).toFixed(1)}" fill="${valueColor}" font-size="11" font-weight="600" text-anchor="middle">${formatChartNumber(cumPos)}</text>`)
      }
    }
    body = stacks.join('')
  } else {
    const groupGap = 0.28
    const barGroupW = xStep * (1 - groupGap)
    const barW = Math.max(8, barGroupW / series.length)
    body = series.map((s, sIdx) => {
      const color = palette[sIdx % palette.length]
      return s.values.map((v, i) => {
        const val = Number(v) || 0
        const x = PAD.left + xStep * i + (xStep * groupGap) / 2 + barW * sIdx
        const y0 = yToPx(0)
        const y = yToPx(val)
        const top = Math.min(y, y0)
        const h = Math.max(2, Math.abs(y - y0))
        return `<rect x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" fill="${color}" rx="2"/>` +
          `<text x="${(x + barW / 2).toFixed(1)}" y="${(top - 6).toFixed(1)}" fill="${valueColor}" font-size="11" font-weight="600" text-anchor="middle">${formatChartNumber(val)}</text>`
      }).join('')
    }).join('')
  }

  let legend = ''
  if (series.length > 1) {
    const lY = 22
    legend = series.map((s, i) => {
      const color = palette[i % palette.length]
      const lx = PAD.left + i * 160
      return `<rect x="${lx}" y="${lY - 10}" width="12" height="12" rx="2" fill="${color}"/>` +
        `<text x="${lx + 18}" y="${lY}" fill="${labelColor}" font-size="12" dominant-baseline="middle">${escapeHtml(s.name)}</text>`
    }).join('')
  }

  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet" style="width:100%;height:100%;display:block">
${bgRect}${grid}<line x1="${PAD.left}" y1="${PAD.top}" x2="${PAD.left}" y2="${PAD.top + innerH}" stroke="${axisColor}" stroke-width="1"/><line x1="${PAD.left}" y1="${(PAD.top + innerH).toFixed(1)}" x2="${PAD.left + innerW}" y2="${(PAD.top + innerH).toFixed(1)}" stroke="${axisColor}" stroke-width="1"/>${body}${xLabels}${legend}</svg>`
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

/* Data */
.slide-data {
  background: #F4EFE5;
  display: flex;
  flex-direction: column;
  padding: 14px 18px;
}
.data-header {
  margin-bottom: 6px;
}
.data-title {
  font-size: 16px;
  font-weight: 600;
  color: #2A1F17;
}
.data-line {
  width: 24px;
  height: 2px;
  background: #E86A3C;
  margin-top: 5px;
}
.data-grid {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 8px 0;
}
.data-card {
  flex: 1;
  text-align: center;
  max-width: 180px;
}
.data-value {
  font-size: 28px;
  font-weight: 700;
  color: #E86A3C;
}
.data-label {
  font-size: 10px;
  color: #5E4F40;
  margin-top: 4px;
}
.data-card-line {
  width: 30px;
  height: 2px;
  background: #E86A3C;
  margin: 6px auto 0;
  border-radius: 1px;
}

/* Quote */
.slide-quote {
  background: linear-gradient(180deg, #F4EFE5 0%, #EAE2D2 100%);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
}
.quote-mark {
  font-size: 56px;
  font-weight: 700;
  color: #E86A3C;
  line-height: 1;
  position: absolute;
  top: 12px;
  left: 16px;
}
.quote-text {
  font-size: 18px;
  font-style: italic;
  color: #2A1F17;
  max-width: 80%;
  line-height: 1.5;
}
.quote-source {
  font-size: 11px;
  color: #8A7B68;
  margin-top: 10px;
}
.quote-bottom-line {
  position: absolute;
  bottom: 16px;
  width: 40px;
  height: 3px;
  background: #E86A3C;
  border-radius: 2px;
}

/* Split */
.slide-split {
  background: #F4EFE5;
  display: flex;
  flex-direction: column;
  padding: 14px 18px;
}
.split-header {
  margin-bottom: 6px;
}
.split-title {
  font-size: 16px;
  font-weight: 600;
  color: #2A1F17;
}
.split-line {
  width: 24px;
  height: 2px;
  background: #E86A3C;
  margin-top: 5px;
}
.split-body {
  flex: 1;
  display: flex;
  gap: 10px;
  overflow: hidden;
}
.split-col {
  flex: 1;
  background: #F8F4EC;
  border: 1px solid #DBD2BE;
  border-radius: 4px;
  padding: 10px;
  display: flex;
  flex-direction: column;
}
.split-col-title {
  font-size: 12px;
  font-weight: 700;
  margin-bottom: 6px;
}
.split-col-cyan { color: #2E8FA3; }
.split-col-ember { color: #E86A3C; }
.split-col-bullets {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
  overflow: hidden;
}
.split-col-bullets li {
  font-size: 10px;
  color: #5E4F40;
  line-height: 1.35;
  display: flex;
  gap: 4px;
}
.split-col-bullets li::before {
  content: '•';
  flex-shrink: 0;
}

/* Table */
.slide-table {
  background: #F4EFE5;
  display: flex;
  flex-direction: column;
  padding: 14px 18px;
}
.table-header {
  margin-bottom: 6px;
}
.table-title {
  font-size: 16px;
  font-weight: 600;
  color: #2A1F17;
}
.table-line {
  width: 24px;
  height: 2px;
  background: #2E8FA3;
  margin-top: 5px;
}
.table-body {
  flex: 1;
  overflow: auto;
  display: flex;
  align-items: center;
}
.table-body table {
  width: 100%;
  border-collapse: collapse;
  font-size: 10px;
}
.table-body th {
  background: #2E8FA3;
  color: white;
  padding: 6px 8px;
  text-align: left;
  font-weight: 600;
}
.table-body td {
  background: #F8F4EC;
  color: #5E4F40;
  padding: 5px 8px;
  border-bottom: 1px solid #DBD2BE;
}

/* Process */
.slide-process {
  background: #F4EFE5;
  display: flex;
  flex-direction: column;
  padding: 14px 18px;
}
.process-header {
  margin-bottom: 6px;
}
.process-title {
  font-size: 16px;
  font-weight: 600;
  color: #2A1F17;
}
.process-line {
  width: 24px;
  height: 2px;
  background: #2E8FA3;
  margin-top: 5px;
}
.process-body {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 8px 0;
}
.process-step {
  flex: 1;
  text-align: center;
  max-width: 140px;
}
.process-circle {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 700;
  color: white;
  margin-bottom: 6px;
}
.process-circle-ember { background: #E86A3C; }
.process-circle-cyan { background: #2E8FA3; }
.process-name {
  font-size: 11px;
  font-weight: 600;
  color: #2A1F17;
}
.process-desc {
  font-size: 9px;
  color: #5E4F40;
  margin-top: 3px;
}
.process-arrow {
  font-size: 14px;
  color: #DBD2BE;
  flex-shrink: 0;
}

/* Section */
.slide-section {
  background: linear-gradient(90deg, #F4EFE5 0%, #EAE2D2 100%);
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding: 20px 30px;
}
.section-number {
  font-size: 56px;
  font-weight: 700;
  color: #E86A3C;
  line-height: 1;
}
.section-title {
  font-size: 22px;
  font-weight: 700;
  color: #2A1F17;
  margin-top: 8px;
}
.section-desc {
  font-size: 12px;
  color: #5E4F40;
  margin-top: 6px;
}
.section-line {
  width: 30px;
  height: 3px;
  background: #E86A3C;
  margin-top: 10px;
  border-radius: 2px;
}
`

function buildSlideHtml(slide, index, total) {
  const num = String(index + 1).padStart(2, '0')
  const totalStr = String(total).padStart(2, '0')
  const type = slide.type || 'content'

  switch (type) {
    case 'cover': {
      const subtitle = slide.bullets?.[0] ? `<p class="cover-subtitle">${escapeHtml(slide.bullets[0])}</p>` : ''
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
      const subtitle = slide.bullets?.[0] ? `<p class="end-subtitle">${escapeHtml(slide.bullets[0])}</p>` : ''
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
    case 'data': {
      const cards = (slide.dataPoints || []).slice(0, 4).map((p) => `
  <div class="data-card">
    <div class="data-value">${escapeHtml(p.value)}</div>
    <div class="data-label">${escapeHtml(p.label)}</div>
    <div class="data-card-line"></div>
  </div>`).join('')
      return `<div class="slide slide-data">
  <div class="data-header">
    <div class="slide-number">SLIDE ${num} / ${totalStr}</div>
    <h2 class="data-title">${escapeHtml(slide.title)}</h2>
    <div class="data-line"></div>
  </div>
  <div class="data-grid">${cards}
  </div>
</div>`
    }
    case 'quote': {
      const q = slide.quote || { text: '', source: '' }
      const sourceHtml = q.source ? `<div class="quote-source">— ${escapeHtml(q.source)}</div>` : ''
      return `<div class="slide slide-quote">
  <div class="slide-number">SLIDE ${num} / ${totalStr}</div>
  <div class="quote-mark">"</div>
  <div class="quote-text">${escapeHtml(q.text)}</div>
  ${sourceHtml}
  <div class="quote-bottom-line"></div>
</div>`
    }
    case 'split': {
      const left = slide.leftColumn || { title: '', bullets: [] }
      const right = slide.rightColumn || { title: '', bullets: [] }
      const leftBullets = left.bullets.map(b => `<li>${escapeHtml(b)}</li>`).join('')
      const rightBullets = right.bullets.map(b => `<li>${escapeHtml(b)}</li>`).join('')
      return `<div class="slide slide-split">
  <div class="split-header">
    <div class="slide-number">SLIDE ${num} / ${totalStr}</div>
    <h2 class="split-title">${escapeHtml(slide.title)}</h2>
    <div class="split-line"></div>
  </div>
  <div class="split-body">
    <div class="split-col">
      <div class="split-col-title split-col-cyan">${escapeHtml(left.title)}</div>
      <ul class="split-col-bullets">${leftBullets}</ul>
    </div>
    <div class="split-col">
      <div class="split-col-title split-col-ember">${escapeHtml(right.title)}</div>
      <ul class="split-col-bullets">${rightBullets}</ul>
    </div>
  </div>
</div>`
    }
    case 'table': {
      const table = slide.table || []
      let tableHtml = ''
      if (table.length >= 2) {
        const header = table[0]
        const body = table.slice(1)
        const th = header.map(c => `<th>${escapeHtml(c)}</th>`).join('')
        const tr = body.map(row => `<tr>${row.map(c => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`).join('')
        tableHtml = `<table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table>`
      }
      return `<div class="slide slide-table">
  <div class="table-header">
    <div class="slide-number">SLIDE ${num} / ${totalStr}</div>
    <h2 class="table-title">${escapeHtml(slide.title)}</h2>
    <div class="table-line"></div>
  </div>
  <div class="table-body">${tableHtml}</div>
</div>`
    }
    case 'process': {
      const steps = (slide.processSteps || []).slice(0, 5).map((step, i) => {
        const cls = i % 2 === 0 ? 'process-circle-ember' : 'process-circle-cyan'
        const arrow = i < (slide.processSteps || []).length - 1 && i < 4 ? '<div class="process-arrow">→</div>' : ''
        const desc = step.desc ? `<div class="process-desc">${escapeHtml(step.desc)}</div>` : ''
        return `
  <div class="process-step">
    <div class="process-circle ${cls}">${i + 1}</div>
    <div class="process-name">${escapeHtml(step.name)}</div>
    ${desc}
  </div>${arrow}`
      }).join('')
      return `<div class="slide slide-process">
  <div class="process-header">
    <div class="slide-number">SLIDE ${num} / ${totalStr}</div>
    <h2 class="process-title">${escapeHtml(slide.title)}</h2>
    <div class="process-line"></div>
  </div>
  <div class="process-body">${steps}
  </div>
</div>`
    }
    case 'section': {
      const desc = slide.bullets?.[0] ? `<div class="section-desc">${escapeHtml(slide.bullets[0])}</div>` : ''
      return `<div class="slide slide-section">
  <div class="slide-number">SLIDE ${num} / ${totalStr}</div>
  <div class="section-number">${num}</div>
  <h1 class="section-title">${escapeHtml(slide.title)}</h1>
  ${desc}
  <div class="section-line"></div>
</div>`
    }
    case 'chart': {
      const svg = buildChartSvg(slide.chart, {
        palette: ['#E86A3C', '#2E8FA3', '#8A7B68', '#4A6B82', '#C97C5D', '#3E7A8C'],
        axisColor: '#8A7B68',
        gridColor: 'rgba(42,31,23,0.10)',
        labelColor: '#5E4F40',
        valueColor: '#2A1F17',
        bg: '',
      })
      return `<div class="slide slide-chart" style="background:#F4EFE5;padding:48px 56px;display:flex;flex-direction:column;box-sizing:border-box">
  <div class="slide-number">SLIDE ${num} / ${totalStr}</div>
  <h2 style="font-family:'Calibri','Source Han Sans SC',sans-serif;font-size:28px;font-weight:700;color:#2A1F17;margin:0 0 6px 0">${escapeHtml(slide.title)}</h2>
  <div style="width:48px;height:3px;background:#E86A3C;margin-bottom:14px;border-radius:2px"></div>
  <div style="flex:1;min-height:0">${svg || '<div style="color:#8A7B68;font-size:13px">（图表数据缺失）</div>'}</div>
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

export function buildClassicHtmlPreview(markdown) {
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

export function buildHtmlPreview(markdown) {
  return buildPremiumHtmlPreview(markdown, { responsive: true })
}


/* ═══════════════════════════════════════════════════════════════════════
   Premium Visual Export — HTML Screenshot → PPTX
   ═══════════════════════════════════════════════════════════════════════ */



/* ═══════════════════════════════════════════════════════════════════════
   Premium Visual Export — HTML Screenshot → PPTX  (v2)
   ═══════════════════════════════════════════════════════════════════════ */

const PREMIUM_CSS = `
* { margin:0; padding:0; box-sizing:border-box; }
html,body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', 'Helvetica Neue', Helvetica, Arial, sans-serif;
  background:#0a0908;
}
.slide {
  width:1920px;
  height:1080px;
  position:relative;
  overflow:hidden;
  background:#F4EFE5;
}

/* ── utilities ── */
.grid-bg {
  position:absolute; inset:0;
  background-image:
    linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px);
  background-size:60px 60px;
  pointer-events:none;
}
.grid-bg-light {
  position:absolute; inset:0;
  background-image:
    linear-gradient(rgba(42,31,23,0.04) 1px, transparent 1px),
    linear-gradient(90deg, rgba(42,31,23,0.04) 1px, transparent 1px);
  background-size:48px 48px;
  pointer-events:none;
}
.dot-texture {
  position:absolute; inset:0;
  background-image: radial-gradient(circle, rgba(255,255,255,0.06) 1px, transparent 1px);
  background-size:24px 24px;
  pointer-events:none;
}
.glow-ember {
  position:absolute;
  border-radius:50%;
  filter:blur(80px);
  opacity:0.35;
  pointer-events:none;
}
.glow-cyan {
  position:absolute;
  border-radius:50%;
  filter:blur(80px);
  opacity:0.25;
  pointer-events:none;
}
.accent-bar-v {
  position:absolute;
  left:0; top:0; bottom:0;
  width:6px;
  background: linear-gradient(180deg, #E86A3C 0%, #2E8FA3 100%);
}
.accent-bar-h {
  position:absolute;
  left:0; right:0;
  height:6px;
  background: linear-gradient(90deg, #E86A3C 0%, #2E8FA3 100%);
}
.corner-badge {
  position:absolute;
  top:40px; right:50px;
  font-size:14px;
  font-weight:600;
  letter-spacing:4px;
  text-transform:uppercase;
  color:#8A7B68;
  padding:8px 16px;
  border:1px solid rgba(138,123,104,0.3);
  border-radius:4px;
}

/* ── Cover ── */
.slide-cover {
  background: linear-gradient(160deg, #12100e 0%, #1a1712 35%, #0f0d0b 70%, #1a1510 100%);
  display:flex;
  flex-direction:column;
  align-items:center;
  justify-content:center;
}
.slide-cover .glow-ember {
  width:900px; height:900px;
  top:-300px; right:-250px;
  background: radial-gradient(circle, rgba(232,106,60,0.5) 0%, transparent 60%);
}
.slide-cover .glow-cyan {
  width:700px; height:700px;
  bottom:-250px; left:-200px;
  background: radial-gradient(circle, rgba(46,143,163,0.4) 0%, transparent 60%);
}
.cover-grid { opacity:0.4; }
.cover-wave {
  position:absolute;
  bottom:0; left:0; right:0;
  height:180px;
  background: linear-gradient(180deg, transparent 0%, rgba(232,106,60,0.08) 100%);
  clip-path: polygon(0% 60%, 15% 45%, 35% 55%, 55% 35%, 75% 50%, 100% 30%, 100% 100%, 0% 100%);
}
.cover-tag {
  font-size:16px;
  letter-spacing:12px;
  text-transform:uppercase;
  color:#E86A3C;
  margin-bottom:50px;
  font-weight:700;
  padding:10px 24px;
  border:2px solid rgba(232,106,60,0.4);
  border-radius:4px;
  background: rgba(232,106,60,0.08);
}
.cover-title {
  font-size:110px;
  font-weight:900;
  letter-spacing:-3px;
  line-height:1.05;
  max-width:1500px;
  text-align:center;
  color:#F4EFE5;
  text-shadow: 0 4px 30px rgba(0,0,0,0.4);
}
.cover-subtitle {
  font-size:34px;
  color:#b8a88a;
  margin-top:45px;
  max-width:1100px;
  text-align:center;
  line-height:1.5;
  font-weight:400;
}
.cover-date {
  font-size:18px;
  color:#7a6e5a;
  margin-top:70px;
  letter-spacing:6px;
  font-weight:500;
}
.cover-line-bottom {
  position:absolute;
  bottom:80px; left:50%; transform:translateX(-50%);
  width:80px; height:4px;
  background: linear-gradient(90deg, transparent 0%, #E86A3C 50%, transparent 100%);
  border-radius:2px;
}
.cover-decor-ring {
  position:absolute;
  width:300px; height:300px;
  top:60px; right:80px;
  border:2px solid rgba(232,106,60,0.15);
  border-radius:50%;
}
.cover-decor-ring::before {
  content:'';
  position:absolute;
  inset:30px;
  border:1px solid rgba(46,143,163,0.12);
  border-radius:50%;
}

/* ── TOC ── */
.slide-toc {
  background: linear-gradient(135deg, #F4EFE5 0%, #EAE2D2 100%);
  display:flex;
}
.toc-sidebar {
  width:480px;
  background: linear-gradient(180deg, #1e1913 0%, #15120f 100%);
  display:flex;
  flex-direction:column;
  justify-content:center;
  padding:100px 60px;
  position:relative;
}
.toc-sidebar .dot-texture { opacity:0.5; }
.toc-sidebar-title {
  font-size:64px;
  font-weight:900;
  color:#F4EFE5;
  line-height:1.1;
  letter-spacing:-1px;
}
.toc-sidebar-sub {
  font-size:20px;
  letter-spacing:8px;
  text-transform:uppercase;
  color:#8A7B68;
  margin-top:24px;
}
.toc-sidebar-line {
  width:80px; height:5px;
  background: linear-gradient(90deg, #E86A3C 0%, #c9552e 100%);
  margin-top:50px;
  border-radius:3px;
}
.toc-sidebar-ring {
  position:absolute;
  width:200px; height:200px;
  top:60px; right:-60px;
  border:2px solid rgba(232,106,60,0.15);
  border-radius:50%;
}
.toc-main {
  flex:1;
  padding:100px 100px 100px 120px;
  display:flex;
  flex-direction:column;
  justify-content:center;
}
.toc-item {
  display:flex;
  align-items:baseline;
  gap:28px;
  padding:32px 0;
  border-bottom:1px solid rgba(219,210,190,0.5);
}
.toc-item-num {
  font-size:22px;
  font-weight:800;
  color:#E86A3C;
  font-variant-numeric: tabular-nums;
  min-width:48px;
}
.toc-item-text {
  font-size:30px;
  color:#2A1F17;
  font-weight:600;
  letter-spacing:-0.3px;
}

/* ── Section ── */
.slide-section {
  background: linear-gradient(135deg, #F4EFE5 0%, #EAE2D2 100%);
  display:flex;
  flex-direction:column;
  justify-content:center;
  padding-left:200px;
  position:relative;
}
.slide-section .grid-bg-light { opacity:0.6; }
.section-bg-num {
  position:absolute;
  top:50px; left:80px;
  font-size:280px;
  font-weight:900;
  color:rgba(232,106,60,0.06);
  line-height:1;
  font-variant-numeric:tabular-nums;
  letter-spacing:-10px;
}
.section-decor-tri {
  position:absolute;
  width:0; height:0;
  bottom:80px; right:100px;
  border-left:80px solid transparent;
  border-right:80px solid transparent;
  border-bottom:140px solid rgba(46,143,163,0.08);
  transform:rotate(15deg);
}
.section-title {
  font-size:88px;
  font-weight:900;
  color:#2A1F17;
  max-width:1300px;
  line-height:1.1;
  letter-spacing:-2px;
}
.section-desc {
  font-size:30px;
  color:#5E4F40;
  margin-top:35px;
  max-width:1000px;
  line-height:1.6;
}
.section-line {
  width:100px; height:6px;
  background: linear-gradient(90deg, #E86A3C 0%, #2E8FA3 100%);
  margin-top:45px;
  border-radius:3px;
}

/* ── Content ── */
.slide-content {
  background:#F4EFE5;
  display:flex;
  flex-direction:column;
  padding:100px 160px;
  position:relative;
}
.slide-content-light {
  background:
    radial-gradient(circle at 88% 18%, rgba(232,106,60,0.14) 0%, transparent 30%),
    radial-gradient(circle at 10% 82%, rgba(46,143,163,0.12) 0%, transparent 28%),
    linear-gradient(135deg, #F6F0E4 0%, #EAE2D2 100%);
}
.slide-content-dark {
  background:
    radial-gradient(circle at 82% 12%, rgba(232,106,60,0.26) 0%, transparent 30%),
    radial-gradient(circle at 14% 86%, rgba(46,143,163,0.24) 0%, transparent 32%),
    linear-gradient(145deg, #11100e 0%, #1b1712 48%, #0d0c0b 100%);
}
.slide-content .accent-bar-v {
  width:8px;
  background: linear-gradient(180deg, #E86A3C 0%, rgba(232,106,60,0.3) 70%, transparent 100%);
}
.slide-content-dark .accent-bar-v {
  background: linear-gradient(180deg, #E86A3C 0%, #2E8FA3 100%);
  box-shadow: 0 0 24px rgba(232,106,60,.45);
}
.content-orb {
  position:absolute;
  border-radius:999px;
  pointer-events:none;
  filter:blur(6px);
}
.content-orb-a {
  width:360px; height:360px;
  right:-120px; top:70px;
  border:1px solid rgba(232,106,60,.22);
  background:radial-gradient(circle, rgba(232,106,60,.10), transparent 62%);
}
.content-orb-b {
  width:220px; height:220px;
  left:96px; bottom:42px;
  border:1px solid rgba(46,143,163,.18);
  background:radial-gradient(circle, rgba(46,143,163,.10), transparent 64%);
}
.content-shard {
  position:absolute;
  width:240px; height:110px;
  right:120px; bottom:72px;
  transform:skewX(-18deg) rotate(-8deg);
  background:linear-gradient(135deg, rgba(255,255,255,.18), rgba(255,255,255,0));
  border:1px solid rgba(255,255,255,.18);
}
.content-tag {
  font-size:16px;
  letter-spacing:7px;
  text-transform:uppercase;
  color:#E86A3C;
  margin-bottom:20px;
  font-weight:700;
}
.content-title {
  font-size:64px;
  font-weight:900;
  color:#2A1F17;
  line-height:1.15;
  letter-spacing:-1px;
  max-width:1320px;
  position:relative;
  z-index:1;
}
.slide-content-dark .content-title {
  color:#F4EFE5;
  text-shadow:0 12px 42px rgba(0,0,0,.35);
}
.content-title-line {
  width:80px; height:5px;
  background: linear-gradient(90deg, #E86A3C 0%, #2E8FA3 100%);
  margin-top:28px;
  border-radius:3px;
  position:relative;
  z-index:1;
}
.content-card-grid {
  margin-top:58px;
  display:grid;
  grid-template-columns:repeat(2, minmax(0, 1fr));
  gap:28px;
  position:relative;
  z-index:1;
}
.slide-template-editorial .content-card-grid {
  grid-template-columns:1.18fr .82fr;
  grid-auto-rows:minmax(150px, auto);
  align-items:stretch;
}
.slide-template-editorial .content-card:first-child {
  grid-row:span 2;
  min-height:328px;
  padding:42px 44px;
  background:linear-gradient(145deg, rgba(255,255,255,.72), rgba(255,255,255,.45));
}
.slide-template-editorial .content-card:first-child .content-card-text {
  font-size:34px;
  line-height:1.34;
}
.slide-template-editorial .content-card:first-child .content-card-note {
  font-size:21px;
  line-height:1.56;
}
.slide-template-matrix .content-card-grid {
  grid-template-columns:repeat(2, minmax(0, 1fr));
  gap:24px;
}
.slide-template-matrix .content-card {
  min-height:158px;
  border-radius:22px;
  background:
    linear-gradient(135deg, rgba(255,255,255,.68), rgba(255,255,255,.38)),
    radial-gradient(circle at 92% 18%, rgba(46,143,163,.12), transparent 42%);
}
.slide-template-matrix .content-card:nth-child(2n) {
  background:
    linear-gradient(135deg, rgba(255,255,255,.64), rgba(255,255,255,.34)),
    radial-gradient(circle at 12% 88%, rgba(232,106,60,.12), transparent 44%);
}
.slide-template-dark-card {
  padding:92px 130px;
}
.slide-template-dark-card .grid-bg-light {
  opacity:.18;
  filter:invert(1);
}
.slide-template-dark-card .content-card-grid {
  grid-template-columns:repeat(4, minmax(0, 1fr));
  gap:20px;
  margin-top:52px;
}
.slide-template-dark-card .content-card {
  grid-template-columns:1fr;
  min-height:300px;
  padding:34px 28px;
  align-content:start;
  background:linear-gradient(180deg, rgba(244,239,229,.09), rgba(244,239,229,.035));
}
.slide-template-dark-card .content-card-index {
  width:48px;
  height:48px;
  border-radius:16px;
}
.slide-template-dark-card .content-card-text {
  font-size:25px;
}
.slide-template-dark-card .content-card-note {
  grid-column:1;
  margin-top:16px;
  font-size:17px;
  color:#C5B694;
}
.content-card {
  min-height:148px;
  border-radius:26px;
  padding:30px 34px;
  display:grid;
  grid-template-columns:64px 1fr;
  gap:20px;
  align-items:start;
  position:relative;
  overflow:hidden;
  background:rgba(255,255,255,.62);
  border:1px solid rgba(42,31,23,.08);
  box-shadow:0 18px 45px rgba(42,31,23,.08), inset 0 1px 0 rgba(255,255,255,.75);
  backdrop-filter:blur(14px);
}
.slide-content-dark .content-card {
  background:rgba(244,239,229,.055);
  border:1px solid rgba(244,239,229,.12);
  box-shadow:0 20px 55px rgba(0,0,0,.26), inset 0 1px 0 rgba(255,255,255,.08);
}
.content-card::after {
  content:'';
  position:absolute;
  left:0; right:0; top:0;
  height:4px;
  background:linear-gradient(90deg, #E86A3C 0%, #2E8FA3 100%);
  opacity:.82;
}
.content-card-index {
  width:54px; height:54px;
  border-radius:18px;
  display:flex;
  align-items:center;
  justify-content:center;
  font-weight:900;
  font-size:22px;
  color:#F4EFE5;
  background:linear-gradient(135deg, #E86A3C 0%, #2E8FA3 100%);
  box-shadow:0 12px 28px rgba(232,106,60,.22);
  font-variant-numeric:tabular-nums;
}
.content-card-text {
  font-size:28px;
  color:#33281f;
  line-height:1.42;
  font-weight:650;
  letter-spacing:-.2px;
}
.slide-content-dark .content-card-text {
  color:#F4EFE5;
}
.content-card-note {
  grid-column:2;
  margin-top:10px;
  font-size:18px;
  line-height:1.5;
  color:#7b6f5f;
}
.slide-content-dark .content-card-note {
  color:#A89B82;
}
.content-footer-line {
  position:absolute;
  bottom:50px; left:160px; right:160px;
  height:2px;
  background: linear-gradient(90deg, rgba(232,106,60,0.3) 0%, transparent 100%);
}
.slide-content-dark .content-footer-line {
  background:linear-gradient(90deg, rgba(232,106,60,.5), rgba(46,143,163,.18), transparent);
}

/* ── Data ── */
.slide-data {
  background: linear-gradient(180deg, #0f0d0b 0%, #1a1712 50%, #0f0d0b 100%);
  display:flex;
  flex-direction:column;
  padding:100px 140px;
  position:relative;
}
.slide-data .grid-bg { opacity:0.3; }
.data-glow-1 {
  position:absolute;
  width:800px; height:800px;
  top:-300px; right:-300px;
  border-radius:50%;
  background: radial-gradient(circle, rgba(232,106,60,0.2) 0%, transparent 55%);
  filter:blur(40px);
  pointer-events:none;
}
.data-glow-2 {
  position:absolute;
  width:600px; height:600px;
  bottom:-200px; left:-200px;
  border-radius:50%;
  background: radial-gradient(circle, rgba(46,143,163,0.15) 0%, transparent 55%);
  filter:blur(40px);
  pointer-events:none;
}
.data-tag {
  font-size:16px;
  letter-spacing:7px;
  text-transform:uppercase;
  color:#E86A3C;
  margin-bottom:20px;
  font-weight:700;
}
.data-title {
  font-size:64px;
  font-weight:900;
  color:#F4EFE5;
  line-height:1.15;
  letter-spacing:-1px;
}
.data-title-line {
  width:80px; height:5px;
  background: linear-gradient(90deg, #E86A3C 0%, #2E8FA3 100%);
  margin-top:28px;
  border-radius:3px;
}
.data-grid {
  display:flex;
  gap:40px;
  margin-top:70px;
}
.data-card {
  flex:1;
  background: rgba(244,239,229,0.04);
  border:1px solid rgba(244,239,229,0.1);
  border-radius:24px;
  padding:55px 35px;
  text-align:center;
  backdrop-filter:blur(16px);
  position:relative;
  box-shadow: 0 8px 32px rgba(0,0,0,0.2), inset 0 1px 0 rgba(255,255,255,0.05);
}
.data-card-glow {
  position:absolute;
  top:-1px; left:15%; right:15%;
  height:2px;
  background: linear-gradient(90deg, transparent 0%, #E86A3C 50%, transparent 100%);
  border-radius:2px;
}
.data-value {
  font-size:90px;
  font-weight:900;
  color:#E86A3C;
  line-height:1;
  letter-spacing:-2px;
}
.data-unit {
  font-size:44px;
  font-weight:700;
}
.data-label {
  font-size:24px;
  color:#a89b82;
  margin-top:24px;
  line-height:1.5;
}
.data-card-line {
  width:50px; height:3px;
  background: linear-gradient(90deg, #E86A3C 0%, #2E8FA3 100%);
  margin:35px auto 0;
  border-radius:2px;
}

/* ── Quote ── */
.slide-quote {
  background: linear-gradient(135deg, #15120f 0%, #1e1913 50%, #15120f 100%);
  display:flex;
  flex-direction:column;
  align-items:center;
  justify-content:center;
  padding:160px;
  position:relative;
}
.slide-quote .dot-texture { opacity:0.4; }
.quote-glow {
  position:absolute;
  width:600px; height:600px;
  top:-200px; left:-200px;
  border-radius:50%;
  background: radial-gradient(circle, rgba(46,143,163,0.2) 0%, transparent 55%);
  filter:blur(50px);
  pointer-events:none;
}
.quote-mark-svg {
  font-size:220px;
  font-weight:900;
  color:rgba(232,106,60,0.15);
  line-height:0.4;
  margin-bottom:20px;
  font-family: Georgia, serif;
}
.quote-text {
  font-size:52px;
  font-style:italic;
  line-height:1.55;
  max-width:1400px;
  text-align:center;
  color:#F4EFE5;
  font-weight:500;
}
.quote-line {
  width:80px; height:4px;
  background: linear-gradient(90deg, #E86A3C 0%, #2E8FA3 100%);
  margin:50px auto;
  border-radius:2px;
}
.quote-source {
  font-size:26px;
  color:#8a7d68;
}

/* ── Split ── */
.slide-split {
  background:#F4EFE5;
  display:flex;
  flex-direction:column;
  padding:100px 140px;
  position:relative;
}
.slide-split .grid-bg-light { opacity:0.5; }
.split-tag {
  font-size:16px;
  letter-spacing:7px;
  text-transform:uppercase;
  color:#E86A3C;
  margin-bottom:20px;
  font-weight:700;
}
.split-title {
  font-size:64px;
  font-weight:900;
  color:#2A1F17;
  line-height:1.15;
  letter-spacing:-1px;
}
.split-title-line {
  width:80px; height:5px;
  background: linear-gradient(90deg, #E86A3C 0%, #2E8FA3 100%);
  margin-top:28px;
  border-radius:3px;
}
.split-body {
  display:flex;
  gap:50px;
  margin-top:60px;
  flex:1;
}
.split-col {
  flex:1;
  padding:55px;
  border-radius:28px;
  display:flex;
  flex-direction:column;
  position:relative;
  overflow:hidden;
}
.split-col-cyan {
  background: linear-gradient(135deg, rgba(46,143,163,0.06) 0%, rgba(46,143,163,0.02) 100%);
  border:2px solid rgba(46,143,163,0.18);
  box-shadow: 0 4px 20px rgba(46,143,163,0.08);
}
.split-col-ember {
  background: linear-gradient(135deg, rgba(232,106,60,0.06) 0%, rgba(232,106,60,0.02) 100%);
  border:2px solid rgba(232,106,60,0.18);
  box-shadow: 0 4px 20px rgba(232,106,60,0.08);
}
.split-col-accent {
  position:absolute;
  top:0; left:0; right:0;
  height:5px;
  border-radius:28px 28px 0 0;
}
.split-col-cyan .split-col-accent {
  background: linear-gradient(90deg, #2E8FA3 0%, #236b7a 100%);
}
.split-col-ember .split-col-accent {
  background: linear-gradient(90deg, #E86A3C 0%, #c9552e 100%);
}
.split-col-title {
  font-size:40px;
  font-weight:900;
  margin-bottom:35px;
  letter-spacing:-0.5px;
}
.split-col-title-cyan { color:#2E8FA3; }
.split-col-title-ember { color:#E86A3C; }
.split-col-bullets { list-style:none; }
.split-col-bullets li {
  font-size:26px;
  color:#3d3328;
  line-height:1.6;
  padding:16px 0 16px 40px;
  position:relative;
  border-bottom:1px solid rgba(219,210,190,0.3);
}
.split-col-bullets li:last-child { border-bottom:none; }
.split-col-bullets li .bullet-square {
  position:absolute;
  left:0; top:24px;
  width:12px; height:12px;
  border-radius:3px;
}
.bullet-square-cyan { background: linear-gradient(135deg, #2E8FA3 0%, #236b7a 100%); }
.bullet-square-ember { background: linear-gradient(135deg, #E86A3C 0%, #c9552e 100%); }

/* ── Table ── */
.slide-table {
  background:#F4EFE5;
  display:flex;
  flex-direction:column;
  padding:100px 140px;
  position:relative;
}
.slide-table .grid-bg-light { opacity:0.5; }
.table-tag {
  font-size:16px;
  letter-spacing:7px;
  text-transform:uppercase;
  color:#2E8FA3;
  margin-bottom:20px;
  font-weight:700;
}
.table-title {
  font-size:64px;
  font-weight:900;
  color:#2A1F17;
  line-height:1.15;
  letter-spacing:-1px;
}
.table-title-line {
  width:80px; height:5px;
  background: linear-gradient(90deg, #2E8FA3 0%, #236b7a 100%);
  margin-top:28px;
  border-radius:3px;
}
.table-body {
  margin-top:55px;
  flex:1;
  overflow:auto;
}
.table-body table {
  width:100%;
  border-collapse:separate;
  border-spacing:0;
  font-size:26px;
  box-shadow: 0 8px 32px rgba(42,31,23,0.08);
  border-radius:16px;
  overflow:hidden;
}
.table-body th {
  background: linear-gradient(135deg, #2E8FA3 0%, #267a8c 100%);
  color:white;
  padding:32px 36px;
  text-align:left;
  font-weight:700;
}
.table-body th:first-child { border-radius:16px 0 0 0; }
.table-body th:last-child { border-radius:0 16px 0 0; }
.table-body td {
  background:white;
  color:#3d3328;
  padding:26px 36px;
  border-bottom:2px solid #EAE2D2;
  font-weight:500;
}
.table-body tr:last-child td:first-child { border-radius:0 0 0 16px; }
.table-body tr:last-child td:last-child { border-radius:0 0 16px 0; }
.table-body tr:nth-child(even) td { background:#faf8f4; }

/* ── Process ── */
.slide-process {
  background:#F4EFE5;
  display:flex;
  flex-direction:column;
  padding:100px 140px;
  position:relative;
}
.slide-process .grid-bg-light { opacity:0.5; }
.process-tag {
  font-size:16px;
  letter-spacing:7px;
  text-transform:uppercase;
  color:#2E8FA3;
  margin-bottom:20px;
  font-weight:700;
}
.process-title {
  font-size:64px;
  font-weight:900;
  color:#2A1F17;
  line-height:1.15;
  letter-spacing:-1px;
}
.process-title-line {
  width:80px; height:5px;
  background: linear-gradient(90deg, #2E8FA3 0%, #236b7a 100%);
  margin-top:28px;
  border-radius:3px;
}
.process-body {
  display:flex;
  align-items:flex-start;
  gap:20px;
  margin-top:70px;
  flex:1;
  position:relative;
}
.process-track {
  position:absolute;
  top:44px; left:90px; right:90px;
  height:3px;
  background: linear-gradient(90deg, #E86A3C 0%, #2E8FA3 100%);
  opacity:0.3;
  border-radius:2px;
}
.process-step {
  flex:1;
  text-align:center;
  display:flex;
  flex-direction:column;
  align-items:center;
  position:relative;
  z-index:1;
}
.process-circle {
  width:100px; height:100px;
  border-radius:50%;
  display:inline-flex;
  align-items:center;
  justify-content:center;
  font-size:40px;
  font-weight:900;
  color:white;
  margin-bottom:35px;
  box-shadow: 0 8px 30px rgba(0,0,0,0.2), inset 0 2px 4px rgba(255,255,255,0.2);
  position:relative;
}
.process-circle-ember { background: linear-gradient(135deg, #E86A3C 0%, #c9552e 100%); }
.process-circle-cyan { background: linear-gradient(135deg, #2E8FA3 0%, #236b7a 100%); }
.process-circle-ring {
  position:absolute;
  inset:-6px;
  border-radius:50%;
  border:2px solid rgba(255,255,255,0.15);
}
.process-name {
  font-size:30px;
  font-weight:800;
  color:#2A1F17;
}
.process-desc {
  font-size:22px;
  color:#5E4F40;
  margin-top:18px;
  line-height:1.5;
  max-width:300px;
}

/* ── Image ── */
.slide-image {
  background:#F4EFE5;
  display:flex;
  flex-direction:column;
  padding:100px 140px;
  position:relative;
}
.slide-image .grid-bg-light { opacity:0.5; }
.image-tag {
  font-size:16px;
  letter-spacing:7px;
  text-transform:uppercase;
  color:#E86A3C;
  margin-bottom:20px;
  font-weight:700;
}
.image-title {
  font-size:64px;
  font-weight:900;
  color:#2A1F17;
  line-height:1.15;
  letter-spacing:-1px;
}
.image-title-line {
  width:80px; height:5px;
  background: linear-gradient(90deg, #E86A3C 0%, #2E8FA3 100%);
  margin-top:28px;
  border-radius:3px;
}
.image-body {
  display:flex;
  gap:60px;
  margin-top:55px;
  flex:1;
  overflow:hidden;
}
.image-text { flex:1; }
.image-text ul { list-style:none; }
.image-text li {
  font-size:28px;
  color:#3d3328;
  line-height:1.6;
  padding:18px 0 18px 44px;
  position:relative;
  border-bottom:1px solid rgba(219,210,190,0.3);
}
.image-text li:last-child { border-bottom:none; }
.image-text li .bullet-diamond {
  position:absolute;
  left:0; top:26px;
  width:14px; height:14px;
  background: linear-gradient(135deg, #E86A3C 0%, #c9552e 100%);
  transform:rotate(45deg);
  border-radius:2px;
}
.image-placeholder {
  width:45%;
  background: linear-gradient(135deg, #EAE2D2 0%, #F4EFE5 100%);
  border:3px dashed rgba(201,191,168,0.6);
  border-radius:24px;
  display:flex;
  align-items:center;
  justify-content:center;
  font-size:26px;
  color:#8A7B68;
  position:relative;
  overflow:hidden;
}
.image-placeholder::before {
  content:'';
  position:absolute;
  inset:20px;
  border:2px dashed rgba(201,191,168,0.3);
  border-radius:16px;
}

/* ── End ── */
.slide-end {
  background: linear-gradient(160deg, #12100e 0%, #1a1712 35%, #0f0d0b 70%, #1a1510 100%);
  display:flex;
  flex-direction:column;
  align-items:center;
  justify-content:center;
  position:relative;
}
.slide-end .glow-cyan {
  width:900px; height:900px;
  top:-350px; left:-300px;
  background: radial-gradient(circle, rgba(46,143,163,0.5) 0%, transparent 55%);
}
.slide-end .glow-ember {
  width:700px; height:700px;
  bottom:-300px; right:-250px;
  background: radial-gradient(circle, rgba(232,106,60,0.4) 0%, transparent 55%);
}
.end-wave {
  position:absolute;
  top:0; left:0; right:0;
  height:180px;
  background: linear-gradient(0deg, transparent 0%, rgba(46,143,163,0.08) 100%);
  clip-path: polygon(0% 70%, 20% 50%, 40% 65%, 60% 45%, 80% 60%, 100% 40%, 100% 0%, 0% 0%);
}
.end-tag {
  font-size:18px;
  letter-spacing:10px;
  text-transform:uppercase;
  color:#2E8FA3;
  margin-bottom:45px;
  font-weight:700;
  padding:10px 24px;
  border:2px solid rgba(46,143,163,0.4);
  border-radius:4px;
  background: rgba(46,143,163,0.08);
}
.end-title {
  font-size:100px;
  font-weight:900;
  letter-spacing:6px;
  color:#F4EFE5;
  text-shadow: 0 4px 30px rgba(0,0,0,0.4);
}
.end-subtitle {
  font-size:32px;
  color:#b8a88a;
  margin-top:35px;
  max-width:1000px;
  text-align:center;
}
.end-line-bottom {
  position:absolute;
  bottom:80px; left:50%; transform:translateX(-50%);
  width:80px; height:4px;
  background: linear-gradient(90deg, transparent 0%, #2E8FA3 50%, transparent 100%);
  border-radius:2px;
}
.end-decor-ring {
  position:absolute;
  width:250px; height:250px;
  bottom:100px; left:80px;
  border:2px solid rgba(46,143,163,0.12);
  border-radius:50%;
}
.end-decor-ring::before {
  content:'';
  position:absolute;
  inset:25px;
  border:1px solid rgba(232,106,60,0.1);
  border-radius:50%;
}
`

const PREMIUM_RESPONSIVE_CSS = `
@media screen {
  html, body {
    min-height:100%;
    background:#070707;
  }
  body {
    padding:24px;
    overflow:auto;
  }
  .slide {
    width:min(100%, 1120px);
    height:auto;
    aspect-ratio:16/9;
    margin:0 auto 24px;
    border-radius:18px;
    box-shadow:0 26px 90px rgba(0,0,0,.38);
  }
  .slide:last-child { margin-bottom:0; }
}
`

/* ── Premium Slide HTML Builder ── */

const PREMIUM_CONTENT_TEMPLATES = [
  {
    id: 'editorial',
    className: 'slide-template-editorial',
    badge: 'EDITORIAL',
    tag: 'DEEP DIVE',
    dark: false,
  },
  {
    id: 'matrix',
    className: 'slide-template-matrix',
    badge: 'MATRIX',
    tag: 'DECISION MAP',
    dark: false,
  },
  {
    id: 'dark-card',
    className: 'slide-template-dark-card',
    badge: 'INSIGHT',
    tag: 'EXECUTIVE LOGIC',
    dark: true,
  },
]

function resolvePremiumContentTemplate(index) {
  const offset = Math.max(0, index - 1)
  return PREMIUM_CONTENT_TEMPLATES[offset % PREMIUM_CONTENT_TEMPLATES.length]
}

function buildPremiumSlideHtml(slide, index) {
  const num = String(index + 1).padStart(2, '0')
  const type = slide.type || 'content'

  switch (type) {
    case 'cover': {
      const subtitle = slide.bullets?.[0]
        ? `<p class="cover-subtitle">${escapeHtml(slide.bullets[0])}</p>`
        : ''
      return `<div class="slide slide-cover">
  <div class="glow-ember"></div>
  <div class="glow-cyan"></div>
  <div class="grid-bg cover-grid"></div>
  <div class="cover-wave"></div>
  <div class="cover-decor-ring"></div>
  <div class="cover-tag">PRESENTATION</div>
  <h1 class="cover-title">${escapeHtml(slide.title)}</h1>
  ${subtitle}
  <p class="cover-date">${new Date().toLocaleDateString('zh-CN')}</p>
  <div class="cover-line-bottom"></div>
</div>`
    }

    case 'toc': {
      const items = slide.bullets
        .map(
          (b, i) => `
  <div class="toc-item">
    <span class="toc-item-num">${String(i + 1).padStart(2, '0')}</span>
    <span class="toc-item-text">${escapeHtml(b)}</span>
  </div>`
        )
        .join('')
      return `<div class="slide slide-toc">
  <div class="toc-sidebar">
    <div class="dot-texture"></div>
    <div class="toc-sidebar-title">目录</div>
    <div class="toc-sidebar-sub">CONTENTS</div>
    <div class="toc-sidebar-line"></div>
    <div class="toc-sidebar-ring"></div>
  </div>
  <div class="toc-main">${items}
  </div>
</div>`
    }

    case 'section': {
      const desc = slide.bullets?.[0]
        ? `<p class="section-desc">${escapeHtml(slide.bullets[0])}</p>`
        : ''
      return `<div class="slide slide-section">
  <div class="grid-bg-light"></div>
  <div class="section-bg-num">${num}</div>
  <div class="section-decor-tri"></div>
  <div class="corner-badge">CHAPTER ${num}</div>
  <h1 class="section-title">${escapeHtml(slide.title)}</h1>
  ${desc}
  <div class="section-line"></div>
</div>`
    }

    case 'data': {
      const cards = (slide.dataPoints || [])
        .slice(0, 4)
        .map(
          (p) => `
  <div class="data-card">
    <div class="data-card-glow"></div>
    <div class="data-value">${escapeHtml(p.value)}</div>
    <div class="data-label">${escapeHtml(p.label)}</div>
    <div class="data-card-line"></div>
  </div>`
        )
        .join('')
      return `<div class="slide slide-data">
  <div class="grid-bg"></div>
  <div class="data-glow-1"></div>
  <div class="data-glow-2"></div>
  <div class="corner-badge">DATA</div>
  <div class="data-tag">DATA INSIGHTS</div>
  <h2 class="data-title">${escapeHtml(slide.title)}</h2>
  <div class="data-title-line"></div>
  <div class="data-grid">${cards}
  </div>
</div>`
    }

    case 'quote': {
      const q = slide.quote || { text: '', source: '' }
      const sourceHtml = q.source
        ? `<p class="quote-source">— ${escapeHtml(q.source)}</p>`
        : ''
      return `<div class="slide slide-quote">
  <div class="dot-texture"></div>
  <div class="quote-glow"></div>
  <div class="quote-mark-svg">"</div>
  <p class="quote-text">${escapeHtml(q.text)}</p>
  <div class="quote-line"></div>
  ${sourceHtml}
</div>`
    }

    case 'split': {
      const left = slide.leftColumn || { title: '', bullets: [] }
      const right = slide.rightColumn || { title: '', bullets: [] }
      const leftBullets = left.bullets
        .map(
          (b) => `
    <li><span class="bullet-square bullet-square-cyan"></span>${escapeHtml(b)}</li>`
        )
        .join('')
      const rightBullets = right.bullets
        .map(
          (b) => `
    <li><span class="bullet-square bullet-square-ember"></span>${escapeHtml(b)}</li>`
        )
        .join('')
      return `<div class="slide slide-split">
  <div class="grid-bg-light"></div>
  <div class="split-tag">COMPARISON</div>
  <h2 class="split-title">${escapeHtml(slide.title)}</h2>
  <div class="split-title-line"></div>
  <div class="split-body">
    <div class="split-col split-col-cyan">
      <div class="split-col-accent"></div>
      <div class="split-col-title split-col-title-cyan">${escapeHtml(left.title)}</div>
      <ul class="split-col-bullets">${leftBullets}
      </ul>
    </div>
    <div class="split-col split-col-ember">
      <div class="split-col-accent"></div>
      <div class="split-col-title split-col-title-ember">${escapeHtml(right.title)}</div>
      <ul class="split-col-bullets">${rightBullets}
      </ul>
    </div>
  </div>
</div>`
    }

    case 'table': {
      const table = slide.table || []
      let tableHtml = ''
      if (table.length >= 2) {
        const header = table[0]
        const body = table.slice(1)
        const th = header.map((c) => `<th>${escapeHtml(c)}</th>`).join('')
        const tr = body
          .map((row) => `<tr>${row.map((c) => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`)
          .join('')
        tableHtml = `<table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table>`
      }
      return `<div class="slide slide-table">
  <div class="grid-bg-light"></div>
  <div class="corner-badge">TABLE</div>
  <div class="table-tag">DATA TABLE</div>
  <h2 class="table-title">${escapeHtml(slide.title)}</h2>
  <div class="table-title-line"></div>
  <div class="table-body">${tableHtml}</div>
</div>`
    }

    case 'process': {
      const steps = (slide.processSteps || [])
        .slice(0, 5)
        .map((step, i) => {
          const cls = i % 2 === 0 ? 'process-circle-ember' : 'process-circle-cyan'
          const desc = step.desc ? `<div class="process-desc">${escapeHtml(step.desc)}</div>` : ''
          return `
  <div class="process-step">
    <div class="process-circle ${cls}"><div class="process-circle-ring"></div>${i + 1}</div>
    <div class="process-name">${escapeHtml(step.name)}</div>
    ${desc}
  </div>`
        })
        .join('')
      return `<div class="slide slide-process">
  <div class="grid-bg-light"></div>
  <div class="corner-badge">PROCESS</div>
  <div class="process-tag">PROCESS</div>
  <h2 class="process-title">${escapeHtml(slide.title)}</h2>
  <div class="process-title-line"></div>
  <div class="process-body">
    <div class="process-track"></div>${steps}
  </div>
</div>`
    }

    case 'image': {
      const bullets = slide.bullets
        .slice(0, 5)
        .map(
          (b) => `
    <li><span class="bullet-diamond"></span>${escapeHtml(b)}</li>`
        )
        .join('')
      return `<div class="slide slide-image">
  <div class="grid-bg-light"></div>
  <div class="corner-badge">VISUAL</div>
  <div class="image-tag">VISUAL</div>
  <h2 class="image-title">${escapeHtml(slide.title)}</h2>
  <div class="image-title-line"></div>
  <div class="image-body">
    <div class="image-text">
      <ul>${bullets}
      </ul>
    </div>
    <div class="image-placeholder">[ ${escapeHtml(slide.images?.[0]?.alt || '配图区域')} ]</div>
  </div>
</div>`
    }

    case 'end': {
      const subtitle = slide.bullets?.[0]
        ? `<p class="end-subtitle">${escapeHtml(slide.bullets[0])}</p>`
        : ''
      return `<div class="slide slide-end">
  <div class="glow-cyan"></div>
  <div class="glow-ember"></div>
  <div class="end-wave"></div>
  <div class="end-decor-ring"></div>
  <div class="end-tag">THANK YOU</div>
  <h1 class="end-title">${escapeHtml(slide.title)}</h1>
  ${subtitle}
  <div class="end-line-bottom"></div>
</div>`
    }

    case 'chart': {
      const svg = buildChartSvg(slide.chart, {
        palette: ['#E86A3C', '#2E8FA3', '#C97C5D', '#3E7A8C', '#8A7B68', '#4A6B82'],
        axisColor: '#8A7B68',
        gridColor: 'rgba(42,31,23,0.08)',
        labelColor: '#5E4F40',
        valueColor: '#2A1F17',
        bg: '',
      })
      return `<div class="slide slide-content" style="padding:60px 70px 70px;display:flex;flex-direction:column;box-sizing:border-box">
  <div class="accent-bar-v"></div>
  <div class="grid-bg-light"></div>
  <div class="corner-badge">DATA</div>
  <div class="content-tag">CHART · ${num}</div>
  <h2 class="content-title">${escapeHtml(slide.title)}</h2>
  <div class="content-title-line"></div>
  <div style="flex:1;min-height:0;margin-top:18px">${svg || '<div style="color:#8A7B68;font-size:13px">（图表数据缺失）</div>'}</div>
  <div class="content-footer-line"></div>
</div>`
    }

    default: {
      const template = resolvePremiumContentTemplate(index)
      const variant = template.dark ? 'slide-content-dark' : 'slide-content-light'
      const bullets = (slide.bullets?.length ? slide.bullets : ['围绕核心判断展开下一步行动'])
        .slice(0, 4)
        .map((b, i) => {
          const { main, note } = splitRichBullet(b)
          const noteHtml = note ? `<div class="content-card-note">${escapeHtml(note)}</div>` : ''
          return `
    <article class="content-card">
      <div class="content-card-index">${String(i + 1).padStart(2, '0')}</div>
      <div class="content-card-text">${escapeHtml(main)}</div>
      ${noteHtml}
    </article>`
        })
        .join('')
      return `<div class="slide slide-content ${variant} ${template.className}">
  <div class="accent-bar-v"></div>
  <div class="grid-bg-light"></div>
  <div class="content-orb content-orb-a"></div>
  <div class="content-orb content-orb-b"></div>
  <div class="content-shard"></div>
  <div class="corner-badge">${template.badge}</div>
  <div class="content-tag" data-template="${template.id}">${template.tag} · ${num}</div>
  <h2 class="content-title">${escapeHtml(slide.title)}</h2>
  <div class="content-title-line"></div>
  <div class="content-card-grid">${bullets}
  </div>
  <div class="content-footer-line"></div>
</div>`
    }
  }
}

export function buildPremiumHtmlPreview(markdown, { responsive = false } = {}) {
  const slides = parseMarkdownSlides(markdown)
  if (!slides.length) return ''

  const total = slides.length
  const slideHtml = slides.map((slide, i) => buildPremiumSlideHtml(slide, i, total)).join('')

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>${PREMIUM_CSS}${responsive ? PREMIUM_RESPONSIVE_CSS : ''}</style>
</head>
<body>${slideHtml}</body>
</html>`
}

/* ── Screenshot → PPTX Pipeline ── */

export async function createPremiumPptxBlob(markdown, { title, onProgress } = {}) {
  const slides = parseMarkdownSlides(markdown)
  if (!slides.length) throw new Error('没有可导出的 PPT 内容')

  // 1. Create off-screen container
  const container = document.createElement('div')
  container.style.cssText =
    'position:fixed;left:-99999px;top:0;width:1920px;'
  document.body.appendChild(container)

  // 2. Render premium HTML
  const html = buildPremiumHtmlPreview(markdown)
  container.innerHTML = html

  // 3. Wait for fonts
  await document.fonts.ready

  // Small extra delay for layout stabilization
  await new Promise((r) => setTimeout(r, 200))

  // 4. Screenshot each slide
  const slideElements = container.querySelectorAll('.slide')
  const images = []
  for (let i = 0; i < slideElements.length; i++) {
    const el = slideElements[i]
    onProgress?.(i + 1, slideElements.length)
    const { toPng } = await import('html-to-image')
    const dataUrl = await toPng(el, {
      width: 1920,
      height: 1080,
      pixelRatio: 1,
      cacheBust: true,
      backgroundColor: null,
    })
    images.push(dataUrl)
  }

  // 5. Clean up
  document.body.removeChild(container)

  // 6. Build PPTX
  const module = await import('pptxgenjs')
  const PptxGenJS = module.default || module
  const pptx = new PptxGenJS()
  pptx.layout = 'LAYOUT_WIDE'
  pptx.author = 'Your Model Atelier'
  pptx.subject = title || slides[0].title
  pptx.title = title || slides[0].title

  for (const dataUrl of images) {
    const slide = pptx.addSlide()
    slide.background = { color: 'F4EFE5' }
    slide.addImage({ data: dataUrl, x: 0, y: 0, w: SLIDE_W, h: SLIDE_H })
  }

  const raw = await pptx.write({ outputType: 'blob' })
  const buf = raw instanceof Blob ? new Uint8Array(await raw.arrayBuffer()) : raw
  const injected = await injectEaFont(buf, CJK_FONT)
  return new Blob([injected], { type: PPTX_MIME })
}

export async function downloadPremiumPptx(markdown, { title, filename, onProgress } = {}) {
  const slides = parseMarkdownSlides(markdown)
  if (!slides.length) throw new Error('没有可导出的 PPT 内容')

  const blob = await createPremiumPptxBlob(markdown, {
    title: title || slides[0].title,
    onProgress,
  })
  saveBlob(blob, filename || buildPresentationFilename(title || slides[0].title))
  return blob
}
