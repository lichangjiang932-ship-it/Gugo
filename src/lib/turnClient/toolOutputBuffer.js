export const TOOL_LIVE_OUTPUT_CHAR_LIMIT = 16_000
export const DEFAULT_TOOL_OUTPUT_FLUSH_MS = 50

function defaultSchedule(callback, delay) {
  return globalThis.setTimeout(callback, delay)
}

function defaultCancel(handle) {
  globalThis.clearTimeout(handle)
}

function tail(value, limit) {
  return value.length > limit ? value.slice(-limit) : value
}

export function createToolOutputBuffer({
  onFlush,
  flushMs = DEFAULT_TOOL_OUTPUT_FLUSH_MS,
  maxChars = TOOL_LIVE_OUTPUT_CHAR_LIMIT,
  schedule = defaultSchedule,
  cancel = defaultCancel,
} = {}) {
  if (typeof onFlush !== 'function') throw new TypeError('onFlush must be a function')

  const interval = Number.isFinite(Number(flushMs)) ? Math.max(0, Number(flushMs)) : DEFAULT_TOOL_OUTPUT_FLUSH_MS
  const limit = Number.isInteger(Number(maxChars)) && Number(maxChars) > 0
    ? Number(maxChars)
    : TOOL_LIVE_OUTPUT_CHAR_LIMIT
  const pending = new Map()
  let scheduledHandle = null
  let disposed = false

  const cancelScheduled = () => {
    if (scheduledHandle === null) return
    cancel(scheduledHandle)
    scheduledHandle = null
  }

  const drain = () => {
    if (pending.size === 0) return 0
    const outputs = [...pending.values()]
    pending.clear()
    for (const output of outputs) onFlush(output)
    return outputs.length
  }

  const flush = () => {
    cancelScheduled()
    return drain()
  }

  const schedulePendingFlush = () => {
    if (scheduledHandle !== null) return
    scheduledHandle = schedule(() => {
      scheduledHandle = null
      drain()
    }, interval)
    scheduledHandle?.unref?.()
  }

  const append = ({ id, name, chunk, stream, turnId } = {}) => {
    if (disposed || !id || typeof chunk !== 'string' || chunk.length === 0) return false
    const existing = pending.get(id)
    const resolvedTurnId = turnId || existing?.turnId || null
    pending.set(id, {
      id,
      name: name || existing?.name,
      chunk: tail(`${existing?.chunk || ''}${chunk}`, limit),
      stream: stream || existing?.stream || 'stdout',
      ...(resolvedTurnId ? { turnId: resolvedTurnId } : {}),
    })
    schedulePendingFlush()
    return true
  }

  const dispose = () => {
    if (disposed) return 0
    disposed = true
    cancelScheduled()
    return drain()
  }

  return {
    append,
    flush,
    dispose,
    get pendingCount() { return pending.size },
  }
}
