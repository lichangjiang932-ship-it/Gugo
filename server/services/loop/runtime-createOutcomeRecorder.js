import { assertRuntimeStage } from './runtimeContract.js'

export async function createOutcomeRecorder(s) {
  assertRuntimeStage(s, 'create-outcome-recorder')
  const i = s.iteration
  const { AVAILABLE_TOOL_CAPABILITIES_MARKER, COMMAND_EXECUTION_TOOL_NAMES, DYNAMIC_EXECUTION_TOOL_RECOVERY_MARKER, DYNAMIC_MUTATION_TOOL_NAMES, PATCH_WRITE_TOOL_NAMES, PROJECT_SCOPE_TARGET, SCHEDULED_WAIT_INTENT, VERIFICATION_TOOLS, appendFinalAnswerToolEvidence, buildToolResultMessageBundle, clearArtifactValidatedMutationTargets, clearVerifiedDeletionTargets, clearVerifiedMutationTargets, extractMutationTargets, hasCommandExecutionTool, installAttemptSignature, isCommandExecutionTool, isExplorationOnlyCall, isFileArtifactTool, isLocalMutationCall, isMutationExecutionCall, isProductiveExecutionOutcome, isSubstantiveToolCall, isSuccessfulPdfLayoutVerification, isSuccessfulToolResult, isVerificationCall, looksLikeDeletionCommand, normalizeArtifactIdList, normalizeMutationTarget, normalizeToolResult, persistLocalToolArtifactsAsync, progressChangesFor, recordToolProgress, replaceRuntimeCapabilityBlock, shouldRequirePdfLayoutVerification, staticDeletionTargets, targetsMatch, toolNameFromSpec } = s.d
  i.recordOutcome = async (outcome) => {
        outcome.result = normalizeToolResult(outcome.result)
        const succeeded = isSuccessfulToolResult(outcome.result)
        const executedCall = outcome.executionArgs === outcome.call?.args
          ? outcome.call
          : { ...outcome.call, args: outcome.executionArgs }
        const hasDeclaredVerifiedCommandOutput = isCommandExecutionTool(executedCall?.name)
          && Array.isArray(outcome.result?.verifiedOutputs)
          && outcome.result.verifiedOutputs.some((output) => (
            output?.type === 'file' && Boolean(String(output?.declaredPath || '').trim())
          ))
        if (succeeded
          && !outcome.artifactId
          && (s.localArtifactPublicationAllowed
            || (s.requiresPersistedArtifact && hasDeclaredVerifiedCommandOutput))) {
          const localArtifacts = await persistLocalToolArtifactsAsync({
            call: executedCall,
            result: outcome.result,
            job: s.job,
            step: s.step,
            toolCallId: outcome.call?.id,
          })
          const publicationFailures = Array.isArray(localArtifacts.publicationFailures)
            ? localArtifacts.publicationFailures
            : []
          const artifactValidationReceipts = Array.isArray(localArtifacts.verificationReceipts)
            ? localArtifacts.verificationReceipts
            : []
          outcome.artifactValidationReceipts = artifactValidationReceipts
          if (localArtifacts.length > 0) {
            outcome.artifactId = localArtifacts[0].id
            outcome.artifactIds = localArtifacts.map((artifact) => artifact.id)
            outcome.artifacts = localArtifacts.map(({ id, filename, type, url }) => ({ id, filename, type, url }))
            outcome.result = {
              ...outcome.result,
              artifactId: localArtifacts[0].id,
              filename: localArtifacts[0].filename,
              url: localArtifacts[0].url,
              artifacts: outcome.artifacts,
              ...(artifactValidationReceipts.length > 0 ? {
                artifactValidation: {
                  ok: true,
                  receipts: artifactValidationReceipts,
                },
              } : {}),
            }
          }
          if (publicationFailures.length > 0) {
            const validationOnly = publicationFailures.every(
              (failure) => failure.code === 'artifact_validation_failed',
            )
            outcome.result = {
              ...outcome.result,
              artifactPublication: {
                ok: false,
                code: validationOnly ? 'artifact_validation_failed' : 'artifact_publication_failed',
                status: localArtifacts.length > 0 ? 'partial' : 'failed',
                retryable: publicationFailures.some((failure) => failure.retryable === true),
                message: validationOnly
                  ? 'The local output was created, but its binary structure is invalid.'
                  : localArtifacts.length > 0
                    ? 'Some local outputs could not be added to the managed artifact store.'
                    : 'The local output was created, but no downloadable artifact could be published.',
                guidance: validationOnly
                  ? 'Regenerate the exact invalid output with a new producing tool call before delivery.'
                  : 'Do not rerun the source tool automatically; verify its real side effects first.',
                failures: publicationFailures,
              },
            }
          }
        }
        s.partialResultFallback.record(executedCall, outcome.result)
        const progressChanges = progressChangesFor(executedCall, outcome.result)
        const semanticControlCall = executedCall?.name === 'set_deliverables'
        const installSignature = installAttemptSignature(executedCall)
        if (installSignature) s.rememberInstallAttempt(installSignature)
        const productiveExecution = !semanticControlCall && s.executionConvergenceEnabled
          && isProductiveExecutionOutcome(executedCall, outcome.result, outcome.artifactId)
        if (productiveExecution) {
          i.convergenceBatch.productiveSuccess = true
          // Keep the current signature as the new progress baseline. Clearing it
          // entirely would let a model repeat the same successful write forever.
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
        if (!succeeded
          && DYNAMIC_MUTATION_TOOL_NAMES.has(String(executedCall?.name || ''))
          && outcome.result?.denied !== true
          && outcome.result?.requiresUserVerification !== true
          && !['tool_budget_exceeded', 'approval_denied'].includes(String(outcome.result?.code || ''))) {
          const recoverySignature = [
            executedCall.name,
            String(outcome.result?.code || outcome.result?.error || 'failed').slice(0, 240),
          ].join(':')
          if (!s.dynamicExecutionRecoverySignatures.has(recoverySignature)) {
            s.dynamicExecutionRecoverySignatures.add(recoverySignature)
            const alternatives = [...DYNAMIC_MUTATION_TOOL_NAMES]
              .filter((toolName) => toolName !== executedCall.name
                && s.activeToolSpecs.some((spec) => toolNameFromSpec(spec) === toolName))
            i.deferredPostBatchMessages.push({
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
        }
        const scheduledWaitEvidence = executedCall?.name === 'sleep_until'
          && outcome.result?.paused === true
          && outcome.result?.clarification?.blocker_kind === 'scheduled_wake'
          && Number.isFinite(Number(outcome.result?.clarification?.wakeAt))
          && SCHEDULED_WAIT_INTENT.test(s.executionIntentText)
        if (!semanticControlCall && succeeded && (isSubstantiveToolCall(executedCall) || scheduledWaitEvidence)) {
          s.executionEvidenceObserved = true
        }
        const mutationExecutionSucceeded = semanticControlCall
          ? false
          : s.executionConvergenceEnabled
          ? productiveExecution
          : succeeded && isMutationExecutionCall(executedCall, outcome.artifactId)
        if (succeeded
          && s.patchOnlyWorkspaceIntent
          && PATCH_WRITE_TOOL_NAMES.has(String(executedCall?.name || ''))) {
          const writeTargets = extractMutationTargets(executedCall, outcome.result)
          const matchedExpectedPath = s.exactWorkspaceTargetPaths.some((expectedPath) => (
            [...writeTargets].some((target) => targetsMatch(target, expectedPath))
          ))
          if (matchedExpectedPath) {
            s.successfulExpectedPathWriteObserved = true
            s.requiresPersistedArtifact = false
            s.expectedArtifactTools.clear()
            s.artifactDeliveryRetries = 0
            s.clearArtifactRecovery()
          }
        }
        if (mutationExecutionSucceeded) {
          s.mutationExecutionObserved = true
          s.priorOutcomeMutationObserved = true
          s.mutationSteeringPending = false
        }
        if (mutationExecutionSucceeded && isLocalMutationCall(executedCall)) {
          if (s.requiresPdfLayoutVerification) s.pdfLayoutVerificationObserved = false
          const currentMutationTargets = extractMutationTargets(executedCall, outcome.result)
          const taskVerificationMutation = s.observeTaskVerificationMutation(
            currentMutationTargets,
          )
          if (taskVerificationMutation.changed) {
            i.deferredPostBatchMessages.push({
              role: 'system',
              content: s.taskVerificationRepairPrompt(),
            })
          }
          const deletionTargets = looksLikeDeletionCommand(executedCall?.args?.command)
            ? staticDeletionTargets(executedCall, outcome.result)
            : null
          if (deletionTargets?.size) {
            for (const deletionTarget of deletionTargets) {
              const auxiliaryTarget = [...s.auxiliaryMutationTargets]
                .find((pending) => targetsMatch(pending, deletionTarget))
              if (auxiliaryTarget) {
                s.auxiliaryMutationTargets.delete(auxiliaryTarget)
                continue
              }
              for (const pending of [...s.pendingMutationTargets]) {
                if (pending !== PROJECT_SCOPE_TARGET && targetsMatch(pending, deletionTarget)) {
                  s.pendingMutationTargets.delete(pending)
                }
              }
              s.pendingDeletionTargets.add(deletionTarget)
              for (const htmlTarget of [...s.localHtmlDeliveryTargets]) {
                if (targetsMatch(htmlTarget, deletionTarget)) {
                  s.localHtmlDeliveryTargets.delete(htmlTarget)
                  s.localHtmlReadSources.delete(htmlTarget)
                }
              }
            }
          } else {
            for (const target of currentMutationTargets) {
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
            const referencedHelperTargets = [...s.pendingMutationTargets].filter((pending) => (
              s.auxiliaryScriptTarget(pending) && s.commandReferencesTarget(executedCall, pending)
            ))
            for (const pending of [...currentMutationTargets, ...referencedHelperTargets]) {
              if (!s.auxiliaryScriptTarget(pending)) continue
              if (declaredOutputs.some((output) => targetsMatch(pending, output))) continue
              s.pendingMutationTargets.delete(pending)
              s.auxiliaryMutationTargets.add(pending)
            }
          }
          const artifactValidatedMutation = clearArtifactValidatedMutationTargets(
            s.pendingMutationTargets,
            outcome.artifactValidationReceipts,
            {
              userId: s.job?.userId,
              sessionId: s.job?.sessionId,
              turnId: s.job?.id,
              jobId: s.job?.id,
              stepId: s.step?.id,
            },
          )
          if (artifactValidatedMutation) {
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
                || s.outputDirectoryContext?.projectDirectory
                || '',
              projectDirectories: s.verificationProjectDirectories,
            },
          )
          const clearedDeletion = clearVerifiedDeletionTargets(
            s.pendingDeletionTargets,
            executedCall,
            outcome.result,
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
        const taskVerificationObservation = s.observeTaskVerificationRepair(
          executedCall,
          outcome.result,
        )
        if (taskVerificationObservation.changed && !taskVerificationObservation.failed) {
          s.loopGuard.markProgress?.()
          s.mutationVerificationRetries = 0
        }
        if (taskVerificationObservation.failed || taskVerificationObservation.indeterminate) {
          const repairPrompt = s.taskVerificationRepairPrompt()
          if (repairPrompt) {
          i.deferredPostBatchMessages.push({
            role: 'system',
              content: repairPrompt,
          })
          }
        }
        if (succeeded
          && executedCall?.name === 'read_file'
          && typeof outcome.result?.content === 'string'
          && outcome.result?.truncated !== true) {
          const evidenceTargets = [outcome.result?.path, executedCall?.args?.path]
            .map(normalizeMutationTarget)
            .filter(Boolean)
          for (const htmlTarget of s.localHtmlDeliveryTargets) {
            if (evidenceTargets.some((candidate) => targetsMatch(candidate, htmlTarget))) {
              s.localHtmlReadSources.set(htmlTarget, outcome.result.content)
            }
          }
        }
        if (s.requiresPdfLayoutVerification
          && isSuccessfulPdfLayoutVerification(executedCall, outcome.result)) {
          s.pdfLayoutVerificationObserved = true
          s.pdfLayoutVerificationRetries = 0
          // ★ 验证器会重新打开源文件与输出文件并逐页断言文本/边界/预览 PNG,
          // 这是比 read/diff 更强的验证证据。它打印 OK 即证明本轮产物完整 ——
          // 清空待验证目标,否则「验证明明通过」最后仍会误报
          // post_mutation_verification_missing,任务以一句矛盾的失败收尾。
          s.pendingMutationTargets.clear()
          s.pendingDeletionTargets.clear()
          s.mutationVerificationRetries = 0
        }
        const requiredArtifactDeliverySatisfied = !s.requiresLocalArtifactDelivery
          || outcome.result?.deliveryStatus !== 'managed_only'
        const artifactOutcomeVerified = succeeded
          && requiredArtifactDeliverySatisfied
          && isFileArtifactTool(outcome.call?.name)
        const validatedArtifactIds = new Set(
          (Array.isArray(outcome.artifactValidationReceipts)
            ? outcome.artifactValidationReceipts
            : [])
            .filter((receipt) => receipt?.verified === true)
            .map((receipt) => String(receipt.artifactId || '').trim())
            .filter(Boolean),
        )
        const artifactMetadataById = new Map(
          (Array.isArray(outcome.artifacts) ? outcome.artifacts : [])
            .map((artifact) => [String(artifact?.id || '').trim(), artifact])
            .filter(([artifactId]) => artifactId),
        )
        if (Array.isArray(outcome.artifactIds)) {
          for (const artifactId of outcome.artifactIds) {
            const receipt = (outcome.artifactValidationReceipts || [])
              .find((candidate) => candidate?.artifactId === artifactId)
            const artifactMetadata = artifactMetadataById.get(String(artifactId))
            s.recordArtifactIds([artifactId], {
              toolName: outcome.call?.name,
              verified: artifactOutcomeVerified || validatedArtifactIds.has(artifactId),
              artifactType: artifactMetadata?.type,
              validation: receipt || null,
            })
          }
        } else if (outcome.artifactId) {
          s.recordArtifactIds([outcome.artifactId], {
            toolName: outcome.call?.name,
            verified: artifactOutcomeVerified || validatedArtifactIds.has(outcome.artifactId),
            artifactType: artifactMetadataById.get(String(outcome.artifactId))?.type,
            validation: (outcome.artifactValidationReceipts || [])[0] || null,
          })
        }
        s.recomputeDeliveredArtifactTools()
        const verifiedArtifactIds = normalizeArtifactIdList(
          Array.isArray(outcome.artifactIds) && outcome.artifactIds.length > 0
            ? outcome.artifactIds
            : outcome.artifactId
              ? [outcome.artifactId]
              : [],
        )
        const verifiedContractTools = new Set()
        for (const artifactId of verifiedArtifactIds) {
          for (const toolName of s.artifactContractToolsForProvenance(
            s.artifactProvenance.get(artifactId),
          )) verifiedContractTools.add(toolName)
        }
        if (verifiedArtifactIds.length > 0
          && verifiedContractTools.size > 0) {
          // A forced generator remains mandatory across malformed calls, tool
          // errors, and provider responses that merely echo the requested call.
          // Release it only after that exact generator returns a verified,
          // deliverable artifact; the next round may then select deliverables.
          if (verifiedContractTools.has(s.forcedArtifactToolName)) s.clearArtifactRecovery()
        }
        if (executedCall?.name === 'read_file' && succeeded) {
          s.hasSuccessfulRepresentativeRead = true
        }
        const toolResultBundle = buildToolResultMessageBundle(
          outcome.call,
          outcome.result,
          { maxChars: i.toolResultMaxChars },
        )
        if (toolResultBundle.ephemeralMessages.length > 0 && outcome.result?.image?.data) {
          const compactImage = { ...outcome.result.image }
          delete compactImage.data
          outcome.result = { ...outcome.result, image: { ...compactImage, captured: true } }
        }
        s.finalAnswerToolEvidence = appendFinalAnswerToolEvidence(
          s.finalAnswerToolEvidence,
          executedCall,
          outcome.result,
        )
        s.convo.push(...toolResultBundle.durableMessages)
        i.deferredEphemeralToolMessages.push(...toolResultBundle.ephemeralMessages)
        if (executedCall?.name === 'request_directory'
          && succeeded
          && outcome.result?.already_authorized === true
          && outcome.result?.authorization?.resource_type === 'directory') {
          const accessMode = String(outcome.result.authorization.access_mode || '').trim()
          const requiredNames = new Set([
            'list_directory',
            'read_file',
            ...(accessMode === 'read_write'
              ? ['write_file', 'edit_file', ...COMMAND_EXECUTION_TOOL_NAMES]
              : []),
          ])
          const byName = new Map(s.activeToolSpecs.map((spec) => [toolNameFromSpec(spec), spec]))
          for (const spec of s.eligibleFallbackToolSpecs) {
            const name = toolNameFromSpec(spec)
            if (requiredNames.has(name) && !byName.has(name)) byName.set(name, spec)
          }
          const refreshedSpecs = [...byName.values()].filter(Boolean)
          if (refreshedSpecs.length > s.activeToolSpecs.length) {
            s.activeToolSpecs = refreshedSpecs
            s.convo = replaceRuntimeCapabilityBlock(s.convo, {
              toolSpecs: s.activeToolSpecs,
              approvalMode: s.approvalMode,
              ...s.outputDirectoryContext,
            })
            s.availableVerificationToolNames = s.activeToolSpecs
              .map(toolNameFromSpec)
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
        }
        const convergenceBlocked = [
          'execution_convergence_probe_blocked',
          'execution_convergence_install_blocked',
        ].includes(String(outcome.result?.code || ''))
        const progress = convergenceBlocked
          ? { ok: true }
          : s.loopGuard.after(outcome.result, outcome.call)
        const toolProgress = convergenceBlocked
          ? { ok: true }
          : s.loopGuard.afterCall?.(executedCall, outcome.result) || { ok: true }
        if (!i.noProgressReason) {
          const noProgressDecision = outcome.noProgressReason
            ? { reason: outcome.noProgressReason, result: outcome.result }
            : !toolProgress.ok
              ? toolProgress
              : !progress.ok
                ? progress
                : null
          i.noProgressReason = noProgressDecision?.reason || null
          if (i.noProgressReason) {
            const noProgressResult = noProgressDecision?.result || {}
            i.noProgressCode = noProgressResult.code || 'tool_no_progress'
            i.noProgressFailure = {
              code: i.noProgressCode,
              retryable: noProgressResult.retryable === true,
              ...(noProgressResult.hint ? { hint: String(noProgressResult.hint) } : {}),
            }
          }
        }
        if (!i.budgetExceeded && outcome.budgetExceeded) i.budgetExceeded = outcome.budgetExceeded
        if (!i.pausedByClarification && outcome.clarification) i.pausedByClarification = outcome.clarification
        await i.markCall(outcome.call, {
          checkpointStatus: 'completed',
          checkpointResult: outcome.result,
          checkpointArtifactId: outcome.artifactId || null,
        })
        if (typeof s.onToolCompleted === 'function') await s.onToolCompleted(outcome)
        await s.emitToolProgress('tool_completed')
      }
  return { kind: 'next' }
}
