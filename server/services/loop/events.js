export const LOOP_EVENT_NAMES = Object.freeze([
  'pre-step',
  'request',
  'request-error',
  'pre-tool',
  'post-tool',
  'compaction',
  'turn-stopping',
])

const LOOP_EVENT_NAME_SET = new Set(LOOP_EVENT_NAMES)

function assertEventName(event) {
  if (!LOOP_EVENT_NAME_SET.has(event)) {
    throw new TypeError(`Unknown loop event: ${String(event)}`)
  }
}

function assertListener(listener) {
  if (typeof listener !== 'function') {
    throw new TypeError('Loop event listener must be a function')
  }
}

/**
 * Per-loop event bus. Dispatch always snapshots listeners so registering or
 * removing a listener during an event only affects subsequent dispatches.
 */
export function createLoopEvents() {
  const listeners = new Map(LOOP_EVENT_NAMES.map((event) => [event, new Set()]))

  const snapshot = (event) => {
    assertEventName(event)
    return [...listeners.get(event)]
  }

  const on = (event, listener) => {
    assertEventName(event)
    assertListener(listener)
    listeners.get(event).add(listener)
    return () => off(event, listener)
  }

  const off = (event, listener) => {
    assertEventName(event)
    assertListener(listener)
    return listeners.get(event).delete(listener)
  }

  const emit = async (event, value, context) => Promise.all(
    snapshot(event).map((listener) => listener(value, context)),
  )

  const serial = async (event, value, context) => {
    const results = []
    for (const listener of snapshot(event)) {
      results.push(await listener(value, context))
    }
    return results
  }

  const waterfall = async (event, value, context) => {
    let current = value
    for (const listener of snapshot(event)) {
      const next = await listener(current, context)
      if (next !== undefined) current = next
    }
    return current
  }

  return Object.freeze({ on, off, emit, serial, waterfall })
}
