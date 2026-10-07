/** Keep the host's required-output receipt and ordinary progress decision together. */
export function recordMutationEvidence(s, outcome, call, succeeded, execution) {
  const { extractMutationTargets, isMutationExecutionCall } = s.d
  const { semanticControlCall, productiveExecution } = execution
  const requested = !semanticControlCall && succeeded
    && isMutationExecutionCall(call, outcome.artifactId, s.executionScope)
    && s.requestedMutationContract.record([...extractMutationTargets(call, outcome.result)])
  const mutated = requested || (!semanticControlCall && (s.executionConvergenceEnabled
    ? productiveExecution
    : succeeded && isMutationExecutionCall(call, outcome.artifactId, s.executionScope)))
  if (mutated) {
    s.mutationExecutionObserved = true
    s.priorOutcomeMutationObserved = true
    s.mutationSteeringPending = false
  }
  return mutated
}
