import { normalizePublicTurnTimeline } from '../../shared/publicTurnTimeline.js'

/** Return one coherent display coordinate space without changing canonical model history. */
export function assistantPublicTimeline(message, content = message?.content || '') {
  const toolCalls = Array.isArray(message?.meta?.toolCalls) ? message.meta.toolCalls : []
  if (!message?.meta?.serverTurnId) return { content, toolCalls }
  const projection = normalizePublicTurnTimeline(message?.meta?.publicTimeline, {
    turnId: message?.meta?.serverTurnId, canonicalText: content,
  })
  if (!projection || message?.meta?.streaming === true) return { content, toolCalls }
  const anchors = new Map(projection.toolAnchors.map((anchor) => [anchor.id, anchor]))
  if (!toolCalls.length || toolCalls.some((call) => anchors.get(call.id)?.name !== call.name)) return { content, toolCalls }
  return { content: projection.text, toolCalls: toolCalls.map((call) => ({ ...call, textOffset: anchors.get(call.id).textOffset })) }
}
