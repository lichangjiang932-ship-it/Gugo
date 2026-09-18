/**
 * Goal-plan tools — the loop-facing surface of the persisted plan.
 *
 * Why these exist: `goalPlanService` alone only binds evidence when a human
 * calls `gugo goal`. These tools let the running loop read the approved plan,
 * advance steps, and propose a rewrite, so the evidence rule actually governs
 * agent behaviour instead of sitting unused.
 *
 * Safety model (deliberate):
 *   - The tools are offered only when the session already has a non-terminal
 *     plan, so a session without a plan sees an unchanged tool block.
 *   - The agent cannot originate a plan. A human creates it (`gugo goal
 *     create`) and approves it; agent output before approval is inert.
 *   - `done` is never self-certified: the host re-reads persisted Turn events
 *     and rejects the claim if the referenced tool call did not succeed.
 *   - Schemas live in `goalToolSpecs.js` (pure data) to avoid an import cycle
 *     with the tool catalog.
 */
import {
  GoalPlanError,
  findActiveGoalPlanForSession,
  getGoalPlan,
  rewriteGoalPlan,
  setGoalStepStatus,
} from '../services/goalPlanService.js'
import { GOAL_TOOL_NAMES, GOAL_TOOL_SPECS, GOAL_STEP_STATUS_ENUM } from './goalToolSpecs.js'

export { GOAL_TOOL_NAMES, GOAL_TOOL_SPECS }

const STEP_STATUS_ENUM = GOAL_STEP_STATUS_ENUM

function failure(error) {
  const code = error instanceof GoalPlanError
    ? String(error.code || 'GOAL_PLAN_FAILED')
    : 'GOAL_PLAN_FAILED'
  return {
    ok: false,
    code,
    ...(error?.evidenceCode ? { evidenceCode: error.evidenceCode } : {}),
    error: error?.message || String(error),
  }
}

/** Active = still actionable, so superseded/finished plans are not surfaced. */
export function activePlanStatuses() {
  return ['awaiting_approval', 'approved']
}

export function findActiveGoalPlan({ userId, sessionId } = {}) {
  return findActiveGoalPlanForSession({ userId, sessionId })
}

function requireSessionPlan({ userId, sessionId, planId }) {
  const plan = getGoalPlan({ userId, planId })
  if (!plan) throw new GoalPlanError('GOAL_PLAN_NOT_FOUND', 'goal plan not found')
  if (!sessionId || String(plan.sessionId || '') !== String(sessionId)) {
    throw new GoalPlanError('GOAL_PLAN_SESSION_MISMATCH', 'model goal tools only operate on their current session')
  }
  return plan
}

/** Compact next-state so the agent does not need a second read to know what is left. */
function planProgress(plan) {
  if (!plan) return { completed: false, openStepCount: 0, nextStepId: null, openSteps: [] }
  const open = plan.steps
    .filter((step) => step.status !== 'done' && step.status !== 'skipped')
    .sort((left, right) => left.ordinal - right.ordinal)
  const actionable = open.filter((step) => step.status !== 'blocked')
  const blocked = open.filter((step) => step.status === 'blocked')
  return {
    completed: plan.status === 'completed',
    openStepCount: open.length,
    nextStepId: actionable[0]?.id || null,
    replanRequired: blocked.length > 0,
    blockedStepIds: blocked.map((step) => step.id),
    openSteps: open.map((step) => ({
      id: step.id, ordinal: step.ordinal, title: step.title, status: step.status,
    })),
  }
}

export function dispatchGoalTool(name, args = {}, { userId = null, sessionId = null, turnId = null } = {}) {
  if (!GOAL_TOOL_NAMES.includes(name)) return { ok: false, error: `unknown goal tool: ${name}` }
  if (!userId) return { ok: false, error: 'no runtime identity, cannot touch a goal plan' }
  try {
    const humanFields = ['manual_confirm', 'manualConfirm', 'manualConfirmed', 'confirmed_by', 'confirmedBy']
    if (humanFields.some((key) => Object.hasOwn(args, key))) {
      throw new GoalPlanError('GOAL_MANUAL_CONFIRMATION_NOT_ALLOWED',
        'human confirmation must come from the authenticated human CLI or HTTP entry, never model tool arguments')
    }
    const expectedVersion = args?.expected_version ?? null
    if (expectedVersion !== null && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)) {
      throw new GoalPlanError('GOAL_PLAN_INVALID_INPUT', 'expected_version must be a positive integer')
    }
    if (name === 'goal_plan_status') {
      const requested = String(args?.plan_id || '').trim()
      const plan = requested
        ? requireSessionPlan({ userId, sessionId, planId: requested })
        : findActiveGoalPlan({ userId, sessionId })
      if (!plan) return { ok: true, plan: null, message: 'this session has no active goal plan' }
      return { ok: true, plan, ...planProgress(plan) }
    }
    if (name === 'goal_step_update') {
      const planId = String(args?.plan_id || '').trim()
      const stepId = String(args?.step_id || '').trim()
      const status = String(args?.status || '').trim()
      if (!planId || !stepId) return { ok: false, error: 'plan_id and step_id are required' }
      requireSessionPlan({ userId, sessionId, planId })
      if (!STEP_STATUS_ENUM.includes(status)) {
        return { ok: false, error: `status must be one of ${STEP_STATUS_ENUM.join(', ')}` }
      }
      const evidence = status === 'done'
        ? {
            turnId: String(args?.turn_id || turnId || '').trim(),
            toolCallId: String(args?.tool_call_id || '').trim(),
            note: String(args?.note || '').trim(),
          }
        : null
      const plan = setGoalStepStatus({ userId, planId, stepId, status, evidence, expectedVersion })
      const step = plan.steps.find((entry) => entry.id === stepId) || null
      return { ok: true, plan, step, ...planProgress(plan) }
    }
    if (name === 'goal_plan_rewrite') {
      const planId = String(args?.plan_id || '').trim()
      if (!planId) return { ok: false, error: 'plan_id is required' }
      requireSessionPlan({ userId, sessionId, planId })
      if (!Array.isArray(args?.steps) || args.steps.length === 0) {
        return { ok: false, error: 'steps must be a non-empty array' }
      }
      const plan = rewriteGoalPlan({
        userId,
        planId,
        objective: args?.objective == null ? null : String(args.objective),
        steps: args.steps,
        expectedVersion,
      })
      return { ok: true, plan, ...planProgress(plan), message: 'new revision created; it needs user approval before steps can change' }
    }
    return { ok: false, error: `unhandled goal tool: ${name}` }
  } catch (error) {
    return failure(error)
  }
}
