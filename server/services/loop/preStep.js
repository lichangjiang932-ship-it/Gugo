import { observeLoopEvent } from './eventIsolation.js'

function eventContext(context, state) {
  return {
    ...(context && typeof context === 'object' ? context : {}),
    iteration: state?.iteration ?? context?.iteration ?? 0,
  }
}

/** Observe one model/tool-loop iteration without granting prompt or tool mutation authority. */
export async function runPreStep({ loopEvents, context = {}, state = {} } = {}) {
  if (!loopEvents) return state
  await observeLoopEvent({
    loopEvents,
    event: 'pre-step',
    value: state,
    context: eventContext(context, state),
  })
  return state
}
