import {
  missingRequirementsForIncompleteReason,
  normalizeIncompleteReason,
} from '../turnTerminalProjection.js'

function normalizedRequirements(reason, provided) {
  const requirements = [...new Set((Array.isArray(provided)
    ? provided
    : missingRequirementsForIncompleteReason(reason))
    .map((value) => String(value || '').trim().toLowerCase())
    .filter((value) => /^[a-z][a-z0-9_]{1,95}$/u.test(value)))]
  if (requirements.length === 0) requirements.push('remaining_task_steps')
  return requirements
}

function createFinishIncomplete(s, formatIncompleteTerminalText) {
  return async ({
    text,
    reason,
    code = null,
    missingRequirements = null,
    retryable,
    manualRetryable,
    taskVerification = null,
    steeringLeaseId = null,
    sourceHandoffFiltered = false,
  }) => {
    const incompleteReason = normalizeIncompleteReason(reason)
    const terminalMetadata = {
      ...(code ? { code: String(code) } : {}),
      missingRequirements: normalizedRequirements(incompleteReason, missingRequirements),
      ...(typeof retryable === 'boolean' ? { retryable } : {}),
      ...(typeof manualRetryable === 'boolean' ? { manualRetryable } : {}),
      ...(taskVerification ? { taskVerification } : {}),
    }
    const localizedText = sourceHandoffFiltered
      ? s.protectTerminalText(text, { incomplete: true })
      : formatIncompleteTerminalText(incompleteReason, {
          locale: s.locale,
          fallbackText: text,
          hasVerificationTools: s.availableVerificationToolNames?.length > 0,
          maxIterations: s.maxIters,
          preserveFallbackText: incompleteReason === 'iteration_limit_reached',
        })
    const safePartialResult = s.partialResultFallback.apply({
      text: localizedText,
      incomplete: true,
      reason: incompleteReason,
    })
    s.finalText = s.protectTerminalText(safePartialResult.text, { incomplete: true })
    const completion = await s.steeringController.prepareCompletion({
      text: s.finalText,
      leaseId: steeringLeaseId,
      incomplete: true,
      reason: incompleteReason,
    })
    if (!completion.closed) return { deferredForSteering: true }
    s.suppressTerminalArtifacts()
    if (!completion.prepared) s.convo.push({ role: 'assistant', content: s.finalText })
    try {
      await s.persistTurn({
        final: {
          text: s.finalText,
          iterations: s.iter + 1,
          incomplete: true,
          reason: incompleteReason,
          ...terminalMetadata,
        },
      })
      s.finalCheckpointPersisted = true
      if (!completion.prepared) await s.steeringController.acknowledge(steeringLeaseId)
    } catch (error) {
      await s.steeringController.release(steeringLeaseId)
      throw error
    }
    return s.emitTurnStopping({
      text: s.finalText,
      artifactIds: s.artifactIds,
      ...s.deliverySelectionFields(),
      iterations: s.iter + 1,
      incomplete: true,
      reason: incompleteReason,
      ...terminalMetadata,
      recovery: s.recovery,
    })
  }
}

function createLocalHtmlFailureHandler(s, maximumRetries) {
  return async ({ failure, content = '', steeringLeaseId = null }) => {
    if (!failure) {
      s.localHtmlDeliveryRetries = 0
      return { scheduled: false, result: null }
    }
    if (s.localHtmlDeliveryRetries >= maximumRetries) {
      return {
        scheduled: false,
        result: await s.finishIncomplete({
          reason: 'local_html_delivery_validation_failed',
          steeringLeaseId,
        }),
      }
    }
    s.localHtmlDeliveryRetries += 1
    s.appendLocalHtmlDeliveryRepairPrompt(failure, content)
    if (s.iter + 1 >= s.maxIters) s.maxIters = s.iter + 3
    await s.persistTurn()
    await s.steeringController.acknowledge(steeringLeaseId)
    return { scheduled: true, result: null }
  }
}

