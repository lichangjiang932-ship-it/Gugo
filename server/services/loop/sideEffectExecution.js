const knownFailedSideEffectOutcomes = new WeakMap()

/**
 * Attach an in-process proof that a built-in executor either rejected the
 * request before its own mutation boundary or completed a verified rollback.
 * A WeakMap deliberately avoids trusting enumerable error fields supplied by
 * plugins or remote tools.
 */
export function markSideEffectOutcomeKnownFailed(error, { code, retryable = false } = {}) {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) return error
  const safeCode = /^[A-Za-z0-9_.:-]{1,128}$/.test(String(code || ''))
    ? String(code)
    : 'TOOL_EXECUTION_FAILED'
  knownFailedSideEffectOutcomes.set(error, {
    ok: false,
    code: safeCode,
    error: 'The tool failed without leaving an unverified side effect.',
    retryable: retryable === true,
  })
  return error
}

/**
 * Coordinates one durable Shell/File/Git execution with its local ledger.
 * Identity construction and all recovery decisions stay centralized so the
 * loop cannot accidentally replay an uncertain side effect.
 */
function recoverDurableSideEffect(context, checkpointArgs, { allowIdempotentResume = false } = {}) {
  const { call, ledger, inputFor, toolName, recoveryBlock, conflictCode, unknownCode, state } = context
  if (call.checkpointStatus !== 'executing') return { resumedPrepared: false, result: null }
  if (!ledger) return { resumedPrepared: false, result: null }
  const input = inputFor(checkpointArgs, { requireCurrentSideEffect: false })
  const existing = ledger.read(input)
  if (!existing) {
    if (call.checkpointReadOnly === true) return { resumedPrepared: false, result: null }
    throw recoveryBlock(
      unknownCode,
      `The service restarted while ${toolName} was executing, but the checkpoint has no durable side-effect record and was not explicitly read-only. Verify local state before retrying.`,
    )
  }
  if (existing.status === 'executing') {
    if (allowIdempotentResume === true) {
      state.resumedExecutingInput = input
      return { resumedPrepared: false, resumedExecuting: true, result: null }
    }
    const unknown = ledger.markUnknown(input)
    throw recoveryBlock(
      unknownCode,
      `The service restarted while ${toolName} was executing. Its outcome is unknown and it was not replayed.`,
      unknown,
    )
  }
  if (existing.status === 'unknown') {
    throw recoveryBlock(
      unknownCode,
      `The outcome of ${toolName} still requires manual verification and was not replayed.`,
      existing,
    )
  }
  if (existing.status === 'prepared') return { resumedPrepared: true, result: null }
  if (existing.status === 'committed' || existing.status === 'failed') {
    return { resumedPrepared: false, result: ledger.parseOutcome(existing) }
  }
  throw recoveryBlock(
    conflictCode,
    `The durable side-effect record for ${toolName} has an invalid state and execution was blocked.`,
    existing,
  )
}

function prepareDurableSideEffect(context, args, { resumeExecuting = false } = {}) {
  const { ledger, inputFor, toolName, recoveryBlock, conflictCode, unknownCode, state } = context
  const input = inputFor(args)
  if (!input) return { input: null, replayed: false, result: null }
  const record = resumeExecuting === true && state.resumedExecutingInput
    ? ledger.read(input)
    : ledger.prepare(input)
  if (!record) {
    throw recoveryBlock(
      conflictCode,
      `The durable side-effect record for ${toolName} is missing and execution was blocked.`,
    )
  }
  if (record.status === 'executing') {
    if (resumeExecuting === true && state.resumedExecutingInput) {
      return { input, replayed: false, resumedExecuting: true, result: null }
    }
    const unknown = ledger.markUnknown(input)
    throw recoveryBlock(
      unknownCode,
      `A prior ${toolName} execution did not record a final outcome and was not replayed.`,
      unknown,
    )
  }
  if (record.status === 'unknown') {
    throw recoveryBlock(
      unknownCode,
      `The outcome of ${toolName} requires manual verification and was not replayed.`,
      record,
    )
  }
  if (record.status === 'committed' || record.status === 'failed') {
    return { input, replayed: true, result: ledger.parseOutcome(record) }
  }
  if (record.status !== 'prepared') {
    throw recoveryBlock(
      conflictCode,
      `The durable side-effect record for ${toolName} could not be prepared safely.`,
      record,
    )
  }
  return { input, replayed: false, result: null }
}

