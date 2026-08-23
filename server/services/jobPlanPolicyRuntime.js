import crypto from 'node:crypto'
import { persistPlannedJob } from './jobCreation.js'
import { normalizeStructuredPlanSteps } from './jobWorkflow.js'

export const JOB_PLAN_APPROVAL_CONTRACT = 'gugo.job-plan-approval'
export const JOB_PLAN_APPROVAL_VERSION = 1

function normalizeCanonicalJson(value) {
  if (value == null) return null
  if (Array.isArray(value)) return value.map(normalizeCanonicalJson)
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value !== 'object') return null
  return Object.fromEntries(Object.keys(value)
    .sort()
    .filter((key) => value[key] !== undefined)
    .map((key) => [key, normalizeCanonicalJson(value[key])]))
}

/**
 * Build the semantic plan covered by an approval. Runtime-only fields such as
 * status, output, timestamps, and generated row ids are deliberately omitted:
 * retries and execution progress must not invalidate an otherwise identical
 * approval, while order, parent relationships, kind, title, and input do.
 */
export function normalizeJobPlanForApproval(steps = []) {
  const ordered = (Array.isArray(steps) ? steps : [])
    .map((step, sourceIndex) => ({ step, sourceIndex }))
    .filter(({ step }) => step?.kind !== 'plan')
    .sort((left, right) => {
      const leftOrder = Number.isFinite(Number(left.step?.sortOrder))
        ? Number(left.step.sortOrder)
        : left.sourceIndex
      const rightOrder = Number.isFinite(Number(right.step?.sortOrder))
        ? Number(right.step.sortOrder)
        : right.sourceIndex
      return leftOrder - rightOrder || left.sourceIndex - right.sourceIndex
    })
  const positions = new Map(ordered
    .map(({ step }, index) => [String(step?.id || ''), index + 1])
    .filter(([id]) => id))

  return ordered.map(({ step }, index) => {
    const parentId = String(step?.parentStepId || '').trim()
    return {
      order: index + 1,
      title: String(step?.title || '').trim(),
      kind: String(step?.kind || '').trim(),
      parent: parentId ? (positions.get(parentId) || `external:${parentId}`) : null,
      input: normalizeCanonicalJson(step?.input ?? null),
    }
  })
}

export function computeJobPlanDigest(steps = []) {
  const canonical = JSON.stringify({
    contract: JOB_PLAN_APPROVAL_CONTRACT,
    version: JOB_PLAN_APPROVAL_VERSION,
    steps: normalizeJobPlanForApproval(steps),
  })
  return crypto.createHash('sha256').update(canonical).digest('hex')
}

function isDigest(value) {
  return /^[a-f0-9]{64}$/.test(String(value || ''))
}

function isVersionedProposal(event) {
  return event?.type === 'plan_proposed'
    && event.payload?.contract === JOB_PLAN_APPROVAL_CONTRACT
    && event.payload?.version === JOB_PLAN_APPROVAL_VERSION
    && isDigest(event.payload?.planDigest)
}

function isVersionedApproval(event, proposal) {
  return event?.type === 'plan_approved'
    && event.payload?.contract === JOB_PLAN_APPROVAL_CONTRACT
    && event.payload?.version === JOB_PLAN_APPROVAL_VERSION
    && Number(event.payload?.proposalEventId) === Number(proposal?.id)
    && event.payload?.proposalPlanDigest === proposal?.payload?.planDigest
    && isDigest(event.payload?.approvedPlanDigest)
}

export function resolveJobPlanApproval(job) {
  const events = Array.isArray(job?.events) ? job.events : []
  const explicitApprovalRequired = (job?.steps || []).some((step) => (
    step.kind === 'plan' && step.input?.requirePlanApproval === true
  ))
  const proposal = [...events].reverse().find((event) => event.type === 'plan_proposed') || null
  const required = explicitApprovalRequired || proposal !== null
  const currentPlanDigest = computeJobPlanDigest(job?.steps)
  if (!required) {
    return {
      required: false,
      authorized: true,
      reason: 'not_required',
      currentPlanDigest,
      proposal: null,
      approval: null,
      needsNewProposal: false,
    }
  }
  if (!proposal) {
    return {
      required: true,
      authorized: false,
      reason: 'proposal_missing',
      currentPlanDigest,
      proposal: null,
      approval: null,
      needsNewProposal: true,
    }
  }
  if (!isVersionedProposal(proposal)) {
    return {
      required: true,
      authorized: false,
      reason: 'proposal_contract_outdated',
      currentPlanDigest,
      proposal,
      approval: null,
      needsNewProposal: true,
    }
  }

  const approval = [...events].reverse().find((event) => (
    event.type === 'plan_approved'
      && Number(event.payload?.proposalEventId) === Number(proposal.id)
  )) || null
  if (isVersionedApproval(approval, proposal)) {
    if (approval.payload.approvedPlanDigest === currentPlanDigest) {
      return {
        required: true,
        authorized: true,
        reason: 'approved',
        currentPlanDigest,
        proposal,
        approval,
        needsNewProposal: false,
      }
    }
    return {
      required: true,
      authorized: false,
      reason: 'approved_plan_drifted',
      currentPlanDigest,
      proposal,
      approval,
      needsNewProposal: true,
    }
  }

  const proposalStillCurrent = proposal.payload.planDigest === currentPlanDigest
  return {
    required: true,
    authorized: false,
    reason: approval ? 'approval_contract_outdated' : 'approval_missing',
    currentPlanDigest,
    proposal,
    approval,
    needsNewProposal: !proposalStillCurrent,
  }
}

