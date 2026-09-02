import { normalizeOptionalUsageNumber } from '../../../shared/modelUsage.js'
import { localizedTerminalModelText } from './incompleteTerminalPresentation.js'

function modelPhaseUsage(result) {
  const usage = result?.usage
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return usage || null
  const tokenUsage = { ...usage }
  delete tokenUsage.costUsd
  const costUsd = normalizeOptionalUsageNumber(result?.costUsd)
  return costUsd === null ? tokenUsage : { ...tokenUsage, costUsd }
}

export async function runModelRequest(s) {
  const i = s.iteration
  const { DIRECTORY_REVIEW_GUARD_MARKER, budgetExceededCopy, extractTextToolCalls, filterCurrentDynamicToolSpecs, formatIncompleteTerminalText, getToolMetadata, mergeCompactionRecovery, snapshotDynamicToolSpecRegistrations, sourceHandoffViolation, toolNameFromSpec } = s.d
  {
          const claimed = await s.steeringController.claimFresh(s.appliedSteeringIds)
          if (claimed.messages.length > 0) {
            i.steeringLeaseId = claimed.leaseId
            s.appendSteeringMessages(claimed.messages)
          }
        }
  i.modelResult = undefined
  i.responseTextPublished = false
  i.finalAnswerEvidenceReviewDigest = s.hasCurrentFinalAnswerEvidenceReview()
    ? s.currentFinalAnswerEvidenceDigest()
    : null
  const hasCurrentAnswerReview = () => !s.requiresFinalAnswerEvidenceReview()
    || s.hasCurrentFinalAnswerEvidenceReview(i.finalAnswerEvidenceReviewDigest)
  // An active loop may outlive a runtime plugin. Never show a stale schema on
  // a later model round after its executor was revoked or replaced.
  s.activeToolSpecs = filterCurrentDynamicToolSpecs(s.activeToolSpecs, {
    userId: s.job?.userId || null,
  })
  const modelMayRequestMutation = s.activeToolSpecs.some((spec) => {
    const name = toolNameFromSpec(spec)
    if (!name) return false
    if (name === 'set_deliverables') return false
    try {
      return getToolMetadata(name, { userId: s.job?.userId || null }).isReadOnly !== true
    } catch {
      // Unknown/dynamic schemas are external-risk by default. Buffer their
      // text until the complete response proves that no tool call will run.
      return true
    }
  })
  // Capture before the provider call starts. Runtime plugins can be replaced
  // while the model is thinking; any returned call stays bound to the schema
  // (and therefore implementation) that the model actually saw.
  i.dynamicToolRegistrations = snapshotDynamicToolSpecRegistrations(s.activeToolSpecs)
  try {
          let streamedText = false
          const request = await s.callTrackedModel({
            messages: s.convo,
            tools: s.activeToolSpecs,
            ...(s.needsDeliverableSelection()
              ? {
                  toolChoice: {
                    type: 'function',
                    function: { name: 'set_deliverables' },
                  },
                }
              : s.forcedArtifactRequestPending()
              ? {
                  toolChoice: {
                    type: 'function',
                    function: { name: s.forcedArtifactToolName },
                  },
                }
              : {}),
            consumeBudget: (cost) => s.budget.consume(cost),
            onTextDelta: async (text, metadata = {}) => {
              if (!text) return
              // Execution responses are buffered until the complete candidate is
              // available for source-handoff validation. Model/tool phase events
              // remain live, and safe narration is published before tools run.
              if (s.requiresSourceHandoffProtection) return
              if (!s.hasRequiredArtifacts() && !s.codeSnippetRequested) return
              // A first execution round can stream a completion claim before
              // the provider reveals toolCalls at the end of the same response.
              // Keep that text private until concrete execution evidence exists;
              // otherwise a later write followed by an incomplete terminal would
              // leave the earlier "completed" claim visible in the transcript.
              // Pure chat remains live because it does not require execution
              // evidence.
              if (s.requiresExecutionEvidence && !s.hasRequiredExecutionEvidence()) return
              if (modelMayRequestMutation) return
              // A completion claim produced before the host evidence review is
              // not authoritative. Keep it private until processModelResult has
              // either scheduled the review round or accepted a digest-bound
              // answer, otherwise a later incomplete result can coexist in the
              // UI with an earlier streamed "completed" fragment.
              if (!hasCurrentAnswerReview()) return
              streamedText = true
              i.responseTextPublished = true
              if (typeof s.onModelDelta === 'function') {
                await s.onModelDelta({ text, iteration: s.iter, modelName: metadata.modelName || null })
              }
            },
            onReasoningDelta: async (text, metadata = {}) => {
              if (!text || typeof s.onReasoningDelta !== 'function') return
              await s.onReasoningDelta({ text, iteration: s.iter, modelName: metadata.modelName || null })
            },
          })
          s.convo.splice(0, s.convo.length, ...request.messages)
          s.recovery = mergeCompactionRecovery(s.recovery, request.recovery)
          i.modelResult = request.response
          if (!Array.isArray(i.modelResult?.toolCalls) || i.modelResult.toolCalls.length === 0) {
            const compatibilityCall = extractTextToolCalls(i.modelResult?.content)
            if (compatibilityCall.detected) {
              i.modelResult = {
                ...i.modelResult,
                content: compatibilityCall.content,
                toolCalls: compatibilityCall.toolCalls,
              }
            }
          }
          const returnedToolCalls = Array.isArray(i.modelResult?.toolCalls) ? i.modelResult.toolCalls : []
          if (s.requiresRepresentativeRead
            && !s.hasSuccessfulRepresentativeRead
            && !s.representativeReadsInjected
            && returnedToolCalls.length === 0
            && s.iter + 1 < s.maxIters) {
            s.representativeReadsInjected = true
            s.convo.push({
              role: 'system',
              content: [
                DIRECTORY_REVIEW_GUARD_MARKER,
                'The previous answer tried to finish from a directory listing alone, so it was discarded.',
                'The runtime is now reading representative documentation, configuration, and entrypoint files through the authorized read_file tool.',
                'Base the next answer on the returned file contents and report any concrete read errors truthfully.',
              ].join(' '),
            })
            i.modelResult = { ...i.modelResult, content: '', toolCalls: s.representativeReadCalls }
          }
          if (typeof s.onModelPhase === 'function') await s.onModelPhase({
            phase: 'completed',
            iteration: s.iter,
            content: returnedToolCalls.length > 0
              || !hasCurrentAnswerReview()
              || (s.requiresSourceHandoffProtection && sourceHandoffViolation(i.modelResult?.content))
              ? ''
              : i.modelResult?.content || '',
            toolCalls: i.modelResult?.toolCalls || [],
            usage: modelPhaseUsage(i.modelResult),
            modelName: i.modelResult?.modelName || null,
          })
          const bufferedTextIsSafe = !s.requiresSourceHandoffProtection
            || !sourceHandoffViolation(i.modelResult?.content)
          const protectedTextHasEvidence = s.requiresPersistedArtifact
            ? s.hasRequiredArtifacts()
            : s.hasRequiredExecutionEvidence()
          if (!streamedText
            && i.modelResult?.content
            && returnedToolCalls.length === 0
            && bufferedTextIsSafe
            && (s.requiresSourceHandoffProtection ? protectedTextHasEvidence : s.hasRequiredArtifacts())
            && (!s.requiresExecutionEvidence || s.hasRequiredExecutionEvidence())
            && hasCurrentAnswerReview()
            && typeof s.onModelDelta === 'function') {
            await s.onModelDelta({
              text: i.modelResult.content,
              iteration: s.iter,
              modelName: i.modelResult?.modelName || null,
            })
            i.responseTextPublished = true
          }
        } catch (error) {
          let recoverableModelResult = error?.partialModelResult
          if (recoverableModelResult
            && (!Array.isArray(recoverableModelResult.toolCalls) || recoverableModelResult.toolCalls.length === 0)) {
            const compatibilityCall = extractTextToolCalls(recoverableModelResult.content)
            if (compatibilityCall.detected) {
              recoverableModelResult = {
                ...recoverableModelResult,
                content: compatibilityCall.content,
                toolCalls: compatibilityCall.toolCalls,
              }
            }
          }
          const recoverableToolCalls = Array.isArray(recoverableModelResult?.toolCalls)
            ? recoverableModelResult.toolCalls
            : []
          if (error?.code === 'MODEL_BUDGET_EXCEEDED' && recoverableToolCalls.length > 0) {
            // The provider request and its cost have already happened. Discarding
            // an actionable tool call here wastes that work and can stop one step
            // before the requested artifact is produced. Execute this final
            // response; the exhausted budget will still reject the next model
            // request before it reaches the provider.
            i.modelResult = recoverableModelResult
            s.modelBudgetExceededAfterResponse = error?.message || 'model budget exceeded'
            if (typeof s.onModelPhase === 'function') await s.onModelPhase({
              phase: 'completed',
              iteration: s.iter,
              content: recoverableToolCalls.length > 0
                || !hasCurrentAnswerReview()
                || (s.requiresSourceHandoffProtection && sourceHandoffViolation(i.modelResult?.content))
                ? ''
                : i.modelResult?.content || '',
              toolCalls: i.modelResult?.toolCalls || [],
              usage: modelPhaseUsage(i.modelResult),
              modelName: i.modelResult?.modelName || null,
              budgetExceeded: true,
              budgetReason: error?.message || String(error),
            })
          } else {
            if (typeof s.onModelPhase === 'function') await s.onModelPhase({
              phase: 'failed', iteration: s.iter, error: error?.message || String(error),
            })
          // ★ 模型报错不再无条件炸掉整个 step。
          //
          // 原来这里直接 throw,一路冒到 runOneTick 把 job 标 failed,
          // **这一步已经收集到的所有工具结果全部丢弃**,checkpoint 也被删掉。
          // 于是 LM Studio 在第 30 轮打了个嗝,前 29 轮的活白干。
          //
          // subagentRuntime.js 早就做对了(见那里的降级注释),job 循环一直没跟上。
          // 现在对齐:已经跑过至少一轮 + 不是用户主动取消 → 降级成部分结果,
          // 把中断原因和已查到的东西交给用户,而不是一个空的 failed。
          if (error?.code === 'MODEL_BUDGET_EXCEEDED') {
            const budgetCopy = budgetExceededCopy(s.locale, error.message)
            let wrapUpText = ''
            try {
              const wrapUpRequest = await s.callTrackedModel({
                messages: [
                  ...s.convo,
                  {
                    role: 'system',
                    content: budgetCopy.wrapUpPrompt,
                  },
                ],
                tools: [],
                allowOverBudget: true,
                toolChoice: 'none',
              })
              s.recovery = mergeCompactionRecovery(s.recovery, wrapUpRequest.recovery)
              wrapUpText = localizedTerminalModelText(
                s.locale,
                wrapUpRequest.response?.content,
                { strictLocale: true },
              )
            } catch (wrapUpError) {
              if (wrapUpError?.name === 'AbortError') throw wrapUpError
            }
            const terminal = await s.finishTerminalResult({
              text: !s.hasRequiredArtifacts()
                ? ''
                : wrapUpText || budgetCopy.fallbackText,
              ...(wrapUpText ? { partialText: wrapUpText } : {}),
              artifactIds: s.artifactIds,
              iterations: s.iter + 1,
              incomplete: true,
              budgetExceeded: true,
              reason: error.message,
              recovery: s.recovery,
            }, { steeringLeaseId: i.steeringLeaseId, finalMetadata: { budgetExceeded: true } })
            if (!terminal) return { kind: 'continue' }
            return { kind: 'return', value: terminal }
          }
          if (error?.code === 'REASONING_RUNAWAY') {
            if (i.steeringLeaseId) {
              if (typeof s.releaseSteering === 'function') await s.releaseSteering(i.steeringLeaseId)
            }
            const terminal = await s.finishTerminalResult({
              text: formatIncompleteTerminalText('reasoning_runaway', { locale: s.locale }),
              artifactIds: s.artifactIds,
              iterations: s.iter + 1,
              incomplete: true,
              code: 'REASONING_RUNAWAY',
              reason: error?.message || 'reasoning exceeded the safe limit',
              recovery: s.recovery,
            }, {
              finalMetadata: {
                code: 'REASONING_RUNAWAY',
                reasoningRunaway: true,
              },
            })
            if (!terminal) return { kind: 'continue' }
            return { kind: 'return', value: terminal }
          }
          if (i.steeringLeaseId) {
            if (typeof s.releaseSteering === 'function') await s.releaseSteering(i.steeringLeaseId)
            i.steeringLeaseId = null
          }
          if (error?.name === 'AbortError' || s.iter === 0) throw error

          const terminal = await s.finishTerminalResult(s.partialResultFallback.apply({
            text: !s.hasRequiredArtifacts()
              ? ''
              : '',
            artifactIds: s.artifactIds,
            iterations: s.iter + 1,
            interrupted: true,
            code: error?.code || 'MODEL_CALL_INTERRUPTED',
            reason: error?.message || String(error),
            recovery: s.recovery,
          }), {
            steeringLeaseId: i.steeringLeaseId,
            appendTextToConversation: false,
            finalMetadata: {
              interrupted: true,
              code: error?.code || 'MODEL_CALL_INTERRUPTED',
            },
          })
          if (!terminal) return { kind: 'continue' }
            return { kind: 'return', value: terminal }
          }
        }
  return { kind: 'next' }
}