function rethrowSideEffectExecutionError(context, {
  error,
  input,
  started,
  returned,
  result,
  checkpointFlushErrorCode,
}) {
  const { ledger, toolName, recoveryBlock, unknownCode } = context
  if (input && started && !returned) {
    const knownFailedOutcome = knownFailedSideEffectOutcomes.get(error)
    if (knownFailedOutcome) {
      let persistedKnownFailure = false
      try {
        const record = ledger.finish(input, { status: 'failed', outcome: knownFailedOutcome })
        persistedKnownFailure = record?.status === 'failed'
      } catch { /* fail closed as unknown below */ }
      if (persistedKnownFailure) throw error
    }
    let unknown = null
    try { unknown = ledger.markUnknown(input) } catch { /* fail closed below */ }
    throw recoveryBlock(
      unknownCode,
      `${toolName} raised an error after crossing the side-effect boundary. It may have partially completed and was not replayed.`,
      unknown,
    )
  }
  if (input && returned && error?.code !== checkpointFlushErrorCode) {
    if (error?.unsafeToReplay === true) throw error
    let unknown = null
    try { unknown = ledger.markUnknown(input, { outcome: result }) } catch { /* fail closed below */ }
    throw recoveryBlock(
      unknownCode,
      `The returned outcome of ${toolName} could not be persisted safely. Verify local state before retrying.`,
      unknown,
    )
  }
  throw error
}

export function createSideEffectExecution({
  ledger,
  durableToolNames,
  isDurableSideEffect,
  toolName,
  call,
  job,
  step,
  approvalOrigin,
  approvalSessionId,
  createScope,
  recoveryBlock,
  conflictCode,
  unknownCode,
}) {
  const executionState = { resumedExecutingInput: null }

  const enabledFor = (args) => Boolean(ledger) && (
    typeof isDurableSideEffect === 'function'
      ? isDurableSideEffect(args) === true
      : durableToolNames?.has(toolName) === true
  )

  const inputFor = (args, { requireCurrentSideEffect = true } = {}) => {
    if (!ledger || (requireCurrentSideEffect && !enabledFor(args))) return null
    try {
      return {
        scope: createScope({ job, step, approvalOrigin, approvalSessionId }),
        toolCallId: call.id,
        idempotencyKey: call.idempotencyKey,
        toolName,
        args,
      }
    } catch (error) {
      throw recoveryBlock(
        conflictCode,
        `The durable identity for ${toolName} is incomplete: ${error?.message || String(error)}`,
      )
    }
  }

  const executionContext = {
    call, ledger, inputFor, toolName, recoveryBlock, conflictCode, unknownCode,
    state: executionState,
  }
  const recover = (checkpointArgs, options) => recoverDurableSideEffect(
    executionContext,
    checkpointArgs,
    options,
  )
  const prepare = (args, options) => prepareDurableSideEffect(executionContext, args, options)

  const markExecuting = (input) => {
    const claim = ledger.claimExecution(input)
    if (claim?.claimed !== true || claim.record?.status !== 'executing') {
      throw recoveryBlock(
        unknownCode,
        `The durable execution boundary for ${toolName} is already claimed or could not be recorded safely. It was not executed.`,
        claim?.record || null,
      )
    }
  }

  const blockResumedExecution = () => {
    if (!executionState.resumedExecutingInput) return null
    const input = executionState.resumedExecutingInput
    executionState.resumedExecutingInput = null
    const unknown = ledger.markUnknown(input)
    if (unknown?.status !== 'unknown') {
      throw recoveryBlock(
        unknownCode,
        `The resumed ${toolName} execution was blocked, but its durable outcome could not be marked unknown safely.`,
        unknown,
      )
    }
    return unknown
  }

  const prepareRecoveryPlan = (input, plan) => {
    if (!input || typeof ledger?.prepareRecovery !== 'function') {
      throw recoveryBlock(
        conflictCode,
        `The durable recovery-plan store for ${toolName} is unavailable. The side effect was not executed.`,
      )
    }
    return ledger.prepareRecovery(input, plan)
  }

  const readRecoveryPlan = (input) => {
    if (!input || typeof ledger?.readRecovery !== 'function') {
      throw recoveryBlock(
        unknownCode,
        `The durable recovery plan for ${toolName} is unavailable. Verify local state before retrying.`,
      )
    }
    return ledger.readRecovery(input)
  }

  const finish = (input, result, isSuccessful) => {
    let record
    if (result && typeof result === 'object' && result.requiresUserVerification === true) {
      record = ledger.markUnknown(input, { outcome: result })
      if (record?.status !== 'unknown') {
        throw recoveryBlock(
          unknownCode,
          `The returned outcome of ${toolName} requires manual verification, but it could not be recorded as unknown safely.`,
          record,
        )
      }
    } else {
      record = ledger.finish(input, {
        status: isSuccessful(result) ? 'committed' : 'failed',
        outcome: result,
      })
    }
    executionState.resumedExecutingInput = null
    return record
  }

  const rethrowExecutionError = (details) => rethrowSideEffectExecutionError({
    ledger,
    toolName,
    recoveryBlock,
    unknownCode,
  }, details)

  return Object.freeze({
    enabledFor,
    recover,
    prepare,
    markExecuting,
    blockResumedExecution,
    prepareRecoveryPlan,
    readRecoveryPlan,
    finish,
    rethrowExecutionError,
  })
}
