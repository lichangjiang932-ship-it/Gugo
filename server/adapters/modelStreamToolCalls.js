/**
 * Normalize streaming provider tool-call events into the canonical OpenAI-
 * compatible tool_calls shape used by the durable tool-loop checkpoint, so
 * streamed and non-streamed turns persist identically.
 */
export function canonicalStreamToolCalls(toolCalls = []) {
  return (Array.isArray(toolCalls) ? toolCalls : []).map((call) => {
    const fn = call?.function && typeof call.function === 'object' ? call.function : {}
    const rawArguments = fn.arguments ?? call?.arguments ?? '{}'
    let argumentsText
    if (typeof rawArguments === 'string') argumentsText = rawArguments
    else {
      try { argumentsText = JSON.stringify(rawArguments ?? {}) } catch { argumentsText = '{}' }
    }
    return {
      ...(call?.id ? { id: call.id } : {}),
      type: call?.type || 'function',
      function: {
        name: String(fn.name || call?.name || ''),
        arguments: argumentsText,
      },
    }
  })
}
