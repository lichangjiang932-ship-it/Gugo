const TOKEN_LIMIT_FINISH_REASONS = new Set([
  'length',
  'max_tokens',
  'max_output_tokens',
  'max_completion_tokens',
  'output_token_limit',
  'token_limit',
])
const INCOMPLETE_FINISH_REASONS = new Set([
  'incomplete',
  'truncated',
  'stream_truncated',
  'model_stream_truncated',
])

function normalizeFinishReason(value) {
  return String(value || '')
    .trim()
    .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .replace(/[\s.-]+/gu, '_')
    .toLowerCase()
}

/**
 * Inspect the complete model response at the host/Loop seam. Tool arguments
 * can be valid JSON while still being semantically incomplete, so the batch
 * termination signal is authoritative over per-call parsing.
 */
export function inspectToolLoopModelResponse(response) {
  const source = response && typeof response === 'object' && !Array.isArray(response)
    ? response
    : {}
  const explicitTruncation = source.modelOutputTruncated === true || source.truncated === true
  const responseStatus = normalizeFinishReason(source.status || source.response?.status)
  const candidates = [
    source.finishReason,
    source.finish_reason,
    source.stopReason,
    source.stop_reason,
    source.doneReason,
    source.done_reason,
    source.incompleteReason,
    source.incomplete_reason,
    source.incompleteDetails?.reason,
    source.incomplete_details?.reason,
    source.response?.incomplete_details?.reason,
    responseStatus === 'incomplete' ? 'incomplete' : null,
  ].map(normalizeFinishReason).filter(Boolean)
  const tokenLimitReason = candidates.find((reason) => TOKEN_LIMIT_FINISH_REASONS.has(reason))
  const incompleteReason = candidates.find((reason) => INCOMPLETE_FINISH_REASONS.has(reason))
  const truncated = explicitTruncation || Boolean(tokenLimitReason || incompleteReason)
  const reason = tokenLimitReason || incompleteReason || (explicitTruncation ? 'truncated' : null)
  return Object.freeze({
    truncated,
    reason,
    finishReason: tokenLimitReason ? 'length' : truncated ? 'truncated' : null,
  })
}

/** Normalize provider-specific truncation fields before a Tool Loop adapter sees them. */
export function normalizeToolLoopModelResponse(response) {
  const inspection = inspectToolLoopModelResponse(response)
  if (!inspection.truncated || !response || typeof response !== 'object' || Array.isArray(response)) {
    return response
  }
  return {
    ...response,
    finishReason: inspection.finishReason,
    modelOutputTruncated: true,
    modelOutputTruncationReason: inspection.reason,
  }
}

/** Stable structured result paired with every call from a truncated batch. */
export function createTruncatedToolCallResult(call, { reason = null } = {}) {
  const normalizedReason = normalizeFinishReason(reason)
  const tokenLimit = TOKEN_LIMIT_FINISH_REASONS.has(normalizedReason)
  const argumentsIncomplete = normalizedReason === 'incomplete_tool_arguments'
  const toolName = String(call?.name || call?.function?.name || '').trim()
  return {
    ok: false,
    code: 'tool_call_truncated',
    error: argumentsIncomplete
      ? `The model returned structurally incomplete arguments while generating${toolName ? ` ${toolName}` : ' this tool call'}, so the complete tool-call batch was not executed.`
      : tokenLimit
      ? `The model reached its output-token limit while generating${toolName ? ` ${toolName}` : ' this tool call'}, so the arguments may be incomplete and were not executed.`
      : `The model response ended before a trusted terminal marker while generating${toolName ? ` ${toolName}` : ' this tool call'}, so the arguments were not executed.`,
    retryable: true,
    recoverable: true,
    recoveryAction: 'regenerate_tool_call',
    truncationReason: normalizedReason || 'truncated',
    hint: 'Generate a fresh complete tool call. Shorten large inline content or split the work into smaller calls when necessary.',
  }
}
