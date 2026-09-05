function initializeArtifactContracts(s) {
  const {
    SERVER_TOOL_SPECS,
    allowedArtifactTools,
    createDisabledToolGuard,
    createPartialResultFallback,
    createRedundantImageGuard,
    isFileArtifactTool,
    normalizeDirectoryAuthorizationResolutions,
  } = s.d
  s.restoredState = s.restored?.state && typeof s.restored.state === 'object'
    ? s.restored.state
    : s.restored && typeof s.restored === 'object' ? s.restored : null
  s.successfulExpectedPathWriteObserved = Boolean(
    s.restoredState?.completionGuards?.successfulExpectedPathWriteObserved,
  )
  s.redundantImageGenerationGuard = createRedundantImageGuard({
    patchOnlyWorkspaceIntent: s.patchOnlyWorkspaceIntent,
    independentImageCreationRequested: s.independentImageCreationRequested,
    hasSuccessfulExpectedPathWrite: () => s.successfulExpectedPathWriteObserved,
  }).validate
  s.restoredDisabledToolNames = Array.isArray(s.restoredState?.completionGuards?.disabledToolNames)
    ? s.restoredState.completionGuards.disabledToolNames
    : []
  s.disabledToolGuard = createDisabledToolGuard({
    toolsConfig: s.toolsConfig,
    restoredDisabledToolNames: s.restoredDisabledToolNames,
  })
  s.disabledToolNames = s.disabledToolGuard.disabledToolNames
  s.disabledToolValidationError = s.disabledToolGuard.validate
  s.artifactToolSpecCatalog = new Map([
    ...(Array.isArray(s.toolSpecs) ? s.toolSpecs : SERVER_TOOL_SPECS),
    ...s.eligibleFallbackToolSpecs,
    ...s.selectedToolSpecs,
  ].filter((spec) => isFileArtifactTool(spec?.function?.name))
    .map((spec) => [spec.function.name, spec]))
  s.partialResultFallback = createPartialResultFallback({
    locale: s.locale,
    entries: s.restoredState?.completionGuards?.partialResultEntries,
  })
  s.directoryAuthorizationResolutions = normalizeDirectoryAuthorizationResolutions(
    s.restoredState?.directoryAuthorizationResolution,
  )
  s.directoryAuthorizationResolution = s.directoryAuthorizationResolutions.at(-1) || null
  s.skillArtifactTools = s.explicitSkillId
    ? new Set([...allowedArtifactTools('', { skillId: s.explicitSkillId })]
        .filter((name) => s.authorizedArtifactTools.has(name)))
    : new Set()
  s.requestedArtifactTools = s.skillArtifactTools.size > 0
    ? s.skillArtifactTools
    : s.authorizedArtifactTools
  s.selectedToolNames = new Set(
    s.selectedToolSpecs.map((spec) => spec?.function?.name).filter(Boolean),
  )
  s.expectedArtifactTools = new Set(
    [...s.requestedArtifactTools].filter((name) => s.selectedToolNames.has(name)),
  )
  s.restoredArtifactContract = s.restoredState?.completionGuards
  s.activeArtifactContractText = String(
    s.restoredArtifactContract?.artifactContractText || s.artifactAuthorizationText,
  )
  s.activeArtifactOutputPrompt = String(
    s.restoredArtifactContract?.artifactOutputPrompt || s.artifactAuthorizationText,
  )
  if (Object.hasOwn(s.restoredArtifactContract || {}, 'activeArtifactTools')) {
    const restoredToolNames = (value) => new Set(
      (Array.isArray(value) ? value : [])
        .map((name) => String(name || '').trim())
        .filter((name) => s.artifactToolSpecCatalog.has(name)),
    )
    const restoredAuthorized = restoredToolNames(s.restoredArtifactContract.activeArtifactTools)
    const restoredRequired = Object.hasOwn(s.restoredArtifactContract, 'requiredArtifactTools')
      ? restoredToolNames(s.restoredArtifactContract.requiredArtifactTools)
      : new Set(restoredAuthorized)
    s.authorizedArtifactTools.clear()
    s.expectedArtifactTools.clear()
    for (const name of restoredAuthorized) s.authorizedArtifactTools.add(name)
    for (const name of restoredRequired) {
      if (s.artifactDeliveryStep && restoredAuthorized.has(name)) s.expectedArtifactTools.add(name)
    }
  }
  if (s.patchOnlyWorkspaceIntent && s.successfulExpectedPathWriteObserved) {
    s.expectedArtifactTools.clear()
  }
  s.requiresPersistedArtifact = s.expectedArtifactTools.size > 0 && s.artifactDeliveryStep
  s.pdfLayoutDeliveryEligible = s.expectedArtifactTools.size === 0
    || s.expectedArtifactTools.has('create_pdf')
}

