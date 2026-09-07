const NUMBERED_PAGE = /^(?:#{1,4}\s*)?(\d{1,2})(?:\.|、)\s+(.+)$/u
const NUMBERED_HEADING_PAGE = /^#{1,4}\s*(\d{1,2})(?:\.|、)\s+(.+)$/u
const CHINESE_PAGE = /^第\s*([一二三四五六七八九十\d]{1,3})\s*页[：:、.]?\s*(.+)$/u
const HEADING = /^#{1,6}\s+\S/u
const TYPE_DECLARATION = /^<!--\s*[\w-]+\s*-->$/u

function nonEmptyLines(value) {
  return value.split('\n').map((line) => line.trim()).filter(Boolean)
}

/** Preserve explicit page boundaries and source text without legacy length clipping. */
export function markdownSlideSources(markdown) {
  const normalized = markdown.replace(/\r\n/gu, '\n').trim()
  const outerFence = normalized.match(/^```(?:markdown|md)?[ \t]*\n([\s\S]*)\n```[ \t]*$/iu)
  const clean = (outerFence ? outerFence[1] : normalized).trim()
  if (!clean) return []
  const separated = clean.split(/^\s*---+\s*$/mu).map(nonEmptyLines).filter((lines) => lines.length)
  if (separated.length > 1) return separated.map((lines) => ({ lines }))
  const lines = separated[0] || []
  const firstNumbered = lines.findIndex((line) => NUMBERED_PAGE.test(line))
  const explicitPageNumbers = lines.some((line) => CHINESE_PAGE.test(line) || NUMBERED_HEADING_PAGE.test(line))
  // A title or type declaration before an ordered list owns that body. Only
  // explicit numbered page headings may override it, not the body's numbers.
  if (!explicitPageNumbers && firstNumbered >= 0
    && lines.slice(0, firstNumbered).some((line) => HEADING.test(line) || TYPE_DECLARATION.test(line))) {
    return [{ lines }]
  }
  const numberedPage = explicitPageNumbers ? NUMBERED_HEADING_PAGE : NUMBERED_PAGE
  const slides = []
  let preface = []
  let current = null
  for (const line of lines) {
    const numbered = line.match(numberedPage) || line.match(CHINESE_PAGE)
    if (numbered) {
      let introduction = ''
      if (!current && preface.length) {
        if (preface.length >= 2 || preface.some((item) => HEADING.test(item))) slides.push({ lines: preface })
        // Legacy outlines did not allocate a page for a single unmarked
        // introduction. Keep that page count, but retain its text as context.
        else introduction = preface[0]
        preface = []
      }
      if (current) slides.push(current)
      current = { lines: [numbered[2].trim()], ...(introduction ? { introduction } : {}) }
    } else if (current) current.lines.push(line)
    else preface.push(line)
  }
  if (current) slides.push(current)
  if (!slides.length && preface.length) slides.push({ lines: preface })
  return slides
}

function inlineMarkdownText(line) {
  return String(line).replace(/\*\*([^*]+)\*\*/gu, '$1').trim()
}

export function markdownSlideText(line) {
  return inlineMarkdownText(String(line)
    .replace(/^>\s?/u, '')
    .replace(/^#{1,6}\s+/u, '')
    .replace(/^[-*+]\s+/u, ''))
}

function markdownTableCells(line) {
  let source = line.trim().replace(/^\|/u, '')
  if (source.endsWith('|')) {
    const escapes = source.slice(0, -1).match(/\\+$/u)?.[0].length || 0
    if (escapes % 2 === 0) source = source.slice(0, -1)
  }
  const cells = []
  let cell = ''
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    if (character === '\\' && ['|', '\\'].includes(source[index + 1])) {
      cell += source[index + 1]
      index += 1
    } else if (character === '|') {
      cells.push(inlineMarkdownText(cell))
      cell = ''
    } else cell += character
  }
  cells.push(inlineMarkdownText(cell))
  return cells
}

export function markdownSlideTable(lines) {
  const rows = []
  const remainder = []
  let header = false
  for (const line of lines) {
    if (!/^\s*\|/u.test(line)) {
      remainder.push(markdownSlideText(line))
      continue
    }
    const cells = markdownTableCells(line)
    if (!header && rows.length === 1 && cells.every((cell) => /^:?-+:?$/u.test(cell))) header = true
    else rows.push(cells)
  }
  return { table: { rows, header }, remainder: remainder.filter(Boolean) }
}
