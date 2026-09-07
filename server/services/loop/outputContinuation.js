import { inspectToolLoopModelResponse } from '../../core/toolLoopModelResponse.js'
import { assertContextRecoveryActive } from '../contextCompactionState.js'
import { modelAssistantHistoryMessage } from './modelAssistantHistory.js'

export const MAX_OUTPUT_CONTINUATIONS = 2
const MAX_CONTINUED_TEXT_CHARS = 128_000
const CONTINUATION_MARKER = '[BOUNDED OUTPUT CONTINUATION]'

export function restoreOutputContinuation(value) {
  if (value == null) return { version: 1, attempts: 0, prefix: '' }
  if (value.version !== 1 || !Number.isSafeInteger(value.attempts)
    || value.attempts < 0 || value.attempts > MAX_OUTPUT_CONTINUATIONS
    || typeof value.prefix !== 'string' || value.prefix.length > MAX_CONTINUED_TEXT_CHARS) {
    throw Object.assign(new Error('The model output continuation checkpoint is invalid'), {
      code: 'MODEL_OUTPUT_CONTINUATION_STATE_INVALID', retryable: false,
    })
  }
  return { version: 1, attempts: value.attempts, prefix: value.prefix }
}

function joinContinuedText(prefix, next) {
  if (!prefix) return next
  if (next.startsWith(prefix)) return next
  for (let overlap = Math.min(prefix.length, next.length, 2048); overlap > 0; overlap -= 1) {
    if (prefix.endsWith(next.slice(0, overlap))) return prefix + next.slice(overlap)
  }
  return prefix + next
}

export function discardContinuedAnswer(s) {
  if (s.outputContinuation) s.outputContinuation.prefix = ''
}

export async function processOutputContinuation(s) {
  assertContextRecoveryActive(s.signal)
  const i = s.iteration
  const inspection = inspectToolLoopModelResponse(i.modelResult)
  const state = s.outputContinuation || (s.outputContinuation = restoreOutputContinuation())
  if (Array.isArray(i.rawToolCalls) && i.rawToolCalls.length) {
    if (state.prefix) {
      discardContinuedAnswer(s)
      s.convo.push({ role: 'system', content: CONTINUATION_MARKER + ' Tool work resumed after the cut response. Produce a fresh complete final answer from the updated evidence, not a continuation of obsolete prose.' })
    }
    return null
  }
  const content = String(i.content || '')
  if (!inspection.truncated && (content.trim() || !state.prefix)) {
    i.content = joinContinuedText(state.prefix, content)
    discardContinuedAnswer(s)
    return null
  }
  const combined = joinContinuedText(state.prefix, content)
  const withinTextLimit = combined.length <= MAX_CONTINUED_TEXT_CHARS
  if (withinTextLimit) state.prefix = combined
  if (content) s.convo.push(modelAssistantHistoryMessage(content, i.modelResult, { meta: { type: 'incomplete_model_output' } }))
  if (inspection.finishReason === 'length' && withinTextLimit
    && state.attempts < MAX_OUTPUT_CONTINUATIONS && s.iter + 1 < s.maxIters) {
    state.attempts += 1
    s.convo.push({
      role: 'system',
      content: CONTINUATION_MARKER + ' The previous response hit the output-token limit and is not a completed answer. Continue exactly from its ending without repeating prior text or adding a new introduction. Preserve every user requirement and finish the remaining work. Prefer smaller complete tool calls if tools are needed; do not repeat completed side effects.',
    })
    await s.persistTurn({ boundary: 'model-output-continuation' })
    await s.steeringController.acknowledge(i.steeringLeaseId)
    i.steeringLeaseId = null
    return { kind: 'continue' }
  }
  const result = await s.finishIncomplete({
    reason: 'model_output_truncated',
    code: 'MODEL_OUTPUT_TRUNCATED',
    missingRequirements: ['complete_model_response'],
    steeringLeaseId: i.steeringLeaseId,
  })
  return result.deferredForSteering ? { kind: 'continue' } : { kind: 'return', value: result }
}
