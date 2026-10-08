import { PROBE_SCRIPT_PATH } from './heuristics/constants.js'
import { probePathsFromCall } from './heuristics/executionRecovery.js'
import { normalizeMutationTarget } from './heuristics/mutationClassification.js'
import { hasInlinePythonMutation } from './heuristics/pythonMutationAnalysis.js'

/**
 * Whether a probe-named script this turn wrote can change files. A Python script
 * is read the way inline `python -c` already is; a script in any other language,
 * or one changed by an edit or patch whose whole body is not in hand, cannot be
 * shown harmless and counts as able to.
 */
function authoredScriptCanMutate(call, path) {
  const content = typeof call?.args?.content === 'string' ? call.args.content : null
  if (call?.name !== 'write_file' || content === null) return true
  if (!/\.py$/i.test(path)) return true
  return hasInlinePythonMutation(content)
}

/**
 * Running a probe-named script is exploration only while nothing says otherwise.
 * A script this turn wrote with file-writing code in it is the model's own code:
 * naming it `probe_*.py` must not let it edit sources or write deliverables
 * outside the verification debt every other execution creates. The same holds
 * for any command whose executor reports the files it changed. The convergence
 * counter may still call such a run exploratory; the debt below does not.
 */
function rememberAuthoredProbeScripts(s, call, succeeded) {
  if (!succeeded || s.d.isCommandExecutionTool(call)) return
  for (const path of probePathsFromCall(call)) {
    if (!PROBE_SCRIPT_PATH.test(path)) continue
    const target = normalizeMutationTarget(path)
    if (!target) continue
    if (authoredScriptCanMutate(call, path)) s.mutatingProbeScripts.add(target)
    else s.mutatingProbeScripts.delete(target)
  }
}

function runsMutatingProbe(s, call) {
  if (!s.mutatingProbeScripts?.size || !s.d.isProbeLikeCall(call)) return false
  return [...s.mutatingProbeScripts].some((script) => s.commandReferencesTarget(call, script))
}

function reportedChangedPaths(result) {
  return Array.isArray(result?.changedPaths) && result.changedPaths.length > 0
}

/** Keep the host's required-output receipt and ordinary progress decision together. */
export function recordMutationEvidence(s, outcome, call, succeeded, execution) {
  const { extractMutationTargets, isCommandExecutionTool, isMutationExecutionCall } = s.d
  const { semanticControlCall, productiveExecution } = execution
  rememberAuthoredProbeScripts(s, call, succeeded)
  const requested = !semanticControlCall && succeeded
    && isMutationExecutionCall(call, outcome.artifactId, s.executionScope)
    && s.requestedMutationContract.record([...extractMutationTargets(call, outcome.result)])
  const probeWithEffect = !semanticControlCall && succeeded && s.executionConvergenceEnabled
    && !productiveExecution && isCommandExecutionTool(call)
    && isMutationExecutionCall(call, outcome.artifactId, s.executionScope)
    && (runsMutatingProbe(s, call) || reportedChangedPaths(outcome.result))
  const mutated = requested || probeWithEffect || (!semanticControlCall && (s.executionConvergenceEnabled
    ? productiveExecution
    : succeeded && isMutationExecutionCall(call, outcome.artifactId, s.executionScope)))
  if (mutated) {
    s.mutationExecutionObserved = true
    s.priorOutcomeMutationObserved = true
    s.mutationSteeringPending = false
  }
  return mutated
}
