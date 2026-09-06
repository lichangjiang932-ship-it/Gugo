import { normalizeOptionalUsageNumber } from '../../../shared/modelUsage.js'
import { normalizeToolLoopModelResponse } from '../../core/toolLoopModelResponse.js'

function cloneJson(value, fallback) {
  try { return JSON.parse(JSON.stringify(value)) } catch { return fallback }
}

export function snapshotModelResponse(response) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    throw new TypeError('model response must be an object')
  }
  response = normalizeToolLoopModelResponse(response)
  const costUsd = normalizeOptionalUsageNumber(response.costUsd)
  return {
    content: String(response.content ?? ''),
    toolCalls: cloneJson(Array.isArray(response.toolCalls) ? response.toolCalls : [], []),
    ...(response.usage && typeof response.usage === 'object'
      ? { usage: cloneJson(response.usage, null) }
      : {}),
    ...(response.modelName != null ? { modelName: String(response.modelName) } : {}),
    ...(response.providerId != null ? { providerId: String(response.providerId) } : {}),
    ...(response.finishReason != null ? { finishReason: String(response.finishReason) } : {}),
    ...(costUsd !== null ? { costUsd } : {}),
    ...(response.reasoningContent != null ? { reasoningContent: String(response.reasoningContent) } : {}),
  }
}
