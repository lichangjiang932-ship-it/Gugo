import path from 'node:path'
import {
  createTruncatedToolCallResult,
  inspectToolLoopModelResponse,
} from '../../core/toolLoopAdapter.js'
import { isLoopPauseResult } from '../../utils/agenticTools.js'
import { requiresPerCallApproval } from '../../utils/approvalPolicy.js'
import {
  filterCurrentDynamicToolSpecs,
  getToolMetadata,
  matchesDynamicToolRegistration,
  snapshotDynamicToolSpecRegistrations,
} from '../toolRegistry.js'
import { createToolAbortScope } from '../../utils/toolCancellation.js'
import { attachJobBudget, getJobBudget, createJobBudget, recordRecoveredModelResult, runWithModelBudget } from '../../utils/jobBudget.js'
import { formatDeniedToolResult, requestApproval, resumePersistedApproval, revalidateHookAuthorization, revalidateToolPermission } from '../approvalGate.js'
import { writeToolAudit } from '../../utils/audit.js'
import { isContextLengthError } from '../../adapters/modelProxy.js'
import { callModelWithContextRecovery } from '../contextCompactionRuntime.js'
import { ensureSafetySystemMessages } from '../promptCompiler.js'
import { allowedArtifactTools, findAdjacentDeliveredArtifacts, findContinuableArtifactTargets, findExplicitlyReferencedDeliveredArtifacts, isArtifactRevisionRequest, isExplicitCodeSnippetRequest, isFileArtifactTool, parseSkillIdFromPrompt, resolveArtifactDeliveryTargets, resolveArtifactRevisionMode } from '../artifactIntent.js'
import { restoreDirectoryAuthorizationToolSpecs } from '../turnToolSpecs.js'
import { createSubagentApprovalContext, rememberApprovedSubagentCall } from '../subagentApprovalContext.js'
import { buildAssistantToolCallsMessage, buildToolResultMessage, buildToolResultMessageBundle, createToolLoopGuard, executeToolWithRetry, isSubstantiveToolCall, mapWithConcurrency, normalizeToolError, normalizeToolResult, normalizeToolCalls, resolveToolResultMaxChars, stripEphemeralToolMediaMessages, validateToolCall } from '../../utils/toolCallHarness.js'
import { extractTextToolCalls } from '../../utils/textToolCalls.js'
import { replaceRuntimeCapabilityBlock } from '../runtimeCapabilities.js'
import { hasMutationExecutionIntent, isExecutionCapabilityChallenge, isTextDeliverableRequest, shouldRequireExecution } from '../../utils/executionIntent.js'
import { observeToolCalls, recordToolProgress, restoreToolProgress, serializeToolProgress, toolProgressPayload } from '../../utils/toolProgress.js'
import { listTurnArtifacts } from '../turnArtifactStore.js'
import { createModelPhaseHeartbeat, DEFAULT_MODEL_PHASE_HEARTBEAT_MS } from '../modelPhaseHeartbeat.js'
import { getDefaultOutputDirectory, getProjectDirectory } from '../localFileAccessService.js'
import { normalizeDirectoryAuthorizationResolutions } from '../turnResolutionRuntime.js'
import { createPartialResultFallback } from '../partialResultFallback.js'
import { validateLocalHtmlDelivery } from '../localHtmlDeliveryValidation.js'
import { CHECKPOINT_FLUSH_ERROR_CODE, createCheckpointBarrier } from './checkpoint.js'
import { createLoopEvents } from './events.js'
import { runPostTool, runPreTool, TOOL_HOOK_RESULT } from './executeToolCalls.js'
import { runPreStep } from './preStep.js'
import { runModelStep } from './step.js'
import { createSteeringController } from './steering.js'
import { createArtifactReplacementGuard, createDisabledToolGuard, createExplicitReadOnlyGuard, createRedundantImageGuard, createWorkspaceTargetGuard, resolveIterationWindow } from './guards.js'
import { FALSE_SUCCESS_STATUS, INCOMPLETE_STATUS, PUBLIC_FILTERED_CLARIFICATION_TEXT, PUBLIC_INCOMPLETE_TASK_TEXT, PUBLIC_UNVERIFIED_FILE_TEXT, STATUS_INQUIRY_PROMPT, isExplicitLocalMutationRetryRequest, isForcedToolChoiceCompatibilityError, isLocalMutationContinuationRequest, latestPriorTurnOutcome, mergeCompactionRecovery, normalizeArtifactIdList, normalizeCompactionRecovery, recoverPriorLocalMutationTargets, restoreNamedToolSpecs, sameArtifactIdList, sanitizeIncompleteTerminalText, sourceHandoffViolation, synchronizeCheckpointToolCallMessages } from './runtimeState.js'
import { hasEffectiveReadOnlyBoundary, resolveChatCapabilityMode, shouldInheritExecutionIntent } from '../chatToolSelection.js'
import { createRepeatCallGuard } from '../../utils/repeatCallGuard.js'
import { COMMAND_EXECUTION_TOOL_NAMES, GENERATED_ARTIFACT_TYPE, MAX_ITERS, JOB_READ_CONCURRENCY, ARTIFACT_DELIVERY_GUARD_MARKER, MAX_ARTIFACT_DELIVERY_RETRIES, EXECUTION_EVIDENCE_GUARD_MARKER, DIRECTORY_RESUME_GUARD_MARKER, AVAILABLE_TOOL_CAPABILITIES_MARKER, POST_MUTATION_VERIFICATION_GUARD_MARKER, PDF_LAYOUT_EXECUTION_CONTRACT_MARKER, PDF_LAYOUT_VERIFICATION_GUARD_MARKER, PDF_LAYOUT_VERIFICATION_OK, MAX_EXECUTION_EVIDENCE_RETRIES, MAX_DIRECTORY_RESUME_RETRIES, MAX_MUTATION_VERIFICATION_RETRIES, MAX_PDF_LAYOUT_VERIFICATION_RETRIES, VERIFIED_DIRECTORY_RESOLUTION, DIRECTORY_AUTHORIZATION_WAIT_CLAIM, EXPLICIT_LOCAL_DIRECTORY_CONTEXT, MANAGED_ATTACHMENT_MARKER, PROJECT_SCOPE_TARGET, VERIFICATION_TOOLS, SCHEDULED_WAIT_INTENT, FILE_WRITE_TOOL_NAMES, FAILURE_RECOVERY_MARKER, FAILURE_RECOVERY_THRESHOLD, EXECUTION_CONVERGENCE_MARKER, REPEAT_CALL_GUARD_MARKER, EXECUTION_CONVERGENCE_ROUND_THRESHOLD, MAX_INSTALL_ATTEMPT_SIGNATURES, toolNameFromSpec, isCommandExecutionTool, hasCommandExecutionTool, commandExecutionToolLabel, contradictedCapabilityClarification, isSuccessfulToolResult, requestedPdfSectionLabel, shouldRequirePdfLayoutVerification, buildPdfLayoutExecutionContract, isSuccessfulPdfLayoutVerification, restoreFailureRecovery, serializeFailureRecovery, installAttemptSignature, isProbeLikeCall, isExplorationOnlyCall, restoreExecutionConvergence, serializeExecutionConvergence, isProductiveExecutionOutcome, shouldReflectOnFailure, progressChangesFor, isLocalMutationCall, isVerificationCall, isMutationExecutionCall, normalizeMutationTarget, targetsMatch, shellTargetWithCwd, looksLikeDeletionCommand, staticDeletionTargets, extractMutationTargets, clearArtifactValidatedMutationTargets, clearVerifiedDeletionTargets, clearVerifiedMutationTargets, persistLocalToolArtifactsAsync, DIRECTORY_REVIEW_GUARD_MARKER, LIVE_STEERING_GUARD_MARKER, DIRECTORY_REVIEW_INTENT, buildRepresentativeReadCalls, hasSuccessfulLocalPreflightRead, successfulReadFileInMessages, requestedArtifactOutputDirective, executeServerTool, supportsIdempotentResume, SERVER_TOOL_SPECS, selectJobToolSpecs, buildJobToolIdempotencyKey, scopeTextToolCallIds } from '../toolLoopHeuristics.js'
import { initializeInputs } from './runtime-initializeInputs.js'
import { initializeArtifacts } from './runtime-initializeArtifacts.js'
import { initializeConversation } from './runtime-initializeConversation.js'
import { initializeCompletion } from './runtime-initializeCompletion.js'
import { initializeExecution } from './runtime-initializeExecution.js'
import { initializeSteering } from './runtime-initializeSteering.js'
import { prepareIteration } from './runtime-prepareIteration.js'
import { executeToolCalls } from './runtime-executeToolCalls.js'
import { createSideEffectExecution } from './sideEffectExecution.js'
import { installToolFailureRecovery } from './toolFailureRecovery.js'
import {
  buildTaskVerificationRepairPrompt,
  hasPendingTaskVerificationRepair,
  observeTaskVerificationMutation,
  observeTaskVerificationRepair,
  restoreTaskVerificationRepair,
  serializeTaskVerificationRepair,
  taskVerificationRepairBlockerText,
  taskVerificationRepairDetails,
  taskVerificationRepairExhausted,
} from './taskVerificationRepair.js'
import { createOutcomeRecorder } from './runtime-createOutcomeRecorder.js'
import { completeToolBatch } from './runtime-completeToolBatch.js'
import { completeIteration } from './runtime-completeIteration.js'
import { runModelRequest } from './runtime-runModelRequest.js'
import { processModelResult } from './runtime-processModelResult.js'
import { finalizeRuntime } from './runtime-finalizeRuntime.js'
import { assertRuntimeDependencies } from './runtimeContract.js'
import { isTrustedInternalLoopPrincipal } from './internalExecutionPrincipal.js'
import {
  appendFinalAnswerToolEvidence,
  buildFinalAnswerEvidenceReviewPrompt,
  buildFinalAnswerEvidenceSnapshot,
  collectFinalAnswerToolEvidence,
  finalAnswerEvidenceDigest,
  normalizeFinalAnswerToolEvidence,
} from './finalAnswerEvidenceReview.js'
import {
  createSideEffectScope,
  getSideEffectExecutionLedger,
  resolveSideEffectExecutionLedger,
  SIDE_EFFECT_LEDGER_CONFLICT,
  SIDE_EFFECT_OUTCOME_UNKNOWN,
  sideEffectRecoveryBlock,
} from '../sideEffectExecutionLedger.js'

