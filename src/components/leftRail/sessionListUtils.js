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

export function workspacePathKey(value) {
  const normalized = String(value || '').trim().replace(/[\\/]+$/, '')
  return /^[a-z]:[\\/]/i.test(normalized) ? normalized.toLowerCase() : normalized
}

export function workspaceName(value) {
  const normalized = String(value || '').trim().replace(/[\\/]+$/, '')
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
