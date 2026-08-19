function eventContext(context, state) {
  return {
    ...(context && typeof context === 'object' ? context : {}),
    iteration: state?.iteration ?? context?.iteration ?? 0,
  }
}

/**
 * Run the extensible boundary that precedes one model/tool-loop iteration.
 * Listeners may replace the state, while returning undefined keeps it intact.
 */
export async function runPreStep({ loopEvents, context = {}, state = {} } = {}) {
  if (!loopEvents || typeof loopEvents.waterfall !== 'function') return state
  return loopEvents.waterfall('pre-step', state, eventContext(context, state))
}
