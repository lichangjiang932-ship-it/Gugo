/**
 * Goal-plan REST surface.
 *
 *   GET    /api/goals/list?status=&sessionId=&limit=
 *   GET    /api/goals/show?planId=
 *   POST   /api/goals/create   { objective, steps, sessionId?, requireApproval? }
 *   POST   /api/goals/approve  { planId, expectedVersion? }
 *   POST   /api/goals/step     { planId, stepId, status, evidence?, expectedVersion? }
 *   POST   /api/goals/rewrite  { planId, objective?, steps, requireApproval?, expectedVersion? }
 *   POST   /api/goals/prune    { planId?, keepPerPlan? }
 *
 * The route layer owns HTTP only: every rule (state machine, evidence
 * verification, optimistic locking) stays in `goalPlanService`, so the CLI, the
 * loop tools and the web UI cannot diverge. Errors are mapped from the service
 * error code, never re-derived here.
 */
import { readJson } from '../utils.js'
import { authenticateRequest } from '../middleware.js'
import {
  GOAL_PLAN_ERROR_CODES,
  GoalPlanError,
  approveGoalPlan,
  createGoalPlan,
  getGoalPlan,
  listGoalPlanEvents,
  listGoalPlans,
  pruneGoalPlanEvents,
  rewriteGoalPlan,
  setGoalStepStatus,
} from '../services/goalPlanService.js'

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' }
const MAX_LIMIT = 200

function sendJson(res, status, body) {
  res.writeHead(status, JSON_HEADERS)
  res.end(JSON.stringify(body))
  return true
}

/** Service code -> HTTP status. Unknown codes are a server fault, not a 200. */
function statusForCode(code) {
  switch (String(code || '')) {
    case GOAL_PLAN_ERROR_CODES.INVALID_INPUT: return 400
    case GOAL_PLAN_ERROR_CODES.NOT_FOUND:
    case GOAL_PLAN_ERROR_CODES.STEP_NOT_FOUND: return 404
    case GOAL_PLAN_ERROR_CODES.VERSION_CONFLICT: return 409
    case GOAL_PLAN_ERROR_CODES.INVALID_TRANSITION:
    case GOAL_PLAN_ERROR_CODES.PLAN_NOT_APPROVED:
    case GOAL_PLAN_ERROR_CODES.EVIDENCE_REQUIRED:
    case GOAL_PLAN_ERROR_CODES.EVIDENCE_ALREADY_USED: return 409
    default: return 500
  }
}

function sendServiceError(res, error) {
  if (error instanceof GoalPlanError) {
    return sendJson(res, statusForCode(error.code), {
      ok: false,
      error: error.message,
      code: error.code,
      ...(error.evidenceCode ? { evidenceCode: error.evidenceCode } : {}),
      ...(error.currentVersion != null ? { currentVersion: error.currentVersion } : {}),
    })
  }
  return null
}

function boundedLimit(value, fallback) {
  // `Number(null)` is 0 (a finite number), so a missing query parameter would
  // otherwise silently clamp to a limit of 1 instead of using the default.
  if (value == null || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(Math.max(1, Math.trunc(parsed)), MAX_LIMIT)
}

function optionalVersion(value) {
  if (value === undefined) return null
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new GoalPlanError(GOAL_PLAN_ERROR_CODES.INVALID_INPUT, 'expectedVersion must be a positive integer when provided')
  }
  return value
}

export async function handleGoalRequest(req, res) {
  const userId = authenticateRequest(req)
  if (!userId) return sendJson(res, 401, { ok: false, error: '请先登录' })
  const url = new URL(req.url, 'http://localhost')
  const pathname = url.pathname

  try {
    if (req.method === 'GET' && pathname === '/api/goals/list') {
      const plans = listGoalPlans({
        userId,
        status: url.searchParams.get('status') || null,
        sessionId: String(url.searchParams.get('sessionId') || '').trim() || null,
        limit: boundedLimit(url.searchParams.get('limit'), 50),
      })
      return sendJson(res, 200, {
        ok: true,
        plans,
      })
    }

    if (req.method === 'GET' && pathname === '/api/goals/show') {
      const planId = String(url.searchParams.get('planId') || '').trim()
      if (!planId) return sendJson(res, 400, { ok: false, error: '缺少 planId' })
      const plan = getGoalPlan({ userId, planId })
      if (!plan) return sendJson(res, 404, { ok: false, error: 'goal plan not found', code: GOAL_PLAN_ERROR_CODES.NOT_FOUND })
      return sendJson(res, 200, {
        ok: true,
        plan,
        events: listGoalPlanEvents({ userId, planId, limit: boundedLimit(url.searchParams.get('eventLimit'), 200) }),
      })
    }

    if (req.method === 'POST' && pathname === '/api/goals/create') {
      const body = await readJson(req)
      const plan = createGoalPlan({
        userId,
        sessionId: body?.sessionId || null,
        objective: body?.objective,
        steps: body?.steps,
        requireApproval: body?.requireApproval !== false,
      })
      return sendJson(res, 201, { ok: true, plan })
    }

    if (req.method === 'POST' && pathname === '/api/goals/approve') {
      const body = await readJson(req)
      const plan = approveGoalPlan({
        userId,
        planId: body?.planId,
        expectedVersion: optionalVersion(body?.expectedVersion),
      })
      return sendJson(res, 200, { ok: true, plan })
    }

    if (req.method === 'POST' && pathname === '/api/goals/step') {
      const body = await readJson(req)
      const plan = setGoalStepStatus({
        userId,
        planId: body?.planId,
        stepId: body?.stepId,
        status: body?.status,
        evidence: body?.evidence || null,
        expectedVersion: optionalVersion(body?.expectedVersion),
      })
      return sendJson(res, 200, { ok: true, plan })
    }

    if (req.method === 'POST' && pathname === '/api/goals/rewrite') {
      const body = await readJson(req)
      const plan = rewriteGoalPlan({
        userId,
        planId: body?.planId,
        objective: body?.objective ?? null,
        steps: body?.steps,
        requireApproval: body?.requireApproval !== false,
        expectedVersion: optionalVersion(body?.expectedVersion),
      })
      return sendJson(res, 201, { ok: true, plan })
    }

    if (req.method === 'POST' && pathname === '/api/goals/prune') {
      const body = await readJson(req)
      const result = pruneGoalPlanEvents({
        userId,
        planId: body?.planId || null,
        keepPerPlan: body?.keepPerPlan,
      })
      return sendJson(res, 200, { ok: true, ...result })
    }

    return sendJson(res, 404, { ok: false, error: '未知路由' })
  } catch (err) {
    const mapped = sendServiceError(res, err)
    if (mapped) return mapped
    return sendJson(res, err?.statusCode || 400, { ok: false, error: err?.message || String(err) })
  }
}
