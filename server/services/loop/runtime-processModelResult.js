async function persistContinuation(s, content, steeringLeaseId, options = {}) {
  if (content) s.convo.push({ role: 'assistant', content })
  if (options.systemContent) s.convo.push({ role: 'system', content: options.systemContent })
  if (options.extendWindow && s.iter + 1 >= s.maxIters) s.maxIters = s.iter + 2
  await s.persistTurn(options.persistOptions)
  if (steeringLeaseId && typeof s.acknowledgeSteering === 'function') {
    await s.acknowledgeSteering(steeringLeaseId)
  }
  return { kind: 'continue' }
}

async function incompleteResult(s, input) {
  const result = await s.finishIncomplete(input)
  return result.deferredForSteering
    ? { kind: 'continue' }
    : { kind: 'return', value: result }
}

async function handleDirectoryAndArtifactCompletion(s) {
  const i = s.iteration
  const {
    ARTIFACT_DELIVERY_GUARD_MARKER,
    ARTIFACT_RECOVERY_PHASE_DIAGNOSE,
    DIRECTORY_AUTHORIZATION_WAIT_CLAIM,
    DIRECTORY_RESUME_GUARD_MARKER,
    MAX_ARTIFACT_DELIVERY_RETRIES,
    MAX_DIRECTORY_RESUME_RETRIES,
  } = s.d
  if (s.hasVerifiedDirectoryResolution
    && DIRECTORY_AUTHORIZATION_WAIT_CLAIM.test(String(i.content || ''))) {
    const canRetry = s.directoryResumeRetries < MAX_DIRECTORY_RESUME_RETRIES
      && s.iter + 1 < s.maxIters
    if (!canRetry) {
      return incompleteResult(s, {
        reason: 'directory_resume_not_converged', steeringLeaseId: i.steeringLeaseId,
      })
    }
    s.directoryResumeRetries += 1
    return persistContinuation(s, i.content, i.steeringLeaseId, {
      systemContent: [
        DIRECTORY_RESUME_GUARD_MARKER,
        'The requested directory grant is already verified in this checkpoint; there is no pending directory selection or authorization action.',
        'Do not ask the user to authorize, choose, or confirm that directory again.',
        'Continue the original task now with the available execution tools and obtain concrete execution and verification results before answering.',
      ].join(' '),
    })
  }
  if (s.hasRequiredArtifacts()) return null
  const missing = s.missingArtifactTools()
  if (s.artifactRecoveryPhase === ARTIFACT_RECOVERY_PHASE_DIAGNOSE && s.forcedArtifactToolName) {
    if (i.content) s.convo.push({ role: 'assistant', content: i.content })
    s.appendForcedArtifactPrompt(s.forcedArtifactToolName)
    s.scheduleForcedArtifactAttempt(s.forcedArtifactToolName)
    return persistContinuation(s, '', i.steeringLeaseId)
  }
  if (s.forcedArtifactRequestPending()) {
    s.forcedArtifactAttemptPending = false
    s.artifactDeliveryRetries += 1
    if (s.artifactDeliveryRetries >= MAX_ARTIFACT_DELIVERY_RETRIES) {
      return incompleteResult(s, { ...s.missingArtifactBlocker(), steeringLeaseId: i.steeringLeaseId })
    }
    if (i.content) s.convo.push({ role: 'assistant', content: i.content })
    s.appendForcedArtifactPrompt(s.forcedArtifactToolName)
    s.scheduleForcedArtifactAttempt(s.forcedArtifactToolName)
    return persistContinuation(s, '', i.steeringLeaseId)
  }
  if (s.artifactDeliveryRetries >= MAX_ARTIFACT_DELIVERY_RETRIES) {
    return incompleteResult(s, { ...s.missingArtifactBlocker(), steeringLeaseId: i.steeringLeaseId })
  }
  s.scheduleForcedArtifactAttempt(missing[0] || '')
  return persistContinuation(s, i.content, i.steeringLeaseId, {
    systemContent: [
      ARTIFACT_DELIVERY_GUARD_MARKER,
      'The user requested a real downloadable file, but the previous response did not create one.',
      `Call each missing artifact generator now: ${missing.join(', ')}.`,
      s.forcedArtifactToolName
        ? `The next model request will require ${s.forcedArtifactToolName}; provide valid, complete arguments.`
        : '',
      s.codeSnippetRequested
        ? 'The explicitly requested code snippet may be included, but it does not satisfy the required file delivery. Do not claim completion until the tool returns artifactId.'
        : 'Do not ask for a directory, print complete source code, provide copy/save instructions, or claim completion until the tool returns artifactId. If the tool still fails, report a concise blocker without code.',
    ].join(' '),
  })
}