const DELIVERABLE_SELECTION_GUARD_MARKER = '[FINAL DELIVERABLE SELECTION REQUIRED]'
const DELIVERABLE_SELECTION_FALLBACK_MARKER = '[FINAL DELIVERABLE SAFE FALLBACK]'
const MAX_DELIVERABLE_SELECTION_RETRIES = 2
const SOURCE_HANDOFF_GUARD_MARKER = '[SOURCE HANDOFF BLOCKED]'
const MAX_SOURCE_HANDOFF_RETRIES = 1
const LOCAL_HTML_DELIVERY_GUARD_MARKER = '[LOCAL HTML DELIVERY VALIDATION REQUIRED]'
const MAX_LOCAL_HTML_DELIVERY_RETRIES = 4
const ARTIFACT_RECOVERY_DIAGNOSIS_MARKER = '[ARTIFACT RECOVERY DIAGNOSIS]'
const ARTIFACT_RECOVERY_FORCE_MARKER = '[ARTIFACT RECOVERY GENERATOR REQUIRED]'
const ARTIFACT_RECOVERY_PHASE_DIAGNOSE = 'diagnose'
const ARTIFACT_RECOVERY_PHASE_FORCE = 'force'
const MAX_ARTIFACT_RECOVERY_DIAGNOSTIC_ROUNDS = 2
const LIVE_ARTIFACT_CONTRACT_MARKER = '[LIVE ARTIFACT CONTRACT UPDATED]'
const DYNAMIC_EXECUTION_TOOL_RECOVERY_MARKER = '[DYNAMIC EXECUTION TOOL RECOVERY]'
const DYNAMIC_EXECUTION_TARGET_MARKER = '[CANONICAL LOCAL FILE CONTINUATION]'
const DYNAMIC_EXECUTION_TOOL_NAMES = new Set([
  'list_directory',
  'read_file',
  'write_file',
  'edit_file',
  'multi_edit',
  'apply_patch',
  'patch_file',
  'bash_exec',
  'run_command',
  'run_project_check',
  'git_status',
  'git_diff',
])
const DYNAMIC_MUTATION_TOOL_NAMES = new Set([
  'write_file',
  'edit_file',
  'multi_edit',
  'apply_patch',
  'patch_file',
  'bash_exec',
  'run_command',
])
const PATCH_WRITE_TOOL_NAMES = new Set([
  'write_file',
  'edit_file',
  'patch_file',
  'apply_patch',
])
const CAPABILITY_CONTROL_TOOL_NAMES = new Set([
  'Agent',
  'manage_todos',
  'reflect',
  'request_clarification',
  'request_directory',
  'set_deliverables',
  'sleep_until',
])
const MAX_CAPABILITY_TOOL_NAMES = 256

