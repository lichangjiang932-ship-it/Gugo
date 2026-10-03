import { cleanTitle, parseDataPoint } from '../../src/lib/presentationExport/presentationParseHelpers.js'
import { parseMarkdownSlides } from '../../src/lib/presentationExport/presentationParser.js'
import { PPTX_LIMITS, PPTX_SLIDE_SCHEMA } from './pptxArtifactContract.js'
import { assertPptxSchema, invalidPptx, normalizePptxTable } from './pptxArtifactValidation.js'
import { canonicalMarkdownChart } from './pptxMarkdownChart.js'
import { markdownSlideSources, markdownSlideTable, markdownSlideText } from './pptxMarkdownSource.js'

const TYPES = new Set([
  'content', 'bullets', 'statement', 'cover', 'section', 'toc', 'end',
  'data', 'kpi', 'chart', 'table', 'split', 'process', 'quote', 'image',
])
const TYPE_TAG = /^<!--\s*([\w-]+)\s*-->$/u
const QUOTE_ATTRIBUTION = /^(?:[—–]{1,2}\s*|--?\s+|(?:source|author|by|来源|作者)(?:\s*[:：]\s*|\s+))\S/iu

function slideSource(lines, index) {
  let declaredType = ''
  const content = []
  for (const line of lines) {
    const tag = line.match(TYPE_TAG)
    if (!tag) { content.push(line); continue }
    if (declaredType) invalidPptx(`slides[${index}]`, 'must declare at most one Markdown slide type')
    declaredType = tag[1].toLowerCase()
    if (!TYPES.has(declaredType)) invalidPptx(`slides[${index}].layout`, `does not support the Markdown type "${declaredType}"`)
  }
  if (!content.length) invalidPptx(`slides[${index}].title`, 'requires a Markdown page title')
  const title = markdownSlideText(cleanTitle(content[0]))
  const rest = content.slice(1)
  // The browser parser provides layout inference only. Read the original lines
  // for content: that preview parser intentionally clips five 80-character bullets.
  const inferred = parseMarkdownSlides(`Compatibility inference\n---\n${content.join('\n')}`)[1]?.type || 'content'
  const namedCover = /^(?:封面(?:页)?|标题页|cover(?:\s+page)?|title\s+slide)$/iu.test(title)
  const type = declaredType || (namedCover ? 'cover' : inferred)
  return { title, rest, type }
}

function markdownDataSlide(title, lines, path) {
  const points = []
  const bullets = []
  for (const line of lines) {
    const text = markdownSlideText(line)
    const point = parseDataPoint(text)
    if (point) points.push({ value: point.value, label: point.label })
    else if (text) bullets.push(text)
  }
  if (!points.length) invalidPptx(`${path}.kpi`, 'requires at least one Markdown value/label pair')
  if (points.length > 4) {
    return { title, layout: 'table', table: { rows: points.map((point) => [point.label, point.value]), header: false }, bullets }
  }
  return { title, layout: 'kpi', kpi: points, bullets }
}

function markdownSplitSlide(title, lines, path) {
  const columns = []
  const preface = []
  for (const line of lines) {
    const heading = line.match(/^\*\*(.+?)\*\*$/u)
    if (heading) columns.push([markdownSlideText(heading[1])])
    else if (columns.length) columns.at(-1).push(markdownSlideText(line))
    else preface.push(markdownSlideText(line))
  }
  if (columns.length !== 2) invalidPptx(path, 'requires exactly two named Markdown columns; use explicit canvas elements for other compositions')
  return {
    title, layout: 'split', bullets: columns.map((column) => column.filter(Boolean).join('\n')),
    ...(preface.filter(Boolean).length ? { subtitle: preface.filter(Boolean).join('\n') } : {}),
  }
}

function markdownQuoteSlide(title, lines, explicit, path) {
  const hasQuoteMarks = lines.some((line) => /^>\s?/u.test(line))
  const quoteLines = (hasQuoteMarks ? lines.filter((line) => /^>\s?/u.test(line)) : lines)
    .map((line) => line.replace(/^>\s?/u, '')).filter((line) => markdownSlideText(line))
  const quoted = quoteLines.map(markdownSlideText)
  const bullets = hasQuoteMarks ? lines.filter((line) => !/^>\s?/u.test(line)).map(markdownSlideText).filter(Boolean) : []
  if (!quoted.length) invalidPptx(`${path}.quote`, 'requires non-empty Markdown quotation text')
  const attributed = quoted.length > 1
    && (QUOTE_ATTRIBUTION.test(quoteLines.at(-1).trim()) || QUOTE_ATTRIBUTION.test(quoted.at(-1)))
  // The old parseQuote contract used two unmarked lines as text + author.
  // Preserve that explicit legacy form, never reinterpret marked > body text.
  const legacyAuthor = explicit && !hasQuoteMarks && quoted.length === 2
  const source = attributed || legacyAuthor ? quoted.pop() : ''
  return { title, layout: 'quote', quote: { text: quoted.join('\n'), ...(source ? { source } : {}) }, bullets }
}

function markdownProcessSlide(title, lines) {
  return {
    title,
    layout: 'process',
    bullets: lines.map((line) => markdownSlideText(line.replace(/^\d+[.、]\s*/u, ''))).filter(Boolean),
  }
}

function canonicalMarkdownSlide({ lines, introduction }, index) {
  const path = `slides[${index}]`
  const { title, rest, type } = slideSource(lines, index)
  if (lines.some((line) => /!\[[^\]]*\]\([^)]+\)/u.test(line))) {
    invalidPptx(`${path}.images`, 'requires authorized top-level images and explicit image elements; Markdown image URLs are not silently omitted or fetched', 'PPTX_IMAGE_REFERENCE_INVALID')
  }
  let slide
  if (type === 'data' || type === 'kpi') slide = markdownDataSlide(title, rest, path)
  else if (type === 'chart') {
    const { chart, remainder } = canonicalMarkdownChart(rest, `${path}.chart`)
    slide = { title, layout: 'chart', chart, bullets: remainder }
  } else if (type === 'table') {
    const { table, remainder } = markdownSlideTable(rest)
    slide = { title, layout: 'table', table, bullets: remainder }
  } else if (type === 'split') slide = markdownSplitSlide(title, rest, path)
  else if (type === 'quote') slide = markdownQuoteSlide(title, rest, lines.some((line) => /^<!--\s*quote\s*-->$/iu.test(line)), path)
  else if (type === 'process') slide = markdownProcessSlide(title, rest)
  else {
    const bullets = rest.map(markdownSlideText).filter(Boolean)
    const layout = ['cover', 'section', 'end', 'statement'].includes(type)
      ? type : bullets.length ? 'bullets' : 'statement'
    slide = { title, layout, bullets }
  }
  if (introduction) slide.subtitle = [introduction, slide.subtitle].filter(Boolean).join('\n')
  assertPptxSchema(slide, PPTX_SLIDE_SCHEMA, path)
  if (slide.table) normalizePptxTable(slide.table, `${path}.table`)
  return slide
}

/** Legacy Markdown is normalized before rendering, never used to rescue a failed canvas. */
export function canonicalPptxMarkdownSlides(markdown) {
  if (typeof markdown !== 'string') invalidPptx('markdown', 'must be a string')
  const sources = markdownSlideSources(markdown)
  if (sources.length > PPTX_LIMITS.slides) invalidPptx('slides', `must contain at most ${PPTX_LIMITS.slides} slides`)
  return sources.map(canonicalMarkdownSlide)
}
