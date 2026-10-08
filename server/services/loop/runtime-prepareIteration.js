/** Passes a paused turn may defer to steering that arrived after its claim. */
const MAX_PAUSE_DEFERRALS = 3

export async function prepareIteration(s) {
  const i = s.iteration
  const { DIRECTORY_REVIEW_GUARD_MARKER, MAX_ARTIFACT_DELIVERY_RETRIES, buildAssistantToolCallsMessage, buildJobToolIdempotencyKey, normalizeToolCalls, observeToolCalls, runPreStep } = s.d
  if (s.artifactRecoveryActive()
        && !s.completionDeferredForSteering
        && s.artifactDeliveryRetries >= MAX_ARTIFACT_DELIVERY_RETRIES
        && !s.hasRequiredArtifacts()) {
        return { kind: 'return', value: s.finishIncomplete(s.missingArtifactBlocker()) }
      }
  if (s.signal?.aborted) {
        const reason = s.signal.reason
        if (reason?.code === 'TURN_PAUSE_REQUESTED') {
          // A user pause stops at an iteration boundary and keeps the turn
          // resumable: `paused` is non-terminal, so "continue" picks up from the
          // persisted checkpoint instead of redoing the task. Cancellation still
          // throws, because a cancelled turn must not be resumed.
          //
          // Steering queued before the pause is taken into the transcript now,
          // so it is saved with the paused checkpoint and read on resume. Left in
          // the inbox, it keeps the completion gate open, and the pause would
          // defer to it forever without a model request ever claiming it.
          const claimed = await s.steeringController.claimFresh(s.appliedSteeringIds)
          if (claimed.messages.length > 0) {
            s.appendSteeringMessages(claimed.messages)
            await s.steeringController.persistAndAcknowledge(claimed.leaseId)
          }
          const clarification = { reason_code: 'user_paused' }
          const terminal = await s.finishTerminalResult({
            text: s.locale === 'en' ? 'Paused.' : '已暂停。',
            artifactIds: s.artifactIds,
            iterations: s.iter + 1,
            paused: true,
            clarification,
            recovery: s.recovery,
          }, { steeringLeaseId: i.steeringLeaseId, finalMetadata: { paused: true, clarification } })
          if (terminal) return { kind: 'return', value: terminal }
          // Steering that arrived after the claim above: claim it on the next
          // pass, but a pause never extends the turn without bound.
          s.pauseDeferrals = (Number(s.pauseDeferrals) || 0) + 1
          if (s.pauseDeferrals > MAX_PAUSE_DEFERRALS) {
            const error = new Error('Turn paused while steering kept arriving')
            error.name = 'AbortError'
            error.code = 'TURN_PAUSE_REQUESTED'
            throw error
          }
          return { kind: 'continue' }
        }
        const error = new Error('Turn cancelled')
        error.name = 'AbortError'
        throw error
      }
  await runPreStep({
        loopEvents: s.activeLoopEvents,
        context: s.loopEventContext({ phase: 'pre-step' }),
        state: {
          iteration: s.iter,
          messages: s.convo,
          toolSpecs: s.activeToolSpecs,
        },
      })
  i.artifactRecoveryPhaseAtIterationStart = s.artifactRecoveryPhase
  i.artifactRecoveryToolAtIterationStart = s.forcedArtifactToolName
  i.steeringLeaseId = null
  i.toolCalls = undefined
  i.modelMutationBatchScheduled = false
  if (s.injectRepresentativeReadsBeforeModel) {
        s.representativeReadsInjected = true
        s.injectRepresentativeReadsBeforeModel = false
        s.convo.push({
          role: 'system',
          content: [
            DIRECTORY_REVIEW_GUARD_MARKER,
            'A directory listing is discovery evidence only.',
            'The runtime is reading representative documentation, configuration, and entrypoint files through the authorized read_file tool before the first model call.',
            'Base the answer on the returned file contents and report any concrete read errors truthfully.',
          ].join(' '),
        })
        s.checkpointCalls = normalizeToolCalls(s.representativeReadCalls, {
          toolSpecs: s.activeToolSpecs,
        }).map((call) => ({
          ...call,
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
        s.convo.push(buildAssistantToolCallsMessage(s.checkpointCalls, ''))
        await s.persistTurn()
      }
  if (!s.checkpointCalls?.length && s.prepareFinalAnswerEvidenceReview()) {
    await s.persistTurn({ boundary: 'final-answer-evidence-review' })
  }
  return { kind: 'next' }
}
