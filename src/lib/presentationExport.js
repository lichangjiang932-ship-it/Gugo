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

function truncateBullet(line) {
  return line.length > MAX_BULLET_LENGTH ? `${line.slice(0, MAX_BULLET_LENGTH)}...` : line
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

  const tableRows = parseTableLines(rest)
  if (tableRows.length >= 2 && (type === 'table' || type === 'content')) {
    const nonTable = rest.filter((line) => !/^\s*\|/.test(line))
    return {
      title, type: type === 'content' ? 'table' : type, index,
      table: tableRows,
      bullets: nonTable.map(cleanBullet).filter(Boolean).slice(0, MAX_BULLETS_PER_SLIDE).map(truncateBullet),
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

  return {
    title, type, index,
    bullets: bullets.slice(0, MAX_BULLETS_PER_SLIDE).map(truncateBullet),
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
    const numbered = line.match(/^(?:#{1,4}\s*)?(\d{1,2})[.、]\s+(.+)$/)
    if (numbered) {
      if (!current && preface.length) {
        const titleSlide = chunkToSlide(preface.filter((item) => !/^\d{1,2}[.、]/.test(item)), 0)
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
    fontFace: 'Aptos Display', fontSize: 44, bold: true, color: THEME.ink,
    align: 'center', margin: 0,
  })
  if (slideData.bullets?.[0]) {
    slide.addText(slideData.bullets[0], {
      x: 1, y: 3.6, w: 11.3, h: 0.6,
      fontFace: 'Aptos', fontSize: 20, color: THEME.inkSoft,
      align: 'center', margin: 0,
    })
  }
  slide.addText(new Date().toLocaleDateString('zh-CN'), {
    x: 1, y: 4.4, w: 11.3, h: 0.4,
    fontFace: 'Aptos', fontSize: 12, color: THEME.inkFade,
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
    fontFace: 'Aptos Display', fontSize: 32, bold: true, color: THEME.white, margin: 0,
  })
  slide.addText('CONTENTS', {
    x: 0.5, y: 3.6, w: 2.6, h: 0.4,
    fontFace: 'Aptos', fontSize: 11, color: 'B8D4DB', margin: 0,
  })
  slideData.bullets.forEach((bullet, i) => {
    const yBase = 1.2 + i * 0.85
    slide.addText(String(i + 1).padStart(2, '0'), {
      x: 4.2, y: yBase, w: 0.8, h: 0.4,
      fontFace: 'Aptos Display', fontSize: 22, bold: true, color: THEME.ember, margin: 0,
    })
    slide.addText(bullet, {
      x: 5.1, y: yBase + 0.05, w: 7.5, h: 0.5,
      fontFace: 'Aptos', fontSize: 18, color: THEME.ink, margin: 0,
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
  slide.addShape(pptx.ShapeType.rect, {
    x: 0, y: 0, w: 0.12, h: SLIDE_H,
    fill: { color: accentColor },
    line: { color: accentColor, width: 0 },
  })
  slide.addText(slideData.title, {
    x: 0.7, y: 0.5, w: 11.8, h: 0.7,
    fontFace: 'Aptos Display', fontSize: 30, bold: true, color: THEME.ink, margin: 0,
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
        fontFace: 'Aptos', fontSize: 18, color: THEME.inkSoft,
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
    fontFace: 'Aptos Display', fontSize: 30, bold: true, color: THEME.ink, margin: 0,
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
        fontFace: 'Aptos', fontSize: 17, color: THEME.inkSoft,
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
    fontFace: 'Aptos', fontSize: 14, color: THEME.inkFade,
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
    fontFace: 'Aptos Display', fontSize: 40, bold: true, color: THEME.ink,
    align: 'center', margin: 0,
  })
  if (slideData.bullets?.[0]) {
    slide.addText(slideData.bullets[0], {
      x: 1, y: 3.7, w: 11.3, h: 0.6,
      fontFace: 'Aptos', fontSize: 18, color: THEME.inkSoft,
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
  slide.addText(slideData.title, {
    x: 0.7, y: 0.5, w: 11.8, h: 0.7,
    fontFace: 'Aptos Display', fontSize: 30, bold: true, color: THEME.ink, margin: 0,
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
        fontFace: 'Aptos Display', fontSize: 36, bold: true, color: accentColor,
        align: 'center', margin: 0,
      })
      slide.addText(point.label, {
        x, y: y + 1.0, w: cardW - 0.3, h: 0.8,
        fontFace: 'Aptos', fontSize: 14, color: THEME.inkSoft,
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
    fontFace: 'Aptos Display', fontSize: 72, bold: true, color: THEME.ember, margin: 0,
  })
  if (slideData.quote?.text) {
    slide.addText(slideData.quote.text, {
      x: 1.5, y: 2.2, w: 10.3, h: 2.0,
      fontFace: 'Aptos', fontSize: 24, italic: true, color: THEME.ink,
      align: 'center', margin: 0,
    })
  }
  if (slideData.quote?.source) {
    slide.addText(`— ${slideData.quote.source}`, {
      x: 1.5, y: 4.4, w: 10.3, h: 0.5,
      fontFace: 'Aptos', fontSize: 14, color: THEME.inkFade,
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
    fontFace: 'Aptos Display', fontSize: 30, bold: true, color: THEME.ink, margin: 0,
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
      fontFace: 'Aptos Display', fontSize: 18, bold: true, color: THEME.cyan, margin: 0,
    })
  }
  if (left.bullets.length) {
    slide.addText(
      left.bullets.map((b) => ({ text: b, options: { bullet: { type: 'bullet' }, breakLine: true, paraSpaceAfterPt: 6 } })),
      {
        x: 0.8, y: 2.3, w: 5.2, h: 3.8,
        fontFace: 'Aptos', fontSize: 14, color: THEME.inkSoft,
        breakLine: false, fit: 'shrink',
      }
    )
  }

  if (right.title) {
    slide.addText(right.title, {
      x: 7.0, y: 1.7, w: 5.4, h: 0.5,
      fontFace: 'Aptos Display', fontSize: 18, bold: true, color: THEME.ember, margin: 0,
    })
  }
  if (right.bullets.length) {
    slide.addText(
      right.bullets.map((b) => ({ text: b, options: { bullet: { type: 'bullet' }, breakLine: true, paraSpaceAfterPt: 6 } })),
      {
        x: 7.1, y: 2.3, w: 5.2, h: 3.8,
        fontFace: 'Aptos', fontSize: 14, color: THEME.inkSoft,
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
    fontFace: 'Aptos Display', fontSize: 30, bold: true, color: THEME.ink, margin: 0,
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
      header.map((cell) => ({ text: cell, options: { bold: true, fill: THEME.cyan, color: THEME.white, fontFace: 'Aptos', fontSize: 13 } })),
      ...body.map((row) => row.map((cell) => ({ text: cell, options: { fill: 'F8F4EC', color: THEME.inkSoft, fontFace: 'Aptos', fontSize: 12 } }))),
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
    fontFace: 'Aptos Display', fontSize: 30, bold: true, color: THEME.ink, margin: 0,
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
        fontFace: 'Aptos Display', fontSize: 16, bold: true, color: THEME.white,
        align: 'center', valign: 'middle', margin: 0,
      })

      slide.addText(step.name, {
        x, y: y + 0.8, w: stepW - 0.2, h: 0.5,
        fontFace: 'Aptos Display', fontSize: 14, bold: true, color: THEME.ink,
        align: 'center', margin: 0,
      })

      if (step.desc) {
        slide.addText(step.desc, {
          x, y: y + 1.3, w: stepW - 0.2, h: 1.5,
          fontFace: 'Aptos', fontSize: 11, color: THEME.inkSoft,
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
  const sectionNum = String(index + 1).padStart(2, '0')
  slide.addText(sectionNum, {
    x: 0.5, y: 1.5, w: 4, h: 2,
    fontFace: 'Aptos Display', fontSize: 96, bold: true, color: THEME.ember, margin: 0,
  })
  slide.addText(slideData.title, {
    x: 0.7, y: 3.5, w: 11, h: 1,
    fontFace: 'Aptos Display', fontSize: 36, bold: true, color: THEME.ink, margin: 0,
  })
  if (slideData.bullets?.[0]) {
    slide.addText(slideData.bullets[0], {
      x: 0.7, y: 4.6, w: 11, h: 0.6,
      fontFace: 'Aptos', fontSize: 16, color: THEME.inkSoft, margin: 0,
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


/* ═══════════════════════════════════════════════════════════════════════
   Premium Visual Export — HTML Screenshot → PPTX
   ═══════════════════════════════════════════════════════════════════════ */

const PREMIUM_CSS = `
* { margin:0; padding:0; box-sizing:border-box; }
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', 'Helvetica Neue', Helvetica, Arial, sans-serif;
  background:#0d0b09;
  padding:0;
}
.slide {
  width:1920px;
  height:1080px;
  position:relative;
  overflow:hidden;
  background:#F4EFE5;
}

/* ── Cover ── */
.slide-cover {
  background: linear-gradient(145deg, #15120f 0%, #1e1913 40%, #15120f 100%);
  display:flex;
  flex-direction:column;
  align-items:center;
  justify-content:center;
}
.cover-decor-1 {
  position:absolute;
  width:700px; height:700px;
  top:-250px; right:-200px;
  border-radius:50%;
  background: radial-gradient(circle, rgba(232,106,60,0.18) 0%, transparent 70%);
}
.cover-decor-2 {
  position:absolute;
  width:500px; height:500px;
  bottom:-150px; left:-150px;
  border-radius:50%;
  background: radial-gradient(circle, rgba(46,143,163,0.12) 0%, transparent 70%);
}
.cover-line-top {
  position:absolute;
  top:80px; left:50%; transform:translateX(-50%);
  width:100px; height:4px;
  background:#E86A3C;
  border-radius:2px;
}
.cover-line-bottom {
  position:absolute;
  bottom:100px; left:50%; transform:translateX(-50%);
  width:60px; height:3px;
  background:#E86A3C;
  border-radius:2px;
}
.cover-tag {
  font-size:18px;
  letter-spacing:10px;
  text-transform:uppercase;
  color:#E86A3C;
  margin-bottom:50px;
  font-weight:600;
}
.cover-title {
  font-size:96px;
  font-weight:800;
  letter-spacing:-2px;
  line-height:1.1;
  max-width:1400px;
  text-align:center;
  color:#F4EFE5;
}
.cover-subtitle {
  font-size:32px;
  color:#b8a88a;
  margin-top:40px;
  max-width:1000px;
  text-align:center;
  line-height:1.4;
}
.cover-date {
  font-size:20px;
  color:#7a6e5a;
  margin-top:60px;
  letter-spacing:4px;
}

/* ── TOC ── */
.slide-toc {
  background: linear-gradient(135deg, #F4EFE5 0%, #EAE2D2 100%);
  display:flex;
}
.toc-sidebar {
  width:420px;
  background: linear-gradient(180deg, #2A1F17 0%, #1e1710 100%);
  display:flex;
  flex-direction:column;
  justify-content:center;
  padding:80px 50px;
  position:relative;
}
.toc-sidebar::after {
  content:'';
  position:absolute;
  top:60px; right:-30px;
  width:60px; height:60px;
  border-radius:50%;
  background: radial-gradient(circle, rgba(232,106,60,0.25) 0%, transparent 70%);
}
.toc-sidebar-title {
  font-size:56px;
  font-weight:800;
  color:#F4EFE5;
  line-height:1.1;
}
.toc-sidebar-sub {
  font-size:18px;
  letter-spacing:6px;
  text-transform:uppercase;
  color:#8A7B68;
  margin-top:20px;
}
.toc-sidebar-line {
  width:60px; height:4px;
  background:#E86A3C;
  margin-top:40px;
  border-radius:2px;
}
.toc-main {
  flex:1;
  padding:80px 80px 80px 100px;
  display:flex;
  flex-direction:column;
  justify-content:center;
}
.toc-item {
  display:flex;
  align-items:baseline;
  gap:24px;
  padding:28px 0;
  border-bottom:1px solid rgba(219,210,190,0.6);
}
.toc-item-num {
  font-size:20px;
  font-weight:700;
  color:#E86A3C;
  font-variant-numeric: tabular-nums;
  min-width:40px;
}
.toc-item-text {
  font-size:28px;
  color:#2A1F17;
  font-weight:500;
}

/* ── Section ── */
.slide-section {
  background: linear-gradient(135deg, #F4EFE5 0%, #EAE2D2 100%);
  display:flex;
  flex-direction:column;
  justify-content:center;
  padding-left:180px;
  position:relative;
}
.section-decor-num {
  position:absolute;
  top:80px; left:100px;
  font-size:220px;
  font-weight:900;
  color:rgba(232,106,60,0.08);
  line-height:1;
  font-variant-numeric:tabular-nums;
}
.section-decor-circle {
  position:absolute;
  width:400px; height:400px;
  bottom:-100px; right:-100px;
  border-radius:50%;
  background: radial-gradient(circle, rgba(46,143,163,0.1) 0%, transparent 70%);
}
.section-title {
  font-size:80px;
  font-weight:800;
  color:#2A1F17;
  max-width:1200px;
  line-height:1.15;
}
.section-desc {
  font-size:28px;
  color:#5E4F40;
  margin-top:30px;
  max-width:900px;
  line-height:1.5;
}
.section-line {
  width:80px; height:5px;
  background:#E86A3C;
  margin-top:40px;
  border-radius:3px;
}

/* ── Content ── */
.slide-content {
  background:#F4EFE5;
  display:flex;
  flex-direction:column;
  padding:90px 140px;
}
.content-header-tag {
  font-size:16px;
  letter-spacing:6px;
  text-transform:uppercase;
  color:#E86A3C;
  margin-bottom:20px;
  font-weight:600;
}
.content-header-title {
  font-size:56px;
  font-weight:700;
  color:#2A1F17;
  line-height:1.2;
}
.content-header-line {
  width:60px; height:4px;
  background:#E86A3C;
  margin-top:24px;
  border-radius:2px;
}
.content-bullets {
  list-style:none;
  margin-top:50px;
  display:flex;
  flex-direction:column;
  gap:4px;
}
.content-bullets li {
  font-size:28px;
  color:#5E4F40;
  line-height:1.55;
  padding:18px 0 18px 48px;
  position:relative;
  border-bottom:1px solid rgba(219,210,190,0.5);
}
.content-bullets li:last-child { border-bottom:none; }
.content-bullets li .bullet-dot {
  position:absolute;
  left:0; top:28px;
  width:14px; height:14px;
  background:#E86A3C;
  border-radius:50%;
}

/* ── Data ── */
.slide-data {
  background: linear-gradient(180deg, #15120f 0%, #1e1913 100%);
  display:flex;
  flex-direction:column;
  padding:90px 140px;
  position:relative;
}
.data-decor {
  position:absolute;
  width:600px; height:600px;
  top:-200px; right:-200px;
  border-radius:50%;
  background: radial-gradient(circle, rgba(232,106,60,0.1) 0%, transparent 70%);
}
.data-header-tag {
  font-size:16px;
  letter-spacing:6px;
  text-transform:uppercase;
  color:#E86A3C;
  margin-bottom:20px;
  font-weight:600;
}
.data-header-title {
  font-size:56px;
  font-weight:700;
  color:#F4EFE5;
  line-height:1.2;
}
.data-header-line {
  width:60px; height:4px;
  background:#E86A3C;
  margin-top:24px;
  border-radius:2px;
}
.data-grid {
  display:flex;
  gap:32px;
  margin-top:60px;
}
.data-card {
  flex:1;
  background: rgba(244,239,229,0.06);
  border:1px solid rgba(244,239,229,0.12);
  border-radius:20px;
  padding:50px 30px;
  text-align:center;
  backdrop-filter:blur(12px);
  position:relative;
}
.data-card-accent {
  position:absolute;
  top:0; left:50%; transform:translateX(-50%);
  width:60px; height:4px;
  background:#E86A3C;
  border-radius:0 0 4px 4px;
}
.data-value {
  font-size:80px;
  font-weight:800;
  color:#E86A3C;
  line-height:1;
}
.data-unit {
  font-size:40px;
  font-weight:600;
}
.data-label {
  font-size:22px;
  color:#a89b82;
  margin-top:20px;
  line-height:1.4;
}
.data-card-line {
  width:40px; height:3px;
  background:#E86A3C;
  margin:30px auto 0;
  border-radius:2px;
}

/* ── Quote ── */
.slide-quote {
  background: linear-gradient(135deg, #1e1913 0%, #15120f 100%);
  display:flex;
  flex-direction:column;
  align-items:center;
  justify-content:center;
  padding:140px;
  position:relative;
}
.quote-decor {
  position:absolute;
  width:500px; height:500px;
  top:-150px; left:-150px;
  border-radius:50%;
  background: radial-gradient(circle, rgba(46,143,163,0.12) 0%, transparent 70%);
}
.quote-mark {
  font-size:200px;
  font-weight:900;
  color:rgba(232,106,60,0.18);
  line-height:0.5;
  margin-bottom:30px;
}
.quote-text {
  font-size:48px;
  font-style:italic;
  line-height:1.5;
  max-width:1400px;
  text-align:center;
  color:#F4EFE5;
}
.quote-line {
  width:60px; height:3px;
  background:#E86A3C;
  margin:50px auto;
  border-radius:2px;
}
.quote-source {
  font-size:24px;
  color:#8a7d68;
}

/* ── Split ── */
.slide-split {
  background:#F4EFE5;
  display:flex;
  flex-direction:column;
  padding:90px 140px;
}
.split-header-tag {
  font-size:16px;
  letter-spacing:6px;
  text-transform:uppercase;
  color:#E86A3C;
  margin-bottom:20px;
  font-weight:600;
}
.split-header-title {
  font-size:56px;
  font-weight:700;
  color:#2A1F17;
  line-height:1.2;
}
.split-header-line {
  width:60px; height:4px;
  background:#E86A3C;
  margin-top:24px;
  border-radius:2px;
}
.split-body {
  display:flex;
  gap:60px;
  margin-top:50px;
  flex:1;
}
.split-col {
  flex:1;
  padding:50px;
  border-radius:24px;
  display:flex;
  flex-direction:column;
}
.split-col-cyan {
  background: linear-gradient(135deg, rgba(46,143,163,0.08) 0%, rgba(46,143,163,0.02) 100%);
  border:2px solid rgba(46,143,163,0.2);
}
.split-col-ember {
  background: linear-gradient(135deg, rgba(232,106,60,0.08) 0%, rgba(232,106,60,0.02) 100%);
  border:2px solid rgba(232,106,60,0.2);
}
.split-col-title {
  font-size:36px;
  font-weight:700;
  margin-bottom:30px;
}
.split-col-title-cyan { color:#2E8FA3; }
.split-col-title-ember { color:#E86A3C; }
.split-col-bullets { list-style:none; }
.split-col-bullets li {
  font-size:24px;
  color:#5E4F40;
  line-height:1.6;
  padding:14px 0 14px 36px;
  position:relative;
}
.split-col-bullets li .bullet-square {
  position:absolute;
  left:0; top:22px;
  width:10px; height:10px;
  border-radius:3px;
}
.bullet-square-cyan { background:#2E8FA3; }
.bullet-square-ember { background:#E86A3C; }

/* ── Table ── */
.slide-table {
  background:#F4EFE5;
  display:flex;
  flex-direction:column;
  padding:90px 140px;
}
.table-header-tag {
  font-size:16px;
  letter-spacing:6px;
  text-transform:uppercase;
  color:#2E8FA3;
  margin-bottom:20px;
  font-weight:600;
}
.table-header-title {
  font-size:56px;
  font-weight:700;
  color:#2A1F17;
  line-height:1.2;
}
.table-header-line {
  width:60px; height:4px;
  background:#2E8FA3;
  margin-top:24px;
  border-radius:2px;
}
.table-body {
  margin-top:50px;
  flex:1;
  overflow:auto;
}
.table-body table {
  width:100%;
  border-collapse:separate;
  border-spacing:0;
  font-size:24px;
}
.table-body th {
  background: linear-gradient(135deg, #2E8FA3 0%, #267a8c 100%);
  color:white;
  padding:28px 32px;
  text-align:left;
  font-weight:600;
}
.table-body th:first-child { border-radius:12px 0 0 0; }
.table-body th:last-child { border-radius:0 12px 0 0; }
.table-body td {
  background:white;
  color:#5E4F40;
  padding:22px 32px;
  border-bottom:2px solid #EAE2D2;
}
.table-body tr:last-child td:first-child { border-radius:0 0 0 12px; }
.table-body tr:last-child td:last-child { border-radius:0 0 12px 0; }
.table-body tr:nth-child(even) td { background:#faf8f4; }

/* ── Process ── */
.slide-process {
  background:#F4EFE5;
  display:flex;
  flex-direction:column;
  padding:90px 140px;
}
.process-header-tag {
  font-size:16px;
  letter-spacing:6px;
  text-transform:uppercase;
  color:#2E8FA3;
  margin-bottom:20px;
  font-weight:600;
}
.process-header-title {
  font-size:56px;
  font-weight:700;
  color:#2A1F17;
  line-height:1.2;
}
.process-header-line {
  width:60px; height:4px;
  background:#2E8FA3;
  margin-top:24px;
  border-radius:2px;
}
.process-body {
  display:flex;
  align-items:flex-start;
  gap:20px;
  margin-top:60px;
  flex:1;
}
.process-step {
  flex:1;
  text-align:center;
  display:flex;
  flex-direction:column;
  align-items:center;
}
.process-circle {
  width:90px; height:90px;
  border-radius:50%;
  display:inline-flex;
  align-items:center;
  justify-content:center;
  font-size:36px;
  font-weight:800;
  color:white;
  margin-bottom:30px;
  box-shadow:0 8px 24px rgba(0,0,0,0.15);
}
.process-circle-ember { background: linear-gradient(135deg, #E86A3C 0%, #c9552e 100%); }
.process-circle-cyan { background: linear-gradient(135deg, #2E8FA3 0%, #236b7a 100%); }
.process-name {
  font-size:28px;
  font-weight:700;
  color:#2A1F17;
}
.process-desc {
  font-size:20px;
  color:#5E4F40;
  margin-top:16px;
  line-height:1.5;
  max-width:280px;
}
.process-arrow {
  font-size:36px;
  color:#DBD2BE;
  margin-top:26px;
  flex-shrink:0;
  font-weight:300;
}

/* ── Image ── */
.slide-image {
  background:#F4EFE5;
  display:flex;
  flex-direction:column;
  padding:90px 140px;
}
.image-header-tag {
  font-size:16px;
  letter-spacing:6px;
  text-transform:uppercase;
  color:#E86A3C;
  margin-bottom:20px;
  font-weight:600;
}
.image-header-title {
  font-size:56px;
  font-weight:700;
  color:#2A1F17;
  line-height:1.2;
}
.image-header-line {
  width:60px; height:4px;
  background:#E86A3C;
  margin-top:24px;
  border-radius:2px;
}
.image-body {
  display:flex;
  gap:60px;
  margin-top:50px;
  flex:1;
  overflow:hidden;
}
.image-text { flex:1; }
.image-text ul { list-style:none; }
.image-text li {
  font-size:26px;
  color:#5E4F40;
  line-height:1.6;
  padding:16px 0 16px 40px;
  position:relative;
}
.image-text li .bullet-dot {
  position:absolute;
  left:0; top:26px;
  width:12px; height:12px;
  background:#E86A3C;
  border-radius:50%;
}
.image-placeholder {
  width:45%;
  background: linear-gradient(135deg, #EAE2D2 0%, #F4EFE5 100%);
  border:3px dashed #C9BFA8;
  border-radius:20px;
  display:flex;
  align-items:center;
  justify-content:center;
  font-size:24px;
  color:#8A7B68;
}

/* ── End ── */
.slide-end {
  background: linear-gradient(145deg, #15120f 0%, #1e1913 50%, #15120f 100%);
  display:flex;
  flex-direction:column;
  align-items:center;
  justify-content:center;
  position:relative;
}
.end-decor-1 {
  position:absolute;
  width:500px; height:500px;
  top:-150px; left:-150px;
  border-radius:50%;
  background: radial-gradient(circle, rgba(46,143,163,0.15) 0%, transparent 70%);
}
.end-decor-2 {
  position:absolute;
  width:350px; height:350px;
  bottom:-80px; right:-80px;
  border-radius:50%;
  background: radial-gradient(circle, rgba(232,106,60,0.1) 0%, transparent 70%);
}
.end-line-top {
  position:absolute;
  top:80px; left:50%; transform:translateX(-50%);
  width:80px; height:4px;
  background:#2E8FA3;
  border-radius:2px;
}
.end-tag {
  font-size:18px;
  letter-spacing:8px;
  text-transform:uppercase;
  color:#2E8FA3;
  margin-bottom:40px;
  font-weight:600;
}
.end-title {
  font-size:90px;
  font-weight:800;
  letter-spacing:4px;
  color:#F4EFE5;
}
.end-subtitle {
  font-size:28px;
  color:#b8a88a;
  margin-top:30px;
}
.end-line-bottom {
  position:absolute;
  bottom:100px; left:50%; transform:translateX(-50%);
  width:60px; height:3px;
  background:#2E8FA3;
  border-radius:2px;
}
`

/* ── Premium Slide HTML Builder ── */

function buildPremiumSlideHtml(slide, index) {
  const num = String(index + 1).padStart(2, '0')
  const type = slide.type || 'content'

  switch (type) {
    case 'cover': {
      const subtitle = slide.bullets?.[0]
        ? `<p class="cover-subtitle">${escapeHtml(slide.bullets[0])}</p>`
        : ''
      return `<div class="slide slide-cover">
  <div class="cover-decor-1"></div>
  <div class="cover-decor-2"></div>
  <div class="cover-line-top"></div>
  <div class="cover-line-bottom"></div>
  <div class="cover-tag">PRESENTATION</div>
  <h1 class="cover-title">${escapeHtml(slide.title)}</h1>
  ${subtitle}
  <p class="cover-date">${new Date().toLocaleDateString('zh-CN')}</p>
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
    <div class="toc-sidebar-title">目录</div>
    <div class="toc-sidebar-sub">CONTENTS</div>
    <div class="toc-sidebar-line"></div>
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
  <div class="section-decor-num">${num}</div>
  <div class="section-decor-circle"></div>
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
    <div class="data-card-accent"></div>
    <div class="data-value">${escapeHtml(p.value)}</div>
    <div class="data-label">${escapeHtml(p.label)}</div>
    <div class="data-card-line"></div>
  </div>`
        )
        .join('')
      return `<div class="slide slide-data">
  <div class="data-decor"></div>
  <div class="data-header-tag">DATA INSIGHTS</div>
  <h2 class="data-header-title">${escapeHtml(slide.title)}</h2>
  <div class="data-header-line"></div>
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
  <div class="quote-decor"></div>
  <div class="quote-mark">"</div>
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
  <div class="split-header-tag">COMPARISON</div>
  <h2 class="split-header-title">${escapeHtml(slide.title)}</h2>
  <div class="split-header-line"></div>
  <div class="split-body">
    <div class="split-col split-col-cyan">
      <div class="split-col-title split-col-title-cyan">${escapeHtml(left.title)}</div>
      <ul class="split-col-bullets">${leftBullets}
      </ul>
    </div>
    <div class="split-col split-col-ember">
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
  <div class="table-header-tag">DATA TABLE</div>
  <h2 class="table-header-title">${escapeHtml(slide.title)}</h2>
  <div class="table-header-line"></div>
  <div class="table-body">${tableHtml}</div>
</div>`
    }

    case 'process': {
      const steps = (slide.processSteps || [])
        .slice(0, 5)
        .map((step, i) => {
          const cls = i % 2 === 0 ? 'process-circle-ember' : 'process-circle-cyan'
          const arrow =
            i < (slide.processSteps || []).length - 1 && i < 4
              ? '<div class="process-arrow">→</div>'
              : ''
          const desc = step.desc ? `<div class="process-desc">${escapeHtml(step.desc)}</div>` : ''
          return `
  <div class="process-step">
    <div class="process-circle ${cls}">${i + 1}</div>
    <div class="process-name">${escapeHtml(step.name)}</div>
    ${desc}
  </div>${arrow}`
        })
        .join('')
      return `<div class="slide slide-process">
  <div class="process-header-tag">PROCESS</div>
  <h2 class="process-header-title">${escapeHtml(slide.title)}</h2>
  <div class="process-header-line"></div>
  <div class="process-body">${steps}
  </div>
</div>`
    }

    case 'image': {
      const bullets = slide.bullets
        .slice(0, 5)
        .map(
          (b) => `
    <li><span class="bullet-dot"></span>${escapeHtml(b)}</li>`
        )
        .join('')
      return `<div class="slide slide-image">
  <div class="image-header-tag">VISUAL</div>
  <h2 class="image-header-title">${escapeHtml(slide.title)}</h2>
  <div class="image-header-line"></div>
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
  <div class="end-decor-1"></div>
  <div class="end-decor-2"></div>
  <div class="end-line-top"></div>
  <div class="end-line-bottom"></div>
  <div class="end-tag">THANK YOU</div>
  <h1 class="end-title">${escapeHtml(slide.title)}</h1>
  ${subtitle}
</div>`
    }

    default: {
      const bullets = slide.bullets
        .map(
          (b) => `
    <li><span class="bullet-dot"></span>${escapeHtml(b)}</li>`
        )
        .join('')
      return `<div class="slide slide-content">
  <div class="content-header-tag">CONTENT</div>
  <h2 class="content-header-title">${escapeHtml(slide.title)}</h2>
  <div class="content-header-line"></div>
  <ul class="content-bullets">${bullets}
  </ul>
</div>`
    }
  }
}

export function buildPremiumHtmlPreview(markdown) {
  const slides = parseMarkdownSlides(markdown)
  if (!slides.length) return ''

  const total = slides.length
  const slideHtml = slides.map((slide, i) => buildPremiumSlideHtml(slide, i, total)).join('')

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<style>${PREMIUM_CSS}</style>
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

  const content = await pptx.write({ outputType: 'blob' })
  if (content instanceof Blob && content.type === PPTX_MIME) return content
  return new Blob([content], { type: PPTX_MIME })
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
