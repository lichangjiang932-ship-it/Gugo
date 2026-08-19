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
