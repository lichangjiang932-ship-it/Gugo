const SYSTEM_DRAG_THRESHOLD = 1

function finitePoint(value) {
  const x = Number(value?.x)
  const y = Number(value?.y)
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null
}

function finiteBounds(value) {
  const point = finitePoint(value)
  const width = Number(value?.width)
  const height = Number(value?.height)
  if (!point || !Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) return null
  return { ...point, width, height }
}

export function createDesktopPetDragSession({ senderId, cursor, bounds } = {}) {
  const start = finitePoint(cursor)
  const origin = finiteBounds(bounds)
  if (!Number.isFinite(senderId) || !start || !origin) return null
  return {
    senderId,
    start,
    last: start,
    origin,
    moved: false,
  }
}

export function resolveDesktopPetDragMove(session, cursor) {
  if (!session) return { accepted: false, reason: 'inactive', session }
  const point = finitePoint(cursor)
  if (!point) return { accepted: false, reason: 'invalid', session }
  if (point.x === session.last.x && point.y === session.last.y) {
    return { accepted: false, reason: 'stationary', session }
  }

  const deltaX = point.x - session.start.x
  const deltaY = point.y - session.start.y
  if (!session.moved && Math.hypot(deltaX, deltaY) < SYSTEM_DRAG_THRESHOLD) {
    return { accepted: false, reason: 'threshold', session }
  }

  const nextSession = { ...session, last: point, moved: true }
  return {
    accepted: true,
    session: nextSession,
    bounds: {
      x: Math.round(session.origin.x + deltaX),
      y: Math.round(session.origin.y + deltaY),
      width: session.origin.width,
      height: session.origin.height,
    },
  }
}
