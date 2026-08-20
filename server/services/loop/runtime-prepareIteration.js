export async function prepareIteration(s) {
  const i = s.iteration
  const { DIRECTORY_REVIEW_GUARD_MARKER, MAX_ARTIFACT_DELIVERY_RETRIES, buildAssistantToolCallsMessage, buildJobToolIdempotencyKey, normalizeToolCalls, observeToolCalls, runPreStep } = s.d
  if (s.artifactRecoveryActive()
        && s.artifactDeliveryRetries >= MAX_ARTIFACT_DELIVERY_RETRIES
        && !s.hasRequiredArtifacts()) {
        return { kind: 'return', value: s.finishIncomplete({
          text: s.missingArtifactBlockerText(),
          reason: 'artifact_delivery_not_converged',
        }) }
      }
  if (s.signal?.aborted) {
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
        }))
        observeToolCalls(s.progressState, s.checkpointCalls)
        if (typeof s.onToolCall === 'function') {
          for (const call of s.checkpointCalls) await s.onToolCall(call)
        }
        await s.emitToolProgress('tools_scheduled')
        s.convo.push(buildAssistantToolCallsMessage(s.checkpointCalls, ''))
        await s.persistTurn()
      }
  return { kind: 'next' }
}
