import { normalizeOptionalUsageNumber } from '../../../shared/modelUsage.js'
import { localizedTerminalModelText } from './incompleteTerminalPresentation.js'

function modelPhaseUsage(result) {
  const usage = result?.usage
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return usage || null
  const tokenUsage = { ...usage }
  delete tokenUsage.costUsd
  const costUsd = normalizeOptionalUsageNumber(result?.costUsd)
  return costUsd === null ? tokenUsage : { ...tokenUsage, costUsd }
}

async function prepareModelRequestIteration(s) {
  const i = s.iteration
  const {
    filterCurrentDynamicToolSpecs,
    getToolMetadata,
    snapshotDynamicToolSpecRegistrations,
    toolNameFromSpec,
  } = s.d
  const claimed = await s.steeringController.claimFresh(s.appliedSteeringIds)
  if (claimed.messages.length > 0) {
    i.steeringLeaseId = claimed.leaseId
    s.appendSteeringMessages(claimed.messages)
  }
  s.completionDeferredForSteering = false
  i.modelResult = undefined
  i.responseTextPublished = false
  i.finalAnswerEvidenceReviewDigest = s.hasCurrentFinalAnswerEvidenceReview()
    ? s.currentFinalAnswerEvidenceDigest()
    : null
  const hasCurrentAnswerReview = () => !s.requiresFinalAnswerEvidenceReview()
    || s.hasCurrentFinalAnswerEvidenceReview(i.finalAnswerEvidenceReviewDigest)
  s.activeToolSpecs = filterCurrentDynamicToolSpecs(s.activeToolSpecs, {
    userId: s.job?.userId || null,
  })
  const modelMayRequestMutation = s.activeToolSpecs.some((spec) => {
    const name = toolNameFromSpec(spec)
    if (!name || name === 'set_deliverables') return false
    try {
      return getToolMetadata(name, { userId: s.job?.userId || null }).isReadOnly !== true
    } catch {
      return true
    }
  })
  i.dynamicToolRegistrations = snapshotDynamicToolSpecRegistrations(s.activeToolSpecs)
  return { hasCurrentAnswerReview, modelMayRequestMutation }
}

function normalizeCompatibilityToolCalls(result, extractTextToolCalls) {
  if (Array.isArray(result?.toolCalls) && result.toolCalls.length > 0) return result
  const compatibilityCall = extractTextToolCalls(result?.content)
  return compatibilityCall.detected
    ? { ...result, content: compatibilityCall.content, toolCalls: compatibilityCall.toolCalls }
    : result
}

