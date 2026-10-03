/**
 * Runtime dependency-bag contract for the bundled loop kernel.
 *
 * The loop hands every phase one shared dependency bag (`s.d`). This module is
 * the fail-closed boundary: before a phase can run, every symbol the phases
 * consume must be present with the expected kind. The required-name list is
 * generated from the real source (see
 * `scripts/generate-loop-dependency-manifest.mjs`); the kind map below is
 * verified against the real bag by `tests/loopDependencyBag.test.js`.
 *
 * Non-function kinds matter: a boolean, number, Set, RegExp, symbol or array
 * dependency that resolves to `undefined` must fail here, not surface as a
 * confusing runtime error in the middle of a turn.
 */
import { LOOP_RUNTIME_DEPENDENCY_MANIFEST } from './dependencyBagManifest.js'

export const LOOP_RUNTIME_DEPENDENCY_MANIFEST_VERSION = LOOP_RUNTIME_DEPENDENCY_MANIFEST.schemaVersion

/** Expected kind for every required dependency. */
export const RUNTIME_DEPENDENCY_KINDS = Object.freeze({
  ADJACENT_ARTIFACT_REVISION_MARKER: 'string',
  allowedArtifactTools: 'function',
  appendFinalAnswerToolEvidence: 'function',
  ARTIFACT_DELIVERY_GUARD_MARKER: 'string',
  ARTIFACT_RECOVERY_DIAGNOSIS_MARKER: 'string',
  ARTIFACT_RECOVERY_FORCE_MARKER: 'string',
  ARTIFACT_RECOVERY_PHASE_DIAGNOSE: 'string',
  ARTIFACT_RECOVERY_PHASE_FORCE: 'string',
  ARTIFACT_SOURCE_DELIVERY_POLICY_MARKER: 'string',
  attachJobBudget: 'function',
  AVAILABLE_TOOL_CAPABILITIES_MARKER: 'string',
  budgetExceededCopy: 'function',
  buildAssistantToolCallsMessage: 'function',
  buildFinalAnswerEvidenceReviewPrompt: 'function',
  buildFinalAnswerEvidenceSnapshot: 'function',
  buildJobToolIdempotencyKey: 'function',
  buildPdfLayoutExecutionContract: 'function',
  buildRepresentativeReadCalls: 'function',
  buildTaskVerificationRepairPrompt: 'function',
  buildToolResultMessage: 'function',
  buildToolResultMessageBundle: 'function',
  callModelWithContextRecovery: 'function',
  CAPABILITY_CONTROL_TOOL_NAMES: 'set',
  CHECKPOINT_FLUSH_ERROR_CODE: 'string',
  clearArtifactValidatedMutationTargets: 'function',
  clearVerifiedDeletionTargets: 'function',
  clearVerifiedMutationTargets: 'function',
  collectFinalAnswerToolEvidence: 'function',
  COMMAND_EXECUTION_TOOL_NAMES: 'set',
  commandExecutionToolLabel: 'function',
  contradictedCapabilityClarification: 'function',
  createArtifactReplacementGuard: 'function',
  createCheckpointBarrier: 'function',
  createDisabledToolGuard: 'function',
  createExplicitReadOnlyGuard: 'function',
  createJobBudget: 'function',
  createLoopEvents: 'function',
  createModelPhaseHeartbeat: 'function',
  createPartialResultFallback: 'function',
  createRedundantImageGuard: 'function',
  createRepeatCallGuard: 'function',
  createSideEffectExecution: 'function',
  createSideEffectScope: 'function',
  createSteeringController: 'function',
  createSubagentApprovalContext: 'function',
  createToolAbortScope: 'function',
  createToolLoopGuard: 'function',
  createTruncatedToolCallResult: 'function',
  createWorkspaceTargetGuard: 'function',
  DEFAULT_MODEL_PHASE_HEARTBEAT_MS: 'number',
  DELIVERABLE_SELECTION_FALLBACK_MARKER: 'string',
  DELIVERABLE_SELECTION_GUARD_MARKER: 'string',
  DIRECT_EXECUTION_REQUIRED_MARKER: 'string',
  DIRECTORY_AUTHORIZATION_REFRESH_MARKER: 'string',
  DIRECTORY_AUTHORIZATION_WAIT_CLAIM: 'regexp',
  DIRECTORY_RESUME_GUARD_MARKER: 'string',
  DIRECTORY_REVIEW_GUARD_MARKER: 'string',
  DIRECTORY_REVIEW_INTENT: 'regexp',
  DYNAMIC_EXECUTION_TARGET_MARKER: 'string',
  DYNAMIC_EXECUTION_TOOL_NAMES: 'set',
  DYNAMIC_EXECUTION_TOOL_RECOVERY_MARKER: 'string',
  DYNAMIC_MUTATION_TOOL_NAMES: 'set',
  ensureSafetySystemMessages: 'function',
  executeServerTool: 'function',
  executeToolWithRetry: 'function',
  EXECUTION_CONVERGENCE_MARKER: 'string',
  EXECUTION_CONVERGENCE_ROUND_THRESHOLD: 'number',
  EXECUTION_EVIDENCE_GUARD_MARKER: 'string',
  EXPLICIT_LOCAL_DIRECTORY_CONTEXT: 'regexp',
  extractMutationTargets: 'function',
  extractTextToolCalls: 'function',
  FAILURE_RECOVERY_MARKER: 'string',
  FAILURE_RECOVERY_THRESHOLD: 'number',
  FALSE_SUCCESS_STATUS: 'regexp',
  FILE_WRITE_TOOL_NAMES: 'set',
  filterCurrentDynamicToolSpecs: 'function',
  finalAnswerEvidenceDigest: 'function',
  findAdjacentDeliveredArtifacts: 'function',
  findContinuableArtifactTargets: 'function',
  findExplicitlyReferencedDeliveredArtifacts: 'function',
  formatDeniedToolResult: 'function',
  formatIncompleteTerminalText: 'function',
  GENERATED_ARTIFACT_TYPE: 'object',
  getDefaultOutputDirectory: 'function',
  getJobBudget: 'function',
  getProjectDirectory: 'function',
  getSideEffectExecutionLedger: 'function',
  getToolMetadata: 'function',
  goalToolContextForTurn: 'function',
  hasCommandExecutionTool: 'function',
  hasEffectiveReadOnlyBoundary: 'function',
  hasMutationExecutionIntent: 'function',
  hasPendingTaskVerificationRepair: 'function',
  hasRuntimeSkillActivationBlock: 'function',
  hasSuccessfulLocalPreflightRead: 'function',
  INCOMPLETE_STATUS: 'regexp',
  inspectToolLoopModelResponse: 'function',
  installAttemptSignature: 'function',
  installToolFailureRecovery: 'function',
  isArtifactRevisionRequest: 'function',
  isCommandExecutionTool: 'function',
  isContextLengthError: 'function',
  isExecutionCapabilityChallenge: 'function',
  isExplicitCodeSnippetRequest: 'function',
  isExplicitLocalMutationRetryRequest: 'function',
  isExplorationOnlyCall: 'function',
  isFileArtifactTool: 'function',
  isForcedToolChoiceCompatibilityError: 'function',
  isLocalMutationCall: 'function',
  isLocalMutationContinuationRequest: 'function',
  isLoopPauseResult: 'function',
  isMutationExecutionCall: 'function',
  isProbeLikeCall: 'function',
  isProductiveExecutionOutcome: 'function',
  isSubstantiveToolCall: 'function',
  isSuccessfulPdfLayoutVerification: 'function',
  isSuccessfulToolResult: 'function',
  isTextDeliverableRequest: 'function',
  isTrustedInternalLoopPrincipal: 'function',
  isVerificationCall: 'function',
  JOB_READ_CONCURRENCY: 'number',
  latestPriorTurnOutcome: 'function',
  listTurnArtifacts: 'function',
  LIVE_ARTIFACT_CONTRACT_MARKER: 'string',
  LIVE_STEERING_GUARD_MARKER: 'string',
  LOCAL_HTML_DELIVERY_GUARD_MARKER: 'string',
  looksLikeDeletionCommand: 'function',
  MANAGED_ATTACHMENT_EXECUTION_MARKER: 'string',
  MANAGED_ATTACHMENT_MARKER: 'regexp',
  mapWithConcurrency: 'function',
  matchesDynamicToolRegistration: 'function',
  MAX_ARTIFACT_DELIVERY_RETRIES: 'number',
  MAX_ARTIFACT_RECOVERY_DIAGNOSTIC_ROUNDS: 'number',
  MAX_CAPABILITY_TOOL_NAMES: 'number',
  MAX_DELIVERABLE_SELECTION_RETRIES: 'number',
  MAX_DIRECTORY_RESUME_RETRIES: 'number',
  MAX_DYNAMIC_SKILLS_PER_TURN: 'number',
  MAX_EXECUTION_EVIDENCE_RETRIES: 'number',
  MAX_INSTALL_ATTEMPT_SIGNATURES: 'number',
  MAX_ITERS: 'number',
  MAX_LOCAL_HTML_DELIVERY_RETRIES: 'number',
  MAX_MUTATION_VERIFICATION_RETRIES: 'number',
  MAX_PDF_LAYOUT_VERIFICATION_RETRIES: 'number',
  MAX_SOURCE_HANDOFF_RETRIES: 'number',
  mergeCompactionRecovery: 'function',
  normalizeArtifactIdList: 'function',
  normalizeCompactionRecovery: 'function',
  normalizeDirectoryAuthorizationResolutions: 'function',
  normalizeFinalAnswerToolEvidence: 'function',
  normalizeMutationTarget: 'function',
  normalizeToolCalls: 'function',
  normalizeToolError: 'function',
  normalizeToolResult: 'function',
  normalizeTurnLocale: 'function',
  observeTaskVerificationMutation: 'function',
  observeTaskVerificationRepair: 'function',
  observeToolCalls: 'function',
  parseSkillIdFromPrompt: 'function',
  PATCH_WRITE_TOOL_NAMES: 'set',
  path: 'object',
  PDF_LAYOUT_EXECUTION_CONTRACT_MARKER: 'string',
  PDF_LAYOUT_VERIFICATION_GUARD_MARKER: 'string',
  PDF_LAYOUT_VERIFICATION_OK: 'string',
  persistLocalToolArtifactsAsync: 'function',
  POST_MUTATION_VERIFICATION_GUARD_MARKER: 'string',
  prepareRuntimeSkillActivation: 'function',
  priorOutcomeStatusCopy: 'function',
  progressChangesFor: 'function',
  PROJECT_SCOPE_TARGET: 'string',
  recordRecoveredModelResult: 'function',
  recordToolProgress: 'function',
  recoverPriorLocalMutationTargets: 'function',
  rememberApprovedSubagentCall: 'function',
  REPEAT_CALL_GUARD_MARKER: 'string',
  replaceRuntimeCapabilityBlock: 'function',
  requestApproval: 'function',
  requestedArtifactOutputDirective: 'function',
  requestedPdfSectionLabel: 'function',
  requiresPerCallApproval: 'function',
  resolveArtifactDeliveryTargets: 'function',
  resolveArtifactRevisionMode: 'function',
  resolveChatCapabilityMode: 'function',
  resolveIterationWindow: 'function',
  resolveSideEffectExecutionLedger: 'function',
  resolveToolResultMaxChars: 'function',
  restoreDirectoryAuthorizationToolSpecs: 'function',
  restoreExecutionConvergence: 'function',
  restoreFailureRecovery: 'function',
  restoreNamedToolSpecs: 'function',
  restoreTaskVerificationRepair: 'function',
  restoreToolProgress: 'function',
  resumePersistedApproval: 'function',
  revalidateHookAuthorization: 'function',
  revalidateToolPermission: 'function',
  runModelStep: 'function',
  runPostTool: 'function',
  runPreStep: 'function',
  runPreTool: 'function',
  runWithModelBudget: 'function',
  salvageBareJsonToolCall: 'function',
  sameArtifactIdList: 'function',
  sanitizeIncompleteTerminalText: 'function',
  SCHEDULED_WAIT_INTENT: 'regexp',
  scopeTextToolCallIds: 'function',
  selectJobToolSpecs: 'function',
  serializeExecutionConvergence: 'function',
  serializeFailureRecovery: 'function',
  serializeTaskVerificationRepair: 'function',
  serializeToolProgress: 'function',
  SERVER_TOOL_SPECS: 'array',
  shellTargetWithCwd: 'function',
  shouldInheritExecutionIntent: 'function',
  shouldReflectOnFailure: 'function',
  shouldRepairLegacyWorkspaceMutationCheckpoint: 'function',
  shouldRequireExecution: 'function',
  shouldRequirePdfLayoutVerification: 'function',
  SIDE_EFFECT_LEDGER_CONFLICT: 'string',
  SIDE_EFFECT_OUTCOME_UNKNOWN: 'string',
  sideEffectRecoveryBlock: 'function',
  snapshotDynamicToolSpecRegistrations: 'function',
  SOURCE_HANDOFF_GUARD_MARKER: 'string',
  sourceHandoffViolation: 'function',
  staticDeletionTargets: 'function',
  STATUS_INQUIRY_PROMPT: 'regexp',
  stripEphemeralToolMediaMessages: 'function',
  successfulReadFileInMessages: 'function',
  supportsIdempotentResume: 'function',
  synchronizeCheckpointToolCallMessages: 'function',
  targetsMatch: 'function',
  taskVerificationRepairBlockerText: 'function',
  taskVerificationRepairDetails: 'function',
  taskVerificationRepairExhausted: 'function',
  terminalProtectionCopy: 'function',
  TOOL_FAILURE_STRATEGY_MARKER: 'string',
  TOOL_HOOK_RESULT: 'symbol',
  toolNameFromSpec: 'function',
  toolProgressPayload: 'function',
  validateLocalHtmlDelivery: 'function',
  validateToolCall: 'function',
  VERIFICATION_TOOLS: 'set',
  writeToolAudit: 'function',
})