const runtimeDependencies = {
  ARTIFACT_DELIVERY_GUARD_MARKER,
  ARTIFACT_RECOVERY_DIAGNOSIS_MARKER,
  ARTIFACT_RECOVERY_FORCE_MARKER,
  ARTIFACT_RECOVERY_PHASE_DIAGNOSE,
  ARTIFACT_RECOVERY_PHASE_FORCE,
  AVAILABLE_TOOL_CAPABILITIES_MARKER,
  CAPABILITY_CONTROL_TOOL_NAMES,
  CHECKPOINT_FLUSH_ERROR_CODE,
  COMMAND_EXECUTION_TOOL_NAMES,
  DEFAULT_MODEL_PHASE_HEARTBEAT_MS,
  DELIVERABLE_SELECTION_FALLBACK_MARKER,
  DELIVERABLE_SELECTION_GUARD_MARKER,
  DIRECTORY_AUTHORIZATION_WAIT_CLAIM,
  DIRECTORY_RESUME_GUARD_MARKER,
  DIRECTORY_REVIEW_GUARD_MARKER,
  DIRECTORY_REVIEW_INTENT,
  DYNAMIC_EXECUTION_TARGET_MARKER,
  DYNAMIC_EXECUTION_TOOL_NAMES,
  DYNAMIC_EXECUTION_TOOL_RECOVERY_MARKER,
  DYNAMIC_MUTATION_TOOL_NAMES,
  EXECUTION_CONVERGENCE_MARKER,
  EXECUTION_CONVERGENCE_ROUND_THRESHOLD,
  EXECUTION_EVIDENCE_GUARD_MARKER,
  EXPLICIT_LOCAL_DIRECTORY_CONTEXT,
  FAILURE_RECOVERY_MARKER,
  FAILURE_RECOVERY_THRESHOLD,
  FALSE_SUCCESS_STATUS,
  FILE_WRITE_TOOL_NAMES,
  GENERATED_ARTIFACT_TYPE,
  INCOMPLETE_STATUS,
  JOB_READ_CONCURRENCY,
  LIVE_ARTIFACT_CONTRACT_MARKER,
  LIVE_STEERING_GUARD_MARKER,
  LOCAL_HTML_DELIVERY_GUARD_MARKER,
  MANAGED_ATTACHMENT_MARKER,
  MAX_ARTIFACT_DELIVERY_RETRIES,
  MAX_ARTIFACT_RECOVERY_DIAGNOSTIC_ROUNDS,
  MAX_CAPABILITY_TOOL_NAMES,
  MAX_DELIVERABLE_SELECTION_RETRIES,
  MAX_DIRECTORY_RESUME_RETRIES,
  MAX_EXECUTION_EVIDENCE_RETRIES,
  MAX_INSTALL_ATTEMPT_SIGNATURES,
  MAX_ITERS,
  MAX_LOCAL_HTML_DELIVERY_RETRIES,
  MAX_MUTATION_VERIFICATION_RETRIES,
  MAX_PDF_LAYOUT_VERIFICATION_RETRIES,
  MAX_SOURCE_HANDOFF_RETRIES,
  PATCH_WRITE_TOOL_NAMES,
  PDF_LAYOUT_EXECUTION_CONTRACT_MARKER,
  PDF_LAYOUT_VERIFICATION_GUARD_MARKER,
  PDF_LAYOUT_VERIFICATION_OK,
  POST_MUTATION_VERIFICATION_GUARD_MARKER,
  PROJECT_SCOPE_TARGET,
  PUBLIC_FILTERED_CLARIFICATION_TEXT,
  PUBLIC_INCOMPLETE_TASK_TEXT,
  PUBLIC_UNVERIFIED_FILE_TEXT,
  REPEAT_CALL_GUARD_MARKER,
  SCHEDULED_WAIT_INTENT,
  SERVER_TOOL_SPECS,
  SOURCE_HANDOFF_GUARD_MARKER,
  STATUS_INQUIRY_PROMPT,
  TOOL_HOOK_RESULT,
  VERIFICATION_TOOLS,
  VERIFIED_DIRECTORY_RESOLUTION,
  allowedArtifactTools,
  attachJobBudget,
  appendFinalAnswerToolEvidence,
  buildAssistantToolCallsMessage,
  buildFinalAnswerEvidenceReviewPrompt,
  buildFinalAnswerEvidenceSnapshot,
  collectFinalAnswerToolEvidence,
  buildJobToolIdempotencyKey,
  buildPdfLayoutExecutionContract,
  buildRepresentativeReadCalls,
  buildToolResultMessage,
  buildToolResultMessageBundle,
  buildTaskVerificationRepairPrompt,
  callModelWithContextRecovery,
  clearArtifactValidatedMutationTargets,
  clearVerifiedDeletionTargets,
  clearVerifiedMutationTargets,
  commandExecutionToolLabel,
  contradictedCapabilityClarification,
  createArtifactReplacementGuard,
  createCheckpointBarrier,
  createDisabledToolGuard,
  createExplicitReadOnlyGuard,
  createJobBudget,
  createLoopEvents,
  createModelPhaseHeartbeat,
  createPartialResultFallback,
  createRedundantImageGuard,
  createRepeatCallGuard,
  createSteeringController,
  createSideEffectScope,
  createSideEffectExecution,
  createSubagentApprovalContext,
  createTruncatedToolCallResult,
  createToolAbortScope,
  createToolLoopGuard,
  createWorkspaceTargetGuard,
  ensureSafetySystemMessages,
  executeServerTool,
  executeToolWithRetry,
  extractMutationTargets,
  extractTextToolCalls,
  filterCurrentDynamicToolSpecs,
  finalAnswerEvidenceDigest,
  findAdjacentDeliveredArtifacts,
  findContinuableArtifactTargets,
  findExplicitlyReferencedDeliveredArtifacts,
  formatDeniedToolResult,
  getDefaultOutputDirectory,
  getJobBudget,
  getProjectDirectory,
  getSideEffectExecutionLedger,
  getToolMetadata,
  matchesDynamicToolRegistration,
  hasCommandExecutionTool,
  hasSuccessfulLocalPreflightRead,
  hasEffectiveReadOnlyBoundary,
  hasMutationExecutionIntent,
  hasPendingTaskVerificationRepair,
  installAttemptSignature,
  inspectToolLoopModelResponse,
  isArtifactRevisionRequest,
  isCommandExecutionTool,
  isContextLengthError,
  isExecutionCapabilityChallenge,
  isExplicitCodeSnippetRequest,
  isExplicitLocalMutationRetryRequest,
  isExplorationOnlyCall,
  isFileArtifactTool,
  isForcedToolChoiceCompatibilityError,
  installToolFailureRecovery,
  isLocalMutationCall,
  isLocalMutationContinuationRequest,
  isLoopPauseResult,
  isMutationExecutionCall,
  isProbeLikeCall,
  isProductiveExecutionOutcome,
  isSubstantiveToolCall,
  isSuccessfulPdfLayoutVerification,
  isSuccessfulToolResult,
  isTrustedInternalLoopPrincipal,
  isTextDeliverableRequest,
  isVerificationCall,
  latestPriorTurnOutcome,
  listTurnArtifacts,
  looksLikeDeletionCommand,
  mapWithConcurrency,
  mergeCompactionRecovery,
  normalizeArtifactIdList,
  normalizeFinalAnswerToolEvidence,
  normalizeCompactionRecovery,
  normalizeDirectoryAuthorizationResolutions,
  normalizeMutationTarget,
  normalizeToolCalls,
  normalizeToolError,
  normalizeToolResult,
  observeTaskVerificationMutation,
  observeTaskVerificationRepair,
  observeToolCalls,
  parseSkillIdFromPrompt,
  path,
  persistLocalToolArtifactsAsync,
  progressChangesFor,
  recordToolProgress,
  recoverPriorLocalMutationTargets,
  recordRecoveredModelResult,
  rememberApprovedSubagentCall,
  replaceRuntimeCapabilityBlock,
  requiresPerCallApproval,
  requestApproval,
  requestedArtifactOutputDirective,
  requestedPdfSectionLabel,
  resolveArtifactDeliveryTargets,
  resolveArtifactRevisionMode,
  resolveChatCapabilityMode,
  resolveIterationWindow,
  resolveToolResultMaxChars,
  restoreDirectoryAuthorizationToolSpecs,
  restoreExecutionConvergence,
  restoreFailureRecovery,
  restoreNamedToolSpecs,
  restoreToolProgress,
  restoreTaskVerificationRepair,
  resolveSideEffectExecutionLedger,
  resumePersistedApproval,
  revalidateHookAuthorization,
  revalidateToolPermission,
  runModelStep,
  runPostTool,
  runPreStep,
  runPreTool,
  runWithModelBudget,
  sameArtifactIdList,
  sanitizeIncompleteTerminalText,
  SIDE_EFFECT_LEDGER_CONFLICT,
  SIDE_EFFECT_OUTCOME_UNKNOWN,
  sideEffectRecoveryBlock,
  scopeTextToolCallIds,
  selectJobToolSpecs,
  snapshotDynamicToolSpecRegistrations,
  serializeExecutionConvergence,
  serializeFailureRecovery,
  serializeToolProgress,
  serializeTaskVerificationRepair,
  shellTargetWithCwd,
  shouldInheritExecutionIntent,
  shouldReflectOnFailure,
  shouldRequireExecution,
  shouldRequirePdfLayoutVerification,
  sourceHandoffViolation,
  staticDeletionTargets,
  stripEphemeralToolMediaMessages,
  successfulReadFileInMessages,
  supportsIdempotentResume,
  synchronizeCheckpointToolCallMessages,
  targetsMatch,
  taskVerificationRepairBlockerText,
  taskVerificationRepairDetails,
  taskVerificationRepairExhausted,
  toolNameFromSpec,
  toolProgressPayload,
  validateLocalHtmlDelivery,
  validateToolCall,
  writeToolAudit,
}

