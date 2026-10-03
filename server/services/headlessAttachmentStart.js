function abortBeforeStart(signal) {
  if (signal?.aborted) throw signal.reason || Object.assign(new Error('cancelled before turn start'), { code: 'CLI_RUN_CANCELLED', exitCode: 130 })
}

/** Staging is a host port; the service never chooses a filesystem or persistence adapter. */
export async function startHeadlessWithAttachments(runtime, request) {
  const { input, scope } = runtime
  let prepared = null
  if (input.attachmentRequests?.length) {
    if (typeof runtime.dependencies.prepareAttachments !== 'function') {
      throw Object.assign(new Error('the selected headless host cannot prepare attachments'), { code: 'HEADLESS_ATTACHMENTS_UNSUPPORTED' })
    }
    prepared = await runtime.dependencies.prepareAttachments({ ...scope, requests: input.attachmentRequests,
      cwd: runtime.workspace.cwd || input.cwd, env: runtime.executionEnv, signal: input.signal,
      modelName: input.normalizedModel, modelProviderId: input.normalizedModelProviderId })
  }
  let failure = null
  try {
    abortBeforeStart(input.signal)
    if (prepared && (!Array.isArray(prepared.attachments) || prepared.attachments.length !== input.attachmentRequests.length
      || prepared.attachments.some((id) => typeof id !== 'string' || !id.trim()) || typeof prepared.discard !== 'function')) {
      throw Object.assign(new Error('invalid attachment preparation receipt'), { code: 'HEADLESS_ATTACHMENTS_INVALID' })
    }
    await runtime.startTurn({ ...request, ...(prepared ? { attachments: prepared.attachments } : {}) })
  } catch (error) { failure = error }
  try { if (prepared?.discard) await prepared.discard() }
  catch (cleanup) {
    if (!failure) throw cleanup
    throw Object.assign(new AggregateError([failure, cleanup], 'turn start and attachment cleanup failed', { cause: failure }), {
      code: failure.code || 'CLI_ATTACHMENT_CLEANUP_FAILED', retryable: failure.retryable, attachmentCleanupFailed: true,
    })
  }
  if (failure) throw failure
}