function initializeArtifactToolVisibility(s) {
  const {
    EXPLICIT_LOCAL_DIRECTORY_CONTEXT,
    SERVER_TOOL_SPECS,
    isFileArtifactTool,
    restoreDirectoryAuthorizationToolSpecs,
  } = s.d
  s.activeToolSpecs = restoreDirectoryAuthorizationToolSpecs(
    s.selectedToolSpecs.filter((spec) => {
      const name = spec?.function?.name
      return s.job?.origin === 'chat' || !isFileArtifactTool(name) || s.stepArtifactTools.has(name)
    }),
    s.directoryAuthorizationResolutions,
    SERVER_TOOL_SPECS,
  )
  if (s.artifactDeliveryStep) {
    const activeNames = new Set(
      s.activeToolSpecs.map((spec) => spec?.function?.name).filter(Boolean),
    )
    for (const name of s.authorizedArtifactTools) {
      const spec = s.artifactToolSpecCatalog.get(name)
      if (spec && !activeNames.has(name)) {
        s.activeToolSpecs.push(spec)
        activeNames.add(name)
      }
    }
  }
  if (s.job?.origin !== 'chat'
    && s.requiresPersistedArtifact
    && !EXPLICIT_LOCAL_DIRECTORY_CONTEXT.test(s.intentText)) {
    s.activeToolSpecs = s.activeToolSpecs.filter(
      (spec) => spec?.function?.name !== 'request_directory',
    )
  }
  if (s.job?.origin !== 'chat' && s.hasManagedAttachments) {
    s.activeToolSpecs = s.activeToolSpecs.filter(
      (spec) => spec?.function?.name !== 'request_directory',
    )
  }
}

