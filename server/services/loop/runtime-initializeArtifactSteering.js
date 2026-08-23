import {
  cancelledArtifactToolsFromSteering,
  steeringDefinesExclusiveArtifactContract,
} from './steeringArtifactContract.js'

export function installArtifactSteeringContract(s) {
  const {
    ARTIFACT_DELIVERY_GUARD_MARKER,
    ARTIFACT_RECOVERY_DIAGNOSIS_MARKER,
    ARTIFACT_RECOVERY_FORCE_MARKER,
    LIVE_ARTIFACT_CONTRACT_MARKER,
    VERIFICATION_TOOLS,
    allowedArtifactTools,
    hasCommandExecutionTool,
    isCommandExecutionTool,
    isFileArtifactTool,
    parseSkillIdFromPrompt,
    replaceRuntimeCapabilityBlock,
    resolveArtifactDeliveryTargets,
    shouldRequirePdfLayoutVerification,
    toolNameFromSpec,
  } = s.d

  s.refreshArtifactContractFromSteering = (value) => {
    const text = String(value || '').trim()
    if (!text) return false

    const steeringSkillId = parseSkillIdFromPrompt(text)
    const detectedTools = new Set(
      [...allowedArtifactTools(text, {
        ...s.artifactIntentOptions,
        skillId: steeringSkillId || undefined,
      })].filter((name) => s.artifactToolSpecCatalog.has(name)),
    )
    const cancelledTools = cancelledArtifactToolsFromSteering(text)
    const exclusive = steeringDefinesExclusiveArtifactContract(text, detectedTools)
    if (!exclusive && detectedTools.size === 0 && cancelledTools.size === 0) return false

    const previousAuthorizedTools = new Set(s.authorizedArtifactTools)
    const previousRequiredTools = new Set(s.expectedArtifactTools)
    const nextAuthorizedTools = exclusive
      ? detectedTools
      : new Set([...s.authorizedArtifactTools, ...detectedTools])
    const nextRequiredTools = exclusive
      ? detectedTools
      : new Set([...s.expectedArtifactTools, ...detectedTools])
    for (const name of cancelledTools) {
      nextAuthorizedTools.delete(name)
      nextRequiredTools.delete(name)
    }
    const changed = previousAuthorizedTools.size !== nextAuthorizedTools.size
      || [...previousAuthorizedTools].some((name) => !nextAuthorizedTools.has(name))
      || previousRequiredTools.size !== nextRequiredTools.size
      || [...previousRequiredTools].some((name) => !nextRequiredTools.has(name))
    if (!changed) {
      s.activeArtifactContractText = text
      return false
    }

    s.authorizedArtifactTools.clear()
    s.expectedArtifactTools.clear()
    for (const name of nextAuthorizedTools) s.authorizedArtifactTools.add(name)
    for (const name of nextRequiredTools) {
      if (s.artifactDeliveryStep && nextAuthorizedTools.has(name)) s.expectedArtifactTools.add(name)
    }
    s.activeArtifactContractText = text
    s.requiresPersistedArtifact = s.expectedArtifactTools.size > 0 && s.artifactDeliveryStep
    s.pdfLayoutDeliveryEligible = s.expectedArtifactTools.size === 0
      || s.expectedArtifactTools.has('create_pdf')
    s.requiresSourceHandoffProtection = !s.codeSnippetRequested && (
      s.directExecutionRequested || s.requiresPersistedArtifact || s.revisesAdjacentArtifact
    )
    s.requiresLocalArtifactDelivery = ['workspace_file', 'mixed'].includes(
      resolveArtifactDeliveryTargets(text, s.artifactIntentOptions).target,
    ) || s.artifactRevisionMode === 'replace_original'
      || Boolean(String(s.outputDirectoryContext.defaultOutputDirectory || '').trim())

    // Steering changes which artifact calls are authorized and which outputs
    // must be delivered; it must not mutate the model-visible chat catalog.
    // Background jobs keep their narrower artifact contract.
    if (s.job?.origin !== 'chat') {
      const activeByName = new Map(
        s.activeToolSpecs
          .filter((spec) => !isFileArtifactTool(spec?.function?.name)
            || s.authorizedArtifactTools.has(spec.function.name))
          .map((spec) => [spec?.function?.name, spec]),
      )
      if (s.artifactDeliveryStep) {
        for (const name of s.authorizedArtifactTools) {
          const spec = s.artifactToolSpecCatalog.get(name)
          if (spec) activeByName.set(name, spec)
        }
      }
      s.activeToolSpecs = [...activeByName.values()].filter(Boolean)
      if (s.hasManagedAttachments) {
        s.activeToolSpecs = s.activeToolSpecs.filter(
          (spec) => spec?.function?.name !== 'request_directory',
        )
      }
    }
    s.availableVerificationToolNames = s.activeToolSpecs
      .map(toolNameFromSpec)
      .filter((name) => VERIFICATION_TOOLS.has(name) || isCommandExecutionTool(name))
    s.requiresPdfLayoutVerification = s.mutationExecutionRequested
      && s.pdfLayoutDeliveryEligible
      && shouldRequirePdfLayoutVerification(text)
      && hasCommandExecutionTool(s.activeToolSpecs)

    s.artifactDeliveryRetries = 0
    s.clearArtifactRecovery()
    s.recomputeDeliveredArtifactTools()
    s.invalidateDeliverableSelection()
    s.convo = s.convo.filter((message) => {
      if (message?.role !== 'system') return true
      const content = String(message?.content || '')
      return !content.includes(ARTIFACT_DELIVERY_GUARD_MARKER)
        && !content.includes(ARTIFACT_RECOVERY_DIAGNOSIS_MARKER)
        && !content.includes(ARTIFACT_RECOVERY_FORCE_MARKER)
        && !content.includes(LIVE_ARTIFACT_CONTRACT_MARKER)
    })
    s.convo = replaceRuntimeCapabilityBlock(s.convo, {
      toolSpecs: s.activeToolSpecs,
      approvalMode: s.approvalMode,
      ...s.outputDirectoryContext,
    })
    const removed = [...previousAuthorizedTools]
      .filter((name) => !s.authorizedArtifactTools.has(name))
    const added = [...s.expectedArtifactTools]
      .filter((name) => !previousRequiredTools.has(name))
    s.convo.push({
      role: 'system',
      content: [
        LIVE_ARTIFACT_CONTRACT_MARKER,
        'The latest live user direction has updated the relevant parts of the file-delivery contract.',
        `Required artifact generators now: ${[...s.expectedArtifactTools].join(', ') || '(none)'}.`,
        removed.length > 0
          ? `Cancelled artifact generators: ${removed.join(', ')}. Do not call or deliver them.`
          : '',
        added.length > 0 ? `Newly required artifact generators: ${added.join(', ')}.` : '',
        'Use only the currently exposed tools. Earlier recovery prompts for cancelled generators are obsolete.',
      ].filter(Boolean).join(' '),
    })
    return true
  }
}