async function handleExecutionVerificationCompletion(s) {
  const i = s.iteration
  const {
    EXECUTION_EVIDENCE_GUARD_MARKER,
    MAX_EXECUTION_EVIDENCE_RETRIES,
    MAX_MUTATION_VERIFICATION_RETRIES,
    MAX_PDF_LAYOUT_VERIFICATION_RETRIES,
    PDF_LAYOUT_VERIFICATION_GUARD_MARKER,
    PDF_LAYOUT_VERIFICATION_OK,
    POST_MUTATION_VERIFICATION_GUARD_MARKER,
    commandExecutionToolLabel,
    hasCommandExecutionTool,
    requestedPdfSectionLabel,
  } = s.d
  if (!s.hasRequiredExecutionEvidence()) {
    const canRetry = s.executionEvidenceRetries < MAX_EXECUTION_EVIDENCE_RETRIES
      && s.iter + 1 < s.maxIters
    if (!canRetry) {
      return incompleteResult(s, {
        reason: 'execution_evidence_missing', steeringLeaseId: i.steeringLeaseId,
      })
    }
    s.executionEvidenceRetries += 1
    return persistContinuation(s, i.content, i.steeringLeaseId, {
      systemContent: [
        EXECUTION_EVIDENCE_GUARD_MARKER,
        'The previous response did not establish execution evidence for the current modification target, so it was not accepted as completion.',
        'Continue until the requested target has concrete mutation evidence, or an inherited successful mutation has been strictly verified.',
        'If indispensable information is missing, call request_clarification instead of presenting instructions as a completed result.',
      ].join(' '),
    })
  }
  if (s.taskVerificationRepairExhausted?.()) {
    return incompleteResult(s, {
      text: s.taskVerificationRepairBlockerText(),
      reason: 'task_verification_repair_exhausted',
      code: 'TASK_VERIFICATION_REPAIR_EXHAUSTED',
      missingRequirements: [
        'verification_failure_repair', 'conclusive_project_verification', 'explicit_recovery_retry',
      ],
      retryable: false,
      manualRetryable: true,
      taskVerification: s.taskVerificationRepairDetails?.(),
      steeringLeaseId: i.steeringLeaseId,
    })
  }
  if (s.hasPendingTaskVerificationRepair?.()) {
    const canRetry = s.mutationVerificationRetries < MAX_MUTATION_VERIFICATION_RETRIES
      && s.iter + 1 < s.maxIters && s.availableVerificationToolNames.length > 0
    if (!canRetry) {
      return incompleteResult(s, {
        text: s.taskVerificationRepairBlockerText(),
        reason: 'task_verification_repair_pending',
        code: 'TASK_VERIFICATION_REPAIR_PENDING',
        missingRequirements: ['conclusive_project_verification', 'rerun_verification_scope'],
        retryable: true,
        taskVerification: s.taskVerificationRepairDetails?.(),
        steeringLeaseId: i.steeringLeaseId,
      })
    }
    s.mutationVerificationRetries += 1
    return persistContinuation(s, i.content, i.steeringLeaseId, {
      systemContent: s.taskVerificationRepairPrompt(),
    })
  }
  if (s.hasPendingMutationVerification()) {
    const canRetry = s.mutationVerificationRetries < MAX_MUTATION_VERIFICATION_RETRIES
      && s.iter + 1 < s.maxIters && s.availableVerificationToolNames.length > 0
    if (!canRetry) {
      return incompleteResult(s, {
        reason: 'post_mutation_verification_missing', steeringLeaseId: i.steeringLeaseId,
      })
    }
    s.mutationVerificationRetries += 1
    return persistContinuation(s, i.content, i.steeringLeaseId, {
      systemContent: [
        POST_MUTATION_VERIFICATION_GUARD_MARKER,
        'A local mutation succeeded, but no later verification has succeeded, so the completion claim was discarded.',
        `Pending changed targets: ${[...s.pendingMutationTargets].join(', ')}.`,
        `Pending deleted targets: ${[...s.pendingDeletionTargets].join(', ')}.`,
        s.taskVerificationRepairPrompt?.() || '',
        `Verify the changed state now with one of these available tools: ${s.availableVerificationToolNames.join(', ')}.`,
        'Read back each matching changed file, inspect the project diff, or run the relevant project check before answering. For deleted targets, list the complete parent directory so absence can be verified. Reading an unrelated file does not verify these targets.',
      ].join(' '),
    })
  }
  const htmlFailure = await s.validateLocalHtmlDeliveries()
  if (htmlFailure) {
    const recovery = await s.handleLocalHtmlDeliveryFailure({
      failure: htmlFailure, content: i.content, steeringLeaseId: i.steeringLeaseId,
    })
    if (!recovery.result) return { kind: 'continue' }
    return recovery.result.deferredForSteering
      ? { kind: 'continue' }
      : { kind: 'return', value: recovery.result }
  }
  s.localHtmlDeliveryRetries = 0
  if (!s.requiresPdfLayoutVerification || s.pdfLayoutVerificationObserved) return null
  const canRetry = s.pdfLayoutVerificationRetries < MAX_PDF_LAYOUT_VERIFICATION_RETRIES
    && s.iter + 1 < s.maxIters && hasCommandExecutionTool(s.activeToolSpecs)
  if (!canRetry) {
    return incompleteResult(s, {
      reason: 'pdf_layout_verification_missing', steeringLeaseId: i.steeringLeaseId,
    })
  }
  s.pdfLayoutVerificationRetries += 1
  return persistContinuation(s, i.content, i.steeringLeaseId, {
    systemContent: [
      PDF_LAYOUT_VERIFICATION_GUARD_MARKER,
      'The PDF/preview files exist, but existence and byte reads do not verify the requested page selection or visual layout.',
      requestedPdfSectionLabel(s.executionIntentText)
        ? `The authoritative requested section is ${requestedPdfSectionLabel(s.executionIntentText)}.`
        : 'Use the exact page or section named by the user.',
      `Create or correct a separate read-only verify_pdf_layout.py, then run it with ${commandExecutionToolLabel(s.activeToolSpecs)} after all writes.`,
      'It must assert target-page text, unchanged non-target pages, full text/order, glyph bounds, forbidden-line clearance, paragraph continuation/indentation, and one fresh non-empty PNG per output page.',
      `Do not use browser_open_url for local file:// PDF or PNG paths; browser tools accept only http/https URLs. Use ${commandExecutionToolLabel(s.activeToolSpecs)} and the validator for local visual evidence.`,
      `Only a successful validator that prints the standalone marker ${PDF_LAYOUT_VERIFICATION_OK} is accepted. Do not echo the marker or print it from the generation script.`,
    ].join(' '),
  })
}

