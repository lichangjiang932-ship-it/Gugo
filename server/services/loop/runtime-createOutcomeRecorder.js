import { assertRuntimeStage } from './runtimeContract.js'

async function publishLocalArtifacts(s, outcome, executedCall, succeeded) {
  const { isCommandExecutionTool, persistLocalToolArtifactsAsync } = s.d
  const declaredOutput = isCommandExecutionTool(executedCall?.name)
    && Array.isArray(outcome.result?.verifiedOutputs)
    && outcome.result.verifiedOutputs.some((output) => (
      output?.type === 'file' && Boolean(String(output?.declaredPath || '').trim())
    ))
  if (!succeeded || outcome.artifactId || (!s.localArtifactPublicationAllowed
    && !(s.requiresPersistedArtifact && declaredOutput))) return
  const localArtifacts = await persistLocalToolArtifactsAsync({
    call: executedCall,
    result: outcome.result,
    job: s.job,
    step: s.step,
    toolCallId: outcome.call?.id,
  })
  const failures = Array.isArray(localArtifacts.publicationFailures)
    ? localArtifacts.publicationFailures
    : []
  const receipts = Array.isArray(localArtifacts.verificationReceipts)
    ? localArtifacts.verificationReceipts
    : []
  outcome.artifactValidationReceipts = receipts
  if (localArtifacts.length > 0) {
    outcome.artifactId = localArtifacts[0].id
    outcome.artifactIds = localArtifacts.map((artifact) => artifact.id)
    outcome.artifacts = localArtifacts.map(({ id, filename, type, url }) => ({
      id, filename, type, url,
    }))
    outcome.result = {
      ...outcome.result,
      artifactId: localArtifacts[0].id,
      filename: localArtifacts[0].filename,
      url: localArtifacts[0].url,
      artifacts: outcome.artifacts,
      ...(receipts.length > 0
        ? { artifactValidation: { ok: true, receipts } }
        : {}),
    }
  }
  if (failures.length > 0) {
    const validationOnly = failures.every((failure) => failure.code === 'artifact_validation_failed')
    outcome.result = {
      ...outcome.result,
      artifactPublication: {
        ok: false,
        code: validationOnly ? 'artifact_validation_failed' : 'artifact_publication_failed',
        status: localArtifacts.length > 0 ? 'partial' : 'failed',
        retryable: failures.some((failure) => failure.retryable === true),
        message: validationOnly
          ? 'The local output was created, but its binary structure is invalid.'
          : localArtifacts.length > 0
            ? 'Some local outputs could not be added to the managed artifact store.'
            : 'The local output was created, but no downloadable artifact could be published.',
        guidance: validationOnly
          ? 'Regenerate the exact invalid output with a new producing tool call before delivery.'
          : 'Do not rerun the source tool automatically; verify its real side effects first.',
        failures,
      },
    }
  }
}

function recordExecutionProgress(s, outcome, executedCall, succeeded) {
  const i = s.iteration
  const { installAttemptSignature, isExplorationOnlyCall,
    isProductiveExecutionOutcome, progressChangesFor, recordToolProgress } = s.d
  s.partialResultFallback.record(executedCall, outcome.result)
  const progressChanges = progressChangesFor(executedCall, outcome.result)
  const semanticControlCall = executedCall?.name === 'set_deliverables'
  const installSignature = installAttemptSignature(executedCall)
  if (installSignature) s.rememberInstallAttempt(installSignature)
  const productiveExecution = !semanticControlCall && s.executionConvergenceEnabled
    && isProductiveExecutionOutcome(executedCall, outcome.result, outcome.artifactId)
  if (productiveExecution) {
    i.convergenceBatch.productiveSuccess = true
    s.loopGuard.markProgress?.(executedCall)
  } else if (s.executionConvergenceEnabled
    && succeeded
    && isExplorationOnlyCall(executedCall, s.job?.userId || null)) {
    i.convergenceBatch.exploratorySuccess = true
  }
  recordToolProgress(s.progressState, {
    call: outcome.call,
    succeeded,
    ...progressChanges,
  })
  i.observeFailureRecovery(executedCall, outcome.result)
  if (!succeeded) outcome.artifactId = null
  return { semanticControlCall, productiveExecution }
}

