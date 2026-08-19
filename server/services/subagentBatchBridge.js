let subagentBatchHandler = null

export function registerSubagentBatchHandler(handler) {
  if (typeof handler !== 'function') {
    throw new TypeError('subagent batch handler must be a function')
  }
  subagentBatchHandler = handler
}

export async function executeSubagentBatch(options) {
  if (!subagentBatchHandler) {
    return {
      ok: false,
      code: 'subagent_runtime_unavailable',
      error: 'The subagent runtime is not registered.',
      retryable: false,
    }
  }
  return subagentBatchHandler(options)
}