function initializeExecutionIntent(s) {
  const {
    PROJECT_SCOPE_TARGET,
    createExplicitReadOnlyGuard,
    createWorkspaceTargetGuard,
    hasEffectiveReadOnlyBoundary,
    hasMutationExecutionIntent,
    isExecutionCapabilityChallenge,
    isExplicitLocalMutationRetryRequest,
    isLocalMutationContinuationRequest,
    isTextDeliverableRequest,
    recoverPriorLocalMutationTargets,
    resolveArtifactDeliveryTargets,
    shouldInheritExecutionIntent,
    shouldRequireExecution,
  } = s.d
  s.generatedWorkflowStep = ['plan', 'verify', 'finalize'].includes(String(s.step?.kind || ''))
  s.executionIntentText = String(
    s.job?.userPrompt
      || (s.generatedWorkflowStep ? s.job?.prompt : s.currentUserMessage?.content)
      || s.job?.prompt
      || '',
  )
  s.explicitReadOnlyConstraint = hasEffectiveReadOnlyBoundary(
    s.executionIntentText,
    s.previousUserPrompt,
  )
  s.explicitReadOnlyValidationError = createExplicitReadOnlyGuard({
    enabled: s.explicitReadOnlyConstraint,
    userId: s.job?.userId || null,
  }).validate
  s.enforceExecutionIntent = s.executionGuardMode !== 'read_only_exploration'
  s.recoveredPriorLocalTargets = recoverPriorLocalMutationTargets(
    s.messages,
    s.currentUserMessage,
    { intentMode: s.intentMode },
  )
  s.recoveredPriorLocalTargetPaths = [...new Set([
    ...s.recoveredPriorLocalTargets.mutationTargets,
    ...s.recoveredPriorLocalTargets.deletionTargets,
  ].map((target) => String(target || '').trim())
    .filter((target) => target && target !== PROJECT_SCOPE_TARGET))]
  s.inheritedLocalMutationContinuation = s.enforceExecutionIntent
    && s.recoveredPriorLocalTargetPaths.length > 0
    && isLocalMutationContinuationRequest(
      s.artifactAuthorizationText,
      s.previousUserPrompt,
      { intentMode: s.intentMode },
    )
  s.inheritedFreshLocalMutationRevision = s.inheritedLocalMutationContinuation
    && !isExplicitLocalMutationRetryRequest(s.artifactAuthorizationText)
    && !isExecutionCapabilityChallenge(s.artifactAuthorizationText)
  s.inheritedCapabilityChallenge = s.enforceExecutionIntent
    && isExecutionCapabilityChallenge(s.executionIntentText)
    && shouldInheritExecutionIntent(
      s.executionIntentText,
      s.previousUserPrompt,
      { intentMode: s.intentMode },
    )
    && hasMutationExecutionIntent(s.previousUserPrompt)
  if (s.inheritedLocalMutationContinuation || s.inheritedCapabilityChallenge) {
    const inheritedDelivery = resolveArtifactDeliveryTargets(s.previousUserPrompt, {
      priorArtifacts: [],
      priorArtifactTypes: [],
      skillId: s.explicitSkillId || s.skillId,
    })
    const inheritedPaths = (Array.isArray(inheritedDelivery?.localFileTargets)
      ? inheritedDelivery.localFileTargets
      : []).map((target) => String(target?.path || '').trim()).filter(Boolean)
    if (s.exactWorkspaceTargetPaths.length === 0) {
      s.exactWorkspaceTargetPaths = [...new Set([
        ...s.recoveredPriorLocalTargetPaths,
        ...inheritedPaths,
      ])]
    }
    if (s.exactWorkspaceTargetPaths.length > 0) s.exactWorkspaceTargetConstraint = true
  }
  s.workspaceTargetValidationError = createWorkspaceTargetGuard({
    enabled: s.exactWorkspaceTargetConstraint,
    exactTargetPaths: s.exactWorkspaceTargetPaths,
  }).validate
  s.directExecutionRequested = s.enforceExecutionIntent && (
    shouldRequireExecution({ intentMode: s.intentMode, text: s.executionIntentText })
    || s.inheritedLocalMutationContinuation
    || s.inheritedCapabilityChallenge
  )
  s.textDeliverableOnly = isTextDeliverableRequest(s.executionIntentText)
  s.mutationExecutionRequested = !s.textDeliverableOnly && (
    s.requiresPersistedArtifact
    || (s.directExecutionRequested && (
      hasMutationExecutionIntent(s.executionIntentText)
      || s.inheritedLocalMutationContinuation
      || s.inheritedCapabilityChallenge
    ))
  )
}

