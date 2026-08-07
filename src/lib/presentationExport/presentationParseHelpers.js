export const MAX_BULLETS_PER_SLIDE = 5
const MAX_BULLET_LENGTH = 80
const MAX_RICH_BULLET_MAIN_LENGTH = 96
const MAX_RICH_BULLET_NOTE_LENGTH = 160

export function stripMarkdownFence(markdown = '') {
  return String(markdown)
    .replace(/\r\n/g, '\n')
    .replace(/^```(?:markdown|md)?\s*/i, '')
    .replace(/\n```\s*$/i, '')
    .trim()
}

export function cleanTitle(line = '') {
  return line
    .replace(/^#{1,6}\s*/, '')
    .replace(/^\d{1,2}[.\u3001]\s*/, '')
    .replace(/^\u7b2c[\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341\d]+\u9875[\uff1a:\u3001.]?\s*/, '')
    .replace(/^[-*+]\s*/, '')
    .trim()
}

export function cleanBullet(line = '') {
  return line
    .replace(/^#{1,6}\s*/, '')
    .replace(/^[-*+]\s*/, '')
    .replace(/^\d{1,2}[.\u3001]\s*/, '')
    .replace(/\*\*/g, '')
    .trim()
}

export function truncateBullet(line) {
  return line.length > MAX_BULLET_LENGTH ? `${line.slice(0, MAX_BULLET_LENGTH)}...` : line
}

export function clipText(line, maxLength) {
  const text = String(line || '').trim()
  return text.length > maxLength ? `${text.slice(0, maxLength).trim()}...` : text
}

export function splitRichBullet(line) {
  const text = String(line || '').trim()
  const parts = text.split(/\s*[;\uff1b]\s*/).map((part) => part.trim()).filter(Boolean)
  if (parts.length <= 1) return { main: text, note: '' }
  return { main: parts[0], note: parts.slice(1).join('; ') }
}

export function truncateRichBullet(line) {
  const { main, note } = splitRichBullet(line)
  if (!note) return truncateBullet(main)
  const clippedMain = clipText(main, MAX_RICH_BULLET_MAIN_LENGTH)
  const clippedNote = clipText(note, MAX_RICH_BULLET_NOTE_LENGTH)
  return clippedNote ? `${clippedMain}; ${clippedNote}` : clippedMain
}

/* \u2500\u2500 Enhanced parser \u2500\u2500 */

export function parseTypeTag(lines) {
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

export function parseTableLines(lines) {
  const rows = []
  for (const line of lines) {
    if (!/^\s*\|/.test(line)) continue
    const cells = line.split('|').map((c) => c.trim()).filter((c) => c !== '' && !/^[-:]+$/.test(c))
    if (cells.length) rows.push(cells)
  }
  return rows
}

export function parseDataPoint(line) {
  const pipe = line.match(/^(.+?)\s*\|\s*(.+)$/)
  if (pipe) return { value: pipe[1].trim(), label: pipe[2].trim() }
  const colon = line.match(/^(.+?)\s*[:\uff1a]\s*(.+)$/)
  if (colon) return { value: colon[2].trim(), label: colon[1].trim() }
  const dash = line.match(/^(.+?)\s*[-\u2014]\s*(.+)$/)
  if (dash) return { value: dash[1].trim(), label: dash[2].trim() }
  return null
}

export function parseQuote(lines) {
  if (!lines.length) return null
  const text = cleanBullet(lines[0])
  const source = lines[1] ? cleanBullet(lines[1]) : ''
  return { text, source }
}

export function parseSplitColumns(lines) {
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

export function parseProcessSteps(lines) {
  return lines.map((line) => {
    const m = line.match(/^\d+[.\u3001]\s*(.+?)(?:\s*[-\u2014:\uff1a]\s*(.+))?$/)
    if (m) return { name: m[1].trim(), desc: m[2] ? m[2].trim() : '' }
    const bullet = cleanBullet(line)
    if (bullet) return { name: bullet, desc: '' }
    return null
  }).filter(Boolean)
}

// fenced ```chart``` \u5757\u6216\u88f8 key:value \u884c,\u8fd4\u56de { type, categories, series:[{name, values}] }.
// \u5bb9\u9519:\u65e0 type \u9ed8\u8ba4 bar;column \u89c6\u4f5c bar;\u65e0 series \u4f46\u672b\u5c3e\u8ddf\u6570\u503c\u884c,\u81ea\u52a8\u547d\u540d"\u7cfb\u5217 N".
export function parseChartBlock(lines) {
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
    const mCat = line.match(/^(?:categories|labels|x|\u6a2a\u8f74)\s*[:=]\s*(.+)$/i)
    if (mCat) {
      categories = mCat[1].split(/[,\uff0c\u3001]/).map((s) => s.trim()).filter(Boolean)
      continue
    }
    if (/^series\s*[:=]?\s*$/i.test(line)) continue
    const mRow = line.match(/^[-*]?\s*(?:["']?(.+?)["']?\s*[:\uff1a]\s*)?(.+)$/)
    if (!mRow) continue
    const valuesPart = mRow[2] || ''
    const values = valuesPart.split(/[,\uff0c\u3001\s]+/).map((s) => Number(s)).filter((n) => Number.isFinite(n))
    if (values.length === 0) continue
    const name = (mRow[1] || '').trim() || `\u7cfb\u5217${series.length + 1}`
    series.push({ name, values })
  }
  if (!categories.length && series.length) {
    const len = Math.max(...series.map((s) => s.values.length))
    categories = Array.from({ length: len }, (_, i) => String(i + 1))
  }
  return { type, categories, series }
}
