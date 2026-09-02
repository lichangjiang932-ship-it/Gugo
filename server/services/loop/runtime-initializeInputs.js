export async function initializeInputs(s) {
  const { DEFAULT_MODEL_PHASE_HEARTBEAT_MS, MANAGED_ATTACHMENT_MARKER, MAX_ITERS, SERVER_TOOL_SPECS, STATUS_INQUIRY_PROMPT, allowedArtifactTools, createArtifactReplacementGuard, createLoopEvents, executeServerTool, findAdjacentDeliveredArtifacts, findContinuableArtifactTargets, findExplicitlyReferencedDeliveredArtifacts, isArtifactRevisionRequest, isExplicitCodeSnippetRequest, latestPriorTurnOutcome, normalizeTurnLocale, parseSkillIdFromPrompt, requestApproval, resolveArtifactDeliveryTargets, resolveArtifactRevisionMode, resolveSideEffectExecutionLedger, selectJobToolSpecs } = s.d
  ;({ job: s.job, step: s.step, messages: s.messages, signal: s.signal } = s.context.input)
  s.locale = normalizeTurnLocale(s.job?.locale)
  ;({ run: s.runModel, reconcileRequest: s.reconcileModelRequest = null, compactionArchivePort: s.compactionArchivePort = null, contextWindow: s.contextWindow, onPhase: s.onModelPhase = null, onDelta: s.onModelDelta = null, onReasoningDelta: s.onReasoningDelta = null } = s.context.model)
  ;({ specs: s.toolSpecs, fallbackSpecs: s.fallbackToolSpecs, config: s.toolsConfig = null, resolutionDecision: s.toolResolutionDecision = null, onProgress: s.onProgress = null, onCall: s.onToolCall = null, onStarted: s.onToolStarted = null, onCompleted: s.onToolCompleted = null } = s.context.tools)
  s.executeTool = s.context.tools.execute === undefined
      ? executeServerTool
      : s.context.tools.execute
  s.sideEffectLedger = resolveSideEffectExecutionLedger({
    configuredLedger: s.context.tools.sideEffectLedger,
    usesDefaultExecutor: s.context.tools.execute === undefined,
    getDefaultLedger: s.d.getSideEffectExecutionLedger,
  })
  s.enableToolHooks = s.context.tools.enableHooks === undefined
      ? true
      : s.context.tools.enableHooks
  s.toolRetryMaxAttempts = s.context.tools.retryMaxAttempts === undefined
      ? 3
      : s.context.tools.retryMaxAttempts
  s.toolRetryBaseDelayMs = s.context.tools.retryBaseDelayMs === undefined
      ? 120
      : s.context.tools.retryBaseDelayMs
  ;({ onPending: s.onApprovalPending = null, onResolved: s.onApprovalResolved = null, sessionId: s.approvalSessionId = null, mode: s.approvalMode = null, context: s.approvalContext = null, principal: s.approvalPrincipal = null } = s.context.approvals)
  s.approvalOrigin = s.context.approvals.origin === undefined
      ? 'job'
      : s.context.approvals.origin
  s.requestToolApproval = s.context.approvals.request === undefined
      ? requestApproval
      : s.context.approvals.request
  ;({ claim: s.claimSteering = null, acknowledge: s.acknowledgeSteering = null, release: s.releaseSteering = null, beforeFinalCompletion: s.beforeFinalCompletion = null } = s.context.steering)
  ;({ load: s.loadCheckpoint = null, save: s.saveCheckpoint = null } = s.context.checkpoint)
  s.skillId = s.context.artifact.skillId
  s.runtimeBudget = s.context.limits.runtimeBudget ?? null
  s.executionGuardMode = s.context.limits.executionGuardMode ?? 'standard'
  s.intentMode = s.context.limits.intentMode ?? 'auto'
  s.modelHeartbeatIntervalMs = s.context.model.heartbeatIntervalMs
      ?? DEFAULT_MODEL_PHASE_HEARTBEAT_MS
  s.maxIters = s.context.limits.maxIterations ?? MAX_ITERS
  s.activeLoopEvents = s.context.events || createLoopEvents()
  s.eligibleFallbackToolSpecs = Array.isArray(s.fallbackToolSpecs)
      ? s.fallbackToolSpecs
      : Array.isArray(s.toolSpecs)
        ? s.toolSpecs
        : SERVER_TOOL_SPECS
  s.currentUserMessage = (Array.isArray(s.messages) ? s.messages : [])
      .findLast((message) => message?.role === 'user' && typeof message.content === 'string')
  s.currentUserIndex = Array.isArray(s.messages) ? s.messages.lastIndexOf(s.currentUserMessage) : -1
  s.previousUserMessage = s.currentUserIndex > 0
      ? s.messages.slice(0, s.currentUserIndex).findLast((message) => (
          message?.role === 'user' && typeof message.content === 'string'
        ))
      : null
  s.previousUserPrompt = String(
      s.job?.previousUserPrompt || s.previousUserMessage?.content || '',
    )
  s.intentText = [
      s.job?.prompt || '',
      s.currentUserMessage?.content || '',
    ].join('\n')
  s.hasManagedAttachments = s.job?.hasManagedAttachments === true
      || (Array.isArray(s.job?.managedAttachments) && s.job.managedAttachments.length > 0)
      || MANAGED_ATTACHMENT_MARKER.test(s.intentText)
  s.explicitSkillId = s.skillId
      || parseSkillIdFromPrompt(s.currentUserMessage?.content || '')
      || parseSkillIdFromPrompt(s.job?.prompt || '')
  s.artifactAuthorizationText = String(
      s.job?.userPrompt || s.currentUserMessage?.content || s.job?.prompt || '',
    )
  s.priorTurnOutcome = latestPriorTurnOutcome(s.messages)
  s.isPriorOutcomeStatusInquiry = Boolean(s.priorTurnOutcome)
      && STATUS_INQUIRY_PROMPT.test(s.artifactAuthorizationText.trim())
  s.adjacentArtifacts = findAdjacentDeliveredArtifacts(s.messages)
  s.continuableArtifacts = findContinuableArtifactTargets(
      s.messages,
      s.artifactAuthorizationText,
    )
  s.explicitlyReferencedArtifacts = findExplicitlyReferencedDeliveredArtifacts(
      s.messages,
      s.artifactAuthorizationText,
    )
  s.discoveredPriorArtifacts = s.explicitlyReferencedArtifacts.length > 0
      ? s.explicitlyReferencedArtifacts
      : s.adjacentArtifacts.length > 0
        ? s.adjacentArtifacts
        : s.continuableArtifacts
  s.artifactDelivery = resolveArtifactDeliveryTargets(s.artifactAuthorizationText, {
      priorArtifacts: s.discoveredPriorArtifacts,
      priorArtifactTypes: [...new Set(s.discoveredPriorArtifacts.map((artifact) => artifact.type))],
      hasExplicitManagedArtifactReference: s.explicitlyReferencedArtifacts.length > 0,
      skillId: s.explicitSkillId || s.skillId,
    })
  s.patchOnlyWorkspaceIntent = s.artifactDelivery.intent === 'patch_intent'
  s.independentImageCreationRequested = s.artifactDelivery.managedArtifactTypes.includes('image')
  s.localArtifactPublicationAllowed = !['workspace_file', 'mixed'].includes(s.artifactDelivery.target)
  s.workspaceArtifactTypes = new Set(s.artifactDelivery.workspaceArtifactTypes)
  s.priorArtifacts = s.discoveredPriorArtifacts.filter((artifact) => !s.workspaceArtifactTypes.has(artifact.type))
  s.priorArtifactTypes = [...new Set(s.priorArtifacts.map((artifact) => artifact.type))]
  s.requestedArtifactRevisionMode = resolveArtifactRevisionMode(s.artifactAuthorizationText)
  s.artifactRevisionMode = s.priorArtifacts.length > 0
      ? s.requestedArtifactRevisionMode
      : 'unspecified'
  s.artifactReplacementGuard = createArtifactReplacementGuard({
      revisionMode: s.artifactRevisionMode,
      priorArtifacts: s.priorArtifacts,
    })
  s.normalizeArtifactReplacementCall = s.artifactReplacementGuard.normalizeCall
  s.artifactReplacementValidationError = s.artifactReplacementGuard.validate
  s.exactWorkspaceTargetPaths = s.artifactDelivery.localFileTargets
      .map((target) => String(target?.path || '').trim())
      .filter(Boolean)
  s.exactWorkspaceTargetConstraint = s.requestedArtifactRevisionMode === 'replace_original'
      && ['workspace_file', 'mixed'].includes(s.artifactDelivery.target)
      && s.exactWorkspaceTargetPaths.length > 0
  s.codeSnippetRequested = isExplicitCodeSnippetRequest(s.artifactAuthorizationText)
  s.artifactIntentOptions = {
      skillId: s.explicitSkillId || s.skillId,
      priorArtifacts: s.priorArtifacts,
      priorArtifactTypes: s.priorArtifactTypes,
      hasExplicitManagedArtifactReference: s.explicitlyReferencedArtifacts.length > 0,
    }
  s.explicitArtifactTools = allowedArtifactTools(s.artifactAuthorizationText, {
      skillId: s.explicitSkillId || s.skillId,
    })
  s.authorizedArtifactTools = allowedArtifactTools(s.artifactAuthorizationText, s.artifactIntentOptions)
  s.inheritsAdjacentArtifact = s.explicitArtifactTools.size === 0
      && s.authorizedArtifactTools.size > 0
  s.revisesAdjacentArtifact = s.priorArtifacts.length > 0
      && s.authorizedArtifactTools.size > 0
      && (s.inheritsAdjacentArtifact
        || s.artifactRevisionMode !== 'unspecified'
        || isArtifactRevisionRequest(s.artifactAuthorizationText, { hasPriorArtifact: true }))
  s.artifactDeliveryStep = !['plan', 'verify', 'finalize'].includes(String(s.step?.kind || ''))
  s.stepArtifactTools = s.artifactDeliveryStep ? s.authorizedArtifactTools : new Set()
  s.chatToolSelectionDecision = null
  s.selectedToolSpecs = selectJobToolSpecs({
      prompt: s.intentText,
      userPrompt: s.artifactAuthorizationText,
      previousUserPrompt: s.previousUserPrompt,
      priorArtifacts: s.priorArtifacts,
      priorArtifactTypes: s.priorArtifactTypes,
      hasExplicitManagedArtifactReference: s.explicitlyReferencedArtifacts.length > 0,
      skillId: s.explicitSkillId || s.skillId,
      specs: Array.isArray(s.toolSpecs) ? s.toolSpecs : SERVER_TOOL_SPECS,
      origin: s.job?.origin,
      intentMode: s.intentMode,
      userId: s.job?.userId || null,
      onDecision: (decision) => { s.chatToolSelectionDecision = decision },
    })
  s.restored = typeof s.loadCheckpoint === 'function' ? await s.loadCheckpoint() : null
  return { kind: 'next' }
}
