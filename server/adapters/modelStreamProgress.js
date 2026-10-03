import { normalizeModelPhaseProgress } from '../../shared/modelPhaseProgress.js'

export function hasModelContentProgress(value) {
  return typeof value === 'string' && value.trim().length > 0
}

/** Only counts and bounded identities escape; incomplete argument text remains private. */
export function createToolArgumentProgressTracker() {
  const previous = new Map()
  return (call, index = 0) => {
    const args = call?.arguments ?? call?.function?.arguments
    if (typeof args !== 'string') return null
    const prior = previous.get(index) || ''
    previous.set(index, args)
    const delta = args.startsWith(prior) ? args.slice(prior.length) : args
    if (!hasModelContentProgress(delta)) return null
    return { type: 'tool_call_progress', index, ...normalizeModelPhaseProgress({
      toolName: call?.name || call?.function?.name,
      toolCallId: call?.id,
      toolArgumentsChars: args.length,
    }) }
  }
}
