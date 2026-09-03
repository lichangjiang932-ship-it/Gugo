import { appendJobEvent, approveJobPlan } from './jobStore.js'
import { getApprovalMode } from './approvalSettingsStore.js'
import { buildJobOutcomeDiagnostics, normalizeStructuredPlanSteps } from './jobWorkflow.js'
import {
  buildJobPlanProposalPayload,
  computeJobPlanDigest,
  JOB_PLAN_APPROVAL_CONTRACT,
  JOB_PLAN_APPROVAL_VERSION,
  resolveJobPlanApproval,
} from './jobPlanPolicyRuntime.js'

const EDITABLE_STEP_KINDS = new Set(['execute', 'batch_item', 'verify', 'finalize'])
const REUSABLE_STEP_STATUSES = new Set(['queued', 'pending'])
const PLAN_CHANGED_STATUSES = new Set([
  'proposal_changed',
  'plan_changed',
  'proposal_contract_invalid',
])
const REFRESHABLE_PLAN_STATUSES = new Set(['plan_changed', 'proposal_contract_invalid'])

function proposalChanged(job) {
  return {
    approved: false,
    error: 'the proposed plan changed; review the latest plan before approving',
    code: 'JOB_PLAN_PROPOSAL_CHANGED',
    job,
  }
}

function normalizeReplacementSteps(job, steps, createStepId) {
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > 50) {
    return { error: 'plan must contain between 1 and 50 steps' }
  }
  const reusableStepIds = new Set(job.steps
    .filter((step) => step.kind !== 'plan' && REUSABLE_STEP_STATUSES.has(step.status))
    .map((step) => step.id))
  const reusedStepIds = new Set()
  const normalizedInput = normalizeStructuredPlanSteps(steps)
  if (normalizedInput.length > 50) {
    return { error: 'plan may contain at most 50 steps including verification and delivery' }
  }
  const replacementSteps = normalizedInput.map((step, index) => {
    const reuseId = reusableStepIds.has(step.id) && !reusedStepIds.has(step.id)
    if (reuseId) reusedStepIds.add(step.id)
    return {
      ...step,
      id: reuseId ? step.id : createStepId(),
      kind: EDITABLE_STEP_KINDS.has(step.kind) ? step.kind : 'execute',
      title: String(step.title || '').trim().slice(0, 200),
      sortOrder: index + 1,
    }
  })
  if (replacementSteps.some((step) => !step.title)) {
    return { error: 'every plan step requires a title' }
  }
  return { replacementSteps }
}

function appendRefreshedProposal({ jobId, job, authorization, emit }) {
  const diagnostics = buildJobOutcomeDiagnostics(job, {
    reason: authorization.reason || 'plan_approval_required',
    nextAction: 'approve_plan',
    status: 'waiting',
  })
  const event = appendJobEvent({
    jobId,
    type: 'plan_proposed',
    code: 'JOB_PLAN_REVIEW_REFRESHED',
    payload: {
      ...buildJobPlanProposalPayload(job, {
        reason: authorization.reason,
        supersedesProposalEventId: authorization.proposal?.id || null,
      }),
      ...diagnostics,
    },
  })
  emit(event)
  return event
}

export function approveRuntimeJobPlan({
  jobId,
  userId,
  steps = null,
  proposalEventId = null,
  planDigest = null,
  getJob,
  emit,
  createStepId,
}) {
  const job = getJob(jobId, { userId })
  if (!job) return null
  let authorization = resolveJobPlanApproval(job)
  if (!authorization.proposal) {
    return { approved: false, error: 'job is not waiting for plan approval', job }
  }
  if ((proposalEventId != null && Number(proposalEventId) !== Number(authorization.proposal.id))
    || (planDigest != null && String(planDigest) !== authorization.proposal.payload?.planDigest)) {
    return proposalChanged(job)
  }
  if (authorization.needsNewProposal) {
    if (job.status !== 'waiting') {
      return { approved: false, error: 'job is not waiting for plan approval', job }
    }
    const refreshed = appendRefreshedProposal({
      jobId,
      job,
      authorization,
      emit,
    })
    return {
      approved: false,
      error: 'the plan was refreshed; review it before approving',
      code: 'JOB_PLAN_REVIEW_REFRESHED',
      proposalEventId: refreshed.id,
      planDigest: refreshed.payload.planDigest,
      job: getJob(jobId, { userId }),
    }
  }

  let replacementSteps = null
  if (steps != null) {
    const normalized = normalizeReplacementSteps(job, steps, createStepId)
    if (normalized.error) return { approved: false, error: normalized.error, job }
    replacementSteps = normalized.replacementSteps
  }
  const previousMode = getApprovalMode({ userId })
  const committed = approveJobPlan({
    jobId,
    userId,
    proposalEventId: authorization.proposal.id,
    proposalPlanDigest: authorization.proposal.payload.planDigest,
    approvedPlanDigest: computeJobPlanDigest(replacementSteps ?? job.steps),
    replacementSteps,
    edited: replacementSteps !== null,
    previousMode,
    contract: JOB_PLAN_APPROVAL_CONTRACT,
    version: JOB_PLAN_APPROVAL_VERSION,
    computePlanDigest: computeJobPlanDigest,
  })
  if (committed.status === 'not_found') return null
  if (committed.status !== 'approved') {
    let latestJob = getJob(jobId, { userId })
    authorization = resolveJobPlanApproval(latestJob)
    if (REFRESHABLE_PLAN_STATUSES.has(committed.status)
      && latestJob?.status === 'waiting'
      && authorization.needsNewProposal) {
      appendRefreshedProposal({
        jobId,
        job: latestJob,
        authorization,
        emit,
      })
      latestJob = getJob(jobId, { userId })
      authorization = resolveJobPlanApproval(latestJob)
    }
    return {
      approved: false,
      error: PLAN_CHANGED_STATUSES.has(committed.status)
        ? 'the proposed plan changed; review the latest plan before approving'
        : 'job is not waiting for plan approval',
      code: PLAN_CHANGED_STATUSES.has(committed.status)
        ? 'JOB_PLAN_PROPOSAL_CHANGED'
        : 'JOB_PLAN_NOT_WAITING',
      proposalEventId: authorization.proposal?.id || null,
      planDigest: authorization.proposal?.payload?.planDigest || null,
      job: latestJob,
    }
  }
  if (!committed.idempotent) emit(committed.event)
  return {
    approved: true,
    idempotent: committed.idempotent === true,
    previousMode: committed.event?.payload?.previousMode ?? previousMode,
    mode: committed.event?.payload?.mode ?? previousMode,
    edited: committed.event?.payload?.edited === true,
    proposalEventId: authorization.proposal.id,
    planDigest: committed.approvedPlanDigest,
    job: getJob(jobId, { userId }),
  }
}
