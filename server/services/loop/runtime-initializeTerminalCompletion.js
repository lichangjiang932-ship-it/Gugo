import {
  missingRequirementsForIncompleteReason,
  normalizeIncompleteReason,
} from '../turnTerminalProjection.js'

export function installTerminalCompletion(s) {
  const { MAX_LOCAL_HTML_DELIVERY_RETRIES } = s.d

  s.finishIncomplete = async ({
    text,
    reason,
    code = null,
    missingRequirements = null,
    retryable,
    manualRetryable,
    taskVerification = null,
    steeringLeaseId = null,
  }) => {
    const incompleteReason = normalizeIncompleteReason(reason)
    const normalizedMissingRequirements = [...new Set((Array.isArray(missingRequirements)
      ? missingRequirements
      : missingRequirementsForIncompleteReason(incompleteReason))
      .map((value) => String(value || '').trim().toLowerCase())
      .filter((value) => /^[a-z][a-z0-9_]{1,95}$/u.test(value)))]
    if (normalizedMissingRequirements.length === 0) {
      normalizedMissingRequirements.push('remaining_task_steps')
    }
    const terminalMetadata = {
      ...(code ? { code: String(code) } : {}),
      missingRequirements: normalizedMissingRequirements,
      ...(typeof retryable === 'boolean' ? { retryable } : {}),
      ...(typeof manualRetryable === 'boolean' ? { manualRetryable } : {}),
      ...(taskVerification ? { taskVerification } : {}),
    }
    const safePartialResult = s.partialResultFallback.apply({
      text,
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

  s.handleLocalHtmlDeliveryFailure = async ({
    failure,
    content = '',
    steeringLeaseId = null,
  }) => {
    if (!failure) {
      s.localHtmlDeliveryRetries = 0
      return { scheduled: false, result: null }
    }
    if (s.localHtmlDeliveryRetries >= MAX_LOCAL_HTML_DELIVERY_RETRIES) {
      return {
        scheduled: false,
        result: await s.finishIncomplete({
          text: '网页文件尚未通过资源完整性验证，因此没有作为已完成文件显示或交付。请重试以继续自动修复。',
          reason: 'local_html_delivery_validation_failed',
          steeringLeaseId,
        }),
      }
    }
    s.localHtmlDeliveryRetries += 1
    s.appendLocalHtmlDeliveryRepairPrompt(failure, content)
    // A normal correction uses one model round to write, one to read back,
    // and one to make the completion claim. Keep the extension bounded by the
    // four validation retries while allowing that complete repair sequence.
    if (s.iter + 1 >= s.maxIters) s.maxIters = s.iter + 3
    await s.persistTurn()
    await s.steeringController.acknowledge(steeringLeaseId)
    return { scheduled: true, result: null }
  }

  s.finishTerminalResult = async (result, {
    steeringLeaseId = null,
    finalMetadata = {},
    appendTextToConversation = true,
  } = {}) => {
    result = s.partialResultFallback.apply(result)
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
      const normalizedMissingRequirements = [...new Set((Array.isArray(result.missingRequirements)
        ? result.missingRequirements
        : missingRequirementsForIncompleteReason(incompleteReason))
        .map((value) => String(value || '').trim().toLowerCase())
        .filter((value) => /^[a-z][a-z0-9_]{1,95}$/u.test(value)))]
      if (normalizedMissingRequirements.length === 0) {
        normalizedMissingRequirements.push('remaining_task_steps')
      }
      incompleteMetadata = {
        missingRequirements: normalizedMissingRequirements,
        ...(typeof result.retryable === 'boolean' ? { retryable: result.retryable } : {}),
        ...(typeof result.manualRetryable === 'boolean'
          ? { manualRetryable: result.manualRetryable }
          : {}),
        ...(result.taskVerification ? { taskVerification: result.taskVerification } : {}),
      }
      result = {
        ...result,
        reason: incompleteReason,
        ...incompleteMetadata,
      }
    }
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