async function executeModelRequestRound(s, context) {
  const i = s.iteration
  const {
    DIRECTORY_REVIEW_GUARD_MARKER,
    extractTextToolCalls,
    mergeCompactionRecovery,
    sourceHandoffViolation,
  } = s.d
  let streamedText = false
  const request = await s.callTrackedModel({
    messages: s.convo,
    tools: s.activeToolSpecs,
    ...(s.needsDeliverableSelection()
      ? { toolChoice: { type: 'function', function: { name: 'set_deliverables' } } }
      : s.forcedArtifactRequestPending()
        ? { toolChoice: { type: 'function', function: { name: s.forcedArtifactToolName } } }
        : {}),
    consumeBudget: (cost) => s.budget.consume(cost),
    onTextDelta: async (text, metadata = {}) => {
      if (!text || s.requiresSourceHandoffProtection) return
      if (!s.hasRequiredArtifacts() && !s.codeSnippetRequested) return
      if (s.requiresExecutionEvidence && !s.hasRequiredExecutionEvidence()) return
      if (context.modelMayRequestMutation || !context.hasCurrentAnswerReview()) return
      streamedText = true
      i.responseTextPublished = true
      if (typeof s.onModelDelta === 'function') {
        await s.onModelDelta({ text, iteration: s.iter, modelName: metadata.modelName || null })
      }
    },
    onReasoningDelta: async (text, metadata = {}) => {
      if (!text || typeof s.onReasoningDelta !== 'function') return
      await s.onReasoningDelta({ text, iteration: s.iter, modelName: metadata.modelName || null })
    },
  })
  s.convo.splice(0, s.convo.length, ...request.messages)
  s.recovery = mergeCompactionRecovery(s.recovery, request.recovery)
  i.modelResult = normalizeCompatibilityToolCalls(request.response, extractTextToolCalls)
  const returnedToolCalls = Array.isArray(i.modelResult?.toolCalls) ? i.modelResult.toolCalls : []
  if (s.requiresRepresentativeRead
    && !s.hasSuccessfulRepresentativeRead
    && !s.representativeReadsInjected
    && returnedToolCalls.length === 0
    && s.iter + 1 < s.maxIters) {
    s.representativeReadsInjected = true
    s.convo.push({
      role: 'system',
      content: [
        DIRECTORY_REVIEW_GUARD_MARKER,
        'The previous answer tried to finish from a directory listing alone, so it was discarded.',
        'The runtime is now reading representative documentation, configuration, and entrypoint files through the authorized read_file tool.',
        'Base the next answer on the returned file contents and report any concrete read errors truthfully.',
      ].join(' '),
    })
    i.modelResult = { ...i.modelResult, content: '', toolCalls: s.representativeReadCalls }
  }
  if (typeof s.onModelPhase === 'function') {
    await s.onModelPhase({
      phase: 'completed',
      iteration: s.iter,
      content: returnedToolCalls.length > 0
        || !context.hasCurrentAnswerReview()
        || (s.requiresSourceHandoffProtection && sourceHandoffViolation(i.modelResult?.content))
        ? ''
        : i.modelResult?.content || '',
      toolCalls: i.modelResult?.toolCalls || [],
      usage: modelPhaseUsage(i.modelResult),
      modelName: i.modelResult?.modelName || null,
    })
  }
  const bufferedTextIsSafe = !s.requiresSourceHandoffProtection
    || !sourceHandoffViolation(i.modelResult?.content)
  const protectedTextHasEvidence = s.requiresPersistedArtifact
    ? s.hasRequiredArtifacts()
    : s.hasRequiredExecutionEvidence()
  if (!streamedText
    && i.modelResult?.content
    && returnedToolCalls.length === 0
    && bufferedTextIsSafe
    && (s.requiresSourceHandoffProtection ? protectedTextHasEvidence : s.hasRequiredArtifacts())
    && (!s.requiresExecutionEvidence || s.hasRequiredExecutionEvidence())
    && context.hasCurrentAnswerReview()
    && typeof s.onModelDelta === 'function') {
    await s.onModelDelta({
      text: i.modelResult.content,
      iteration: s.iter,
      modelName: i.modelResult?.modelName || null,
    })
    i.responseTextPublished = true
  }
}

async function finishModelBudgetFailure(s, error) {
  const i = s.iteration
  const { budgetExceededCopy, mergeCompactionRecovery } = s.d
  const budgetCopy = budgetExceededCopy(s.locale, error.message)
  let wrapUpText = ''
  try {
    const wrapUpRequest = await s.callTrackedModel({
      messages: [...s.convo, { role: 'system', content: budgetCopy.wrapUpPrompt }],
      tools: [],
      allowOverBudget: true,
      toolChoice: 'none',
    })
    s.recovery = mergeCompactionRecovery(s.recovery, wrapUpRequest.recovery)
    wrapUpText = localizedTerminalModelText(
      s.locale,
      wrapUpRequest.response?.content,
      { strictLocale: true },
    )
  } catch (wrapUpError) {
    if (wrapUpError?.name === 'AbortError') throw wrapUpError
  }
  const terminal = await s.finishTerminalResult({
    text: !s.hasRequiredArtifacts() ? '' : wrapUpText || budgetCopy.fallbackText,
    ...(wrapUpText ? { partialText: wrapUpText } : {}),
    artifactIds: s.artifactIds,
    iterations: s.iter + 1,
    incomplete: true,
    budgetExceeded: true,
    reason: error.message,
    recovery: s.recovery,
  }, { steeringLeaseId: i.steeringLeaseId, finalMetadata: { budgetExceeded: true } })
  return terminal ? { kind: 'return', value: terminal } : { kind: 'continue' }
}