export function buildJobPlanProposalPayload(job, {
  planGuard = null,
  reason = 'approval_required',
  supersedesProposalEventId = null,
} = {}) {
  const steps = (job?.steps || []).filter((step) => step.kind !== 'plan')
  return {
    contract: JOB_PLAN_APPROVAL_CONTRACT,
    version: JOB_PLAN_APPROVAL_VERSION,
    planDigest: computeJobPlanDigest(steps),
    reason,
    ...(supersedesProposalEventId == null ? {} : { supersedesProposalEventId }),
    plan: {
      title: job?.title || '',
      objective: job?.prompt || '',
      steps: steps.map((step) => ({
        id: step.id,
        title: step.title,
        kind: step.kind,
        input: step.input || null,
      })),
    },
    ...(planGuard ? { planGuard } : {}),
  }
}

function hasPendingRequiredPlanApproval(job) {
  const approval = resolveJobPlanApproval(job)
  return approval.required && !approval.authorized
}

function planApprovalIsWaiting(job) {
  if (!hasPendingRequiredPlanApproval(job) || job?.status !== 'waiting') return false
  const latestSuspension = [...(job.events || [])]
    .reverse()
    .find((event) => event.type === 'plan_proposed' || event.type === 'awaiting_user')
  return latestSuspension?.type === 'plan_proposed'
}

function planApprovalRequiredError() {
  const error = new Error('the proposed plan requires explicit approval before this action')
  error.code = 'JOB_PLAN_APPROVAL_REQUIRED'
  error.statusCode = 409
  return error
}

export function normalizeJobModelSnapshot({
  modelName,
  modelProviderId = null,
  modelConfigRevision = null,
} = {}) {
  return {
    modelName: String(modelName || '').trim().slice(0, 512) || undefined,
    modelProviderId,
    modelConfigRevision,
  }
}

export function assertJobPlanApprovalResolved(job) {
  const approval = resolveJobPlanApproval(job)
  if (approval.required && !approval.authorized) {
    const error = planApprovalRequiredError()
    error.reason = approval.reason
    error.proposalEventId = approval.proposal?.id || null
    error.planDigest = approval.currentPlanDigest
    throw error
  }
}

export function assertJobPlanRetryAllowed(job, step = null) {
  if (!hasPendingRequiredPlanApproval(job)) return
  if (!planApprovalIsWaiting(job) && (!step || step.kind === 'plan')) return
  throw planApprovalRequiredError()
}

export async function prepareGuardedTaskPlan({
  plan,
  prompt,
  modelName,
  requirePlanApproval = false,
  taskPlanGuard,
}) {
  const normalizedPlan = {
    ...plan,
    prompt: plan?.prompt || String(prompt || '').trim(),
    steps: normalizeStructuredPlanSteps(plan?.steps),
  }
  const result = await taskPlanGuard({
    plan: normalizedPlan,
    modelName,
    requirePlanApproval,
  })
  return {
    plan: normalizedPlan,
    requirePlanApproval: requirePlanApproval === true || result?.requirePlanApproval === true,
    planGuard: result?.guard || null,
  }
}

export async function persistGuardedGeneratedPlan({
  id,
  userId,
  prompt,
  plan,
  modelName,
  modelProviderId,
  modelConfigRevision,
  requirePlanApproval,
  sourceType,
  sourceId,
  grants,
  taskPlanGuard,
}) {
  const guarded = await prepareGuardedTaskPlan({
    plan,
    prompt,
    modelName,
    requirePlanApproval,
    taskPlanGuard,
  })
  const event = persistPlannedJob({
    id,
    userId,
    prompt,
    plan: guarded.plan,
    modelName,
    modelProviderId,
    modelConfigRevision,
    requirePlanApproval: guarded.requirePlanApproval,
    sourceType,
    sourceId,
    grants,
    planGuard: guarded.planGuard,
  })
  return { event, plan: guarded.plan }
}

export async function persistGuardedStructuredPlan({
  id,
  userId,
  title,
  prompt,
  steps,
  modelName,
  modelProviderId,
  modelConfigRevision,
  taskPlanGuard,
}) {
  const guarded = await prepareGuardedTaskPlan({
    plan: {
      title: String(title || '').trim().slice(0, 200),
      prompt: String(prompt || title || '').trim(),
      taskType: 'structured',
      planningSource: 'user',
      steps,
    },
    modelName,
    modelProviderId,
    modelConfigRevision,
    taskPlanGuard,
  })
  const event = persistPlannedJob({
    id,
    userId,
    prompt: guarded.plan.prompt,
    plan: guarded.plan,
    modelName,
    modelProviderId,
    modelConfigRevision,
    requirePlanApproval: guarded.requirePlanApproval,
    sourceType: null,
    sourceId: null,
    grants: [],
    planGuard: guarded.planGuard,
  })
  return { event, plan: guarded.plan }
}
