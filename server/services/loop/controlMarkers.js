/**
 * Registry of host→model control markers: one enumerable home for the *set*.
 *
 * A control marker is a bracketed token the host injects into the conversation so a
 * later phase recognises the state it created. The definitions themselves stay where
 * they are (mostly `heuristics/constants.js`, plus a few in `runtime.js` and one per
 * owning module); this file only records which markers exist, who owns each one, and
 * what it is for.
 *
 * Two deliberate design constraints:
 *
 * 1. **No marker text is duplicated here.** `tests/loopMarkers.test.js` pins the
 *    invariant that every bracketed marker literal occurs exactly once in the tree —
 *    at its `*_MARKER` definition — so that string-based control flow cannot misfire.
 *    Copying the values into this file would break that invariant, and a second copy
 *    would become a silent drift source. The text is therefore read from the real
 *    definitions by `tests/controlMarkerRegistry.test.js`.
 *
 * 2. **No imports either.** Pulling the constants in would make this module execute the
 *    loop's dependency graph (including `runtime.js`), which is exactly what the shared
 *    dependency bag exists to avoid. The registry is pure data.
 *
 * Runtime code keeps importing the original definitions. Nothing here is wired into the
 * loop yet; `CONTROL_MARKER_COUNT_BASELINE` is the growth fence.
 */