function recordDynamicFailureRecovery(s, outcome, executedCall, succeeded) {
  const { DYNAMIC_EXECUTION_TOOL_RECOVERY_MARKER, DYNAMIC_MUTATION_TOOL_NAMES,
    toolNameFromSpec } = s.d
  if (succeeded
    || !DYNAMIC_MUTATION_TOOL_NAMES.has(String(executedCall?.name || ''))
    || outcome.result?.denied === true
    || outcome.result?.requiresUserVerification === true
    || ['tool_budget_exceeded', 'approval_denied'].includes(String(outcome.result?.code || ''))) return
  const signature = [
    executedCall.name,
    String(outcome.result?.code || outcome.result?.error || 'failed').slice(0, 240),
  ].join(':')
  if (s.dynamicExecutionRecoverySignatures.has(signature)) return
  s.dynamicExecutionRecoverySignatures.add(signature)
  const alternatives = [...DYNAMIC_MUTATION_TOOL_NAMES]
    .filter((name) => name !== executedCall.name
      && s.activeToolSpecs.some((spec) => toolNameFromSpec(spec) === name))
  s.iteration.deferredPostBatchMessages.push({
    role: 'system',
    content: [
      DYNAMIC_EXECUTION_TOOL_RECOVERY_MARKER,
      `The trusted execution tool ${executedCall.name} failed; this is recoverable runtime feedback, not a final answer.`,
      'Inspect the structured tool result, correct the arguments or switch to an equivalent available mutation tool, and continue the original task now.',
      alternatives.length > 0 ? `Equivalent mutation tools available: ${alternatives.join(', ')}.` : '',
      'Do not paste source code, ask the user to save or run anything, expose the internal error as the final reply, or claim completion before the exact target is read back and verified.',
    ].filter(Boolean).join(' '),
  })
}

