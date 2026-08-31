import { ARTIFACT_DELIVERY_INCOMPLETE_REASON } from '../turnTerminalProjection.js'

const MISSING_ARTIFACT_BLOCKER = Object.freeze({
  reason: ARTIFACT_DELIVERY_INCOMPLETE_REASON,
})

export function missingArtifactBlocker() {
  return MISSING_ARTIFACT_BLOCKER
}

export async function initializeCompletion(s) {
  const { ARTIFACT_RECOVERY_PHASE_DIAGNOSE, ARTIFACT_RECOVERY_PHASE_FORCE, AVAILABLE_TOOL_CAPABILITIES_MARKER, FALSE_SUCCESS_STATUS, FILE_WRITE_TOOL_NAMES, GENERATED_ARTIFACT_TYPE, INCOMPLETE_STATUS, LOCAL_HTML_DELIVERY_GUARD_MARKER, MAX_ARTIFACT_RECOVERY_DIAGNOSTIC_ROUNDS, PDF_LAYOUT_EXECUTION_CONTRACT_MARKER, PROJECT_SCOPE_TARGET, VERIFIED_DIRECTORY_RESOLUTION, buildFinalAnswerEvidenceReviewPrompt, buildFinalAnswerEvidenceSnapshot, buildPdfLayoutExecutionContract, buildTaskVerificationRepairPrompt, collectFinalAnswerToolEvidence, finalAnswerEvidenceDigest, getProjectDirectory, hasPendingTaskVerificationRepair, hasSuccessfulLocalPreflightRead, isCommandExecutionTool, isFileArtifactTool, normalizeFinalAnswerToolEvidence, normalizeMutationTarget, observeTaskVerificationMutation, observeTaskVerificationRepair, path, restoreExecutionConvergence, restoreTaskVerificationRepair, shellTargetWithCwd, targetsMatch, taskVerificationRepairBlockerText, taskVerificationRepairExhausted, toolNameFromSpec, validateLocalHtmlDelivery } = s.d
  s.artifactDeliveryRetries = Math.max(0, Number(s.restoredState?.completionGuards?.artifactDeliveryRetries) || 0)
  s.forcedArtifactToolName = s.expectedArtifactTools.has(
      String(s.restoredState?.completionGuards?.forcedArtifactToolName || '').trim(),
    )
      ? String(s.restoredState.completionGuards.forcedArtifactToolName).trim()
      : ''
  s.restoredArtifactRecoveryPhase = String(
      s.restoredState?.completionGuards?.artifactRecoveryPhase || '',
    ).trim()
  s.artifactRecoveryPhase = s.forcedArtifactToolName
      ? ([ARTIFACT_RECOVERY_PHASE_DIAGNOSE, ARTIFACT_RECOVERY_PHASE_FORCE]
          .includes(s.restoredArtifactRecoveryPhase)
          ? s.restoredArtifactRecoveryPhase
          : s.restoredState?.completionGuards?.forcedArtifactAttemptPending === false
            ? ARTIFACT_RECOVERY_PHASE_DIAGNOSE
            : ARTIFACT_RECOVERY_PHASE_FORCE)
      : ''
  s.forcedArtifactAttemptPending = s.forcedArtifactToolName
      && s.artifactRecoveryPhase === ARTIFACT_RECOVERY_PHASE_FORCE
      ? (Object.hasOwn(s.restoredState?.completionGuards || {}, 'forcedArtifactAttemptPending')
          ? s.restoredState.completionGuards.forcedArtifactAttemptPending === true
          : true)
      : false
  s.artifactRecoveryDiagnosticRounds = s.artifactRecoveryPhase === ARTIFACT_RECOVERY_PHASE_DIAGNOSE
      ? Math.min(
          MAX_ARTIFACT_RECOVERY_DIAGNOSTIC_ROUNDS,
          Math.max(0, Math.floor(Number(
            s.restoredState?.completionGuards?.artifactRecoveryDiagnosticRounds,
          ) || 0)),
        )
      : 0
  s.artifactRecoveryIterationLimit = Math.max(
      0,
      Math.floor(Number(s.restoredState?.completionGuards?.artifactRecoveryIterationLimit) || 0),
    )
  s.deliveredArtifactTools = new Set()
  s.artifactContractToolsForProvenance = (provenance) => {
      const covered = new Set()
      if (!provenance || provenance.verified !== true) return covered
      const sourceTool = String(provenance.toolName || '').trim()
      if (s.expectedArtifactTools.has(sourceTool)) covered.add(sourceTool)

      const validation = provenance.validation
      const artifactType = String(provenance.artifactType || '').trim().toLowerCase()
      const declaredCommandOutput = isCommandExecutionTool(sourceTool)
        && validation?.verified === true
        && validation?.verifier === 'bounded_structure_parser'
        && /^[a-f0-9]{64}$/i.test(String(validation?.sha256 || ''))
        && Boolean(String(validation?.declaredPath || '').trim())
      if (!declaredCommandOutput || !artifactType) return covered

      for (const expectedTool of s.expectedArtifactTools) {
        if (GENERATED_ARTIFACT_TYPE[expectedTool] === artifactType) covered.add(expectedTool)
      }
      return covered
    }
  s.recomputeDeliveredArtifactTools = () => {
      s.deliveredArtifactTools.clear()
      for (const [artifactId, provenance] of s.artifactProvenance) {
        if (!s.artifactIds.includes(artifactId)
          || provenance?.verified !== true) continue
        for (const toolName of s.artifactContractToolsForProvenance(provenance)) {
          s.deliveredArtifactTools.add(toolName)
        }
      }
    }
  s.recomputeDeliveredArtifactTools()
  s.inheritedArtifactEvidence = ['verify', 'finalize'].includes(String(s.step?.kind || ''))
      && Array.isArray(s.job?.steps)
      && s.job.steps.some((priorStep) => (
        priorStep?.id !== s.step?.id
        && priorStep?.status === 'completed'
        && Array.isArray(priorStep?.output?.artifactIds)
        && priorStep.output.artifactIds.length > 0
      ))
  s.executionEvidenceObserved = Boolean(s.restoredState?.completionGuards?.executionEvidenceObserved)
      || s.deliveredArtifactTools.size > 0
      || s.inheritedArtifactEvidence
      || (!s.mutationExecutionRequested && hasSuccessfulLocalPreflightRead(s.job?.prompt))
  s.mutationExecutionObserved = Boolean(s.restoredState?.completionGuards?.mutationExecutionObserved)
      || s.deliveredArtifactTools.size > 0
      || s.inheritedArtifactEvidence
  s.priorOutcomeMutationObserved = Boolean(
      s.restoredState?.completionGuards?.priorOutcomeMutationObserved,
    )
  s.guardPriorOutcomeStatusText = (value) => {
      const text = String(value || '')
      if (!s.isPriorOutcomeStatusInquiry
        || (s.priorOutcomeMutationObserved && !s.hasPendingMutationVerification())
        || INCOMPLETE_STATUS.test(text)
        || !FALSE_SUCCESS_STATUS.test(text)) return text
      const blocker = String(
        s.priorTurnOutcome?.error?.message || s.priorTurnOutcome?.error?.code || '上一轮执行未完成',
      ).trim()
      const verifiedFiles = Array.isArray(s.priorTurnOutcome?.verifiedLocalFiles)
        ? s.priorTurnOutcome.verifiedLocalFiles.map((file) => String(file?.path || '').trim()).filter(Boolean)
        : []
      return [
        `上一轮仍未完成：${blocker}。`,
        verifiedFiles.length > 0
          ? `已确认存在的文件：${verifiedFiles.join('、')}；文件存在不代表整项任务已经完成。`
          : '',
        '在取得新的执行与验证证据前，不能标记为完成。',
      ].filter(Boolean).join('\n')
    }
  s.executionEvidenceRetries = Math.max(
      0,
      Number(s.restoredState?.completionGuards?.executionEvidenceRetries) || 0,
    )
  s.executionReasoningRetries = Math.max(
      0,
      Number(s.restoredState?.completionGuards?.executionReasoningRetries) || 0,
    )
  s.sourceHandoffRetries = Math.max(
      0,
      Number(s.restoredState?.completionGuards?.sourceHandoffRetries) || 0,
    )
  s.directoryResumeRetries = Math.max(
      0,
      Number(s.restoredState?.completionGuards?.directoryResumeRetries) || 0,
    )
  s.hasVerifiedDirectoryResolution = s.directoryAuthorizationResolution?.type === 'directory_authorization'
      && s.directoryAuthorizationResolution?.approved === true
      || s.convo.some((message) => (
        message?.role === 'system'
          && VERIFIED_DIRECTORY_RESOLUTION.test(String(message?.content || ''))
      ))
  s.restoredMutationTargets = Array.isArray(s.restoredState?.completionGuards?.pendingMutationTargets)
      ? s.restoredState.completionGuards.pendingMutationTargets
      : s.restoredState?.completionGuards?.pendingMutationVerification
        ? [PROJECT_SCOPE_TARGET]
        : []
  s.recoveredHistoricalTargets = s.recoveredPriorLocalTargets
  s.pendingMutationTargets = new Set(
      [
        ...s.restoredMutationTargets,
        ...(s.inheritedFreshLocalMutationRevision ? [] : s.recoveredHistoricalTargets.mutationTargets),
      ]
        .map(normalizeMutationTarget)
        .filter(Boolean),
    )
  s.pendingDeletionTargets = new Set(
      [
        ...(Array.isArray(s.restoredState?.completionGuards?.pendingDeletionTargets)
          ? s.restoredState.completionGuards.pendingDeletionTargets
          : []),
        ...(s.inheritedFreshLocalMutationRevision ? [] : s.recoveredHistoricalTargets.deletionTargets),
      ]
        .map(normalizeMutationTarget)
        .filter(Boolean),
    )
  s.auxiliaryMutationTargets = new Set(
      (Array.isArray(s.restoredState?.completionGuards?.auxiliaryMutationTargets)
        ? s.restoredState.completionGuards.auxiliaryMutationTargets
        : [])
        .map(normalizeMutationTarget)
        .filter(Boolean),
    )
  s.isLocalHtmlTarget = (value) => {
      const target = normalizeMutationTarget(value)
      if (target === PROJECT_SCOPE_TARGET || !/\.html?$/i.test(target)) return false
      // A Windows drive path is only a local, reopenable delivery target on
      // Windows. Linux CI also exercises the cmd.exe parser with synthetic
      // D:\\... paths; treating those as Linux files would schedule a bogus
      // repair loop after an otherwise successful mocked read-back.
      if (process.platform !== 'win32' && /^[a-z]:\//i.test(target)) return false
      return true
    }
  s.localHtmlDeliveryTargets = new Set(
      [
        ...(Array.isArray(s.restoredState?.completionGuards?.localHtmlDeliveryTargets)
          ? s.restoredState.completionGuards.localHtmlDeliveryTargets
          : []),
        ...(s.mutationExecutionObserved ? s.exactWorkspaceTargetPaths : []),
      ]
        .map(normalizeMutationTarget)
        .filter(s.isLocalHtmlTarget),
    )
  s.localHtmlReadSources = new Map()
  s.localHtmlDeliveryValidationPending = s.localHtmlDeliveryTargets.size > 0
  s.localHtmlDeliveryRetries = Math.max(
      0,
      Number(s.restoredState?.completionGuards?.localHtmlDeliveryRetries) || 0,
    )
  s.absoluteLocalHtmlPath = (target) => {
      const normalized = normalizeMutationTarget(target)
      if (!normalized || normalized === PROJECT_SCOPE_TARGET) return ''
      if (path.isAbsolute(normalized) || /^[a-z]:\//i.test(normalized)) return path.normalize(normalized)
      return path.resolve(getProjectDirectory({ userId: s.job?.userId || null }), normalized)
    }
  s.readSourceForHtmlTarget = (target) => {
      for (const [candidate, source] of s.localHtmlReadSources) {
        if (targetsMatch(candidate, target)) return source
      }
      return undefined
    }
  s.validateLocalHtmlDeliveries = async () => {
      if (!s.requiresLocalArtifactDelivery || s.localHtmlDeliveryTargets.size === 0) {
        s.localHtmlDeliveryValidationPending = false
        return null
      }
      if (!s.localHtmlDeliveryValidationPending) return null
      for (const target of s.localHtmlDeliveryTargets) {
        try {
          await validateLocalHtmlDelivery({
            filePath: s.absoluteLocalHtmlPath(target),
            source: s.readSourceForHtmlTarget(target),
          })
        } catch (error) {
          return { target, error }
        }
      }
      s.localHtmlDeliveryValidationPending = false
      return null
    }
  s.appendLocalHtmlDeliveryRepairPrompt = ({ target, error }, content = '') => {
      if (content) s.convo.push({ role: 'assistant', content })
      s.convo.push({
        role: 'system',
        content: [
          LOCAL_HTML_DELIVERY_GUARD_MARKER,
          'The previous completion claim was discarded because the final local HTML would not render completely in the project side preview.',
          `HTML target: ${target}.`,
          `Validation failure: ${String(error?.code || 'HTML_DELIVERY_VALIDATION_FAILED')} — ${String(error?.message || error)}.`,
          error?.reference ? `Broken reference: ${String(error.reference).slice(0, 400)}.` : '',
          error?.resourcePath ? `Resolved resource path: ${String(error.resourcePath).slice(0, 800)}.` : '',
          'Correct the actual HTML file now with the available tools. Every local src, srcset, poster, stylesheet, script, font, CSS url(), import, and fetch dependency must exist beneath the HTML file directory; use browser-style forward-slash relative URLs. Referenced images must be real decodable image files.',
          'If an input image is outside that directory, either embed it into the HTML or, when the user permits additional files, copy it into an adjacent asset subdirectory and update the reference. Do not print source code or ask the user to repair it manually.',
          'After correcting all affected files, read back the exact final HTML and continue the task. The runtime will validate it again automatically.',
        ].filter(Boolean).join(' '),
      })
    }
  s.auxiliaryScriptTarget = (target) => /(?:^|\/)[._-]?(?:run|generate|render|verify|validate|inspect|probe|cleanup|tmp|temp)(?:[-_.][^/]*)?\.(?:py|m?js|cjs|ts|ps1|sh|cmd|bat)$/i
      .test(normalizeMutationTarget(target))
  s.commandReferencesTarget = (call, target) => {
      if (!isCommandExecutionTool(call)) return false
      const command = String(call?.args?.command || call?.args?.cmd || '')
      const cwd = call?.args?.cwd
      const referencedTargets = new Set()
      const addReference = (value) => {
        const candidate = String(value || '').trim()
        if (!candidate || candidate.startsWith('-')) return
        const resolved = shellTargetWithCwd(candidate, cwd)
        if (resolved) referencedTargets.add(resolved)
      }
      const quoted = /"([^"\r\n]+)"|'([^'\r\n]+)'/g
      for (const match of command.matchAll(quoted)) addReference(match[1] || match[2])
      const unquoted = command.replace(quoted, ' ')
      const literal = /(?:^|[\s=,(])([^\s"'<>|;&,)]+)/g
      for (const match of unquoted.matchAll(literal)) addReference(match[1])
      return [...referencedTargets].some((candidate) => targetsMatch(candidate, target))
    }
  s.taskVerificationRepair = restoreTaskVerificationRepair(
      s.restoredState?.completionGuards?.taskVerificationRepair,
    )
  s.hasPendingTaskVerificationRepair = () => hasPendingTaskVerificationRepair(
      s.taskVerificationRepair,
    )
  s.taskVerificationRepairExhausted = () => taskVerificationRepairExhausted(
      s.taskVerificationRepair,
    )
  s.taskVerificationRepairPrompt = () => buildTaskVerificationRepairPrompt(
      s.taskVerificationRepair,
    )
  s.taskVerificationRepairBlockerText = () => taskVerificationRepairBlockerText(
      s.taskVerificationRepair,
    )
  const taskVerificationWorkspaceRoot = s.outputDirectoryContext?.projectDirectory || ''
  s.observeTaskVerificationMutation = (targets) => observeTaskVerificationMutation(
      s.taskVerificationRepair,
      targets,
      { workspaceRoot: taskVerificationWorkspaceRoot },
    )
  s.observeTaskVerificationRepair = (call, result) => observeTaskVerificationRepair(
      s.taskVerificationRepair,
      call,
      result,
      {
        mutationObserved: s.mutationExecutionRequested && s.mutationExecutionObserved,
        batchId: s.iteration?.taskVerificationBatchId,
        workspaceRoot: taskVerificationWorkspaceRoot,
      },
    )
  s.hasPendingMutationVerification = () => (
      s.pendingMutationTargets.size > 0
      || s.pendingDeletionTargets.size > 0
      || s.hasPendingTaskVerificationRepair()
    )
  s.recoveredMutationVerificationPending = !s.mutationExecutionObserved
      && s.hasPendingMutationVerification()
  s.verifiedRecoveredMutationObserved = Boolean(
      s.restoredState?.completionGuards?.verifiedRecoveredMutationObserved,
    )
  s.mutationSteeringPending = Boolean(
      s.restoredState?.completionGuards?.mutationSteeringPending,
    )
  s.mutationVerificationRetries = Math.max(
      0,
      Number(s.restoredState?.completionGuards?.mutationVerificationRetries) || 0,
    )
  s.pdfLayoutVerificationObserved = Boolean(
      s.restoredState?.completionGuards?.pdfLayoutVerificationObserved,
    )
  s.pdfLayoutVerificationRetries = Math.max(
      0,
      Number(s.restoredState?.completionGuards?.pdfLayoutVerificationRetries) || 0,
    )
  s.executionConvergence = restoreExecutionConvergence(
      s.restoredState?.completionGuards?.executionConvergence,
    )
  if (s.hasManagedAttachments && !s.hasRuntimeMarker('[MANAGED ATTACHMENT EXECUTION CONTRACT]')) {
      const attachmentUris = (Array.isArray(s.job?.managedAttachments) ? s.job.managedAttachments : [])
        .map((item) => String(item?.uri || '').trim())
        .filter(Boolean)
        .slice(0, 16)
      s.convo.push({
        role: 'system',
        content: [
          '[MANAGED ATTACHMENT EXECUTION CONTRACT]',
          'The attached files are already uploaded into Gugo-managed storage and require no directory permission or cloud connector.',
          attachmentUris.length ? `Use read_file with these exact URIs when file contents are needed: ${attachmentUris.join(', ')}.` : 'Use the attachment:// URI shown in the user message with read_file when file contents are needed.',
          'Do not search Dropbox, Google Drive, OneDrive, or browser apps to locate these files. Prefer the supplied extracted PDF/text content when it is already present.',
        ].join(' '),
      })
    }
  if (s.priorArtifacts.length > 0
      && s.revisesAdjacentArtifact
      && !s.hasRuntimeMarker('[ADJACENT ARTIFACT REVISION CONTRACT]')) {
      const revisionInstruction = s.artifactRevisionMode === 'replace_original'
        ? [
            'The user explicitly requested an in-place revision of the original file.',
            'Call each matching artifact generator with replace_artifact_id set to the exact authorized artifact ID shown above. The tool will preserve that artifact ID and filename while replacing its contents.',
            'Do not create or deliver a second file for that artifact.',
          ]
        : s.artifactRevisionMode === 'create_copy'
          ? [
              'The user explicitly requested a new or separate file and wants the original preserved.',
              'Call the matching artifact generator without replace_artifact_id and deliver the newly returned artifact ID.',
              'Do not overwrite or mutate the adjacent original artifact.',
            ]
          : s.artifactRevisionMode === 'conflict'
            ? [
                'The current request contains conflicting instructions about replacing the original versus creating a separate file.',
                'Call request_clarification before any artifact generator. Do not guess which file disposition the user intended.',
              ]
            : [
                'No explicit in-place replacement was authorized. Create and deliver a new revised artifact ID, preserving the prior delivered file.',
              ]
      s.convo.push({
        role: 'system',
        content: [
          '[ADJACENT ARTIFACT REVISION CONTRACT]',
          'The current user request is a revision of the authorized delivered files listed below. An exact filename or artifact ID in the current request may deliberately select an older delivered file instead of the immediately preceding one.',
          `Prior delivered artifacts: ${JSON.stringify(s.priorArtifacts)}.`,
          'Use the preceding tool-call arguments and current user request as the source of truth, apply the requested changes, and call the matching artifact generator.',
          ...revisionInstruction,
          'Do not answer with source code, save instructions, or a request for the user to recreate the file manually.',
        ].join(' '),
      })
    }
  if ((s.directExecutionRequested || s.requiresPersistedArtifact || s.revisesAdjacentArtifact || s.codeSnippetRequested)
      && !s.hasRuntimeMarker('[ARTIFACT SOURCE DELIVERY POLICY]')) {
      s.convo.push({
        role: 'system',
        content: s.codeSnippetRequested
          ? [
              '[ARTIFACT SOURCE DELIVERY POLICY]',
              'The user explicitly requested a code snippet, so you may include the specifically requested snippet in the answer.',
              'If the user also requested a downloadable artifact, the snippet does not replace the required successful artifact tool call.',
            ].join(' ')
          : [
              '[ARTIFACT SOURCE DELIVERY POLICY]',
              'The user did not explicitly request a code snippet.',
              'Never output complete source code, a large code block, copy/paste instructions, or directions telling the user to create, save, rename, or convert the file manually.',
              'This remains true after malformed arguments, a failed artifact tool call, retries, missing capabilities, or exhausted execution budget. Correct and retry with tools when safe; otherwise report one concise blocker without source code.',
            ].join(' '),
      })
    }
  if ((s.directExecutionRequested || s.requiresPersistedArtifact)
      && !s.hasRuntimeMarker(AVAILABLE_TOOL_CAPABILITIES_MARKER)) {
      const activeToolNames = s.activeToolSpecs.map(toolNameFromSpec).filter(Boolean)
      const activeCommandToolNames = activeToolNames.filter((name) => isCommandExecutionTool(name))
      const activeCommandToolLabel = activeCommandToolNames.join('/')
      const capabilityNotes = []
      if (activeCommandToolNames.length > 0) {
        capabilityNotes.push(`${activeCommandToolLabel} can run commands and installed Python/Node scripts in an authorized workspace or local directory`)
      }
      if (process.platform === 'win32'
        && activeCommandToolNames.length > 0
        && activeToolNames.includes('write_file')) {
        capabilityNotes.push(`on Windows, ${activeCommandToolLabel} uses cmd.exe; for multiline or long Python such as PDF/image generation, write a UTF-8 .py file with write_file and then run that file instead of embedding the program in python -c, and do not use Unix-only tail/grep/sed/awk pipelines`)
      }
      const writableTools = activeToolNames.filter((name) => FILE_WRITE_TOOL_NAMES.has(name))
      if (writableTools.length > 0) {
        capabilityNotes.push(`${writableTools.join('/')} can create or modify authorized files`)
      }
      const artifactTools = activeToolNames.filter((name) => isFileArtifactTool(name))
      if (artifactTools.length > 0) {
        capabilityNotes.push(`${artifactTools.join('/')} can create persisted downloadable artifacts`)
      }
      s.convo.push({
        role: 'system',
        content: [
          AVAILABLE_TOOL_CAPABILITIES_MARKER,
          `The callable tools for this turn are: ${activeToolNames.join(', ') || '(none)'}.`,
          capabilityNotes.length > 0 ? `${capabilityNotes.join('; ')}.` : '',
          'Treat this runtime-provided list as authoritative. A malformed argument or one failed tool call does not mean that the tool is unavailable.',
          'Do not call request_clarification merely to claim that a listed capability is missing; correct the arguments or use another listed tool and continue.',
        ].filter(Boolean).join(' '),
      })
    }
  if ((s.directExecutionRequested || s.requiresPersistedArtifact)
      && !s.hasRuntimeMarker('[DIRECT EXECUTION REQUIRED]')) {
      s.convo.push({
        role: 'system',
        content: [
          '[DIRECT EXECUTION REQUIRED]',
          'The user asked for concrete work, not instructions for doing it later.',
          'Use the available tools now, follow the supplied steps, create or modify the requested deliverable, and verify the result before answering.',
          'Do not merely print a script or tell the user to run commands. If execution is genuinely blocked, report the concise blocker; full source is allowed only when the artifact source-delivery policy confirms that the user explicitly requested a code snippet.',
          'Keep internal deliberation brief; report the completed result or one concise, specific blocker.',
        ].join(' '),
      })
    }
  if (s.requiresPdfLayoutVerification
      && !s.hasRuntimeMarker(PDF_LAYOUT_EXECUTION_CONTRACT_MARKER)) {
      s.convo.push({
        role: 'system',
        content: buildPdfLayoutExecutionContract(s.executionIntentText),
      })
    }
  s.missingArtifactTools = () => {
      s.recomputeDeliveredArtifactTools()
      return [...s.expectedArtifactTools].filter((name) => !s.deliveredArtifactTools.has(name))
    }
  s.hasRequiredArtifacts = () => !s.requiresPersistedArtifact || s.missingArtifactTools().length === 0
  s.hasRequiredExecutionEvidence = () => !s.requiresExecutionEvidence
      || (s.mutationExecutionRequested
        ? !s.mutationSteeringPending && (
            s.mutationExecutionObserved || (
              !s.requiresPersistedArtifact
              && s.verifiedRecoveredMutationObserved
              && s.executionEvidenceObserved
              && !s.hasPendingMutationVerification()
            )
          )
        : s.executionEvidenceObserved)
  s.deliveryContractReadyForSelection = () => s.hasRequiredArtifacts()
      && s.hasRequiredExecutionEvidence()
      && !s.hasPendingMutationVerification()
      && (!s.requiresPdfLayoutVerification || s.pdfLayoutVerificationObserved)
      && !s.localHtmlDeliveryValidationPending
  s.safeFallbackDeliverableIds = () => {
      // Automatic fallback is deliberately narrower than an explicit model
      // selection: only verified outputs from every required generator qualify.
      // Unknown checkpoint artifacts and auxiliary/intermediate artifacts are
      // never attached automatically.
      if (!s.requiresPersistedArtifact || s.expectedArtifactTools.size === 0) return []
      const candidates = s.artifactIds.filter((artifactId) => {
        const provenance = s.artifactProvenance.get(artifactId)
        return provenance?.verified === true
          && s.artifactContractToolsForProvenance(provenance).size > 0
      })
      const coveredTools = new Set()
      for (const artifactId of candidates) {
        for (const toolName of s.artifactContractToolsForProvenance(s.artifactProvenance.get(artifactId))) {
          coveredTools.add(toolName)
        }
      }
      return [...s.expectedArtifactTools].every((name) => coveredTools.has(name))
        ? candidates
        : []
    }
  s.applySafeDeliverableFallback = () => {
      if (!s.deliveryContractReadyForSelection()) return null
      const artifactIdsForFallback = s.safeFallbackDeliverableIds()
      if (artifactIdsForFallback.length === 0) return null
      const selection = s.selectDeliverables({ artifact_ids: artifactIdsForFallback })
      if (selection?.ok !== true) return null
      return {
        ...selection,
        code: 'deliverable_selection_safe_fallback',
        fallback: true,
      }
    }
  // Terminal transports project this stable reason into missing requirements;
  // the client owns all user-visible copy for the selected locale.
  s.missingArtifactBlocker = missingArtifactBlocker
  const restoredAnswerReview = s.restoredState?.completionGuards?.finalAnswerEvidenceReview
  const restoredToolEvidence = s.restoredState?.completionGuards?.finalAnswerToolEvidence
  s.finalAnswerToolEvidence = Array.isArray(restoredToolEvidence)
    ? normalizeFinalAnswerToolEvidence(restoredToolEvidence)
    : collectFinalAnswerToolEvidence(s.convo)
  s.finalAnswerEvidenceReview = /^[a-f0-9]{64}$/i.test(String(restoredAnswerReview?.digest || ''))
    ? {
        digest: String(restoredAnswerReview.digest),
        iteration: Math.max(0, Number(restoredAnswerReview.iteration) || 0),
      }
    : null
  s.requiresFinalAnswerEvidenceReview = () => s.mutationExecutionObserved === true
    || (s.hasCurrentDeliverableSelection() && s.deliveryArtifactIds.length > 0)
  s.finalAnswerEvidenceSnapshot = () => buildFinalAnswerEvidenceSnapshot({
    objective: s.artifactAuthorizationText || s.job?.prompt || '',
    requiredArtifactTools: [...s.expectedArtifactTools],
    artifacts: s.artifactIds.map((id) => {
      const provenance = s.artifactProvenance.get(id)
      return {
        id,
        tool: provenance?.toolName,
        type: provenance?.artifactType,
        verified: provenance?.verified === true,
      }
    }),
    selectedArtifactIds: s.hasCurrentDeliverableSelection() ? s.deliveryArtifactIds : [],
    mutationExecutionObserved: s.mutationExecutionObserved,
    executionEvidenceObserved: s.executionEvidenceObserved,
    postMutationVerificationPassed: s.mutationExecutionObserved && !s.hasPendingMutationVerification(),
    pdfLayoutVerificationPassed: !s.requiresPdfLayoutVerification || s.pdfLayoutVerificationObserved,
    localHtmlValidationPassed: !s.localHtmlDeliveryValidationPending,
    toolEvidence: s.finalAnswerToolEvidence,
  })
  s.currentFinalAnswerEvidenceDigest = () => finalAnswerEvidenceDigest(
    s.finalAnswerEvidenceSnapshot(),
  )
  s.finalAnswerEvidenceReady = () => s.requiresFinalAnswerEvidenceReview()
    && s.hasRequiredArtifacts()
    && s.hasRequiredExecutionEvidence()
    && !s.hasPendingMutationVerification()
    && (!s.requiresPdfLayoutVerification || s.pdfLayoutVerificationObserved)
    && !s.localHtmlDeliveryValidationPending
    && !s.needsDeliverableSelection()
  s.hasCurrentFinalAnswerEvidenceReview = (requestDigest = null) => {
    if (!s.finalAnswerEvidenceReady()) return false
    const digest = s.currentFinalAnswerEvidenceDigest()
    return s.finalAnswerEvidenceReview?.digest === digest
      && (requestDigest === null || requestDigest === digest)
  }
  s.prepareFinalAnswerEvidenceReview = () => {
    if (!s.finalAnswerEvidenceReady() || s.hasCurrentFinalAnswerEvidenceReview()) return false
    const snapshot = s.finalAnswerEvidenceSnapshot()
    const digest = finalAnswerEvidenceDigest(snapshot)
    s.finalAnswerEvidenceReview = { digest, iteration: s.iter }
    s.convo.push({
      role: 'system',
      content: buildFinalAnswerEvidenceReviewPrompt(snapshot, digest),
    })
    return true
  }
  return { kind: 'next' }
}