function createFinishTerminalResult(s, { formatIncompleteTerminalText, sourceHandoffViolation }) {
  return async (result, {
    steeringLeaseId = null,
    finalMetadata = {},
    appendTextToConversation = true,
  } = {}) => {
    const sourceHandoffFiltered = result?.incomplete === true
      && s.requiresSourceHandoffProtection
      && Boolean(sourceHandoffViolation(result?.text))
    const sourceSafeText = sourceHandoffFiltered
      ? s.protectTerminalText(result?.text, { incomplete: true })
      : ''
    const preserveFallbackText = sourceHandoffFiltered
      || result?.budgetExceeded === true
      || result?.noProgress === true
    let incompleteMetadata = {}
    if (result?.incomplete === true) {
      const incompleteReason = normalizeIncompleteReason(
        result.budgetExceeded === true
          ? 'execution_budget_exhausted'
          : result.noProgress === true
            ? 'tool_no_progress'
            : String(result.code || '').trim().toUpperCase() === 'REASONING_RUNAWAY'
              ? 'reasoning_runaway'
              : result.reason,
      )
      incompleteMetadata = {
        missingRequirements: normalizedRequirements(incompleteReason, result.missingRequirements),
        ...(typeof result.retryable === 'boolean' ? { retryable: result.retryable } : {}),
        ...(typeof result.manualRetryable === 'boolean'
          ? { manualRetryable: result.manualRetryable }
          : {}),
        ...(result.taskVerification ? { taskVerification: result.taskVerification } : {}),
      }
      result = {
        ...result,
        text: sourceHandoffFiltered
          ? sourceSafeText
          : formatIncompleteTerminalText(incompleteReason, {
              locale: s.locale,
              fallbackText: result?.text,
              hasVerificationTools: s.availableVerificationToolNames?.length > 0,
              maxIterations: s.maxIters,
              preserveFallbackText,
            }),
        reason: incompleteReason,
        ...incompleteMetadata,
      }
    }
    result = s.partialResultFallback.apply(result)
    const terminalIsIncomplete = result?.incomplete === true
      || result?.paused === true
      || result?.interrupted === true
      || result?.budgetExceeded === true
      || result?.noProgress === true
    const text = s.protectTerminalText(result?.text, { incomplete: terminalIsIncomplete })
    const completion = await s.steeringController.prepareCompletion({
      text,
      leaseId: steeringLeaseId,
      incomplete: result?.incomplete === true,
      reason: result?.reason || null,
    })
    if (!completion.closed) return null
    if (result?.incomplete === true || result?.paused === true || result?.interrupted === true) {
      s.suppressTerminalArtifacts()
    }
    if (!completion.prepared && text && appendTextToConversation) {
      s.convo.push({ role: 'assistant', content: text })
    }
    await s.persistTurn({
      final: {
        text,
        iterations: Math.max(1, Number(result?.iterations) || s.iter + 1),
        incomplete: result?.incomplete === true,
        reason: result?.reason || null,
        ...finalMetadata,
        ...incompleteMetadata,
      },
    })
    s.finalCheckpointPersisted = Boolean(text.trim())
    return s.emitTurnStopping({ ...result, text, ...s.deliverySelectionFields() })
  }
}

export function installTerminalCompletion(s) {
  const {
    MAX_LOCAL_HTML_DELIVERY_RETRIES,
    formatIncompleteTerminalText,
    sourceHandoffViolation,
  } = s.d
  s.finishIncomplete = createFinishIncomplete(s, formatIncompleteTerminalText)
  s.handleLocalHtmlDeliveryFailure = createLocalHtmlFailureHandler(
    s,
    MAX_LOCAL_HTML_DELIVERY_RETRIES,
  )
  s.finishTerminalResult = createFinishTerminalResult(s, {
    formatIncompleteTerminalText,
    sourceHandoffViolation,
  })
}