async function runPhase(phase, state) {
  const outcome = await phase(state)
  return outcome || { kind: 'next' }
}

const preparedToolsLoopRuntimes = new WeakMap()
const NO_PREPARED_TERMINAL_OUTCOME = Object.freeze({ terminal: false })

function preparedRuntimeError(code, message) {
  return Object.assign(new TypeError(message), {
    code,
    retryable: false,
  })
}

function getPreparedRuntimeRecord(prepared) {
  const record = preparedToolsLoopRuntimes.get(prepared)
  if (!record) {
    throw preparedRuntimeError(
      'TOOLS_LOOP_RUNTIME_PREPARED_INVALID',
      'A prepared Tools Loop runtime handle created by this module is required',
    )
  }
  if (record.status !== 'prepared') {
    throw preparedRuntimeError(
      'TOOLS_LOOP_RUNTIME_PREPARED_STALE',
      'The prepared Tools Loop runtime handle is already in use or consumed',
    )
  }
  return record
}

/**
 * Run the initialization boundary and retain its mutable state behind an
 * opaque, module-branded handle. The handle deliberately has no properties:
 * the handle itself cannot be used to inspect or replace the phase state.
 */
export async function prepareToolsLoopRuntime(context) {
  // The generated phases intentionally share this dependency bag. Validate the
  // small bootstrap subset here so refactors fail at the boundary, not mid-turn.
  assertRuntimeDependencies(runtimeDependencies)
  const s = { context, d: runtimeDependencies, iteration: null }
  let terminalOutcome = null
  for (const phase of [
    initializeInputs,
    initializeArtifacts,
    initializeConversation,
    initializeCompletion,
    initializeExecution,
    initializeSteering,
  ]) {
    const outcome = await runPhase(phase, s)
    if (outcome.kind === 'return') {
      terminalOutcome = outcome
      break
    }
  }

  const prepared = Object.freeze(Object.create(null))
  preparedToolsLoopRuntimes.set(prepared, {
    state: s,
    terminalOutcome,
    status: 'prepared',
  })
  return prepared
}

