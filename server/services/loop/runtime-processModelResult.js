export async function processModelResult(s) {
  const i = s.iteration
  const { ARTIFACT_DELIVERY_GUARD_MARKER, ARTIFACT_RECOVERY_PHASE_DIAGNOSE, DELIVERABLE_SELECTION_FALLBACK_MARKER, DELIVERABLE_SELECTION_GUARD_MARKER, DIRECTORY_AUTHORIZATION_WAIT_CLAIM, DIRECTORY_RESUME_GUARD_MARKER, EXECUTION_EVIDENCE_GUARD_MARKER, MAX_ARTIFACT_DELIVERY_RETRIES, MAX_DELIVERABLE_SELECTION_RETRIES, MAX_DIRECTORY_RESUME_RETRIES, MAX_EXECUTION_EVIDENCE_RETRIES, MAX_MUTATION_VERIFICATION_RETRIES, MAX_PDF_LAYOUT_VERIFICATION_RETRIES, MAX_SOURCE_HANDOFF_RETRIES, PDF_LAYOUT_VERIFICATION_GUARD_MARKER, PDF_LAYOUT_VERIFICATION_OK, POST_MUTATION_VERIFICATION_GUARD_MARKER, SOURCE_HANDOFF_GUARD_MARKER, buildAssistantToolCallsMessage, buildJobToolIdempotencyKey, commandExecutionToolLabel, hasCommandExecutionTool, inspectToolLoopModelResponse, normalizeToolCalls, observeToolCalls, requestedPdfSectionLabel, scopeTextToolCallIds, sourceHandoffViolation } = s.d
  ;({ content: i.content, toolCalls: i.rawToolCalls } = i.modelResult)
  // The completed response is now owned by this processing stage. The next
  // checkpoint persists its projected text/tool effects while clearing the
  // invocation in the same state snapshot. If that checkpoint fails, the
  // previous durable checkpoint still contains the response and recovery can
  // replay it without issuing another provider request.
  s.modelInvocation = null
  s.restoredModelInvocation = null
  if (!i.rawToolCalls || i.rawToolCalls.length === 0) {
          if (s.hasVerifiedDirectoryResolution && DIRECTORY_AUTHORIZATION_WAIT_CLAIM.test(String(i.content || ''))) {
            const canRetry = s.directoryResumeRetries < MAX_DIRECTORY_RESUME_RETRIES
              && s.iter + 1 < s.maxIters
            if (!canRetry) {
              const incomplete = await s.finishIncomplete({
                text: '\u76ee\u5f55\u6743\u9650\u5df2\u6388\u4e88\uff0c\u4f46\u6a21\u578b\u5728\u6062\u590d\u540e\u4ecd\u91cd\u590d\u8bf7\u6c42\u540c\u4e00\u6388\u6743\uff0c\u4e14\u672a\u6267\u884c\u539f\u4efb\u52a1\u3002\u672c\u8f6e\u6ca1\u6709\u6807\u8bb0\u4e3a\u5b8c\u6210\u3002',
                reason: 'directory_resume_not_converged',
                steeringLeaseId: i.steeringLeaseId,
              })
              if (incomplete.deferredForSteering) return { kind: 'continue' }
              return { kind: 'return', value: incomplete }
            }
            s.directoryResumeRetries += 1
            if (i.content) s.convo.push({ role: 'assistant', content: i.content })
            s.convo.push({
              role: 'system',
              content: [
                DIRECTORY_RESUME_GUARD_MARKER,
                'The requested directory grant is already verified in this checkpoint; there is no pending directory selection or authorization action.',
                'Do not ask the user to authorize, choose, or confirm that directory again.',
                'Continue the original task now with the available execution tools and obtain concrete execution and verification results before answering.',
              ].join(' '),
            })
            await s.persistTurn()
            if (i.steeringLeaseId && typeof s.acknowledgeSteering === 'function') {
              await s.acknowledgeSteering(i.steeringLeaseId)
            }
            return { kind: 'continue' }
          }
          if (!s.hasRequiredArtifacts()) {
            const missing = s.missingArtifactTools()
            if (s.artifactRecoveryPhase === ARTIFACT_RECOVERY_PHASE_DIAGNOSE
              && s.forcedArtifactToolName) {
              // A diagnosis round may decide that no more discovery is needed.
              // Move to the bounded forced generator request without charging a
              // generator attempt for this full-tool-set reasoning round.
              if (i.content) s.convo.push({ role: 'assistant', content: i.content })
              s.appendForcedArtifactPrompt(s.forcedArtifactToolName)
              s.scheduleForcedArtifactAttempt(s.forcedArtifactToolName)
              await s.persistTurn()
              if (i.steeringLeaseId && typeof s.acknowledgeSteering === 'function') {
                await s.acknowledgeSteering(i.steeringLeaseId)
              }
              return { kind: 'continue' }
            }
            if (s.forcedArtifactRequestPending()) {
              // The provider ignored an explicit required generator request. It
              // still consumes one of the four bounded generation attempts, but
              // there is no concrete tool error to diagnose, so retry the forced
              // request directly instead of spending a discovery round.
              s.forcedArtifactAttemptPending = false
              s.artifactDeliveryRetries += 1
              if (s.artifactDeliveryRetries >= MAX_ARTIFACT_DELIVERY_RETRIES) {
                const incomplete = await s.finishIncomplete({
                  ...s.missingArtifactBlocker(),
                  steeringLeaseId: i.steeringLeaseId,
                })
                if (incomplete.deferredForSteering) return { kind: 'continue' }
                return { kind: 'return', value: incomplete }
              }
              if (i.content) s.convo.push({ role: 'assistant', content: i.content })
              s.appendForcedArtifactPrompt(s.forcedArtifactToolName)
              s.scheduleForcedArtifactAttempt(s.forcedArtifactToolName)
              await s.persistTurn()
              if (i.steeringLeaseId && typeof s.acknowledgeSteering === 'function') {
                await s.acknowledgeSteering(i.steeringLeaseId)
              }
              return { kind: 'continue' }
            }
            if (s.artifactDeliveryRetries >= MAX_ARTIFACT_DELIVERY_RETRIES) {
              const incomplete = await s.finishIncomplete({
                ...s.missingArtifactBlocker(),
                steeringLeaseId: i.steeringLeaseId,
              })
              if (incomplete.deferredForSteering) return { kind: 'continue' }
              return { kind: 'return', value: incomplete }
            }
            s.scheduleForcedArtifactAttempt(missing[0] || '')
            if (i.content) s.convo.push({ role: 'assistant', content: i.content })
            s.convo.push({
              role: 'system',
              content: [
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
            await s.persistTurn()
            if (i.steeringLeaseId && typeof s.acknowledgeSteering === 'function') {
              await s.acknowledgeSteering(i.steeringLeaseId)
            }
            return { kind: 'continue' }
          }
          if (!s.hasRequiredExecutionEvidence()) {
            const canRetry = s.executionEvidenceRetries < MAX_EXECUTION_EVIDENCE_RETRIES
              && s.iter + 1 < s.maxIters
            if (!canRetry) {
              const incomplete = await s.finishIncomplete({
                text: '任务尚未完成：尚未取得符合本次修改目标的实际执行证据。可重试本任务，或切换到支持工具调用的模型。',
                reason: 'execution_evidence_missing',
                steeringLeaseId: i.steeringLeaseId,
              })
              if (incomplete.deferredForSteering) return { kind: 'continue' }
              return { kind: 'return', value: incomplete }
            }
            s.executionEvidenceRetries += 1
            if (i.content) s.convo.push({ role: 'assistant', content: i.content })
            s.convo.push({
              role: 'system',
              content: [
                EXECUTION_EVIDENCE_GUARD_MARKER,
                'The previous response did not establish execution evidence for the current modification target, so it was not accepted as completion.',
                'Continue until the requested target has concrete mutation evidence, or an inherited successful mutation has been strictly verified.',
                'If indispensable information is missing, call request_clarification instead of presenting instructions as a completed result.',
              ].join(' '),
            })
            await s.persistTurn()
            if (i.steeringLeaseId && typeof s.acknowledgeSteering === 'function') {
              await s.acknowledgeSteering(i.steeringLeaseId)
            }
            return { kind: 'continue' }
          }
          if (s.taskVerificationRepairExhausted?.()) {
            const incomplete = await s.finishIncomplete({
              text: s.taskVerificationRepairBlockerText(),
              reason: 'task_verification_repair_exhausted',
              code: 'TASK_VERIFICATION_REPAIR_EXHAUSTED',
              missingRequirements: [
                'verification_failure_repair',
                'conclusive_project_verification',
                'explicit_recovery_retry',
              ],
              retryable: false,
              manualRetryable: true,
              taskVerification: s.taskVerificationRepairDetails?.(),
              steeringLeaseId: i.steeringLeaseId,
            })
            if (incomplete.deferredForSteering) return { kind: 'continue' }
            return { kind: 'return', value: incomplete }
          }
          if (s.hasPendingTaskVerificationRepair?.()) {
            const canRetry = s.mutationVerificationRetries < MAX_MUTATION_VERIFICATION_RETRIES
              && s.iter + 1 < s.maxIters
              && s.availableVerificationToolNames.length > 0
            if (!canRetry) {
              const incomplete = await s.finishIncomplete({
                text: s.taskVerificationRepairBlockerText(),
                reason: 'task_verification_repair_pending',
                code: 'TASK_VERIFICATION_REPAIR_PENDING',
                missingRequirements: [
                  'conclusive_project_verification',
                  'rerun_verification_scope',
                ],
                retryable: true,
                taskVerification: s.taskVerificationRepairDetails?.(),
                steeringLeaseId: i.steeringLeaseId,
              })
              if (incomplete.deferredForSteering) return { kind: 'continue' }
              return { kind: 'return', value: incomplete }
            }
            s.mutationVerificationRetries += 1
            if (i.content) s.convo.push({ role: 'assistant', content: i.content })
            s.convo.push({
              role: 'system',
              content: s.taskVerificationRepairPrompt(),
            })
            await s.persistTurn()
            if (i.steeringLeaseId && typeof s.acknowledgeSteering === 'function') {
              await s.acknowledgeSteering(i.steeringLeaseId)
            }
            return { kind: 'continue' }
          }
          if (s.hasPendingMutationVerification()) {
            const canRetry = s.mutationVerificationRetries < MAX_MUTATION_VERIFICATION_RETRIES
              && s.iter + 1 < s.maxIters
              && s.availableVerificationToolNames.length > 0
            if (!canRetry) {
              const incomplete = await s.finishIncomplete({
                text: s.availableVerificationToolNames.length > 0
                  ? '修改已经执行，但尚未通过读回、差异检查或项目检查验证，因此没有标记为完成。请重试以继续验证。'
                  : '修改已经执行，但当前没有启用可用于读回、差异检查或项目检查的工具，因此无法确认完成。',
                reason: 'post_mutation_verification_missing',
                steeringLeaseId: i.steeringLeaseId,
              })
              if (incomplete.deferredForSteering) return { kind: 'continue' }
              return { kind: 'return', value: incomplete }
            }
            s.mutationVerificationRetries += 1
            if (i.content) s.convo.push({ role: 'assistant', content: i.content })
            s.convo.push({
              role: 'system',
              content: [
                POST_MUTATION_VERIFICATION_GUARD_MARKER,
                'A local mutation succeeded, but no later verification has succeeded, so the completion claim was discarded.',
                `Pending changed targets: ${[...s.pendingMutationTargets].join(', ')}.`,
                `Pending deleted targets: ${[...s.pendingDeletionTargets].join(', ')}.`,
                s.taskVerificationRepairPrompt?.() || '',
                `Verify the changed state now with one of these available tools: ${s.availableVerificationToolNames.join(', ')}.`,
                'Read back each matching changed file, inspect the project diff, or run the relevant project check before answering. For deleted targets, list the complete parent directory so absence can be verified. Reading an unrelated file does not verify these targets.',
              ].join(' '),
            })
            await s.persistTurn()
            if (i.steeringLeaseId && typeof s.acknowledgeSteering === 'function') {
              await s.acknowledgeSteering(i.steeringLeaseId)
            }
            return { kind: 'continue' }
          }
          const localHtmlDeliveryFailure = await s.validateLocalHtmlDeliveries()
          if (localHtmlDeliveryFailure) {
            const recoveryResult = await s.handleLocalHtmlDeliveryFailure({
              failure: localHtmlDeliveryFailure,
              content: i.content,
              steeringLeaseId: i.steeringLeaseId,
            })
            if (recoveryResult.result) {
              if (recoveryResult.result.deferredForSteering) return { kind: 'continue' }
              return { kind: 'return', value: recoveryResult.result }
            }
            return { kind: 'continue' }
          }
          s.localHtmlDeliveryRetries = 0
          if (s.requiresPdfLayoutVerification && !s.pdfLayoutVerificationObserved) {
            const canRetry = s.pdfLayoutVerificationRetries < MAX_PDF_LAYOUT_VERIFICATION_RETRIES
              && s.iter + 1 < s.maxIters
              && hasCommandExecutionTool(s.activeToolSpecs)
            if (!canRetry) {
              const incomplete = await s.finishIncomplete({
                text: '\u6587\u4ef6\u5df2\u751f\u6210\uff0c\u4f46\u5c1a\u672a\u901a\u8fc7\u76ee\u6807\u9875\u3001\u975e\u76ee\u6807\u9875\u3001\u6587\u672c\u8fb9\u754c\u4e0e\u9010\u9875\u6e32\u67d3\u7684 PDF \u5e03\u5c40\u6821\u9a8c\uff0c\u56e0\u6b64\u6ca1\u6709\u6807\u8bb0\u4e3a\u5b8c\u6210\u3002',
                reason: 'pdf_layout_verification_missing',
                steeringLeaseId: i.steeringLeaseId,
              })
              if (incomplete.deferredForSteering) return { kind: 'continue' }
              return { kind: 'return', value: incomplete }
            }
            s.pdfLayoutVerificationRetries += 1
            if (i.content) s.convo.push({ role: 'assistant', content: i.content })
            s.convo.push({
              role: 'system',
              content: [
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
            await s.persistTurn()
            if (i.steeringLeaseId && typeof s.acknowledgeSteering === 'function') {
              await s.acknowledgeSteering(i.steeringLeaseId)
            }
            return { kind: 'continue' }
          }
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
                const incomplete = await s.finishIncomplete({
                  text: 'Files were created, but final deliverable selection did not converge. No unverified or intermediate files were attached to the answer.',
                  reason: 'deliverable_selection_missing',
                  steeringLeaseId: i.steeringLeaseId,
                })
                if (incomplete.deferredForSteering) return { kind: 'continue' }
                return { kind: 'return', value: incomplete }
              }
            }
            if (s.needsDeliverableSelection()) {
              s.deliverableSelectionRetries += 1
              if (i.content) s.convo.push({ role: 'assistant', content: i.content })
              s.convo.push({
                role: 'system',
                content: [
                  DELIVERABLE_SELECTION_GUARD_MARKER,
                  'The previous completion was discarded because this chat turn created files without explicitly selecting its final deliverables.',
                  `Current artifact IDs: ${s.artifactIds.join(', ')}.`,
                  'Call set_deliverables now with only the artifact_ids that should appear in the final answer. Use an empty array only when no file should be delivered.',
                  'If any later tool creates another artifact, call set_deliverables again after that tool finishes.',
                ].join(' '),
              })
              if (s.iter + 1 >= s.maxIters) s.maxIters = s.iter + 2
              await s.persistTurn()
              if (i.steeringLeaseId && typeof s.acknowledgeSteering === 'function') {
                await s.acknowledgeSteering(i.steeringLeaseId)
              }
              return { kind: 'continue' }
            }
          }
          if (s.requiresFinalAnswerEvidenceReview()
            && !s.hasCurrentFinalAnswerEvidenceReview(i.finalAnswerEvidenceReviewDigest)) {
            if (!s.prepareFinalAnswerEvidenceReview()) {
              const incomplete = await s.finishIncomplete({
                text: '',
                reason: 'final_answer_evidence_review_missing',
                steeringLeaseId: i.steeringLeaseId,
              })
              if (incomplete.deferredForSteering) return { kind: 'continue' }
              return { kind: 'return', value: incomplete }
            }
            if (s.iter + 1 >= s.maxIters) s.maxIters = s.iter + 2
            await s.persistTurn({ boundary: 'final-answer-evidence-review' })
            if (i.steeringLeaseId && typeof s.acknowledgeSteering === 'function') {
              await s.acknowledgeSteering(i.steeringLeaseId)
            }
            return { kind: 'continue' }
          }
          const sourceViolation = s.requiresSourceHandoffProtection
            ? sourceHandoffViolation(i.content)
            : null
          let acceptedContent = String(i.content || '')
          if (sourceViolation) {
            if (s.sourceHandoffRetries < MAX_SOURCE_HANDOFF_RETRIES) {
              s.sourceHandoffRetries += 1
              s.convo.push({
                role: 'system',
                content: [
                  SOURCE_HANDOFF_GUARD_MARKER,
                  `The previous final response was withheld because it contained ${sourceViolation}.`,
                  'Return one concise prose-only summary of what was actually executed, changed, and verified.',
                  'Do not include fenced blocks, source code, commands for the user to run, or instructions to copy, save, rename, or convert files manually.',
                ].join(' '),
              })
              if (s.iter + 1 >= s.maxIters) s.maxIters = s.iter + 2
              await s.persistTurn()
              if (i.steeringLeaseId && typeof s.acknowledgeSteering === 'function') {
                await s.acknowledgeSteering(i.steeringLeaseId)
              }
              return { kind: 'continue' }
            }
            acceptedContent = s.protectTerminalText(i.content)
            i.responseTextPublished = false
          }
          acceptedContent = s.guardPriorOutcomeStatusText(acceptedContent)
          if (!i.responseTextPublished && acceptedContent && typeof s.onModelDelta === 'function') {
            await s.onModelDelta({
              text: acceptedContent,
              iteration: s.iter,
              modelName: i.modelResult?.modelName || null,
            })
          }
          const completion = await s.steeringController.prepareCompletion({
            text: acceptedContent,
            leaseId: i.steeringLeaseId,
          })
          if (!completion.closed) return { kind: 'continue' }
          s.finalText = acceptedContent
          if (!completion.prepared) s.convo.push({ role: 'assistant', content: s.finalText })
          try {
            const hasFinalText = Boolean(s.finalText.trim())
            await s.persistTurn(hasFinalText ? { final: { text: s.finalText, iterations: s.iter + 1 } } : {})
            s.finalCheckpointPersisted = hasFinalText
            if (!completion.prepared) await s.steeringController.acknowledge(i.steeringLeaseId)
          } catch (error) {
            await s.steeringController.release(i.steeringLeaseId)
            throw error
          }
          return { kind: 'break' }
        }
  i.scopedToolCalls = scopeTextToolCallIds(i.rawToolCalls, {
          turnId: s.job?.id || s.step?.id,
          iteration: s.iter,
        })
  i.modelOutputInspection = inspectToolLoopModelResponse(i.modelResult)
  i.modelOutputTruncated = i.modelOutputInspection.truncated
  const normalizedCheckpointCalls = normalizeToolCalls(i.scopedToolCalls, {
          toolSpecs: s.activeToolSpecs,
        }).map(s.normalizeArtifactReplacementCall)
  // A provider can claim a normal tool-call finish while returning JSON that
  // only becomes parseable after the harness appends missing structural
  // closers. That repair is useful for diagnostics, but it is also direct
  // evidence that the argument batch was incomplete. Fail the complete batch
  // closed so an earlier, complete-looking sibling call cannot run either.
  if (!i.modelOutputTruncated && normalizedCheckpointCalls.some((call) => (
    call.argumentRepair?.kind === 'closed_truncated_json'
  ))) {
    i.modelOutputInspection = Object.freeze({
      truncated: true,
      reason: 'incomplete_tool_arguments',
      finishReason: 'truncated',
    })
    i.modelOutputTruncated = true
  }
  s.checkpointCalls = normalizedCheckpointCalls.map((call) => ({
          ...call,
          dynamicToolRegistrationId: i.dynamicToolRegistrations?.[call.name] || null,
          modelOutputTruncated: i.modelOutputTruncated,
          modelOutputTruncationReason: i.modelOutputInspection.reason,
          idempotencyKey: buildJobToolIdempotencyKey({
            jobId: s.job?.id,
            stepId: s.step?.id,
            toolCallId: call.id,
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
          // The model response and steering text become durable atomically from
          // the engine's perspective; only then may the steering lease be ACKed.
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