async function handleDeliveryAndFinalAnswer(s) {
  const i = s.iteration
  const { DELIVERABLE_SELECTION_FALLBACK_MARKER, DELIVERABLE_SELECTION_GUARD_MARKER,
    MAX_DELIVERABLE_SELECTION_RETRIES, MAX_SOURCE_HANDOFF_RETRIES,
    SOURCE_HANDOFF_GUARD_MARKER, sourceHandoffViolation } = s.d
  if (s.needsDeliverableSelection()) {
    if (s.deliverableSelectionRetries >= MAX_DELIVERABLE_SELECTION_RETRIES) {
      const fallback = s.applySafeDeliverableFallback()
      if (fallback) {
        s.convo.push({
          role: 'system',
          content: `${DELIVERABLE_SELECTION_FALLBACK_MARKER} The runtime selected only the current turn's verified outputs that satisfy every required generator. Continue with one concise final answer and do not call set_deliverables again unless another artifact is created.`,
        })
        await s.persistTurn()
      } else {
        return incompleteResult(s, {
          reason: 'deliverable_selection_missing', steeringLeaseId: i.steeringLeaseId,
        })
      }
    }
    if (s.needsDeliverableSelection()) {
      s.deliverableSelectionRetries += 1
      return persistContinuation(s, i.content, i.steeringLeaseId, {
        extendWindow: true,
        systemContent: [
          DELIVERABLE_SELECTION_GUARD_MARKER,
          'The previous completion was discarded because this chat turn created files without explicitly selecting its final deliverables.',
          `Current artifact IDs: ${s.artifactIds.join(', ')}.`,
          'Call set_deliverables now with only the artifact_ids that should appear in the final answer. Use an empty array only when no file should be delivered.',
          'If any later tool creates another artifact, call set_deliverables again after that tool finishes.',
        ].join(' '),
      })
    }
  }
  if (s.requiresFinalAnswerEvidenceReview()
    && !s.hasCurrentFinalAnswerEvidenceReview(i.finalAnswerEvidenceReviewDigest)) {
    if (!s.prepareFinalAnswerEvidenceReview()) {
      return incompleteResult(s, {
        text: '', reason: 'final_answer_evidence_review_missing',
        steeringLeaseId: i.steeringLeaseId,
      })
    }
    return persistContinuation(s, '', i.steeringLeaseId, {
      extendWindow: true,
      persistOptions: { boundary: 'final-answer-evidence-review' },
    })
  }
  const sourceViolation = s.requiresSourceHandoffProtection ? sourceHandoffViolation(i.content) : null
  let acceptedContent = String(i.content || '')
  if (sourceViolation) {
    if (s.sourceHandoffRetries < MAX_SOURCE_HANDOFF_RETRIES) {
      s.sourceHandoffRetries += 1
      return persistContinuation(s, '', i.steeringLeaseId, {
        extendWindow: true,
        systemContent: [
          SOURCE_HANDOFF_GUARD_MARKER,
          `The previous final response was withheld because it contained ${sourceViolation}.`,
          'Return one concise prose-only summary of what was actually executed, changed, and verified.',
          'Do not include fenced blocks, source code, commands for the user to run, or instructions to copy, save, rename, or convert files manually.',
        ].join(' '),
      })
    }
    acceptedContent = s.protectTerminalText(i.content)
    i.responseTextPublished = false
  }
  acceptedContent = s.guardPriorOutcomeStatusText(acceptedContent)
  if (!i.responseTextPublished && acceptedContent && typeof s.onModelDelta === 'function') {
    await s.onModelDelta({
      text: acceptedContent, iteration: s.iter, modelName: i.modelResult?.modelName || null,
    })
  }
  const completion = await s.steeringController.prepareCompletion({
    text: acceptedContent, leaseId: i.steeringLeaseId,
  })
  if (!completion.closed) return { kind: 'continue' }
  s.finalText = acceptedContent
  if (!completion.prepared) s.convo.push({ role: 'assistant', content: s.finalText })
  try {
    const hasFinalText = Boolean(s.finalText.trim())
    await s.persistTurn(hasFinalText
      ? { final: { text: s.finalText, iterations: s.iter + 1 } }
      : {})
    s.finalCheckpointPersisted = hasFinalText
    if (!completion.prepared) await s.steeringController.acknowledge(i.steeringLeaseId)
  } catch (error) {
    await s.steeringController.release(i.steeringLeaseId)
    throw error
  }
  return { kind: 'break' }
}