function recordMutationExecution(s, outcome, executedCall, succeeded, execution) {
  const {
    PATCH_WRITE_TOOL_NAMES,
    PROJECT_SCOPE_TARGET,
    clearArtifactValidatedMutationTargets,
    clearVerifiedDeletionTargets,
    clearVerifiedMutationTargets,
    extractMutationTargets,
    isLocalMutationCall,
    isMutationExecutionCall,
    isVerificationCall,
    looksLikeDeletionCommand,
    normalizeMutationTarget,
    staticDeletionTargets,
    targetsMatch,
  } = s.d
  const { semanticControlCall, productiveExecution } = execution
  const mutationSucceeded = semanticControlCall
    ? false
    : s.executionConvergenceEnabled
      ? productiveExecution
      : succeeded && isMutationExecutionCall(executedCall, outcome.artifactId)
  if (succeeded && s.patchOnlyWorkspaceIntent
    && PATCH_WRITE_TOOL_NAMES.has(String(executedCall?.name || ''))) {
    const targets = extractMutationTargets(executedCall, outcome.result)
    if (s.exactWorkspaceTargetPaths.some((expected) => (
      [...targets].some((target) => targetsMatch(target, expected))
    ))) {
      s.successfulExpectedPathWriteObserved = true
      s.requiresPersistedArtifact = false
      s.expectedArtifactTools.clear()
      s.artifactDeliveryRetries = 0
      s.clearArtifactRecovery()
    }
  }
  if (mutationSucceeded) {
    s.mutationExecutionObserved = true
    s.priorOutcomeMutationObserved = true
    s.mutationSteeringPending = false
  }
  if (mutationSucceeded && isLocalMutationCall(executedCall)) {
    if (s.requiresPdfLayoutVerification) s.pdfLayoutVerificationObserved = false
    const currentTargets = extractMutationTargets(executedCall, outcome.result)
    const repair = s.observeTaskVerificationMutation(currentTargets)
    if (repair.changed) {
      s.iteration.deferredPostBatchMessages.push({
        role: 'system', content: s.taskVerificationRepairPrompt(),
      })
    }
    const deletions = looksLikeDeletionCommand(executedCall?.args?.command)
      ? staticDeletionTargets(executedCall, outcome.result)
      : null
    if (deletions?.size) {
      for (const target of deletions) {
        const auxiliary = [...s.auxiliaryMutationTargets]
          .find((pending) => targetsMatch(pending, target))
        if (auxiliary) {
          s.auxiliaryMutationTargets.delete(auxiliary)
          continue
        }
        for (const pending of [...s.pendingMutationTargets]) {
          if (pending !== PROJECT_SCOPE_TARGET && targetsMatch(pending, target)) {
            s.pendingMutationTargets.delete(pending)
          }
        }
        s.pendingDeletionTargets.add(target)
        for (const htmlTarget of [...s.localHtmlDeliveryTargets]) {
          if (targetsMatch(htmlTarget, target)) {
            s.localHtmlDeliveryTargets.delete(htmlTarget)
            s.localHtmlReadSources.delete(htmlTarget)
          }
        }
      }
    } else {
      for (const target of currentTargets) {
        s.pendingMutationTargets.add(target)
        if (s.isLocalHtmlTarget(target)) s.localHtmlDeliveryTargets.add(target)
        if (target === PROJECT_SCOPE_TARGET) continue
        for (const deleted of [...s.pendingDeletionTargets]) {
          if (targetsMatch(deleted, target)) s.pendingDeletionTargets.delete(deleted)
        }
      }
      for (const target of s.exactWorkspaceTargetPaths) {
        if (s.isLocalHtmlTarget(target)) s.localHtmlDeliveryTargets.add(normalizeMutationTarget(target))
      }
    }
    const declaredOutputs = Array.isArray(executedCall?.args?.expected_outputs)
      ? executedCall.args.expected_outputs.map(normalizeMutationTarget).filter(Boolean)
      : []
    if (declaredOutputs.length > 0) {
      const helpers = [...s.pendingMutationTargets].filter((pending) => (
        s.auxiliaryScriptTarget(pending) && s.commandReferencesTarget(executedCall, pending)
      ))
      for (const pending of [...currentTargets, ...helpers]) {
        if (!s.auxiliaryScriptTarget(pending)) continue
        if (declaredOutputs.some((output) => targetsMatch(pending, output))) continue
        s.pendingMutationTargets.delete(pending)
        s.auxiliaryMutationTargets.add(pending)
      }
    }
    const cleared = clearArtifactValidatedMutationTargets(
      s.pendingMutationTargets,
      outcome.artifactValidationReceipts,
      {
        userId: s.job?.userId, sessionId: s.job?.sessionId,
        turnId: s.job?.id, jobId: s.job?.id, stepId: s.step?.id,
      },
    )
    if (cleared) {
      s.loopGuard.markProgress?.()
      if (s.recoveredMutationVerificationPending && !s.hasPendingMutationVerification()) {
        s.verifiedRecoveredMutationObserved = true
        s.recoveredMutationVerificationPending = false
      }
    }
    s.localHtmlDeliveryValidationPending = s.localHtmlDeliveryTargets.size > 0
    s.mutationVerificationRetries = 0
  } else if (succeeded && s.hasPendingMutationVerification() && isVerificationCall(executedCall)) {
    const clearedMutation = clearVerifiedMutationTargets(
      s.pendingMutationTargets,
      executedCall,
      outcome.result,
      {
        projectDirectory: s.verificationProjectDirectory
          || s.outputDirectoryContext?.projectDirectory || '',
        projectDirectories: s.verificationProjectDirectories,
      },
    )
    const clearedDeletion = clearVerifiedDeletionTargets(
      s.pendingDeletionTargets, executedCall, outcome.result,
    )
    if (clearedMutation || clearedDeletion) {
      s.loopGuard.markProgress?.()
      s.mutationVerificationRetries = 0
      if (s.recoveredMutationVerificationPending && !s.hasPendingMutationVerification()) {
        s.verifiedRecoveredMutationObserved = true
        s.recoveredMutationVerificationPending = false
      }
    }
  }
}

function recordVerificationObservations(s, outcome, executedCall, succeeded) {
  const { isSuccessfulPdfLayoutVerification, normalizeMutationTarget, targetsMatch } = s.d
  const observation = s.observeTaskVerificationRepair(executedCall, outcome.result)
  if (observation.changed && !observation.failed) {
    s.loopGuard.markProgress?.()
    s.mutationVerificationRetries = 0
  }
  if (observation.failed || observation.indeterminate) {
    const prompt = s.taskVerificationRepairPrompt()
    if (prompt) s.iteration.deferredPostBatchMessages.push({ role: 'system', content: prompt })
  }
  if (succeeded && executedCall?.name === 'read_file'
    && typeof outcome.result?.content === 'string' && outcome.result?.truncated !== true) {
    const targets = [outcome.result?.path, executedCall?.args?.path]
      .map(normalizeMutationTarget).filter(Boolean)
    for (const htmlTarget of s.localHtmlDeliveryTargets) {
      if (targets.some((candidate) => targetsMatch(candidate, htmlTarget))) {
        s.localHtmlReadSources.set(htmlTarget, outcome.result.content)
      }
    }
  }
  if (s.requiresPdfLayoutVerification
    && isSuccessfulPdfLayoutVerification(executedCall, outcome.result)) {
    s.pdfLayoutVerificationObserved = true
    s.pdfLayoutVerificationRetries = 0
    s.pendingMutationTargets.clear()
    s.pendingDeletionTargets.clear()
    s.mutationVerificationRetries = 0
  }
}

