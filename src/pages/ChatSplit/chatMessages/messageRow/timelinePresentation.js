import { buildMessageTimeline } from '../../../../lib/messageTimeline.js'
import { stripChoices } from '../../../../lib/choices.js'

export function stableTimelineSegments(content, toolCalls) {
  let previousToolKey = 'start'
  let toolStepOffset = 0
  return buildMessageTimeline(content, toolCalls).map((segment, index) => {
    if (segment.kind === 'tools') {
      const firstCall = segment.calls?.[0]
      const stepOffset = toolStepOffset
      toolStepOffset += segment.calls?.length || 0
      previousToolKey = String(firstCall?.id || `offset-${firstCall?.textOffset ?? index}`)
      return { ...segment, key: `tools:${previousToolKey}`, stepOffset }
    }
    // Tool offsets index the original body. Removing display-only controls
    // before slicing would move every subsequent call into unrelated text.
    return { ...segment, text: stripChoices(segment.text), key: `text-after:${previousToolKey}` }
  }).filter((segment) => segment.kind !== 'text' || segment.text)
}

export function assistantTimelinePresentation(timeline) {
  const normalized = Array.isArray(timeline) ? timeline : []
  const hasTools = normalized.some((segment) => segment.kind === 'tools')
  if (!hasTools) {
    return {
      execution: [],
      answer: normalized.filter((segment) => segment.kind === 'text').map((segment) => segment.text).join(''),
      hasPublicNarration: false,
    }
  }
  const lastToolIndex = normalized.findLastIndex((segment) => segment.kind === 'tools')
  const hasPublicNarration = normalized.some((segment, index) => index < lastToolIndex
    && segment.kind === 'text' && String(segment.text || '').trim())
  const finalTextIndex = normalized.findLastIndex((segment, index) => (
    index > lastToolIndex
    && segment.kind === 'text'
    && String(segment.text || '').trim()
  ))
  if (finalTextIndex < 0) return { execution: normalized, answer: '', hasPublicNarration }
  return {
    execution: normalized.filter((_, index) => index !== finalTextIndex),
    answer: normalized[finalTextIndex].text,
    hasPublicNarration,
  }
}
