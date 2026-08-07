export function formatTaskStatus(item, t) {
  if (item.state === 'done') return t('history.done')
  if (item.state === 'active') return t('history.active')
  return t('history.failed')
}

export function getItemType(item) {
  if (item.type === 'session') return 'sessions'
  if (item.type === 'task' || (item.state != null && item.state !== '')) return 'tasks'
  return 'sessions'
}

export function contentPreview(content, t) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((part) => part?.type === 'text' ? part.text : part?.type === 'image_url' ? t('history.image') : '').filter(Boolean).join(' ')
}

export function timestampValue(item) {
  const value = item.date || item.updatedAt || item.createdAt
  const parsed = typeof value === 'number' ? value : Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

export function groupByDate(items, t, lang) {
  const groups = {}
  for (const item of items) {
    const timestamp = timestampValue(item)
    const date = timestamp ? new Date(timestamp).toLocaleDateString(lang) : t('history.unknownDate')
    if (!groups[date]) groups[date] = []
    groups[date].push(item)
  }
  return Object.entries(groups).map(([date, groupedItems]) => ({ date, items: groupedItems }))
}
