import { normalizeOptionalUsageNumber } from '../../../shared/modelUsage.js'

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
  const { DIRECTORY_REVIEW_GUARD_MARKER, extractTextToolCalls, filterCurrentDynamicToolSpecs, mergeCompactionRecovery, snapshotDynamicToolSpecRegistrations, sourceHandoffViolation } = s.d
  {
          const claimed = await s.steeringController.claimFresh(s.appliedSteeringIds)
          if (claimed.messages.length > 0) {
            i.steeringLeaseId = claimed.leaseId
            s.appendSteeringMessages(claimed.messages)
          }
        }
  i.modelResult = undefined
  i.responseTextPublished = false
  // An active loop may outlive a runtime plugin. Never show a stale schema on
  // a later model round after its executor was revoked or replaced.
  s.activeToolSpecs = filterCurrentDynamicToolSpecs(s.activeToolSpecs, {
    userId: s.job?.userId || null,
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
            content: s.requiresSourceHandoffProtection && sourceHandoffViolation(i.modelResult?.content)
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
            && bufferedTextIsSafe
            && (s.requiresSourceHandoffProtection ? protectedTextHasEvidence : s.hasRequiredArtifacts())
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
              content: s.requiresSourceHandoffProtection && sourceHandoffViolation(i.modelResult?.content)
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
            let wrapUpText = ''
            try {
              const wrapUpRequest = await s.callTrackedModel({
                messages: [
                  ...s.convo,
                  {
                    role: 'system',
                    content: `模型预算已用尽(${error.message})。请基于目前已有的信息给出最终回答，不要再调用任何工具。`,
                  },
                ],
                tools: [],
                allowOverBudget: true,
                toolChoice: 'none',
              })
              s.recovery = mergeCompactionRecovery(s.recovery, wrapUpRequest.recovery)
              wrapUpText = wrapUpRequest.response?.content || ''
            } catch (wrapUpError) {
              if (wrapUpError?.name === 'AbortError') throw wrapUpError
            }
            const terminal = await s.finishTerminalResult({
              text: !s.hasRequiredArtifacts()
                ? s.missingArtifactBlockerText()
                : wrapUpText || '模型预算已用尽，任务尚未完成。请重试以继续。',
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
              text: '模型推理超过安全上限，任务已停止。请重试，或换用更适合执行工具任务的模型。',
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
              ? s.missingArtifactBlockerText()
              : '任务执行被中断，尚未完成。请重试以继续。',
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
