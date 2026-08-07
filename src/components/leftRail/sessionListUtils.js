function startOfLocalDay(value) {
  const date = new Date(value)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

export function timestampOf(session) {
  const raw = session?.updatedAt ?? session?.createdAt ?? session?.messages?.at?.(-1)?.timestamp
  const parsed = typeof raw === 'number' ? raw : Date.parse(raw)
  return Number.isFinite(parsed) ? parsed : 0
}

export function groupSessions(sessions, now = Date.now()) {
  const todayStart = startOfLocalDay(now)
  const today = new Date(todayStart)
  const yesterday = new Date(todayStart)
  yesterday.setDate(today.getDate() - 1)
  const weekStart = new Date(todayStart)
  weekStart.setDate(today.getDate() - ((today.getDay() + 6) % 7))
  const groups = { today: [], yesterday: [], week: [], earlier: [] }
  ;[...sessions].sort((left, right) => timestampOf(right) - timestampOf(left)).forEach((session) => {
    const time = timestampOf(session)
    const sessionDay = time ? startOfLocalDay(time) : 0
    if (sessionDay >= todayStart) groups.today.push(session)
    else if (sessionDay === yesterday.getTime()) groups.yesterday.push(session)
    else if (sessionDay >= weekStart.getTime()) groups.week.push(session)
    else groups.earlier.push(session)
  })
  return groups
}
