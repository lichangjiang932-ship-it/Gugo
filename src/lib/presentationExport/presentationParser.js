import {
  MAX_BULLETS_PER_SLIDE,
  cleanBullet,
  cleanTitle,
  parseChartBlock,
  parseDataPoint,
  parseProcessSteps,
  parseQuote,
  parseSplitColumns,
  parseTableLines,
  parseTypeTag,
  stripMarkdownFence,
  truncateRichBullet,
} from './presentationParseHelpers.js'
export { splitRichBullet } from './presentationParseHelpers.js'

function chunkToSlide(lines, index) {
  const cleaned = lines.map((line) => line.trim()).filter(Boolean)
  if (!cleaned.length) return null

  const title = cleanTitle(cleaned[0]) || '\u672a\u547d\u540d\u9875\u9762'
  let type = parseTypeTag(cleaned) || 'content'

  if (type === 'content') {
    if (index === 0) type = 'cover'
    else if (/\u76ee\u5f55|\u5185\u5bb9\u6982\u89c8|\u5927\u7eb2|Agenda/i.test(title)) type = 'toc'
    else if (/\u611f\u8c22|Q&A|\u95ee\u7b54|\u603b\u7ed3|\u7ed3\u8bed|\u7ed3\u675f|Thank/i.test(title)) type = 'end'
  }

  const rest = cleaned.slice(1)

  if (type === 'content') {
    const split = parseSplitColumns(rest)
    if (split.left.title && split.right.title) {
      return { title, type: 'split', index, leftColumn: split.left, rightColumn: split.right }
    }
    const processSteps = parseProcessSteps(rest)
    const numberedSteps = rest.filter((line) => /^\d+[.\u3001]\s*/.test(line)).length
    if (numberedSteps >= 3 && processSteps.length >= 3) {
      return { title, type: 'process', index, processSteps }
    }
    if (rest.some((line) => /^>\s*/.test(line))) {
      return { title, type: 'quote', index, quote: parseQuote(rest.map((line) => line.replace(/^>\s*/, ''))) }
    }
    if (/^(?:\u7b2c[\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341\d]+[\u7ae0\u8282\u90e8\u5206]|part\s+\d+|section\s+\d+)/i.test(title)) {
      type = 'section'
    }
  }

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
    if (bullet && bullet !== '---' && !/^\u76ee\u5f55$/.test(bullet)) {
      bullets.push(bullet)
    }
  }

  if (type === 'content' && images.length > 0) {
    type = 'image'
  }

  if (type === 'content') {
    const dataPoints = bullets
      .map(parseDataPoint)
      .filter((point) => point && /[\d\uff10-\uff19%\uff05\u00a5\uffe5$\u4e07\u4ebfkK+\-.]/.test(point.value))
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

/* \u2500\u2500 Layout helpers \u2500\u2500 */
