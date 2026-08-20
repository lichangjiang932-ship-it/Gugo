function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value
  seen.add(value)
  for (const child of Object.values(value)) deepFreeze(child, seen)
  return Object.freeze(value)
}

export function immutableEventSnapshot(value, label = 'loop event') {
  try {
    return deepFreeze(structuredClone(value))
  } catch {
    return deepFreeze({
      unavailable: true,
      reason: `${label} payload was not cloneable data`,
    })
  }
}

export async function observeLoopEvent({
  loopEvents,
  event,
  value,
  context = {},
} = {}) {
  if (!loopEvents) return immutableEventSnapshot(value, event)
  if (typeof loopEvents.has === 'function' && !loopEvents.has(event)) return null
  const payload = immutableEventSnapshot(value, event)
  const eventContext = immutableEventSnapshot(context, `${event} context`)
  if (typeof loopEvents.observe === 'function') {
    await loopEvents.observe(event, payload, eventContext)
  } else if (typeof loopEvents.serial === 'function') {
    try {
      await loopEvents.serial(event, payload, eventContext)
    } catch { /* observer errors do not own host control flow */ }
  } else if (typeof loopEvents.waterfall === 'function') {
    try {
      await loopEvents.waterfall(event, payload, eventContext)
    } catch { /* compatibility bus: preserve observer fail-open semantics */ }
  }
  return payload
}
