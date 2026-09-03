import { observeLoopEvent } from './eventIsolation.js'
import { assertRuntimeStage } from './runtimeContract.js'
import { restoreModelInvocationCheckpoint } from './modelInvocationCheckpoint.js'

export async function initializeExecution(s) {
  const { ARTIFACT_RECOVERY_DIAGNOSIS_MARKER, ARTIFACT_RECOVERY_FORCE_MARKER, ARTIFACT_RECOVERY_PHASE_DIAGNOSE, ARTIFACT_RECOVERY_PHASE_FORCE, FAILURE_RECOVERY_THRESHOLD, MAX_ITERS, buildJobToolIdempotencyKey, createCheckpointBarrier, createRepeatCallGuard, createSteeringController, isSuccessfulToolResult, normalizeCompactionRecovery, normalizeToolResult, observeToolCalls, progressChangesFor, recordToolProgress, resolveIterationWindow, restoreFailureRecovery, restoreToolProgress, serializeExecutionConvergence, serializeFailureRecovery, serializeTaskVerificationRepair, serializeToolProgress, sourceHandoffViolation, synchronizeCheckpointToolCallMessages, toolProgressPayload } = s.d
  s.recovery = normalizeCompactionRecovery(s.restoredState?.recovery)
  s.appliedSteeringIds = new Set(
      Array.isArray(s.restoredState?.appliedSteeringIds)
        ? s.restoredState.appliedSteeringIds.map((id) => String(id || '').trim()).filter(Boolean)
        : [],
    )
  s.finalText = ''
  s.finalCheckpointPersisted = false
  s.pendingEphemeralToolMessages = []
  s.restoredModelInvocation = restoreModelInvocationCheckpoint(
    s.restoredState?.modelInvocation,
    {
      stepId: s.step?.id,
      modelProviderId: s.job?.modelProviderId,
      modelName: s.job?.modelName,
      modelConfigRevision: s.job?.modelConfigRevision,
    },
  )
  s.modelInvocation = s.restoredModelInvocation
  s.iter = Math.max(0, Number(s.restoredState?.iterations) || 0)
  s.loopEventContext = (extra = {}) => Object.freeze({
      userId: String(s.job?.userId || '').trim() || null,
      sessionId: String(s.job?.sessionId || '').trim() || null,
      jobId: String(s.job?.id || '').trim() || null,
      stepId: String(s.step?.id || '').trim() || null,
      iteration: s.iter,
      phase: String(extra.phase || '').trim() || null,
      ...(typeof extra.executed === 'boolean' ? { executed: extra.executed } : {}),
    })
  s.iterationWindow = resolveIterationWindow({
      restoredStart: s.restoredState?.iterationWindowStart,
      currentIteration: s.iter,
      requestedSize: s.maxIters,
      defaultSize: MAX_ITERS,
    })
  s.iterationWindowStart = s.iterationWindow.start
  s.maxIters = s.iterationWindow.limit
  s.artifactRecoveryActive = () => Boolean(
      s.forcedArtifactToolName
        && [ARTIFACT_RECOVERY_PHASE_DIAGNOSE, ARTIFACT_RECOVERY_PHASE_FORCE]
          .includes(s.artifactRecoveryPhase),
    )
  s.forcedArtifactRequestPending = () => s.artifactRecoveryActive()
      && s.artifactRecoveryPhase === ARTIFACT_RECOVERY_PHASE_FORCE
      && s.forcedArtifactAttemptPending
  if (s.artifactRecoveryActive()) {
      // A diagnosis or forced generator call may have been checkpointed at the
      // old window boundary. Restore only the small runtime-owned extension;
      // never trust an unbounded checkpoint value to enlarge the loop.
      s.artifactRecoveryIterationLimit = Math.min(
        Math.max(s.artifactRecoveryIterationLimit, s.iter + 1),
        s.iter + 2,
      )
      s.maxIters = Math.max(s.maxIters, s.artifactRecoveryIterationLimit)
    } else {
      s.artifactRecoveryIterationLimit = 0
    }
  s.extendArtifactRecoveryWindow = () => {
      if (!s.artifactRecoveryActive()) return
      s.artifactRecoveryIterationLimit = Math.max(s.artifactRecoveryIterationLimit, s.iter + 2)
      s.maxIters = Math.max(s.maxIters, s.artifactRecoveryIterationLimit)
    }
  s.clearArtifactRecovery = () => {
      s.forcedArtifactToolName = ''
      s.artifactRecoveryPhase = ''
      s.forcedArtifactAttemptPending = false
      s.artifactRecoveryDiagnosticRounds = 0
      s.artifactRecoveryIterationLimit = 0
    }
  s.scheduleArtifactRecoveryDiagnosis = (toolName, { resetRounds = true } = {}) => {
      const normalized = String(toolName || '').trim()
      if (!s.expectedArtifactTools.has(normalized)) return false
      s.forcedArtifactToolName = normalized
      s.artifactRecoveryPhase = ARTIFACT_RECOVERY_PHASE_DIAGNOSE
      s.forcedArtifactAttemptPending = false
      if (resetRounds) s.artifactRecoveryDiagnosticRounds = 0
      s.extendArtifactRecoveryWindow()
      return true
    }
  s.scheduleForcedArtifactAttempt = (toolName = s.forcedArtifactToolName) => {
      const normalized = String(toolName || '').trim()
      if (!s.expectedArtifactTools.has(normalized)) return false
      s.forcedArtifactToolName = normalized
      s.artifactRecoveryPhase = ARTIFACT_RECOVERY_PHASE_FORCE
      s.forcedArtifactAttemptPending = true
      s.artifactRecoveryDiagnosticRounds = 0
      s.extendArtifactRecoveryWindow()
      return true
    }
  s.appendArtifactRecoveryDiagnosisPrompt = (toolName = s.forcedArtifactToolName) => {
      s.convo.push({
        role: 'system',
        content: [
          ARTIFACT_RECOVERY_DIAGNOSIS_MARKER,
          `The required generator (${toolName}) just failed or returned no verified deliverable.`,
          'Read the concrete tool result already present in this conversation and diagnose the cause before retrying.',
          'The full tool set is available in this phase. Use list_directory, read_file, or other discovery/input tools when they are needed to obtain real source data, paths, attachment references, or valid arguments.',
          'Do not claim completion, print source code for the user to save, or select a draft artifact. After gathering the missing evidence or input, retry the required generator.',
        ].join(' '),
      })
    }
  s.appendForcedArtifactPrompt = (toolName = s.forcedArtifactToolName) => {
      s.convo.push({
        role: 'system',
        content: [
          ARTIFACT_RECOVERY_FORCE_MARKER,
          `Diagnosis/input collection is complete. Call ${toolName} now with corrected, complete arguments.`,
          'Only a successful tool result containing a verified deliverable artifact can complete this recovery attempt.',
        ].join(' '),
      })
    }
  s.modelBudgetExceededAfterResponse = null
  s.checkpointCalls = Array.isArray(s.restoredState?.toolCalls)
      ? s.restoredState.toolCalls.map((call) => ({
          ...call,
          idempotencyKey: call.idempotencyKey || buildJobToolIdempotencyKey({
            jobId: s.job?.id,
            stepId: s.step?.id,
            toolCallId: call.id,
          }),
        })).map(s.normalizeArtifactReplacementCall)
      : null
  if (s.checkpointCalls?.length) {
      s.convo = synchronizeCheckpointToolCallMessages(s.convo, s.checkpointCalls)
    }
  s.progressState = restoreToolProgress(s.restoredState?.progress)
  observeToolCalls(s.progressState, s.checkpointCalls)
  for (const call of s.checkpointCalls || []) {
      if (call?.checkpointStatus !== 'completed') continue
      const result = normalizeToolResult(call.checkpointResult)
      const progressChanges = progressChangesFor(call, result)
      recordToolProgress(s.progressState, {
        call,
        succeeded: isSuccessfulToolResult(result),
        ...progressChanges,
      })
    }
  s.failureRecovery = restoreFailureRecovery(s.restoredState?.failureRecovery)
  s.pendingFailureRecoveryPrompt = s.failureRecovery.count >= FAILURE_RECOVERY_THRESHOLD
      && !s.failureRecovery.reflected
  s.repeatCallGuard = createRepeatCallGuard()
  s.pendingRepeatCallReminder = null
  s.emitToolProgress = async (phase, iteration = s.iter + 1) => {
      if (typeof s.onProgress !== 'function') return
      await s.onProgress(toolProgressPayload(s.progressState, { iteration, phase }))
    }
  s.emitTurnStopping = async (result, phase = 'turn-stopping') => {
      await observeLoopEvent({
        loopEvents: s.activeLoopEvents,
        event: 'turn-stopping',
        value: result,
        context: s.loopEventContext({ phase }),
      })
      return result
    }
  const restoredFinal = s.restoredState?.final
  if (restoredFinal?.harnessAdapter === true
      && typeof restoredFinal.text === 'string'
      && !restoredFinal.text.trim()) {
    s.restoredState.final = {
      ...restoredFinal,
      text: s.d.formatIncompleteTerminalText('empty_model_response', { locale: s.locale }),
      incomplete: true,
      reason: 'empty_model_response',
    }
  }
  s.restoredFinalIsInterrupted = s.restoredState?.final?.interrupted === true
  s.restoredFinalIsTerminal = Boolean(
      s.restoredState?.final?.incomplete
      || s.restoredState?.final?.paused
      || s.restoredState?.final?.budgetExceeded
      || s.restoredState?.final?.noProgress,
    )
  if (s.restoredFinalIsInterrupted || s.restoredFinalIsTerminal) s.suppressTerminalArtifacts()
  s.restoredLocalHtmlDeliveryFailure = null
  const restoredFinalHasReusableText = s.restoredState?.final?.text != null
      && String(s.restoredState.final.text).trim()
      && !s.restoredFinalIsInterrupted
      && (!s.requiresSourceHandoffProtection || !sourceHandoffViolation(s.restoredState.final.text))
  // Restoring local HTML starts with validation pending because the file may
  // have changed after the checkpoint was persisted. Revalidate it before the
  // final-answer evidence gate: that gate also requires HTML validation, so
  // checking it first would make the disk revalidation branch unreachable.
  if (restoredFinalHasReusableText && !s.restoredFinalIsTerminal) {
    s.restoredLocalHtmlDeliveryFailure = await s.validateLocalHtmlDeliveries()
  }
  if (restoredFinalHasReusableText
      && (s.restoredFinalIsTerminal || (
         s.hasRequiredArtifacts()
         && s.hasRequiredExecutionEvidence()
         && !s.hasPendingMutationVerification()
         && (!s.requiresPdfLayoutVerification || s.pdfLayoutVerificationObserved)
         && !s.needsDeliverableSelection()
         && (
           !s.requiresFinalAnswerEvidenceReview()
           || s.hasCurrentFinalAnswerEvidenceReview()
         )
       ))) {
      if (!s.restoredLocalHtmlDeliveryFailure) {
        const restoredClarification = s.protectClarification(s.restoredState.final.clarification)
        const rawIncompleteReason = String(s.restoredState.final.reason || '').trim()
        const hasStructuredIncompleteReason = /^[a-z][a-z0-9_]{1,95}$/iu.test(rawIncompleteReason)
        const restoredTerminalText = s.restoredState.final.paused === true && restoredClarification
          ? restoredClarification.question || restoredClarification.message
          : s.d.formatIncompleteTerminalText(s.restoredState.final.reason, {
              locale: s.locale,
              fallbackText: s.restoredState.final.text,
              hasVerificationTools: s.availableVerificationToolNames?.length > 0,
              maxIterations: s.maxIters,
              preserveFallbackText: s.restoredState.final.budgetExceeded === true
                || s.restoredState.final.noProgress === true
                || !hasStructuredIncompleteReason,
            })
        return { kind: 'return', value: s.emitTurnStopping({
          ...s.restoredState.final,
          text: s.restoredFinalIsTerminal
            ? s.protectTerminalText(restoredTerminalText, { incomplete: true })
            : String(s.restoredState.final.text),
          ...(restoredClarification ? { clarification: restoredClarification } : {}),
          artifactIds: s.artifactIds,
          ...s.deliverySelectionFields(),
          iterations: Math.max(1, Number(s.restoredState.final.iterations) || s.iter || 1),
          resumed: true,
          recovery: s.recovery,
        }, 'restored-turn-stopping') }
      }
    }
  s.injectRepresentativeReadsBeforeModel = s.requiresRepresentativeRead
      && !s.hasSuccessfulRepresentativeRead
      && !s.representativeReadsInjected
      && !s.checkpointCalls?.length
  s.buildCheckpointState = ({ final = null, checkpointWriteSequence = null } = {}) => {
    // This closure is installed before steering initializes the budget and loop
    // guard. Keep that ordering explicit and fail fast if it is ever invoked early.
    assertRuntimeStage(s, 'checkpoint-state')
    return {
        ...(Number.isSafeInteger(checkpointWriteSequence) && checkpointWriteSequence > 0
          ? { checkpointWriteSequence }
          : {}),
        messages: s.convo,
        toolCalls: s.checkpointCalls || [],
        artifactIds: s.artifactIds,
        ...s.deliverySelectionFields(),
        appliedSteeringIds: [...s.appliedSteeringIds],
        iterations: s.iter,
        iterationWindowStart: s.iterationWindowStart,
        budget: s.budget.snapshot?.() || null,
        recovery: s.recovery,
        progress: serializeToolProgress(s.progressState),
        failureRecovery: serializeFailureRecovery(s.failureRecovery),
        loopGuard: s.loopGuard.snapshot(),
        capabilityDecision: s.capabilityDecisionSnapshot(),
        ...(s.modelInvocation ? { modelInvocation: s.modelInvocation } : {}),
        ...(s.directoryAuthorizationResolutions.length > 0
          ? { directoryAuthorizationResolution: s.directoryAuthorizationResolutions }
          : {}),
        completionGuards: {
          partialResultEntries: s.partialResultFallback.snapshot(),
          representativeReadsInjected: s.representativeReadsInjected,
          activeArtifactTools: [...s.authorizedArtifactTools],
          requiredArtifactTools: [...s.expectedArtifactTools],
          artifactContractText: s.activeArtifactContractText,
          artifactOutputPrompt: s.activeArtifactOutputPrompt,
          artifactDeliveryRetries: s.artifactDeliveryRetries,
          successfulExpectedPathWriteObserved: s.successfulExpectedPathWriteObserved,
          forcedArtifactToolName: s.forcedArtifactToolName || null,
          forcedArtifactAttemptPending: s.forcedArtifactAttemptPending,
          artifactRecoveryPhase: s.artifactRecoveryPhase || null,
          artifactRecoveryDiagnosticRounds: s.artifactRecoveryDiagnosticRounds,
          artifactRecoveryIterationLimit: s.artifactRecoveryIterationLimit,
          artifactProvenance: [...s.artifactProvenance.entries()].map(([artifactId, provenance]) => ({
            artifactId,
            toolName: provenance.toolName,
            verified: provenance.verified === true,
            ...(provenance.artifactType ? { artifactType: provenance.artifactType } : {}),
            ...(provenance.validation ? { validation: provenance.validation } : {}),
          })),
          deliveredArtifactTools: [...s.deliveredArtifactTools],
          deliverableSelectionRetries: s.deliverableSelectionRetries,
          disabledToolNames: [...s.disabledToolNames].sort(),
          deliveryArtifactSelectionArtifactIds: [...s.deliveryArtifactSelectionArtifactIds],
          executionEvidenceObserved: s.executionEvidenceObserved,
          mutationExecutionObserved: s.mutationExecutionObserved,
          priorOutcomeMutationObserved: s.priorOutcomeMutationObserved,
          dynamicallyMountedToolNames: [...s.dynamicallyMountedToolNames],
          verifiedRecoveredMutationObserved: s.verifiedRecoveredMutationObserved,
          mutationSteeringPending: s.mutationSteeringPending,
          executionEvidenceRetries: s.executionEvidenceRetries,
          executionReasoningRetries: s.executionReasoningRetries,
          sourceHandoffRetries: s.sourceHandoffRetries,
          directoryResumeRetries: s.directoryResumeRetries,
          pendingMutationVerification: s.hasPendingMutationVerification(),
          pendingMutationTargets: [...s.pendingMutationTargets],
          pendingDeletionTargets: [...s.pendingDeletionTargets],
          auxiliaryMutationTargets: [...s.auxiliaryMutationTargets],
          mutationVerificationRetries: s.mutationVerificationRetries,
          taskVerificationRepair: serializeTaskVerificationRepair(s.taskVerificationRepair),
          localHtmlDeliveryTargets: [...s.localHtmlDeliveryTargets],
          localHtmlDeliveryRetries: s.localHtmlDeliveryRetries,
          pdfLayoutVerificationObserved: s.pdfLayoutVerificationObserved,
          pdfLayoutVerificationRetries: s.pdfLayoutVerificationRetries,
          executionConvergence: serializeExecutionConvergence(s.executionConvergence),
          finalAnswerToolEvidence: s.finalAnswerToolEvidence,
          ...(s.finalAnswerEvidenceReview
            ? { finalAnswerEvidenceReview: { ...s.finalAnswerEvidenceReview } }
            : {}),
        },
      final,
    }
  }
  s.checkpointBarrier = createCheckpointBarrier({
      saveCheckpoint: s.saveCheckpoint,
      stateFactory: s.buildCheckpointState,
      initialWriteSequence: Number.isSafeInteger(s.restoredState?.checkpointWriteSequence)
        && s.restoredState.checkpointWriteSequence > 0
        ? s.restoredState.checkpointWriteSequence
        : 0,
    })
  s.persistTurn = async ({ final = null, boundary = 'state-change' } = {}) => (
      s.checkpointBarrier.flush({ meta: { boundary, final } })
    )
  s.steeringController = createSteeringController({
      claim: s.claimSteering,
      acknowledge: s.acknowledgeSteering,
      release: s.releaseSteering,
      persist: s.persistTurn,
      appendAssistant: (text) => s.convo.push({ role: 'assistant', content: text }),
      beforeFinalCompletion: s.beforeFinalCompletion,
      onCompletionDeferred: () => {
        if (s.iter + 1 >= s.maxIters) s.maxIters = s.iter + 2
      },
    })
  return { kind: 'next' }
}