function restoreDynamicExecutionTools(s) {
  const {
    DYNAMIC_EXECUTION_TOOL_NAMES,
    DYNAMIC_MUTATION_TOOL_NAMES,
    resolveChatCapabilityMode,
    restoreNamedToolSpecs,
    toolNameFromSpec,
  } = s.d
  const priorMessages = s.messages.slice(
    Math.max(0, s.messages.slice(0, s.currentUserIndex)
      .findLastIndex((message) => message?.role === 'user')),
    s.currentUserIndex,
  )
  s.priorTurnMutationToolObserved = s.currentUserIndex > 0
    && priorMessages.some((message) => message?.role === 'assistant'
      && Array.isArray(message.tool_calls)
      && message.tool_calls.some((call) => DYNAMIC_MUTATION_TOOL_NAMES.has(String(
        call?.function?.name || call?.name || '',
      ).trim())))
  s.restoredDynamicToolNames = new Set(
    (Array.isArray(s.restoredState?.completionGuards?.dynamicallyMountedToolNames)
      ? s.restoredState.completionGuards.dynamicallyMountedToolNames
      : []).map((name) => String(name || '').trim())
      .filter((name) => DYNAMIC_EXECUTION_TOOL_NAMES.has(name)),
  )
  s.dynamicallyMountedToolNames = new Set(s.restoredDynamicToolNames)
  s.dynamicExecutionRecoverySignatures = new Set()
  s.capabilityMode = resolveChatCapabilityMode({
    prompt: s.intentText,
    userPrompt: s.artifactAuthorizationText,
    previousUserPrompt: s.previousUserPrompt,
    intentMode: s.intentMode,
    executionRequired: s.directExecutionRequested || s.revisesAdjacentArtifact,
  })
  s.shouldRestoreExecutionTools = s.approvalMode === 'bypass' && s.enforceExecutionIntent && (
    s.mutationExecutionRequested
    || s.revisesAdjacentArtifact
    || (s.capabilityMode === 'execute' && (
      s.d.hasMutationExecutionIntent(s.previousUserPrompt)
      || s.priorTurnMutationToolObserved
      || s.restoredDynamicToolNames.size > 0
    ))
  )
  if (s.shouldRestoreExecutionTools) {
    const activeNames = new Set(s.activeToolSpecs.map(toolNameFromSpec).filter(Boolean))
    s.activeToolSpecs = restoreNamedToolSpecs(
      s.activeToolSpecs,
      s.eligibleFallbackToolSpecs,
      new Set([...DYNAMIC_EXECUTION_TOOL_NAMES, ...s.restoredDynamicToolNames]),
    )
    for (const spec of s.activeToolSpecs) {
      const name = toolNameFromSpec(spec)
      if (DYNAMIC_EXECUTION_TOOL_NAMES.has(name) && !activeNames.has(name)) {
        s.dynamicallyMountedToolNames.add(name)
      }
    }
  }
}

