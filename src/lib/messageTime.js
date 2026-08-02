const LOCALES = {
  zh: 'zh-CN',
  en: 'en-US',
  ja: 'ja-JP',
  ko: 'ko-KR',
  'zh-TW': 'zh-TW',
}

export function normalizeMessageTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  if (typeof value !== 'string' || value.trim() === '') return null

  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

export function backfillMessageTimestamps(sessions, now = Date.now()) {
  if (!Array.isArray(sessions)) return []
  const fallbackNow = normalizeMessageTimestamp(now) ?? Date.now()

  return sessions.map((session) => {
    if (!Array.isArray(session?.messages)) return session

    const baseTimestamp = normalizeMessageTimestamp(session.createdAt)
      ?? normalizeMessageTimestamp(session.updatedAt)
      ?? fallbackNow
    let changed = false
    const messages = session.messages.map((message, index) => {
      if (normalizeMessageTimestamp(message?.timestamp) !== null) return message
      changed = true
      return { ...message, timestamp: baseTimestamp + index }
    })

    return changed ? { ...session, messages } : session
  })
}

function localeFor(lang) {
  return LOCALES[lang] || LOCALES.en
}

export function formatMessageTime(timestamp, lang = 'zh') {
  const normalized = normalizeMessageTimestamp(timestamp)
  if (normalized === null) return ''
  return new Intl.DateTimeFormat(localeFor(lang), {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(normalized)
}

export function formatMessageDateTime(timestamp, lang = 'zh') {
  const normalized = normalizeMessageTimestamp(timestamp)
  if (normalized === null) return ''
  return new Intl.DateTimeFormat(localeFor(lang), {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(normalized)
}

/** 按最近活动时间把会话分到自然日；组和组内会话均按新到旧排列。 */
export function groupSessionsByDay(sessions) {
  if (!Array.isArray(sessions)) return []
  const groups = new Map()
  for (const session of sessions) {
    const timestamp = normalizeMessageTimestamp(session?.updatedAt)
      ?? normalizeMessageTimestamp(session?.createdAt)
    if (timestamp === null) continue
    const dayStart = new Date(timestamp).setHours(0, 0, 0, 0)
    if (!groups.has(dayStart)) groups.set(dayStart, [])
    groups.get(dayStart).push({ session, timestamp })
  }
  return [...groups.entries()]
    .sort(([left], [right]) => right - left)
    .map(([dayStart, entries]) => ({
      dayStart,
      items: entries
        .sort((left, right) => right.timestamp - left.timestamp)
        .map(({ session }) => session),
    }))
}

/** 侧栏较早日期使用本地化的月/日；跨年时补年份。 */
export function formatSessionGroupDate(timestamp, lang = 'zh', now = Date.now()) {
  const normalized = normalizeMessageTimestamp(timestamp)
  if (normalized === null) return ''
  const date = new Date(normalized)
  const current = new Date(normalizeMessageTimestamp(now) ?? Date.now())
  return new Intl.DateTimeFormat(localeFor(lang), {
    ...(date.getFullYear() === current.getFullYear() ? {} : { year: 'numeric' }),
    month: 'short',
    day: 'numeric',
    weekday: 'short',
  }).format(date)
}