/** Every marker currently defined under `server/`. Fenced by CONTROL_MARKER_COUNT_BASELINE. */
export const CONTROL_MARKER_REGISTRY = Object.freeze([
  Object.freeze({
    name: 'ADJACENT_ARTIFACT_REVISION_MARKER',
    definedIn: 'server/services/loop/heuristics/constants.js',
    purpose: 'States that the requested revision applies to the artifact delivered in the adjacent turn.',
  }),
  Object.freeze({
    name: 'ARTIFACT_DELIVERY_GUARD_MARKER',
    definedIn: 'server/services/loop/heuristics/constants.js',
    purpose: 'Forces a persisted artifact write instead of a chat-only answer, and drives the delivery retry budget.',
  }),
  Object.freeze({
    name: 'ARTIFACT_RECOVERY_DIAGNOSIS_MARKER',
    definedIn: 'server/services/loop/runtime.js',
    purpose: 'Opens the diagnose phase of artifact recovery before the forced generator phase.',
  }),
  Object.freeze({
    name: 'ARTIFACT_RECOVERY_FORCE_MARKER',
    definedIn: 'server/services/loop/runtime.js',
    purpose: 'Opens the forced-generator phase of artifact recovery with a bound tool choice.',
  }),
  Object.freeze({
    name: 'ARTIFACT_SOURCE_DELIVERY_POLICY_MARKER',
    definedIn: 'server/services/loop/heuristics/constants.js',
    purpose: 'Restates how source files must accompany a generated artifact for the current turn.',
  }),
  Object.freeze({
    name: 'AVAILABLE_TOOL_CAPABILITIES_MARKER',
    definedIn: 'server/services/loop/heuristics/constants.js',
    purpose: 'Publishes the tool capabilities actually available this turn so the model stops claiming it cannot act.',
  }),
  Object.freeze({
    name: 'CONTINUATION_MARKER',
    definedIn: 'server/services/loop/outputContinuation.js',
    purpose: 'Marks a continuation prompt used when output was cut off by the token budget.',
  }),
  Object.freeze({
    name: 'DELIVERABLE_SELECTION_FALLBACK_MARKER',
    definedIn: 'server/services/loop/runtime.js',
    purpose: 'Announces the safe fallback taken when no deliverable could be selected.',
  }),
  Object.freeze({
    name: 'DELIVERABLE_SELECTION_GUARD_MARKER',
    definedIn: 'server/services/loop/runtime.js',
    purpose: 'Forces an explicit final-deliverable selection before the turn may complete.',
  }),
  Object.freeze({
    name: 'DIRECT_EXECUTION_REQUIRED_MARKER',
    definedIn: 'server/services/loop/heuristics/constants.js',
    purpose: 'Requires the model to execute instead of answering a capability challenge with prose.',
  }),
  Object.freeze({
    name: 'DIRECTORY_AUTHORIZATION_REFRESH_MARKER',
    definedIn: 'server/services/loop/heuristics/constants.js',
    purpose: 'Refreshes the directory-authorization tool specs after a verified grant.',
  }),
  Object.freeze({
    name: 'DIRECTORY_RESUME_GUARD_MARKER',
    definedIn: 'server/services/loop/heuristics/constants.js',
    purpose: 'Resumes a turn that was parked waiting for directory authorization, with a bounded retry budget.',
  }),
  Object.freeze({
    name: 'DIRECTORY_REVIEW_GUARD_MARKER',
    definedIn: 'server/services/loop/heuristics/directoryReview.js',
    purpose: 'Requires a representative read before the model may summarise a directory it has not inspected.',
  }),
  Object.freeze({
    name: 'DYNAMIC_EXECUTION_TARGET_MARKER',
    definedIn: 'server/services/loop/runtime.js',
    purpose: 'Re-binds a continued turn to the canonical local file target selected earlier.',
  }),
  Object.freeze({
    name: 'DYNAMIC_EXECUTION_TOOL_RECOVERY_MARKER',
    definedIn: 'server/services/loop/runtime.js',
    purpose: 'Re-publishes execution tool specs that were dropped when dynamic tools were rebound.',
  }),
  Object.freeze({
    name: 'DYNAMIC_SKILL_SYSTEM_MARKER',
    definedIn: 'server/services/runtimeSkillActivation.js',
    purpose: 'Confirms host-side activation of a dynamically loaded skill for this turn.',
  }),
  Object.freeze({
    name: 'EXECUTION_CONVERGENCE_MARKER',
    definedIn: 'server/services/loop/heuristics/constants.js',
    purpose: 'Pushes a looping turn toward convergence once the round threshold is reached.',
  }),
  Object.freeze({
    name: 'EXECUTION_EVIDENCE_GUARD_MARKER',
    definedIn: 'server/services/loop/heuristics/constants.js',
    purpose: 'Demands execution evidence before a completion claim is accepted.',
  }),
  Object.freeze({
    name: 'FAILURE_RECOVERY_MARKER',
    definedIn: 'server/services/loop/heuristics/constants.js',
    purpose: 'Opens the tool-failure recovery strategy once repeated failures cross the threshold.',
  }),
  Object.freeze({
    name: 'FINAL_ANSWER_EVIDENCE_REVIEW_MARKER',
    definedIn: 'server/services/loop/finalAnswerEvidenceReview.js',
    purpose: 'Requests an evidence review of the final answer before it is presented as complete.',
  }),
  Object.freeze({
    name: 'JOB_DIRECTORY_RESOLUTION_MARKER',
    definedIn: 'server/services/jobDirectoryAuthorization.js',
    purpose: 'Prefix of the persisted job-level directory authorization record embedded in the transcript.',
  }),
  Object.freeze({
    name: 'LIVE_ARTIFACT_CONTRACT_MARKER',
    definedIn: 'server/services/loop/runtime.js',
    purpose: 'Announces that the live-artifact contract was rewritten mid-turn.',
  }),
  Object.freeze({
    name: 'LIVE_STEERING_GUARD_MARKER',
    definedIn: 'server/services/loop/heuristics/directoryReview.js',
    purpose: 'Describes how a live steering update is delivered without breaking tool pairing.',
  }),
  Object.freeze({
    name: 'LOCAL_HTML_DELIVERY_GUARD_MARKER',
    definedIn: 'server/services/loop/runtime.js',
    purpose: 'Requires a local HTML deliverable to pass validation before completion.',
  }),
  Object.freeze({
    name: 'MANAGED_ATTACHMENT_EXECUTION_MARKER',
    definedIn: 'server/services/loop/heuristics/constants.js',
    purpose: 'States the execution contract for host-managed attachments in the current turn.',
  }),
  Object.freeze({
    name: 'PDF_LAYOUT_EXECUTION_CONTRACT_MARKER',
    definedIn: 'server/services/loop/heuristics/constants.js',
    purpose: 'States how a PDF deliverable must be laid out and verified this turn.',
  }),
  Object.freeze({
    name: 'PDF_LAYOUT_VERIFICATION_GUARD_MARKER',
    definedIn: 'server/services/loop/heuristics/constants.js',
    purpose: 'Requires PDF layout verification with a bounded retry budget before completion.',
  }),
  Object.freeze({
    name: 'POST_MUTATION_VERIFICATION_GUARD_MARKER',
    definedIn: 'server/services/loop/heuristics/constants.js',
    purpose: 'Requires the model to verify its own local mutation with a bounded retry budget.',
  }),
  Object.freeze({
    name: 'PRESENTATION_RUNTIME_PROMPT_MARKER',
    definedIn: 'server/services/loop/presentationPromptContext.js',
    purpose: 'States the presentation authoring contract for the current turn.',
  }),
  Object.freeze({
    name: 'PRIOR_TURN_OUTCOME_MARKER',
    definedIn: 'server/services/loop/runtimeState.js',
    purpose: 'Carries the previous turn outcome status so a continuation does not restate it as a failure.',
  }),
  Object.freeze({
    name: 'REPEAT_CALL_GUARD_MARKER',
    definedIn: 'server/services/loop/heuristics/constants.js',
    purpose: 'Stops the model from re-issuing an identical tool call that already returned.',
  }),
  Object.freeze({
    name: 'RUNTIME_CAPABILITIES_MARKER',
    definedIn: 'server/services/runtimeCapabilities.js',
    purpose: 'Publishes the runtime capability block that may be replaced as capabilities change.',
  }),
  Object.freeze({
    name: 'SKILL_TRUNCATION_MARKER',
    definedIn: 'server/services/promptCompiler.js',
    purpose: 'Notes that a skill prompt was truncated by the safety budget while compiling the prompt.',
  }),
  Object.freeze({
    name: 'SOURCE_HANDOFF_GUARD_MARKER',
    definedIn: 'server/services/loop/runtime.js',
    purpose: 'Blocks a completion that would hand off a source file without delivering it.',
  }),
  Object.freeze({
    name: 'TASK_VERIFICATION_REPAIR_MARKER',
    definedIn: 'server/services/loop/taskVerificationRepairPresentation.js',
    purpose: 'Requests a task-verification repair round and carries its remaining budget.',
  }),
  Object.freeze({
    name: 'TOOL_FAILURE_STRATEGY_MARKER',
    definedIn: 'server/services/loop/heuristics/constants.js',
    purpose: 'Requires an explicit strategy change after the same tool failed repeatedly.',
  }),
  Object.freeze({
    name: 'TURN_RESOLUTION_MARKER',
    definedIn: 'server/services/turnResolutionRuntime.js',
    purpose: 'Prefix of the persisted turn-resolution record embedded in the transcript.',
  }),
])

