import { assertRuntimeStage } from './runtimeContract.js'

export async function completeToolBatch(s) {
  assertRuntimeStage(s, 'complete-tool-batch')
  const i = s.iteration
  const { EXECUTION_CONVERGENCE_MARKER, EXECUTION_CONVERGENCE_ROUND_THRESHOLD, JOB_READ_CONCURRENCY, REPEAT_CALL_GUARD_MARKER, buildToolResultMessage, getToolMetadata, isCommandExecutionTool, mapWithConcurrency, recordToolProgress, resolveToolResultMaxChars } = s.d
  i.pendingToolResultCount = Math.max(
        1,
        i.toolCalls.filter((call) => call.checkpointStatus !== 'completed').length,
      )
  i.toolResultMaxChars = resolveToolResultMaxChars({
        contextWindow: s.contextWindow,
        resultCount: i.pendingToolResultCount,
      })
  i.convergenceBatch = {
        exploratorySuccess: false,
        productiveSuccess: false,
      }
  i.deferredPostBatchMessages = []
  i.deferredEphemeralToolMessages = []
  i.taskVerificationBatchId = [
    `iteration:${s.iter}`,
    ...i.toolCalls.map((call) => String(call?.id || '').trim()),
  ].join('\u0000').slice(0, 2_000)
  i.isParallelReadCall = (call) => {
        const metadata = getToolMetadata(call.name, {
          args: call.args,
          userId: s.job?.userId || null,
        })
        // Concurrency safety only describes whether two calls may overlap; it
        // is not proof that a side effect can be replayed after a crash. Keep
        // every mutation on the durable serial path even when a dynamic/MCP
        // tool explicitly declares itself concurrency-safe.
        return metadata.executionMode === 'parallel'
          && metadata.isReadOnly === true
          && metadata.isConcurrencySafe === true
      }
  i.requiresPreExecutionSteeringCheck = (call) => {
        if (!call) return false
        const metadata = getToolMetadata(call.name, {
          args: call.args,
          userId: s.job?.userId || null,
        })
        // Command tools remain conservatively guarded even when static analysis
        // classifies a particular command as read-only. Every other built-in,
        // MCP, or plugin tool is governed by its canonical side-effect metadata.
        return isCommandExecutionTool(call) || metadata.isReadOnly !== true
      }
  i.shouldStopBatch = () => Boolean(
        i.noProgressReason || i.budgetExceeded || i.pausedByClarification,
      )
  i.skipRemainingCalls = async (startIndex) => {
        // If the batch must stop, every unanswered tool_call still needs a tool
        // result before the conversation can be sent back to the model.
        for (const skipped of i.toolCalls.slice(startIndex)) {
          if (skipped.checkpointStatus === 'completed') continue
          const skippedResult = {
            ok: false,
            code: 'tool_execution_skipped',
            error: i.noProgressReason || i.budgetExceeded || '当前轮已暂停',
            retryable: false,
          }
          s.convo.push(buildToolResultMessage(skipped, skippedResult))
          Object.assign(skipped, {
            checkpointStatus: 'completed',
            checkpointResult: skippedResult,
          })
          recordToolProgress(s.progressState, { call: skipped, succeeded: false })
        }
        await s.persistTurn()
      }
  i.supersedeRemainingCalls = (startIndex) => {
        for (const superseded of i.toolCalls.slice(startIndex)) {
          if (superseded.checkpointStatus === 'completed') continue
          const supersededResult = {
            ok: false,
            code: 'tool_execution_superseded_by_steering',
            error: 'This unstarted tool call was skipped because newer user steering superseded the current tool-call batch.',
            retryable: false,
            superseded: true,
            executed: false,
          }
          s.convo.push(buildToolResultMessage(
            superseded,
            supersededResult,
            { maxChars: i.toolResultMaxChars },
          ))
          Object.assign(superseded, {
            checkpointStatus: 'completed',
            checkpointResult: supersededResult,
            checkpointArtifactId: null,
          })
          // Superseded calls count as protocol-complete progress, but they never
          // enter failure recovery, convergence, loop-guard, or tool-failure UI.
          recordToolProgress(s.progressState, { call: superseded, succeeded: false })
        }
      }
  i.claimSteeringAtToolBoundary = async (startIndex) => {
        if (startIndex >= i.toolCalls.length) return false
        const claimed = await s.steeringController.claimFresh(s.appliedSteeringIds)
        if (claimed.messages.length === 0) return false

        i.supersedeRemainingCalls(startIndex)
        // Keep every tool response in the assistant batch contiguous before
        // adding screenshot context or the newer user direction.
        s.convo.push(...i.deferredPostBatchMessages)
        i.deferredPostBatchMessages.length = 0
        s.pendingEphemeralToolMessages.push(...i.deferredEphemeralToolMessages)
        i.deferredEphemeralToolMessages.length = 0
        s.appendSteeringMessages(claimed.messages)
        await s.steeringController.persistAndAcknowledge(claimed.leaseId)
        if (s.iter + 1 >= s.maxIters) s.maxIters = s.iter + 2
        return true
      }
  i.callIndex = 0
  i.batchSupersededBySteering = false
  i.firstPendingCallIndex = i.toolCalls.findIndex((call) => call.checkpointStatus !== 'completed')
  i.firstPendingCall = i.firstPendingCallIndex >= 0 ? i.toolCalls[i.firstPendingCallIndex] : null
  if (i.modelMutationBatchScheduled
        && i.requiresPreExecutionSteeringCheck(i.firstPendingCall)
        && await i.claimSteeringAtToolBoundary(i.firstPendingCallIndex)) {
        i.batchSupersededBySteering = true
      }
  while (!i.batchSupersededBySteering && i.callIndex < i.toolCalls.length) {
        const call = i.toolCalls[i.callIndex]
        if (call.checkpointStatus === 'completed') {
          i.callIndex += 1
          continue
        }

        if (i.isParallelReadCall(call)) {
          const readSegment = []
          let segmentEnd = i.callIndex
          while (segmentEnd < i.toolCalls.length) {
            const candidate = i.toolCalls[segmentEnd]
            if (candidate.checkpointStatus === 'completed' || !i.isParallelReadCall(candidate)) break
            readSegment.push(candidate)
            segmentEnd += 1
          }
          const outcomes = await mapWithConcurrency(
            readSegment,
            (candidate) => i.executeOne(candidate, { durableExecution: false }),
            {
              concurrency: readSegment.reduce((limit, candidate) => {
                const declared = getToolMetadata(candidate.name, {
                  args: candidate.args,
                  userId: s.job?.userId || null,
                }).maxParallel
                return Number.isInteger(declared) ? Math.min(limit, declared) : limit
              }, JOB_READ_CONCURRENCY),
            },
          )
          const hardNoProgressOutcome = outcomes.find((outcome) => outcome.noProgressReason) || null
          for (const outcome of outcomes) await i.recordOutcome(outcome)
          // A later successful candidate proves progress after ordinary read
          // failures. It must not, however, erase a pre-execution hard fuse such
          // as the third identical call in the same segment.
          if (hardNoProgressOutcome) {
            i.noProgressReason = hardNoProgressOutcome.noProgressReason
            i.noProgressCode = hardNoProgressOutcome.result?.code || 'tool_no_progress'
          } else if (outcomes.some(({ result }) => result?.ok === true)) {
            i.noProgressReason = null
            i.noProgressCode = null
            i.noProgressFailure = null
          }
          i.callIndex = segmentEnd
        } else {
          const outcome = await i.executeOne(call)
          await i.recordOutcome(outcome)
          i.callIndex += 1
        }

        if (await i.claimSteeringAtToolBoundary(i.callIndex)) {
          i.batchSupersededBySteering = true
          break
        }
        if (i.shouldStopBatch()) {
          await i.skipRemainingCalls(i.callIndex)
          break
        }
      }
  s.convo.push(...i.deferredPostBatchMessages)
  s.pendingEphemeralToolMessages.push(...i.deferredEphemeralToolMessages)
  i.failureStrategyAdvisories = s.loopGuard.pendingAdvisories?.() || []
  for (const advisory of i.failureStrategyAdvisories) {
        s.convo.push({
          role: 'system',
          content: [
            '[TOOL FAILURE STRATEGY REQUIRED]',
            'code=' + advisory.code,
            'level=' + advisory.level,
            'tool=' + advisory.tool,
            'failures=' + advisory.count + '.',
            advisory.content,
          ].join(' '),
        })
      }
  if (i.failureStrategyAdvisories.length > 0) s.loopGuard.commitPendingAdvisories?.()
  if (s.executionConvergenceEnabled) {
        if (i.convergenceBatch.productiveSuccess) {
          s.executionConvergence.unproductiveRounds = 0
          s.executionConvergence.interventionActive = false
          s.executionConvergence.installAttempts = []
        } else if (i.convergenceBatch.exploratorySuccess) {
          s.executionConvergence.unproductiveRounds += 1
        }
        if (!s.executionConvergence.interventionActive
          && s.executionConvergence.unproductiveRounds >= EXECUTION_CONVERGENCE_ROUND_THRESHOLD) {
          s.executionConvergence.interventions += 1
          s.executionConvergence.interventionActive = true
          s.convo.push({
            role: 'system',
            content: [
              EXECUTION_CONVERGENCE_MARKER,
              `${s.executionConvergence.unproductiveRounds} consecutive tool batches completed discovery or inspection work without producing the requested output.`,
              'Discovery is now considered complete. Do not create or run more inspect/probe/diagnostic scripts, repeat dependency checks, or reinstall an already attempted dependency.',
              'Immediately execute the requested mutation or artifact-generation step, declare expected_outputs for generated local files when supported, and then verify the resulting files or project state.',
              'If execution is genuinely blocked, report the single concrete command error or missing authorization; do not substitute another exploration loop.',
            ].join(' '),
          })
        }
      }
  i.appendFailureRecoveryPrompt()
  if (s.pendingRepeatCallReminder) {
        s.convo.push({
          role: 'system',
          content: `${REPEAT_CALL_GUARD_MARKER} ${s.pendingRepeatCallReminder.content}`,
        })
        s.pendingRepeatCallReminder = null
      }
  return { kind: 'next' }
}
