export function timestampOf(session) {
  const raw = session?.updatedAt ?? session?.createdAt ?? session?.messages?.at?.(-1)?.timestamp
  const parsed = typeof raw === 'number' ? raw : Date.parse(raw)
  return Number.isFinite(parsed) ? parsed : 0
}

export function sortSessions(sessions = []) {
  return [...sessions].sort((left, right) => timestampOf(right) - timestampOf(left))
}