function recordArtifactOutcome(s, outcome, succeeded) {
  const { isFileArtifactTool, normalizeArtifactIdList } = s.d
  const deliverySatisfied = !s.requiresLocalArtifactDelivery
    || outcome.result?.deliveryStatus !== 'managed_only'
  const artifactVerified = succeeded && deliverySatisfied && isFileArtifactTool(outcome.call?.name)
  const receipts = Array.isArray(outcome.artifactValidationReceipts)
    ? outcome.artifactValidationReceipts
    : []
  const validatedIds = new Set(receipts.filter((receipt) => receipt?.verified === true)
    .map((receipt) => String(receipt.artifactId || '').trim()).filter(Boolean))
  const metadataById = new Map((Array.isArray(outcome.artifacts) ? outcome.artifacts : [])
    .map((artifact) => [String(artifact?.id || '').trim(), artifact]).filter(([id]) => id))
  const ids = Array.isArray(outcome.artifactIds)
    ? outcome.artifactIds
    : outcome.artifactId ? [outcome.artifactId] : []
  for (const artifactId of ids) {
    const receipt = receipts.find((candidate) => candidate?.artifactId === artifactId)
    s.recordArtifactIds([artifactId], {
      toolName: outcome.call?.name,
      verified: artifactVerified || validatedIds.has(artifactId),
      artifactType: metadataById.get(String(artifactId))?.type,
      validation: receipt || null,
    })
  }
  s.recomputeDeliveredArtifactTools()
  const verifiedIds = normalizeArtifactIdList(ids)
  const contractTools = new Set()
  for (const id of verifiedIds) {
    for (const name of s.artifactContractToolsForProvenance(s.artifactProvenance.get(id))) {
      contractTools.add(name)
    }
  }
  if (verifiedIds.length > 0 && contractTools.size > 0
    && contractTools.has(s.forcedArtifactToolName)) s.clearArtifactRecovery()
}

function appendToolOutcomeMessages(s, outcome, executedCall, succeeded) {
  const i = s.iteration
  const { AVAILABLE_TOOL_CAPABILITIES_MARKER, COMMAND_EXECUTION_TOOL_NAMES,
    VERIFICATION_TOOLS, buildToolResultMessageBundle, hasCommandExecutionTool,
    isCommandExecutionTool, replaceRuntimeCapabilityBlock,
    shouldRequirePdfLayoutVerification, toolNameFromSpec } = s.d
  if (executedCall?.name === 'read_file' && succeeded) s.hasSuccessfulRepresentativeRead = true
  const bundle = buildToolResultMessageBundle(outcome.call, outcome.result, {
    maxChars: i.toolResultMaxChars,
  })
  if (bundle.ephemeralMessages.length > 0 && outcome.result?.image?.data) {
    const compactImage = { ...outcome.result.image }
    delete compactImage.data
    outcome.result = { ...outcome.result, image: { ...compactImage, captured: true } }
  }
  s.finalAnswerToolEvidence = s.d.appendFinalAnswerToolEvidence(
    s.finalAnswerToolEvidence, executedCall, outcome.result,
  )
  s.convo.push(...bundle.durableMessages)
  i.deferredEphemeralToolMessages.push(...bundle.ephemeralMessages)
  if (executedCall?.name !== 'request_directory' || !succeeded
    || outcome.result?.already_authorized !== true
    || outcome.result?.authorization?.resource_type !== 'directory') return
  const accessMode = String(outcome.result.authorization.access_mode || '').trim()
  const requiredNames = new Set([
    'list_directory', 'read_file',
    ...(accessMode === 'read_write'
      ? ['write_file', 'edit_file', ...COMMAND_EXECUTION_TOOL_NAMES]
      : []),
  ])
  const byName = new Map(s.activeToolSpecs.map((spec) => [toolNameFromSpec(spec), spec]))
  for (const spec of s.eligibleFallbackToolSpecs) {
    const name = toolNameFromSpec(spec)
    if (requiredNames.has(name) && !byName.has(name)) byName.set(name, spec)
  }
  const refreshed = [...byName.values()].filter(Boolean)
  if (refreshed.length <= s.activeToolSpecs.length) return
  s.activeToolSpecs = refreshed
  s.convo = replaceRuntimeCapabilityBlock(s.convo, {
    toolSpecs: s.activeToolSpecs, approvalMode: s.approvalMode, ...s.outputDirectoryContext,
  })
  s.availableVerificationToolNames = s.activeToolSpecs.map(toolNameFromSpec)
    .filter((name) => VERIFICATION_TOOLS.has(name) || isCommandExecutionTool(name))
  s.requiresPdfLayoutVerification = s.mutationExecutionRequested
    && s.pdfLayoutDeliveryEligible
    && shouldRequirePdfLayoutVerification(s.executionIntentText)
    && hasCommandExecutionTool(s.activeToolSpecs)
  i.deferredPostBatchMessages.push({
    role: 'system',
    content: [
      '[DIRECTORY AUTHORIZATION TOOL REFRESH]',
      `The persisted ${accessMode} directory grant has been verified by the runtime.`,
      `The callable tools for the next response are now: ${s.activeToolSpecs.map(toolNameFromSpec).filter(Boolean).join(', ')}.`,
      `Use the exact authorized directory ${JSON.stringify(outcome.result.authorization.path)} and continue the original task without requesting authorization again.`,
      `This refreshed list supersedes the earlier ${AVAILABLE_TOOL_CAPABILITIES_MARKER} list for local file and code-execution capabilities.`,
    ].join(' '),
  })
}