/**
 * Growth fence. Adding a marker requires raising this number deliberately, so the set
 * cannot drift upward silently. Lower it when a marker is genuinely removed — the
 * dead `EXECUTION_REASONING_RECOVERY_MARKER` was deleted on 2026-09-17, taking the
 * count from 38 to 37.
 */
export const CONTROL_MARKER_COUNT_BASELINE = 37

export const CONTROL_MARKER_NAMES = Object.freeze(CONTROL_MARKER_REGISTRY.map((entry) => entry.name))

const BY_NAME = new Map(CONTROL_MARKER_REGISTRY.map((entry) => [entry.name, entry]))

/** Look a registered marker up by its exported constant name. */
export function controlMarkerByName(name) {
  return BY_NAME.get(name) ?? null
}

const MARKER_NAME_PATTERN = /^[A-Z][A-Z0-9_]*_MARKER$/

/** Constant names whose value is a prefix template (e.g. `[TURN_RESOLUTION:`) rather than a full token. */
export const CONTROL_MARKER_PREFIX_NAMES = Object.freeze(['JOB_DIRECTORY_RESOLUTION_MARKER', 'TURN_RESOLUTION_MARKER'])

export function isControlMarkerName(name) {
  return typeof name === 'string' && MARKER_NAME_PATTERN.test(name)
}
