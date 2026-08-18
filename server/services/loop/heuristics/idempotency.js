export function buildJobToolIdempotencyKey({ jobId, stepId, toolCallId }) {
  return `job:${String(jobId || 'unknown')}:step:${String(stepId || 'unknown')}:tool:${String(toolCallId || 'unknown')}`
}

export function textToolCallScope(value) {
  return String(value || 'turn')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'turn'
}

/**
 * Local chat templates often restart their synthetic call ids at
 * `text-tool-1` for every model response. Scope only those compatibility ids
 * before checkpointing so later tool rounds cannot overwrite the first UI row
 * or reuse the same connector idempotency key. The scope is deterministic, so
 * a persisted turn remains stable across process restarts.
 */
export function scopeTextToolCallIds(rawCalls, { turnId, iteration = 0 } = {}) {
  if (!Array.isArray(rawCalls)) return []
  const scope = textToolCallScope(turnId)
  const round = Math.max(0, Math.floor(Number(iteration) || 0)) + 1
  return rawCalls.map((call, index) => {
    const id = String(call?.id || '')
    if (!/^text-tool-\d+$/i.test(id)) return call
    return {
      ...call,
      id: `text-tool-${scope}-i${round}-c${index + 1}`,
    }
  })
}

export function supportsIdempotentResume(executor, callContext) {
  const capability = executor?.supportsIdempotentResume
  if (typeof capability === 'function') return capability(callContext) === true
  return capability === true
}