async function finishReasoningRunaway(s, error) {
  const i = s.iteration
  const { formatIncompleteTerminalText } = s.d
  if (i.steeringLeaseId && typeof s.releaseSteering === 'function') {
    await s.releaseSteering(i.steeringLeaseId)
  }
  const terminal = await s.finishTerminalResult({
    text: formatIncompleteTerminalText('reasoning_runaway', { locale: s.locale }),
    artifactIds: s.artifactIds,
    iterations: s.iter + 1,
    incomplete: true,
    code: 'REASONING_RUNAWAY',
    reason: error?.message || 'reasoning exceeded the safe limit',
    recovery: s.recovery,
  }, { finalMetadata: { code: 'REASONING_RUNAWAY', reasoningRunaway: true } })
  return terminal ? { kind: 'return', value: terminal } : { kind: 'continue' }
}

async function handleModelRequestFailure(s, error, context) {
  const i = s.iteration
  const { extractTextToolCalls } = s.d
  const recoverableModelResult = normalizeCompatibilityToolCalls(
    error?.partialModelResult,
    extractTextToolCalls,
  )
  const recoverableToolCalls = Array.isArray(recoverableModelResult?.toolCalls)
    ? recoverableModelResult.toolCalls
    : []
  if (error?.code === 'MODEL_BUDGET_EXCEEDED' && recoverableToolCalls.length > 0) {
    i.modelResult = recoverableModelResult
    s.modelBudgetExceededAfterResponse = error?.message || 'model budget exceeded'
    if (typeof s.onModelPhase === 'function') {
      await s.onModelPhase({
        phase: 'completed',
        iteration: s.iter,
        content: recoverableToolCalls.length > 0
          || !context.hasCurrentAnswerReview()
          || (s.requiresSourceHandoffProtection
            && s.d.sourceHandoffViolation(i.modelResult?.content))
          ? ''
          : i.modelResult?.content || '',
        toolCalls: i.modelResult?.toolCalls || [],
        usage: modelPhaseUsage(i.modelResult),
        modelName: i.modelResult?.modelName || null,
        budgetExceeded: true,
        budgetReason: error?.message || String(error),
      })
    }
    return { kind: 'next' }
  }
  if (typeof s.onModelPhase === 'function') {
    await s.onModelPhase({ phase: 'failed', iteration: s.iter, error: error?.message || String(error) })
  }
  if (error?.code === 'MODEL_BUDGET_EXCEEDED') return finishModelBudgetFailure(s, error)
  if (error?.code === 'REASONING_RUNAWAY') return finishReasoningRunaway(s, error)
  if (i.steeringLeaseId) {
    if (typeof s.releaseSteering === 'function') await s.releaseSteering(i.steeringLeaseId)
    i.steeringLeaseId = null
  }
  if (error?.name === 'AbortError' || s.iter === 0) throw error
  const terminal = await s.finishTerminalResult(s.partialResultFallback.apply({
    text: '',
    artifactIds: s.artifactIds,
    iterations: s.iter + 1,
    interrupted: true,
    code: error?.code || 'MODEL_CALL_INTERRUPTED',
    reason: error?.message || String(error),
    recovery: s.recovery,
  }), {
    steeringLeaseId: i.steeringLeaseId,
    appendTextToConversation: false,
    finalMetadata: { interrupted: true, code: error?.code || 'MODEL_CALL_INTERRUPTED' },
  })
  return terminal ? { kind: 'return', value: terminal } : { kind: 'continue' }
}

export async function runModelRequest(s) {
  const context = await prepareModelRequestIteration(s)
  try {
    await executeModelRequestRound(s, context)
    return { kind: 'next' }
  } catch (error) {
    return handleModelRequestFailure(s, error, context)
  }
}