export const REQUIRED_RUNTIME_DEPENDENCIES = LOOP_RUNTIME_DEPENDENCY_MANIFEST.required
export const DECLARED_RUNTIME_DEPENDENCIES = LOOP_RUNTIME_DEPENDENCY_MANIFEST.declared

export function runtimeDependencyKind(value) {
  if (value instanceof RegExp) return 'regexp'
  if (value instanceof Set) return 'set'
  if (value instanceof Map) return 'map'
  if (Array.isArray(value)) return 'array'
  if (value === null) return 'null'
  return typeof value
}

/**
 * Validate the complete bag at the loop boundary.
 *
 * @returns {{ ok: true } | { ok: false, stage: string, missingFields: string[], invalidFields: string[], unexpectedFields: string[], expectedKinds: Record<string,string> }}
 */
export function inspectRuntimeDependencies(dependencies) {
  const bag = dependencies && typeof dependencies === 'object' ? dependencies : {}
  const declared = new Set(DECLARED_RUNTIME_DEPENDENCIES)
  const missingFields = []
  const invalidFields = []
  const unexpectedFields = []
  for (const name of REQUIRED_RUNTIME_DEPENDENCIES) {
    if (!Object.hasOwn(bag, name) || bag[name] === undefined || bag[name] === null) {
      missingFields.push(name)
      continue
    }
    const expected = RUNTIME_DEPENDENCY_KINDS[name]
    if (expected && runtimeDependencyKind(bag[name]) !== expected) invalidFields.push(name)
  }
  for (const name of Object.keys(bag)) {
    if (!declared.has(name)) unexpectedFields.push(name)
    else if (bag[name] === undefined || bag[name] === null) {
      if (!missingFields.includes(name)) invalidFields.push(name)
    }
  }
  if (missingFields.length === 0 && invalidFields.length === 0 && unexpectedFields.length === 0) {
    return { ok: true }
  }
  return {
    ok: false,
    stage: 'runtime-dependencies',
    missingFields,
    invalidFields,
    unexpectedFields,
    expectedKinds: Object.fromEntries(
      [...missingFields, ...invalidFields]
        .filter((name) => RUNTIME_DEPENDENCY_KINDS[name])
        .map((name) => [name, RUNTIME_DEPENDENCY_KINDS[name]]),
    ),
  }
}