/**
 * Trusted host-internal escape hatch for installing canonical brokers around a
 * prepared runtime without putting mutable state on the handle. The callback
 * receives mutable state and can retain it, so this must never be re-exported
 * as a plugin or public API boundary.
 * Operations are synchronous and cannot be nested with execution or another
 * operation on the same handle.
 */
export function usePreparedToolsLoopRuntime(prepared, operation) {
  const record = getPreparedRuntimeRecord(prepared)
  if (typeof operation !== 'function') {
    throw preparedRuntimeError(
      'TOOLS_LOOP_RUNTIME_OPERATION_INVALID',
      'Prepared Tools Loop runtime operation must be a function',
    )
  }
  record.status = 'accessing'
  try {
    return operation(record.state)
  } finally {
    if (record.status === 'accessing') record.status = 'prepared'
  }
}

/**
 * Inspect the initialization outcome without exposing its mutable record.
 * A terminal outcome consumes the handle because running its partially
 * initialized state would violate the phase contract.
 */
export function consumePreparedToolsLoopTerminalOutcome(prepared) {
  const record = getPreparedRuntimeRecord(prepared)
  if (!record.terminalOutcome) return NO_PREPARED_TERMINAL_OUTCOME

  const result = Object.freeze({
    terminal: true,
    value: record.terminalOutcome.value,
  })
  record.status = 'consumed'
  record.state = null
  record.terminalOutcome = null
  return result
}