async function processCompletionResponse(s) {
  for (const handler of [handleDirectoryAndArtifactCompletion, handleExecutionVerificationCompletion]) {
    const outcome = await handler(s)
    if (outcome) return outcome
  }
  return handleDeliveryAndFinalAnswer(s)
}

async function scheduleModelToolCalls(s) {
  const i = s.iteration
  const { buildAssistantToolCallsMessage, buildJobToolIdempotencyKey,
    inspectToolLoopModelResponse, normalizeToolCalls, observeToolCalls,
    scopeTextToolCallIds, sourceHandoffViolation } = s.d
  i.scopedToolCalls = scopeTextToolCallIds(i.rawToolCalls, {
    turnId: s.job?.id || s.step?.id,
    iteration: s.iter,
  })
  i.modelOutputInspection = inspectToolLoopModelResponse(i.modelResult)
  i.modelOutputTruncated = i.modelOutputInspection.truncated
  const normalized = normalizeToolCalls(i.scopedToolCalls, {
    toolSpecs: s.activeToolSpecs,
  }).map(s.normalizeArtifactReplacementCall)
  if (!i.modelOutputTruncated && normalized.some((call) => (
    call.argumentRepair?.kind === 'closed_truncated_json'
  ))) {
    i.modelOutputInspection = Object.freeze({
      truncated: true, reason: 'incomplete_tool_arguments', finishReason: 'truncated',
    })
    i.modelOutputTruncated = true
  }
  s.checkpointCalls = normalized.map((call) => ({
    ...call,
    dynamicToolRegistrationId: i.dynamicToolRegistrations?.[call.name] || null,
    modelOutputTruncated: i.modelOutputTruncated,
    modelOutputTruncationReason: i.modelOutputInspection.reason,
    idempotencyKey: buildJobToolIdempotencyKey({
      jobId: s.job?.id, stepId: s.step?.id, toolCallId: call.id,
    }),
    checkpointStatus: 'pending',
    checkpointApprovalId: null,
    checkpointPolicyProvenance: null,
    checkpointHookAuthorizationProvenance: null,
  }))
  observeToolCalls(s.progressState, s.checkpointCalls)
  if (typeof s.onToolCall === 'function') {
    for (const call of s.checkpointCalls) await s.onToolCall(call)
  }
  await s.emitToolProgress('tools_scheduled')
  i.toolCalls = s.checkpointCalls
  i.checkpointContent = s.requiresSourceHandoffProtection && sourceHandoffViolation(i.content)
    ? ''
    : i.content
  s.convo.push(buildAssistantToolCallsMessage(i.toolCalls, i.checkpointContent, {
    reasoning: typeof i.modelResult?.reasoning === 'string' ? i.modelResult.reasoning : '',
  }))
  try {
    await s.persistTurn()
    if (i.steeringLeaseId && typeof s.acknowledgeSteering === 'function') {
      await s.acknowledgeSteering(i.steeringLeaseId)
      i.steeringLeaseId = null
    }
    i.modelMutationBatchScheduled = true
  } catch (error) {
    if (i.steeringLeaseId && typeof s.releaseSteering === 'function') {
      await s.releaseSteering(i.steeringLeaseId)
    }
    throw error
  }
  return { kind: 'next' }
}

export async function processModelResult(s) {
  const i = s.iteration
  ;({ content: i.content, toolCalls: i.rawToolCalls } = i.modelResult)
  s.modelInvocation = null
  s.restoredModelInvocation = null
  if (!i.rawToolCalls || i.rawToolCalls.length === 0) return processCompletionResponse(s)
  return scheduleModelToolCalls(s)
}
