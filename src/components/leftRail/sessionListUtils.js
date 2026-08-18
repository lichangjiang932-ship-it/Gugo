export function timestampOf(session) {
  const raw = session?.updatedAt ?? session?.createdAt ?? session?.messages?.at?.(-1)?.timestamp
  const parsed = typeof raw === 'number' ? raw : Date.parse(raw)
  return Number.isFinite(parsed) ? parsed : 0
}

export function pinnedTimestampOf(session) {
  const raw = session?.pinnedAt
  const parsed = typeof raw === 'number' ? raw : Date.parse(raw)
  return Number.isFinite(parsed) ? parsed : 0
}

export function sortSessions(sessions = []) {
  return sessions
    .map((session, index) => ({ session, index }))
    .sort((left, right) => {
      const leftPinned = left.session?.pinnedAt != null
      const rightPinned = right.session?.pinnedAt != null
      if (leftPinned !== rightPinned) return leftPinned ? -1 : 1
      if (leftPinned) {
        const pinDifference = pinnedTimestampOf(right.session) - pinnedTimestampOf(left.session)
        if (pinDifference) return pinDifference
        const idDifference = String(left.session?.id || '').localeCompare(String(right.session?.id || ''))
        if (idDifference) return idDifference
      }
      const activityDifference = timestampOf(right.session) - timestampOf(left.session)
      return activityDifference || left.index - right.index
    })
    .map(({ session }) => session)
}

function compactLabel(value, maxLength = 72) {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  if (text.length <= maxLength) return text
  return `${text.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`
}

function pathParts(value) {
  const text = String(value || '').trim()
  if (!text || (!/[\\/]/.test(text) && !/^[a-z]:/i.test(text))) return []
  return text.replace(/[\\/]+/g, '/').split('/').filter(Boolean)
}

function cleanProjectSegment(value) {
  const segment = String(value || '').replace(/\.[^./]+$/, '').split('...')[0].trim()
  return compactLabel(segment || 'Gugo', 36)
}

export function sessionProjectLabel(session = {}) {
  const explicit = session.projectName || session.workspaceName || session.project?.name
  if (explicit) return compactLabel(explicit, 36)
  const workspaceParts = pathParts(session.projectDirectory || session.workspacePath || session.cwd)
  if (workspaceParts.length) return cleanProjectSegment(workspaceParts.at(-1))
  const titleParts = pathParts(session.title)
  if (titleParts.length) return cleanProjectSegment(titleParts.at(-1))
  return 'Gugo'
}

export function sessionSummaryLabel(session = {}) {
  const explicit = session.summary || session.lastMessagePreview || session.preview
  if (explicit) return compactLabel(explicit)
  const titleParts = pathParts(session.title)
  if (titleParts.length) return compactLabel(titleParts.at(-1))
  const latestMessage = session.messages?.at?.(-1)?.content
  return compactLabel(latestMessage || session.title || 'New conversation')
}

export function formatRelativeSessionTime(session, {
  now = Date.now(),
  locale = 'zh-CN',
} = {}) {
  const timestamp = timestampOf(session)
  if (!timestamp) return ''
  const deltaMs = timestamp - now
  const absoluteMs = Math.abs(deltaMs)
  const relative = new Intl.RelativeTimeFormat(locale || 'zh-CN', { numeric: 'auto' })
  if (absoluteMs < 60_000) return relative.format(0, 'minute')
  if (absoluteMs < 3_600_000) return relative.format(Math.round(deltaMs / 60_000), 'minute')
  if (absoluteMs < 86_400_000) return relative.format(Math.round(deltaMs / 3_600_000), 'hour')
  if (absoluteMs < 604_800_000) return relative.format(Math.round(deltaMs / 86_400_000), 'day')
  return new Intl.DateTimeFormat(locale || 'zh-CN', { month: 'numeric', day: 'numeric' }).format(timestamp)
}

export function groupSessionsByProject(sessions = []) {
  const groups = new Map()
  for (const session of sortSessions(sessions)) {
    const project = sessionProjectLabel(session)
    if (!groups.has(project)) groups.set(project, [])
    groups.get(project).push(session)
  }
  return [...groups.entries()].map(([project, groupedSessions]) => ({ project, sessions: groupedSessions }))
}
