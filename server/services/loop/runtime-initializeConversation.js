export async function initializeConversation(s) {
  const { DIRECTORY_REVIEW_GUARD_MARKER, DIRECTORY_REVIEW_INTENT, DYNAMIC_EXECUTION_TARGET_MARKER, PUBLIC_FILTERED_CLARIFICATION_TEXT, PUBLIC_INCOMPLETE_TASK_TEXT, PUBLIC_UNVERIFIED_FILE_TEXT, buildRepresentativeReadCalls, ensureSafetySystemMessages, getDefaultOutputDirectory, getProjectDirectory, isFileArtifactTool, listTurnArtifacts, normalizeArtifactIdList, path, replaceRuntimeCapabilityBlock, sameArtifactIdList, sanitizeIncompleteTerminalText, sourceHandoffViolation, stripEphemeralToolMediaMessages, successfulReadFileInMessages } = s.d
  s.representativeReadCalls = buildRepresentativeReadCalls(s.job?.prompt, s.job?.id)
  s.requiresRepresentativeRead = s.job?.origin === 'chat'
      && DIRECTORY_REVIEW_INTENT.test(String(s.job?.userPrompt || ''))
      && s.activeToolSpecs.some((spec) => spec?.function?.name === 'read_file')
      && s.representativeReadCalls.length > 0
  s.recoverySessionId = s.job?.origin === 'chat' && s.job?.sessionId
      ? String(s.job.sessionId)
      : s.job?.id && s.step?.id
        ? `job:${s.job.id}:${s.step.id}`
        : null
  s.semanticSummary = false
  s.outputDirectoryContext = {}
  try {
      s.outputDirectoryContext = {
        defaultOutputDirectory: getDefaultOutputDirectory({ userId: s.job?.userId || null }),
        projectDirectory: getProjectDirectory({ userId: s.job?.userId || null }),
      }
    } catch {
      // Prompt context is best-effort and must never block a turn.
    }
  const authorizedVerificationRoots = s.directoryAuthorizationResolutions
    .filter((resolution) => (
      resolution?.type === 'directory_authorization'
        && resolution?.approved === true
        && resolution?.access_mode === 'read_write'
        && Boolean(String(resolution?.grant_id || '').trim())
        && path.isAbsolute(String(resolution?.path || '').trim())
    ))
    .map((resolution) => path.resolve(String(resolution.path).trim()))
  const configuredVerificationRoot = path.isAbsolute(
    String(s.outputDirectoryContext.projectDirectory || '').trim(),
  )
    ? path.resolve(String(s.outputDirectoryContext.projectDirectory).trim())
    : ''
  // Keep the configured project and the independently authorized directory as
  // separate trusted roots. Verification selects the root containing the
  // check cwd; authorizing an output directory must not replace project scope.
  s.verificationProjectDirectory = configuredVerificationRoot || authorizedVerificationRoots[0] || ''
  s.verificationProjectDirectories = [...new Set([
    configuredVerificationRoot,
    ...authorizedVerificationRoots,
  ].filter(Boolean))]
  s.requiresLocalArtifactDelivery = ['workspace_file', 'mixed'].includes(s.artifactDelivery.target)
      || s.artifactRevisionMode === 'replace_original'
      || Boolean(String(s.outputDirectoryContext.defaultOutputDirectory || '').trim())
  s.convo = ensureSafetySystemMessages(
      Array.isArray(s.restoredState?.messages)
        ? stripEphemeralToolMediaMessages(s.restoredState.messages)
        : [...s.messages],
    )
  s.convo = replaceRuntimeCapabilityBlock(s.convo, {
      toolSpecs: s.activeToolSpecs,
      approvalMode: s.approvalMode,
      ...s.outputDirectoryContext,
    })
  if (s.shouldRestoreExecutionTools
      && s.recoveredPriorLocalTargetPaths.length > 0
      && !s.convo.some((message) => message?.role === 'system'
        && String(message?.content || '').includes(DYNAMIC_EXECUTION_TARGET_MARKER))) {
      s.convo.push({
        role: 'system',
        content: [
          DYNAMIC_EXECUTION_TARGET_MARKER,
          `The previous execution turn established these canonical local targets: ${s.recoveredPriorLocalTargetPaths.map((target) => JSON.stringify(target)).join(', ')}.`,
          'Continue against those exact formal files in place. Read the exact target before choosing an edit, preserve its path identity, and do not create a copy or substitute another path unless the user explicitly asks for one.',
        ].join(' '),
      })
    }
  s.hasRuntimeMarker = (marker) => s.convo.some((message) => (
      message?.role === 'system' && String(message?.content || '').includes(marker)
    ))
  s.representativeReadsInjected = Boolean(s.restoredState?.completionGuards?.representativeReadsInjected)
      || s.convo.some((message) => message?.role === 'system' && String(message?.content || '').includes(DIRECTORY_REVIEW_GUARD_MARKER))
  s.hasSuccessfulRepresentativeRead = successfulReadFileInMessages(s.convo)
  s.artifactIds = normalizeArtifactIdList(s.restoredState?.artifactIds)
  s.artifactProvenance = new Map(
      (Array.isArray(s.restoredState?.completionGuards?.artifactProvenance)
        ? s.restoredState.completionGuards.artifactProvenance
        : [])
        .map((entry) => [
          String(entry?.artifactId || '').trim(),
          {
            toolName: String(entry?.toolName || '').trim(),
            verified: entry?.verified === true,
            ...(entry?.artifactType ? { artifactType: String(entry.artifactType).trim().toLowerCase() } : {}),
            ...(entry?.validation && typeof entry.validation === 'object'
              ? { validation: { ...entry.validation } }
              : {}),
          },
        ])
        .filter(([artifactId, entry]) => s.artifactIds.includes(artifactId) && entry.toolName),
    )
  s.protectTerminalText = (text, { incomplete = false } = {}) => {
      const value = incomplete
        ? sanitizeIncompleteTerminalText(
            text,
            s.requiresPersistedArtifact ? PUBLIC_UNVERIFIED_FILE_TEXT : PUBLIC_INCOMPLETE_TASK_TEXT,
          )
        : String(text || '')
      if (!s.requiresSourceHandoffProtection || !sourceHandoffViolation(value)) return value

      if (s.artifactIds.length > 0) {
        return incomplete
          ? PUBLIC_UNVERIFIED_FILE_TEXT
          : '文件已通过工具生成并完成交付。已隐藏模型返回的代码内容。'
      }
      return incomplete
        ? PUBLIC_INCOMPLETE_TASK_TEXT
        : '任务已通过工具执行并完成必要验证。已隐藏模型返回的代码内容。'
    }
  s.protectClarification = (clarification) => {
      if (!s.requiresSourceHandoffProtection || !clarification || typeof clarification !== 'object') {
        return clarification
      }
      const detectionSeen = new WeakSet()
      const containsSourceHandoff = (value) => {
        if (typeof value === 'string') return sourceHandoffViolation(value)
        if (!value || typeof value !== 'object' || detectionSeen.has(value)) return false
        detectionSeen.add(value)
        return Object.values(value).some(containsSourceHandoff)
      }
      const sourceWasFiltered = containsSourceHandoff(clarification)
      const safeQuestion = sourceWasFiltered
        ? PUBLIC_FILTERED_CLARIFICATION_TEXT
        : s.protectTerminalText(
            clarification.question || clarification.message || clarification.why,
            { incomplete: true },
          ) || '需要你补充信息后才能继续。'
      const seen = new WeakSet()
      const protectValue = (value) => {
        if (typeof value === 'string') {
          return sourceHandoffViolation(value) ? safeQuestion : value
        }
        if (!value || typeof value !== 'object') return value
        if (seen.has(value)) return null
        seen.add(value)
        if (Array.isArray(value)) return value.map(protectValue)
        return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, protectValue(nested)]))
      }
      return { ...protectValue(clarification), question: safeQuestion }
    }
  s.deliveryArtifactSelectionExplicit = Object.hasOwn(s.restoredState || {}, 'deliveryArtifactIds')
  s.deliveryArtifactIds = s.deliveryArtifactSelectionExplicit
      ? normalizeArtifactIdList(s.restoredState.deliveryArtifactIds)
      : []
  s.restoredSelectionArtifactIds = s.restoredState?.completionGuards?.deliveryArtifactSelectionArtifactIds
  s.deliveryArtifactSelectionArtifactIds = s.deliveryArtifactSelectionExplicit
      ? normalizeArtifactIdList(Array.isArray(s.restoredSelectionArtifactIds)
          ? s.restoredSelectionArtifactIds
          : s.artifactIds)
      : []
  if (s.deliveryArtifactSelectionExplicit
      && Array.isArray(s.restoredSelectionArtifactIds)
      && !sameArtifactIdList(s.deliveryArtifactSelectionArtifactIds, s.artifactIds)) {
      s.deliveryArtifactSelectionExplicit = false
      s.deliveryArtifactIds = []
      s.deliveryArtifactSelectionArtifactIds = []
    }
  s.deliverableSelectionRetries = Math.max(
      0,
      Number(s.restoredState?.completionGuards?.deliverableSelectionRetries) || 0,
    )
  s.hasCurrentDeliverableSelection = () => s.deliveryArtifactSelectionExplicit
      && sameArtifactIdList(s.deliveryArtifactSelectionArtifactIds, s.artifactIds)
  s.deliverySelectionFields = () => {
      if (s.hasCurrentDeliverableSelection()) {
        return { deliveryArtifactIds: [...s.deliveryArtifactIds] }
      }
      // Once a chat turn has artifacts, an absent field is ambiguous to older
      // checkpoint consumers and can revive a stale selection after a crash.
      // Persist an explicit empty delivery while selection is pending/invalid;
      // completionGuards still distinguishes that state from an intentional
      // set_deliverables({ artifact_ids: [] }) selection on resume.
      if (s.job?.origin === 'chat' && s.artifactIds.length > 0) {
        return { deliveryArtifactIds: [] }
      }
      return {}
    }
  s.invalidateDeliverableSelection = () => {
      s.deliveryArtifactSelectionExplicit = false
      s.deliveryArtifactIds = []
      s.deliveryArtifactSelectionArtifactIds = []
      s.deliverableSelectionRetries = 0
    }
  s.recordArtifactIds = (ids, provenance = null) => {
      let added = false
      let selectedArtifactInvalidated = false
      for (const id of normalizeArtifactIdList(ids)) {
        if (!s.artifactIds.includes(id)) {
          s.artifactIds.push(id)
          added = true
        }
        if (provenance?.toolName) {
          const previous = s.artifactProvenance.get(id)
          const next = {
            toolName: String(provenance.toolName),
            verified: provenance.verified === true,
            ...(provenance.artifactType
              ? { artifactType: String(provenance.artifactType).trim().toLowerCase() }
              : {}),
            ...(provenance.validation && typeof provenance.validation === 'object'
              ? { validation: { ...provenance.validation } }
              : {}),
          }
          s.artifactProvenance.set(id, next)
          if (previous?.verified === true
            && (next.verified !== true
              || previous.toolName !== next.toolName
              || previous.artifactType !== next.artifactType)
            && s.deliveryArtifactIds.includes(id)) {
            selectedArtifactInvalidated = true
          }
        }
      }
      if ((added || selectedArtifactInvalidated) && s.deliveryArtifactSelectionExplicit) {
        s.invalidateDeliverableSelection()
      }
      return added
    }
  s.needsDeliverableSelection = () => s.job?.origin === 'chat'
      && s.artifactIds.length > 0
      && s.deliveryContractReadyForSelection()
      && !s.hasCurrentDeliverableSelection()
  s.suppressTerminalArtifacts = () => {
      // Draft/intermediate files remain in the durable checkpoint so an
      // explicit retry can continue from them, but an incomplete/failed turn
      // must never expose them as final clickable deliverables.
      s.deliveryArtifactIds = []
      s.deliveryArtifactSelectionArtifactIds = [...s.artifactIds]
      s.deliveryArtifactSelectionExplicit = true
    }
  s.selectDeliverables = (args = {}) => {
      if (s.job?.origin !== 'chat' || !s.job?.userId || !s.job?.sessionId || !s.job?.id) {
        return {
          ok: false,
          code: 'deliverable_scope_unavailable',
          error: 'Final deliverables can only be selected for a persisted chat turn.',
          retryable: false,
        }
      }
      const requested = args.artifact_ids
      if (!Array.isArray(requested)
        || requested.some((id) => typeof id !== 'string' || !id || id.trim() !== id)
        || new Set(requested).size !== requested.length) {
        return {
          ok: false,
          code: 'invalid_deliverable_artifact_ids',
          error: 'artifact_ids must contain unique, non-empty artifact ID strings without surrounding whitespace.',
          retryable: false,
        }
      }
      const ownedIds = new Set(listTurnArtifacts({
        userId: s.job.userId,
        sessionId: s.job.sessionId,
        turnId: s.job.id,
      }).map((artifact) => artifact.id))
      if (s.artifactRevisionMode === 'replace_original') {
        for (const artifact of s.priorArtifacts) {
          if (s.artifactIds.includes(artifact.id)) ownedIds.add(artifact.id)
        }
      }
      const invalidArtifactIds = requested.filter((id) => !ownedIds.has(id))
      if (invalidArtifactIds.length > 0) {
        return {
          ok: false,
          code: 'deliverable_artifact_scope_mismatch',
          error: 'Every deliverable artifact ID must be created by this turn or be an adjacent artifact successfully replaced in place by this turn.',
          invalidArtifactIds,
          retryable: false,
        }
      }
      if (s.requiresPersistedArtifact) {
        const ineligibleArtifactIds = requested.filter((id) => {
          const provenance = s.artifactProvenance.get(id)
          const verifiedAuthorizedGenerator = provenance?.verified === true
            && isFileArtifactTool(provenance.toolName)
            && s.authorizedArtifactTools.has(provenance.toolName)
          const verifiedEquivalentOutput = provenance?.verified === true
            && s.artifactContractToolsForProvenance(provenance).size > 0
          return !verifiedAuthorizedGenerator && !verifiedEquivalentOutput
        })
        if (ineligibleArtifactIds.length > 0) {
          return {
            ok: false,
            code: 'deliverable_artifact_provenance_mismatch',
            error: 'Final deliverables must come from a verified generator or a structurally verified declared command output of the requested type. Intermediate files cannot be selected.',
            invalidArtifactIds: ineligibleArtifactIds,
            retryable: true,
            hint: 'Select only verified artifact IDs that satisfy the requested output type.',
          }
        }
        const missingSelectedTools = [...s.expectedArtifactTools].filter((toolName) => (
          !requested.some((id) => (
            s.artifactContractToolsForProvenance(s.artifactProvenance.get(id)).has(toolName)
          ))
        ))
        if (missingSelectedTools.length > 0) {
          return {
            ok: false,
            code: 'required_deliverable_not_selected',
            error: `Every requested file type must be selected. Missing verified deliverables from: ${missingSelectedTools.join(', ')}.`,
            missingTools: missingSelectedTools,
            retryable: true,
            hint: 'Include one verified artifact ID for every requested output type.',
          }
        }
      }
      s.deliveryArtifactIds = [...requested]
      s.deliveryArtifactSelectionArtifactIds = [...s.artifactIds]
      s.deliveryArtifactSelectionExplicit = true
      s.deliverableSelectionRetries = 0
      return {
        ok: true,
        deliveryArtifactIds: [...s.deliveryArtifactIds],
        selected: s.deliveryArtifactIds.length,
        replaced: true,
      }
    }
  return { kind: 'next' }
}