function recordNoProgressAndSignals(s, outcome, executedCall) {
  const i = s.iteration
  const convergenceBlocked = [
    'execution_convergence_probe_blocked',
    'execution_convergence_install_blocked',
  ].includes(String(outcome.result?.code || ''))
  const progress = convergenceBlocked ? { ok: true } : s.loopGuard.after(outcome.result, outcome.call)
  const toolProgress = convergenceBlocked
    ? { ok: true }
    : s.loopGuard.afterCall?.(executedCall, outcome.result) || { ok: true }
  if (!i.noProgressReason) {
    const decision = outcome.noProgressReason
      ? { reason: outcome.noProgressReason, result: outcome.result }
      : !toolProgress.ok ? toolProgress : !progress.ok ? progress : null
    i.noProgressReason = decision?.reason || null
    if (i.noProgressReason) {
      const result = decision?.result || {}
      i.noProgressCode = result.code || 'tool_no_progress'
      i.noProgressFailure = {
        code: i.noProgressCode,
        retryable: result.retryable === true,
        ...(result.hint ? { hint: String(result.hint) } : {}),
      }
    }
  }
  if (!i.budgetExceeded && outcome.budgetExceeded) i.budgetExceeded = outcome.budgetExceeded
  if (!i.pausedByClarification && outcome.clarification) {
    i.pausedByClarification = outcome.clarification
  }
}

async function recordOutcome(s, outcome) {
  const i = s.iteration
  const { isSuccessfulToolResult } = s.d
  outcome.result = s.d.normalizeToolResult(outcome.result)
  const succeeded = isSuccessfulToolResult(outcome.result)
  const executedCall = outcome.executionArgs === outcome.call?.args
    ? outcome.call
    : { ...outcome.call, args: outcome.executionArgs }
  await publishLocalArtifacts(s, outcome, executedCall, succeeded)
  const execution = recordExecutionProgress(s, outcome, executedCall, succeeded)
  recordDynamicFailureRecovery(s, outcome, executedCall, succeeded)
  const scheduledWait = executedCall?.name === 'sleep_until'
    && outcome.result?.paused === true
    && outcome.result?.clarification?.blocker_kind === 'scheduled_wake'
    && Number.isFinite(Number(outcome.result?.clarification?.wakeAt))
    && s.d.SCHEDULED_WAIT_INTENT.test(s.executionIntentText)
  if (!execution.semanticControlCall && succeeded
    && (s.d.isSubstantiveToolCall(executedCall) || scheduledWait)) {
    s.executionEvidenceObserved = true
  }
  recordMutationExecution(s, outcome, executedCall, succeeded, execution)
  recordVerificationObservations(s, outcome, executedCall, succeeded)
  recordArtifactOutcome(s, outcome, succeeded)
  appendToolOutcomeMessages(s, outcome, executedCall, succeeded)
  recordNoProgressAndSignals(s, outcome, executedCall)
  await i.markCall(outcome.call, {
    checkpointStatus: 'completed',
    checkpointResult: outcome.result,
    checkpointArtifactId: outcome.artifactId || null,
  })
  if (typeof s.onToolCompleted === 'function') await s.onToolCompleted(outcome)
  await s.emitToolProgress('tool_completed')
}

export async function createOutcomeRecorder(s) {
  assertRuntimeStage(s, 'create-outcome-recorder')
  s.iteration.recordOutcome = (outcome) => recordOutcome(s, outcome)
  return { kind: 'next' }
}