async function runPreparedToolsLoopState(s) {
  for (; s.iter < s.maxIters; s.iter += 1) {
    s.iteration = {}
    let outcome = await runPhase(prepareIteration, s)
    if (outcome.kind === 'return') return outcome.value
    if (outcome.kind === 'continue') continue
    if (outcome.kind === 'break') break

    if (s.checkpointCalls?.length) {
      s.iteration.toolCalls = s.checkpointCalls
    } else {
      outcome = await runPhase(runModelRequest, s)
      if (outcome.kind === 'return') return outcome.value
      if (outcome.kind === 'continue') continue
      if (outcome.kind === 'break') break
      outcome = await runPhase(processModelResult, s)
      if (outcome.kind === 'return') return outcome.value
      if (outcome.kind === 'continue') continue
      if (outcome.kind === 'break') break
    }

    for (const phase of [executeToolCalls, createOutcomeRecorder, completeToolBatch, completeIteration]) {
      outcome = await runPhase(phase, s)
      if (outcome.kind === 'return') return outcome.value
      if (outcome.kind === 'continue') break
      if (outcome.kind === 'break') return finalizeRuntime(s)
    }
    if (outcome?.kind === 'continue') continue
  }
  return finalizeRuntime(s)
}

/** Execute exactly once from a module-branded prepared runtime handle. */
export async function executePreparedToolsLoop(prepared) {
  const record = getPreparedRuntimeRecord(prepared)
  record.status = 'executing'
  try {
    if (record.terminalOutcome) return record.terminalOutcome.value
    return await runPreparedToolsLoopState(record.state)
  } finally {
    record.status = 'consumed'
    record.state = null
    record.terminalOutcome = null
  }
}

export async function runToolsLoopCore(context) {
  const prepared = await prepareToolsLoopRuntime(context)
  return executePreparedToolsLoop(prepared)
}
