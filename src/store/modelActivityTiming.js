/** Token deltas change the activity kind, not the identity of its model request. */
export function preserveModelActivityTiming(previousMeta = {}, nextMeta = {}) {
  const previous = previousMeta.modelActivity
  const next = nextMeta.modelActivity
  if (!previous || !next || !['responding', 'reasoning'].includes(next.kind)
    || Object.hasOwn(next, 'startedAt')
    || !Number.isFinite(previous.startedAt) || previous.startedAt <= 0
    || (Number.isInteger(previous.iteration) && Number.isInteger(next.iteration) && previous.iteration !== next.iteration)) return nextMeta
  return {
    ...nextMeta,
    modelActivity: {
      ...next,
      startedAt: previous.startedAt,
      ...(next.iteration === undefined && Number.isInteger(previous.iteration) ? { iteration: previous.iteration } : {}),
    },
  }
}
