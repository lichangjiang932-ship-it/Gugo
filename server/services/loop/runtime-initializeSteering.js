import { observeLoopEvent } from './eventIsolation.js'

export async function initializeSteering(s) {
  const { ARTIFACT_DELIVERY_GUARD_MARKER, ARTIFACT_RECOVERY_DIAGNOSIS_MARKER, ARTIFACT_RECOVERY_FORCE_MARKER, LIVE_ARTIFACT_CONTRACT_MARKER, LIVE_STEERING_GUARD_MARKER, MAX_INSTALL_ATTEMPT_SIGNATURES, MAX_LOCAL_HTML_DELIVERY_RETRIES, VERIFICATION_TOOLS, allowedArtifactTools, attachJobBudget, callModelWithContextRecovery, createJobBudget, createModelPhaseHeartbeat, createSubagentApprovalContext, createToolLoopGuard, getJobBudget, hasCommandExecutionTool, hasMutationExecutionIntent, installAttemptSignature, isCommandExecutionTool, isContextLengthError, isFileArtifactTool, isForcedToolChoiceCompatibilityError, isProbeLikeCall, parseSkillIdFromPrompt, replaceRuntimeCapabilityBlock, requestedArtifactOutputDirective, resolveArtifactDeliveryTargets, runModelStep, runWithModelBudget, shouldRequirePdfLayoutVerification, stripEphemeralToolMediaMessages, toolNameFromSpec } = s.d
  s.steeringArtifactTerms = new Map([
      ['create_html_app', '(?:网页|网站|页面|HTML(?:\\s*(?:文件|页面))?|web(?:site|page)|site)'],
      ['create_pptx', '(?:PPTX?|幻灯片|演示文稿|PowerPoint|slide(?:\\s*deck)?)'],
      ['create_docx', '(?:DOCX?|Word(?:\\s*document)?|文档|报告文件)'],
      ['create_xlsx', '(?:XLSX?|Excel|电子表格|工作簿|spreadsheet|workbook)'],
      ['create_pdf', '(?:PDF(?:\\s*(?:文件|文档))?)'],
      ['generate_image', '(?:图片|图像|插图|海报|image|picture)'],
    ])
  s.cancelledArtifactToolsFromSteering = (value) => {
      const text = String(value || '')
      const cancelled = new Set()
      for (const [toolName, term] of s.steeringArtifactTerms) {
        const explicitCancellation = new RegExp([
          `(?:不要|不再|停止|别|不用|不需要)(?:再|继续)?\\s*(?:生成|创建|制作|输出|导出|交付|调用)\\s*(?:(?:任何|新的?|一张|一个|一份)\\s*)*${term}`,
          `(?:取消|放弃|去掉|删除|无需|不必|不再需要)\\s*(?:生成|创建|制作|输出|导出|交付)?\\s*(?:(?:任何|新的?|一张|一个|一份)\\s*)*${term}`,
          `不要\\s*(?:(?:任何|新的?|一张|一个|一份)\\s*)*${term}(?:文件|产物)?(?:了|啦)?(?=[，,。；;！!？?\\s]|$)`,
          `${term}\\s*(?:不要|无需|不必|不再)\\s*(?:生成|创建|制作|输出|导出|交付)`,
          `(?:do\\s+not|don't|no\\s+longer|stop|cancel)\\s+(?:create|generate|make|export|deliver|produce)\\s+(?:a\\s+|an\\s+|any\\s+|new\\s+)?${term}`,
        ].join('|'), 'i')
        if (explicitCancellation.test(text)) cancelled.add(toolName)
      }
      return cancelled
    }
  s.steeringDefinesExclusiveArtifactContract = (value, detectedTools) => {
      if (!(detectedTools instanceof Set) || detectedTools.size === 0) return false
      const text = String(value || '')
      return /(?:只|仅)(?:需|需要|要|生成|创建|制作|输出|导出|交付|保留|使用|用)|(?:改为|换成|替换为)\s*(?:只|仅)?|\bonly\b|\binstead\b/i.test(text)
    }
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
      const cancelledTools = s.cancelledArtifactToolsFromSteering(text)
      const exclusive = s.steeringDefinesExclusiveArtifactContract(text, detectedTools)
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
          s.activeToolSpecs = s.activeToolSpecs.filter((spec) => spec?.function?.name !== 'request_directory')
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
      const removed = [...previousAuthorizedTools].filter((name) => !s.authorizedArtifactTools.has(name))
      const added = [...s.expectedArtifactTools].filter((name) => !previousRequiredTools.has(name))
      s.convo.push({
        role: 'system',
        content: [
          LIVE_ARTIFACT_CONTRACT_MARKER,
          'The latest live user direction has updated the relevant parts of the file-delivery contract.',
          `Required artifact generators now: ${[...s.expectedArtifactTools].join(', ') || '(none)'}.`,
          removed.length > 0 ? `Cancelled artifact generators: ${removed.join(', ')}. Do not call or deliver them.` : '',
          added.length > 0 ? `Newly required artifact generators: ${added.join(', ')}.` : '',
          'Use only the currently exposed tools. Earlier recovery prompts for cancelled generators are obsolete.',
        ].filter(Boolean).join(' '),
      })
      return true
    }
  s.appendSteeringMessages = (messages = []) => {
      if (!messages.length) return 0
      // 用户干预改变了上下文,跨干预的重复调用不算死循环。
      s.repeatCallGuard.reset()
      s.loopGuard.resetRepetition?.()
      s.pendingRepeatCallReminder = null
      if (!s.hasRuntimeMarker(LIVE_STEERING_GUARD_MARKER)) {
        s.convo.push({
          role: 'system',
          content: `${LIVE_STEERING_GUARD_MARKER} The user sent steering updates while this task was running. Apply them now; newer user direction takes precedence.`,
        })
      }
      for (const steering of messages) {
        // Preserve the user text verbatim. Do not summarize steering before the model sees it.
        const id = String(steering?.id || '').trim()
        if (id) s.appliedSteeringIds.add(id)
        s.convo.push({ role: 'user', content: steering.content })
        if (requestedArtifactOutputDirective(steering.content).hasDirective) {
          s.activeArtifactOutputPrompt = String(steering.content || '').trim()
        }
        s.refreshArtifactContractFromSteering(steering.content)
        if (hasMutationExecutionIntent(String(steering?.content || ''))) {
          s.mutationSteeringPending = true
          s.verifiedRecoveredMutationObserved = false
          s.recoveredMutationVerificationPending = false
        }
      }
      return messages.length
    }
  s.finishIncomplete = async ({ text, reason, steeringLeaseId = null }) => {
      const safePartialResult = s.partialResultFallback.apply({
        text,
        incomplete: true,
        reason,
      })
      s.finalText = s.protectTerminalText(safePartialResult.text, { incomplete: true })
      const completion = await s.steeringController.prepareCompletion({
        text: s.finalText,
        leaseId: steeringLeaseId,
        incomplete: true,
        reason,
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
            reason,
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
        reason,
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
        },
      })
      s.finalCheckpointPersisted = Boolean(text.trim())
      return s.emitTurnStopping({ ...result, text, ...s.deliverySelectionFields() })
    }
  s.restoredBudget = s.restoredState?.budget && typeof s.restoredState.budget === 'object'
      ? {
          maxTotalCalls: s.restoredState.budget.maxTotalCalls,
          maxWallMs: s.restoredState.budget.maxWallMs,
          maxModelCalls: s.restoredState.budget.maxModelCalls,
          maxModelTokens: s.restoredState.budget.maxModelTokens,
          maxCostUsd: s.restoredState.budget.maxCostUsd,
          initialUsed: s.restoredState.budget.used,
          initialElapsedMs: s.restoredState.budget.elapsed,
          initialModelMs: s.restoredState.budget.modelMs,
          initialModelCalls: s.restoredState.budget.modelCalls,
          initialModelTokens: s.restoredState.budget.modelTokens,
          initialCostUsd: s.restoredState.budget.costUsd,
        }
      : undefined
  s.budget = s.runtimeBudget || (s.job
      ? (getJobBudget(s.job) || attachJobBudget(s.job, s.restoredBudget))
      : createJobBudget(s.restoredBudget))
  s.callTrackedModel = async ({
      messages: modelMessages,
      tools: modelTools = [],
      toolChoice,
      consumeBudget,
      allowOverBudget = false,
      onTextDelta,
      onReasoningDelta: handleReasoningDelta,
    }) => {
      if (typeof s.onModelPhase === 'function') {
        await s.onModelPhase({ phase: 'started', iteration: s.iter })
      }
      const heartbeat = createModelPhaseHeartbeat({
        onPhase: s.onModelPhase,
        iteration: s.iter,
        intervalMs: s.modelHeartbeatIntervalMs,
      })
      const ephemeralMessages = s.pendingEphemeralToolMessages.splice(0)
      let forcedToolChoiceCompatibilityFallbackUsed = false
      try {
        const request = await callModelWithContextRecovery({
          messages: modelMessages,
          ephemeralMessages,
          tools: modelTools,
          callModel: async (modelRequest) => {
            await heartbeat.beginRequest()
            const invoke = (requestPayload) => runModelStep({
              request: requestPayload,
              loopEvents: s.activeLoopEvents,
              context: s.loopEventContext({ phase: 'model-request' }),
              beforeRequest: ({ attempt }) => s.checkpointBarrier.beforeSideEffect({
                meta: { boundary: 'model-request', iteration: s.iter, attempt },
              }),
              runModel: (preparedRequest) => runWithModelBudget(
                s.budget,
                () => s.runModel(preparedRequest),
                { allowOverBudget },
              ),
            })
            try {
              return await invoke(modelRequest)
            } catch (error) {
              const forcedChoice = modelRequest?.toolChoice
              if (forcedToolChoiceCompatibilityFallbackUsed
                || !forcedChoice
                || typeof forcedChoice !== 'object'
                || !isForcedToolChoiceCompatibilityError(error)) {
                throw error
              }

              // A number of OpenAI-compatible servers support tools but reject
              // selecting one named function through tool_choice. The recovery
              // prompt and runtime validator still require the same generator,
              // so retry this logical request once without the incompatible wire
              // field instead of terminating an otherwise recoverable file task.
              forcedToolChoiceCompatibilityFallbackUsed = true
              const compatibleRequest = { ...modelRequest }
              delete compatibleRequest.toolChoice
              await heartbeat.beginRequest()
              return invoke(compatibleRequest)
            }
          },
          isContextLengthError,
          contextWindow: s.contextWindow,
          semanticSummary: s.semanticSummary,
          signal: s.signal,
          userId: s.job?.userId || null,
          sessionId: s.recoverySessionId,
          ...(typeof consumeBudget === 'function' ? { consumeBudget } : {}),
          ...(toolChoice !== undefined ? { toolChoice } : {}),
          onTextDelta: async (text, metadata = {}) => {
            if (text) await heartbeat.recordDelta()
            if (typeof onTextDelta === 'function') await onTextDelta(text, metadata)
          },
          onReasoningDelta: async (text, metadata = {}) => {
            if (text) await heartbeat.recordDelta()
            if (typeof handleReasoningDelta === 'function') {
              await handleReasoningDelta(text, metadata)
            }
          },
        })
        if (request.recovery?.compacted === true) {
          await observeLoopEvent({
            loopEvents: s.activeLoopEvents,
            event: 'compaction',
            value: {
              recovery: request.recovery,
              messages: request.messages,
            },
            context: s.loopEventContext({ phase: 'context-compaction' }),
          })
        }
        return {
          ...request,
          messages: stripEphemeralToolMediaMessages(request.messages),
        }
      } finally {
        await heartbeat.stop()
      }
    }
  s.subagentApprovalContext = s.approvalContext || createSubagentApprovalContext()
  s.loopGuard = createToolLoopGuard({
      maxRepeatedCalls: 2,
      maxConsecutiveErrors: 20,
      maxSameToolFailures: 20,
      initialState: s.restoredState?.loopGuard,
    })
  s.rememberInstallAttempt = (signature) => {
      if (!signature) return
      s.executionConvergence.installAttempts = s.executionConvergence.installAttempts
        .filter((item) => item !== signature)
      s.executionConvergence.installAttempts.push(signature)
      s.executionConvergence.installAttempts = s.executionConvergence.installAttempts
        .slice(-MAX_INSTALL_ATTEMPT_SIGNATURES)
    }
  s.convergenceBlockFor = (call) => {
      if (!s.executionConvergenceEnabled || !s.executionConvergence.interventionActive) return null
      if (isProbeLikeCall(call)) {
        return {
          ok: false,
          code: 'execution_convergence_probe_blocked',
          error: 'The call was blocked because this execution task already spent several rounds on environment or inspection probes without producing the requested output.',
          retryable: false,
          blockedKind: 'probe',
          hint: 'Stop creating or running inspection scripts. Execute the requested mutation or artifact generation now, then verify its actual output.',
        }
      }
      const installSignature = installAttemptSignature(call)
      if (installSignature && s.executionConvergence.installAttempts.includes(installSignature)) {
        return {
          ok: false,
          code: 'execution_convergence_install_blocked',
          error: `The repeated dependency installation (${installSignature}) was blocked after the task failed to converge.`,
          retryable: false,
          blockedKind: 'repeated_install',
          hint: 'Use the dependency state already observed and execute the requested output-producing command. Only report a blocker when a concrete execution error proves the dependency is unusable.',
        }
      }
      return null
    }
  if (s.restoredLocalHtmlDeliveryFailure) {
      const restoredRecovery = await s.handleLocalHtmlDeliveryFailure({
        failure: s.restoredLocalHtmlDeliveryFailure,
      })
      if (restoredRecovery.result) return { kind: 'return', value: restoredRecovery.result }
    }
  return { kind: 'next' }
}
