function validTimestamp(raw) {
  const parsed = typeof raw === 'number' || (typeof raw === 'string' && /^\d+$/.test(raw.trim()))
    ? Number(raw) : Date.parse(raw)
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 8640000000000000 ? parsed : 0
}

export function timestampOf(session) {
  return Math.max(...[session?.updatedAt, session?.createdAt, session?.messages?.at?.(-1)?.timestamp].map(validTimestamp))
}

export function pinnedTimestampOf(session) {
  return validTimestamp(session?.pinnedAt)
}

const dateFormatters = new Map()
const timePresentations = new Map()
function dateFormatter(locale, kind, options) {
  const language = locale === 'en' ? 'en-US' : 'zh-CN'
  const key = `${language}:${kind}`
  if (!dateFormatters.has(key)) dateFormatters.set(key, new Intl.DateTimeFormat(language, options))
  return dateFormatters.get(key)
}

export function sessionTimePresentation(session, { locale = 'zh', now = Date.now() } = {}) {
  const timestamp = timestampOf(session)
  if (!timestamp) return null
  const date = new Date(timestamp)
  const today = new Date(now)
  const sameYear = date.getFullYear() === today.getFullYear()
  const sameDay = sameYear && date.getMonth() === today.getMonth() && date.getDate() === today.getDate()
  const kind = sameDay ? 'time' : sameYear ? 'date' : 'year'
  const cacheKey = `${locale}:${kind}:${timestamp}`
  if (timePresentations.has(cacheKey)) return timePresentations.get(cacheKey)
  const options = sameDay ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }
    : { month: '2-digit', day: '2-digit', ...(sameYear ? {} : { year: '2-digit' }) }
  try {
    const result = { compact: dateFormatter(locale, kind, options).format(date), dateTime: date.toISOString(),
      full: dateFormatter(locale, 'full', { dateStyle: 'medium', timeStyle: 'short' }).format(date) }
    if (timePresentations.size >= 2048) timePresentations.delete(timePresentations.keys().next().value)
    timePresentations.set(cacheKey, result)
    return result
  } catch { return null }
}

export function sortSessions(sessions = []) {
  return sessions
    .map((session, index) => ({ session, index }))
    .sort((left, right) => {
      const leftPinned = pinnedTimestampOf(left.session) > 0
      const rightPinned = pinnedTimestampOf(right.session) > 0
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

export function workspacePathKey(value) {
  const path = String(value || '').trim()
  if (/^[a-z]:[\\/]/i.test(path) || /^(?:\\\\|\/\/)/.test(path)) {
    const windows = path.replace(/\//g, '\\')
    const prefix = windows.startsWith('\\\\') ? '\\\\' : ''
    const normalized = prefix + windows.slice(prefix.length).replace(/\\+/g, '\\')
    if (/^[a-z]:\\$/i.test(normalized)) return normalized.toLowerCase()
    return normalized.replace(/\\+$/, '').toLowerCase()
  }
  return path.replace(/\/+$/, '') || (path.startsWith('/') ? '/' : '')
}

export function workspaceName(value) {
  const path = String(value || '').trim()
  const normalized = path.replace(/[\\/]+$/, '') || (path.startsWith('/') ? '/' : '')
  return normalized.split(/[\\/]/).filter(Boolean).at(-1) || normalized
}

export function groupSessionsByProject(sessions = [], storedProjects = []) {
  const projectsByPath = new Map()
  const ensureProject = ({ path, name, usedAt = 0 }) => {
    const normalizedPath = String(path || '').trim()
    const key = workspacePathKey(normalizedPath)
    if (!key) return null
    if (!projectsByPath.has(key)) {
      projectsByPath.set(key, {
        key,
        path: normalizedPath,
        name: String(name || '').trim() || workspaceName(normalizedPath),
        sessions: [],
        usedAt: Number(usedAt) || 0,
      })
    }
    return projectsByPath.get(key)
  }

  for (const project of Array.isArray(storedProjects) ? storedProjects : []) {
    ensureProject(project || {})
  }

  const ungrouped = []
  for (const session of Array.isArray(sessions) ? sessions : []) {
    const path = String(session?.workspacePath || '').trim()
    if (!path) {
      ungrouped.push(session)
      continue
    }
    const project = ensureProject({ path })
    if (!project) { ungrouped.push(session); continue }
    project.sessions.push(session)
    project.usedAt = Math.max(project.usedAt, timestampOf(session))
  }

  return {
    projects: [...projectsByPath.values()]
      .map((project) => ({ ...project, sessions: sortSessions(project.sessions) }))
      .sort((left, right) => right.usedAt - left.usedAt || left.name.localeCompare(right.name)),
    ungrouped: sortSessions(ungrouped),
  }
}
