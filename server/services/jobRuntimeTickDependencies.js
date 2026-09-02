import {
  appendJobEvent,
  getJob as getJobRow,
  getJobWithChildren,
  listJobSteps,
  listRecoverableJobs,
  updateJob,
  updateJobStep,
} from './jobStore.js'
import { createNotification } from './notificationsStore.js'
import { dispatchHooks } from './hooksService.js'
import { getApprovalMode } from './approvalSettingsStore.js'
import {
  cancelJobWake,
  claimDueJobWakes,
  scheduleJobWake,
} from './jobWakeStore.js'
import { blockClaimedAutoRetryWakeTransition } from './jobRuntimeTransitionStore.js'
import {
  acknowledgeJobSteering,
  claimJobSteering,
  releaseJobSteeringLease,
} from './jobSteeringStore.js'
import {
  buildFinalOutput,
  buildJobOutcomeDiagnostics,
  clearCompletedJobOutcomeDiagnostics,
  clearResumedJobOutcomeDiagnostics,
  deriveJobProgress,
  findNextRunnableStep,
  resolveWorkflowState,
  stepRequiresPlanApproval,
} from './jobWorkflow.js'
import {
  latestPersistedOutcomeFields,
  persistJobOutcomeDiagnostics,
} from './jobRuntimeProjection.js'
import {
  emitTaskReviewEvent,
  persistRejectedStepResult,
  runVerificationRepairLoop,
} from './jobAcceptanceRuntime.js'
import {
  buildJobPlanProposalPayload,
  JOB_PLAN_APPROVAL_CONTRACT,
  JOB_PLAN_APPROVAL_VERSION,
  resolveJobPlanApproval,
} from './jobPlanPolicyRuntime.js'
import { createJobTickBudgetScope } from './jobTickBudgetScope.js'
import { userCancellationError } from '../utils/toolCancellation.js'
import {
  lostJobExecutionLease,
  notifyJobStopHook,
  notifyJobTerminal,
} from './jobRuntimeLifecycle.js'
import { isModelReadinessError } from './modelReadinessService.js'
import { hasExplicitIncompleteStepOutput } from './jobRetryEligibility.js'
import { persistJobStepFailure } from './jobStepFailureRuntime.js'
import { TERMINAL_JOB_STATUSES } from './jobRuntimeRetryCommands.js'

const JOB_CANCELLED_MESSAGE = '任务已由用户终止'
// awaiting_approval intentionally remains suspended. Re-queuing approved work
// during crash recovery could repeat an irreversible action.
const SUSPENDED_JOB_STATUSES = new Set(['waiting', 'awaiting_approval'])

export const DEFAULT_JOB_RUNTIME_TICK_DEPENDENCIES = Object.freeze({
  claimDueJobWakes,
  blockClaimedAutoRetryWakeTransition,
  appendJobEvent,
  listRecoverableJobs,
  SUSPENDED_JOB_STATUSES,
  createJobTickBudgetScope,
  getJobRow,
  getJobWithChildren,
  listJobSteps,
  updateJob,
  updateJobStep,
  clearResumedJobOutcomeDiagnostics,
  latestPersistedOutcomeFields,
  JOB_CANCELLED_MESSAGE,
  deriveJobProgress,
  persistJobOutcomeDiagnostics,
  notifyJobTerminal,
  notifyJobStopHook,
  findNextRunnableStep,
  resolveWorkflowState,
  resolveJobPlanApproval,
  buildJobOutcomeDiagnostics,
  buildJobPlanProposalPayload,
  JOB_PLAN_APPROVAL_CONTRACT,
  JOB_PLAN_APPROVAL_VERSION,
  createNotification,
  isModelReadinessError,
  dispatchHooks,
  buildFinalOutput,
  clearCompletedJobOutcomeDiagnostics,
  userCancellationError,
  claimJobSteering,
  acknowledgeJobSteering,
  releaseJobSteeringLease,
  runVerificationRepairLoop,
  lostJobExecutionLease,
  hasExplicitIncompleteStepOutput,
  scheduleJobWake,
  cancelJobWake,
  persistRejectedStepResult,
  stepRequiresPlanApproval,
  getApprovalMode,
  emitTaskReviewEvent,
  persistJobStepFailure,
  TERMINAL_JOB_STATUSES,
})