function installCapabilityDecision(s) {
  const {
    CAPABILITY_CONTROL_TOOL_NAMES,
    DYNAMIC_MUTATION_TOOL_NAMES,
    FILE_WRITE_TOOL_NAMES,
    MAX_CAPABILITY_TOOL_NAMES,
    SERVER_TOOL_SPECS,
    VERIFICATION_TOOLS,
    getToolMetadata,
    hasCommandExecutionTool,
    isCommandExecutionTool,
    isFileArtifactTool,
    shouldRequirePdfLayoutVerification,
    toolNameFromSpec,
  } = s.d
  s.executionConvergenceEnabled = s.enforceExecutionIntent && s.mutationExecutionRequested
  s.requiresPdfLayoutVerification = s.mutationExecutionRequested
    && s.pdfLayoutDeliveryEligible
    && shouldRequirePdfLayoutVerification(s.executionIntentText)
    && hasCommandExecutionTool(s.activeToolSpecs)
  s.requiresExecutionEvidence = s.directExecutionRequested && !s.textDeliverableOnly
  s.requiresSourceHandoffProtection = !s.codeSnippetRequested && (
    s.directExecutionRequested || s.requiresPersistedArtifact || s.revisesAdjacentArtifact
  )
  s.availableVerificationToolNames = s.activeToolSpecs.map(toolNameFromSpec)
    .filter((name) => VERIFICATION_TOOLS.has(name) || isCommandExecutionTool(name))
  s.capabilityDecisionSnapshot = () => {
    const allSelectedTools = [...new Set(s.activeToolSpecs.map(toolNameFromSpec).filter(Boolean))].sort()
    const selectedTools = allSelectedTools.slice(0, MAX_CAPABILITY_TOOL_NAMES)
    const selectedToolSet = new Set(allSelectedTools)
    const requiredCapabilities = []
    const unmetCapabilities = []
    if (s.requiresExecutionEvidence) requiredCapabilities.push('execution_evidence')
    if (s.mutationExecutionRequested) {
      requiredCapabilities.push('mutation_evidence', 'post_mutation_verification')
      const mutationToolAvailable = allSelectedTools.some((name) => {
        if (CAPABILITY_CONTROL_TOOL_NAMES.has(name)) return false
        if (DYNAMIC_MUTATION_TOOL_NAMES.has(name)
          || FILE_WRITE_TOOL_NAMES.has(name)
          || isCommandExecutionTool(name)
          || isFileArtifactTool(name)) return true
        try {
          return getToolMetadata(name, { userId: s.job?.userId || null }).isReadOnly === false
        } catch { return false }
      })
      if (!mutationToolAvailable) {
        unmetCapabilities.push({
          capability: 'mutation_evidence',
          reason: 'no_authorized_mutation_tool_in_turn_catalog',
        })
      }
      if (!allSelectedTools.some((name) => (
        VERIFICATION_TOOLS.has(name) || isCommandExecutionTool(name)
      ))) {
        unmetCapabilities.push({
          capability: 'post_mutation_verification',
          reason: 'no_authorized_verification_tool_in_turn_catalog',
        })
      }
    }
    if (s.requiresPersistedArtifact) {
      requiredCapabilities.push('artifact_generation')
      const missingGenerators = [...s.expectedArtifactTools]
        .filter((name) => !selectedToolSet.has(name))
        .sort()
      if (missingGenerators.length > 0) {
        unmetCapabilities.push({
          capability: 'artifact_generation',
          reason: 'required_generator_not_authorized_in_turn_catalog',
          tools: missingGenerators.slice(0, MAX_CAPABILITY_TOOL_NAMES),
        })
      }
    }
    const excludedTools = []
    const excludedKeys = new Set()
    for (const entry of [
      ...(s.toolResolutionDecision?.excludedTools || []),
      ...(s.chatToolSelectionDecision?.excludedTools || []),
    ]) {
      const name = String(entry?.name || '').trim()
      const stage = String(entry?.stage || '').trim()
      const reason = String(entry?.reason || '').trim()
      if (!name || !reason || selectedToolSet.has(name)) continue
      const key = `${name}\u0000${stage}\u0000${reason}`
      if (excludedKeys.has(key)) continue
      excludedKeys.add(key)
      excludedTools.push({ name, ...(stage ? { stage } : {}), reason })
      if (excludedTools.length >= 256) break
    }
    return {
      version: 1,
      capabilityMode: s.capabilityMode,
      intentMode: String(s.intentMode || 'auto'),
      requiredCapabilities: [...new Set(requiredCapabilities)].sort(),
      intentToolNames: Array.isArray(s.chatToolSelectionDecision?.intentToolNames)
        ? s.chatToolSelectionDecision.intentToolNames
            .map((name) => String(name || '').trim()).filter(Boolean)
            .slice(0, MAX_CAPABILITY_TOOL_NAMES)
        : [],
      eligibleTools: Array.isArray(s.toolResolutionDecision?.eligibleToolNames)
        ? s.toolResolutionDecision.eligibleToolNames
            .map((name) => String(name || '').trim()).filter(Boolean)
            .slice(0, MAX_CAPABILITY_TOOL_NAMES)
        : (Array.isArray(s.toolSpecs) ? s.toolSpecs : SERVER_TOOL_SPECS)
            .map(toolNameFromSpec).filter(Boolean).sort().slice(0, MAX_CAPABILITY_TOOL_NAMES),
      selectedTools,
      dynamicallyMountedTools: [...s.dynamicallyMountedToolNames]
        .sort().slice(0, MAX_CAPABILITY_TOOL_NAMES),
      excludedTools,
      discoveryIssues: Array.isArray(s.toolResolutionDecision?.discoveryIssues)
        ? s.toolResolutionDecision.discoveryIssues
            .map((issue) => ({
              source: String(issue?.source || '').trim(),
              reason: String(issue?.reason || '').trim(),
            }))
            .filter((issue) => issue.source && issue.reason)
            .slice(0, 16)
        : [],
      unmetCapabilities,
    }
  }
}

export async function initializeArtifacts(s) {
  initializeArtifactContracts(s)
  initializeArtifactToolVisibility(s)
  initializeExecutionIntent(s)
  restoreDynamicExecutionTools(s)
  installCapabilityDecision(s)
  return { kind: 'next' }
}
