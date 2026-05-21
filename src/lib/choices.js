/**
 * Choice 格式解析工具。
 * 借鉴 Reasonix ask_choice 设计。
 *
 * 格式: [[choice:id1:title1~summary1|id2:title2~summary2]]
 */

const CHOICE_RE = /\[\[choice:([^\]]+)\]\]/

export function parseChoices(text) {
  const m = text.match(CHOICE_RE)
  if (!m) return null
  const raw = m[1]
  const parts = raw.split('|').map((part) => part.trim()).filter(Boolean)
  const options = parts.map((part) => {
    const [id, ...rest] = part.split(':')
    const body = rest.join(':') || ''
    const [title, summary] = body.split('~').map((s) => s.trim())
    return { id: id.trim(), title: title || id.trim(), summary: summary || '' }
  })
  return { match: m[0], options }
}

export function hasChoices(text) {
  return CHOICE_RE.test(text)
}

export function stripChoices(text) {
  const parsed = parseChoices(text)
  if (!parsed) return text
  return text.replace(parsed.match, '').trim()
}
