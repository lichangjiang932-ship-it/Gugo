/**
 * Server-side goal plan with step-level evidence binding.
 *
 * State machine (plan): awaiting_approval -> approved -> completed
 * (plus blocked / cancelled terminals, and superseded when a rewrite replaces
 * a revision). A rewrite never mutates steps in place: it creates revision
 * n+1 and marks revision n `superseded`.
 *
 * State machine (step): pending -> in_progress -> done | blocked | skipped.
 * `done` is accepted only when the supplied evidence verifies against persisted
 * Turn events; a rejected step keeps its previous status and stores no claim.
 *
 * Two counters: `revision` is the rewrite generation, `version` is the
 * optimistic-lock counter bumped by every write. Callers that pass
 * `expectedVersion` fail closed on a concurrent edit instead of overwriting.
 */
import { getDb } from '../db.js'
import { randomUUID } from 'node:crypto'
import { listTurnEvents, resolveTurnSession } from './turnEventStore.js'
import {
  normalizeStepAcceptance,
  normalizeStepEvidence,
  verifyStepEvidence,
} from './goalPlanEvidence.js'

export const GOAL_PLAN_STATUSES = Object.freeze([
  'awaiting_approval', 'approved', 'completed', 'blocked', 'cancelled', 'superseded',
])
export const GOAL_STEP_STATUSES = Object.freeze(['pending', 'in_progress', 'done', 'blocked', 'skipped'])
const TERMINAL_PLAN_STATUSES = new Set(['completed', 'cancelled', 'superseded'])
const STEP_TRANSITIONS = Object.freeze({
  pending: new Set(['pending', 'in_progress', 'done', 'blocked', 'skipped']),
  in_progress: new Set(['in_progress', 'done', 'blocked', 'skipped']),
  blocked: new Set(['blocked', 'in_progress', 'done', 'skipped']),
  skipped: new Set(['skipped', 'in_progress']),
  done: new Set(['done', 'in_progress']),
})
const MAX_STEPS = 64
const MAX_TITLE = 500
const MAX_ACCEPTANCE = 20
const MAX_EVENT_PAYLOAD = 8_000
export const DEFAULT_EVENT_RETENTION_PER_PLAN = 500

export const GOAL_PLAN_ERROR_CODES = Object.freeze({
  INVALID_INPUT: 'GOAL_PLAN_INVALID_INPUT',
  NOT_FOUND: 'GOAL_PLAN_NOT_FOUND',
  STEP_NOT_FOUND: 'GOAL_PLAN_STEP_NOT_FOUND',
  INVALID_TRANSITION: 'GOAL_PLAN_INVALID_TRANSITION',
  PLAN_NOT_APPROVED: 'GOAL_PLAN_NOT_APPROVED',
  EVIDENCE_REQUIRED: 'GOAL_STEP_EVIDENCE_REQUIRED',
  EVIDENCE_ALREADY_USED: 'GOAL_EVIDENCE_ALREADY_USED',
  VERSION_CONFLICT: 'GOAL_PLAN_VERSION_CONFLICT',
})

export class GoalPlanError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'GoalPlanError'
    this.code = code
  }
}

function fail(code, message) {
  throw new GoalPlanError(code, message)
}

function cleanText(value, max) {
  return String(value ?? '').trim().slice(0, max)
}

function normalizeSteps(steps) {
  if (!Array.isArray(steps) || steps.length === 0) {
    fail(GOAL_PLAN_ERROR_CODES.INVALID_INPUT, 'steps must be a non-empty array')
  }
  if (steps.length > MAX_STEPS) {
    fail(GOAL_PLAN_ERROR_CODES.INVALID_INPUT, `steps must not exceed ${MAX_STEPS}`)
  }
  return steps.map((step, index) => {
    const title = cleanText(step?.title, MAX_TITLE)
    if (!title) fail(GOAL_PLAN_ERROR_CODES.INVALID_INPUT, `step ${index} requires a title`)
    if (step?.acceptance != null && !Array.isArray(step.acceptance)) {
      fail(GOAL_PLAN_ERROR_CODES.INVALID_INPUT, `step ${index} acceptance must be an array`)
    }
    if ((step?.acceptance?.length || 0) > MAX_ACCEPTANCE) {
      fail(GOAL_PLAN_ERROR_CODES.INVALID_INPUT, `step ${index} has too many acceptance conditions`)
    }
    // Free text stays a human-readable note; typed entries must survive
    // intact or the machine-checkable acceptance would be destroyed here.
    const acceptance = (Array.isArray(step?.acceptance) ? step.acceptance : [])
      .map((item) => {
        if (typeof item === 'string') return cleanText(item, 1_000)
        if (item && typeof item === 'object' && !Array.isArray(item)) return item
        fail(GOAL_PLAN_ERROR_CODES.INVALID_INPUT, `step ${index} contains an invalid acceptance condition`)
      })
      .filter((item) => item !== '')
      .slice(0, MAX_ACCEPTANCE)
    try {
      normalizeStepAcceptance(acceptance)
    } catch (error) {
      fail(GOAL_PLAN_ERROR_CODES.INVALID_INPUT, `step ${index} acceptance: ${error.message}`)
    }
    return Object.freeze({ title, acceptance })
  })
}

function rowToPlan(row) {
  if (!row) return null
  return {
    id: row.id,
    userId: row.user_id,
    sessionId: row.session_id || null,
    objective: row.objective,
    status: row.status,
    revision: row.revision,
    version: row.version,
    supersedesPlanId: row.supersedes_plan_id || null,
    approvedAt: row.approved_at ?? null,
    approvedBy: row.approved_by || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function parseJsonColumn(raw, fallback) {
  try {
    const parsed = JSON.parse(raw || '')
    return parsed ?? fallback
  } catch {
    return fallback
  }
}

function rowToStep(row) {
  if (!row) return null
  let acceptance
  let evidence
  try { acceptance = JSON.parse(row.acceptance_json || '[]') } catch { acceptance = [] }
  try { evidence = JSON.parse(row.evidence_json || '{}') } catch { evidence = null }
  const hasEvidence = evidence && typeof evidence === 'object' && Object.keys(evidence).length > 0
  return {
    id: row.id,
    planId: row.plan_id,
    ordinal: row.ordinal,
    title: row.title,
    acceptance: Array.isArray(acceptance) ? acceptance : [],
    status: row.status,
    evidence: hasEvidence ? evidence : null,
    evidenceVerified: row.evidence_verified === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function appendPlanEvent(db, { planId, userId, revision, type, payload = {}, now }) {
  const serialized = JSON.stringify(payload ?? {}).slice(0, MAX_EVENT_PAYLOAD)
  db.prepare(`
    INSERT INTO goal_plan_events (plan_id, user_id, revision, type, payload_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(String(planId), String(userId), Number(revision) || 1, String(type).slice(0, 64),
    serialized, now)
}

function loadPlanRow(db, userId, planId) {
  return db.prepare('SELECT * FROM goal_plans WHERE user_id = ? AND id = ?').get(userId, String(planId))
}

function listStepRows(db, planId) {
  return db.prepare('SELECT * FROM goal_plan_steps WHERE plan_id = ? ORDER BY ordinal').all(String(planId))
}

function assertExpectedVersion(plan, expectedVersion) {
  if (expectedVersion == null) return
  const expected = Number(expectedVersion)
  if (!Number.isFinite(expected) || expected !== Number(plan.version)) {
    const error = new GoalPlanError(
      GOAL_PLAN_ERROR_CODES.VERSION_CONFLICT,
      `goal plan version conflict: expected ${expectedVersion}, current ${plan.version}`,
    )
    error.expectedVersion = expectedVersion
    error.currentVersion = plan.version
    throw error
  }
}

/** Bump the optimistic-lock counter, failing the whole transaction on a race. */
function bumpPlanVersion(db, { userId, planId, expectedVersion, now }) {
  const result = db.prepare(`
    UPDATE goal_plans SET version = version + 1, updated_at = ?
    WHERE user_id = ? AND id = ? AND version = ?
  `).run(now, String(userId), String(planId), Number(expectedVersion))
  if (result.changes !== 1) {
    fail(GOAL_PLAN_ERROR_CODES.VERSION_CONFLICT, 'goal plan changed concurrently; reload and retry')
  }
}

/** Create a plan revision with its steps. Never wraps its own transaction. */
function insertGoalPlan(db, {
  userId, sessionId = null, objective = '', steps = [], requireApproval = true, now = Date.now(),
  planId = null, supersedesPlanId = null, revision = 1, approvedBy = null,
}) {
  if (!userId) fail(GOAL_PLAN_ERROR_CODES.INVALID_INPUT, 'userId is required')
  const trimmedObjective = cleanText(objective, 8_000)
  if (!trimmedObjective) fail(GOAL_PLAN_ERROR_CODES.INVALID_INPUT, 'objective is required')
  const normalizedSteps = normalizeSteps(steps)
  const id = planId || randomUUID()
  const status = requireApproval ? 'awaiting_approval' : 'approved'
  const approvedAt = requireApproval ? null : now
  const approver = requireApproval ? null : String(approvedBy || userId)
  db.prepare(`
    INSERT INTO goal_plans
      (id, user_id, session_id, objective, status, revision, version, supersedes_plan_id,
       approved_at, approved_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
  `).run(id, String(userId), sessionId ? String(sessionId) : null, trimmedObjective, status,
    Number(revision) || 1, supersedesPlanId ? String(supersedesPlanId) : null,
    approvedAt, approver, now, now)
  const insertStep = db.prepare(`
    INSERT INTO goal_plan_steps
      (id, plan_id, user_id, ordinal, title, acceptance_json, status, evidence_json,
       evidence_verified, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', '{}', 0, ?, ?)
  `)
  normalizedSteps.forEach((step, ordinal) => {
    insertStep.run(randomUUID(), id, String(userId), ordinal, step.title,
      JSON.stringify(step.acceptance), now, now)
  })
  appendPlanEvent(db, { planId: id, userId, revision, type: 'plan.created', now,
    payload: { status, stepCount: normalizedSteps.length } })
  return { id, status }
}

/** Create a plan revision with its steps. Always starts unapproved by default. */
export function createGoalPlan(params = {}) {
  if (!params.userId) fail(GOAL_PLAN_ERROR_CODES.INVALID_INPUT, 'userId is required')
  const db = getDb()
  let id = null
  db.transaction(() => { id = insertGoalPlan(db, params).id }).immediate()
  return getGoalPlan({ userId: params.userId, planId: id })
}

export function approveGoalPlan({ userId, planId, approvedBy = null, expectedVersion = null, now = Date.now() } = {}) {
  const db = getDb()
  const row = loadPlanRow(db, userId, planId)
  if (!row) fail(GOAL_PLAN_ERROR_CODES.NOT_FOUND, 'goal plan not found')
  if (row.status !== 'awaiting_approval') {
    fail(GOAL_PLAN_ERROR_CODES.INVALID_TRANSITION, `cannot approve a plan in status ${row.status}`)
  }
  assertExpectedVersion(row, expectedVersion)
  // Approval is a user decision. The plan owner must be the approver; a future
  // role model can widen this, but it can never silently approve as someone else.
  const approver = cleanText(approvedBy || userId, 200)
  if (!approver || approver !== String(userId)) {
    fail(GOAL_PLAN_ERROR_CODES.INVALID_INPUT, 'only the plan owner can approve this plan')
  }
  db.transaction(() => {
    bumpPlanVersion(db, { userId, planId, expectedVersion: row.version, now })
    db.prepare(`
      UPDATE goal_plans SET status = 'approved', approved_at = ?, approved_by = ?
      WHERE user_id = ? AND id = ?
    `).run(now, approver, String(userId), String(planId))
    appendPlanEvent(db, { planId, userId, revision: row.revision, type: 'plan.approved', now,
      payload: { approvedBy: approver } })
  }).immediate()
  return getGoalPlan({ userId, planId })
}

/** Versioned rewrite: creates revision n+1 and supersedes the previous plan. */
export function rewriteGoalPlan({
  userId, planId, objective = null, steps = [], requireApproval = true, expectedVersion = null,
  now = Date.now(),
} = {}) {
  const db = getDb()
  const row = loadPlanRow(db, userId, planId)
  if (!row) fail(GOAL_PLAN_ERROR_CODES.NOT_FOUND, 'goal plan not found')
  if (TERMINAL_PLAN_STATUSES.has(row.status)) {
    fail(GOAL_PLAN_ERROR_CODES.INVALID_TRANSITION, `cannot rewrite a plan in status ${row.status}`)
  }
  assertExpectedVersion(row, expectedVersion)
  let nextId = null
  db.transaction(() => {
    nextId = insertGoalPlan(db, {
      userId,
      sessionId: row.session_id,
      objective: objective == null ? row.objective : objective,
      steps,
      requireApproval,
      now,
      supersedesPlanId: row.id,
      revision: Number(row.revision) + 1,
    }).id
    bumpPlanVersion(db, { userId, planId, expectedVersion: row.version, now })
    db.prepare("UPDATE goal_plans SET status = 'superseded' WHERE user_id = ? AND id = ?")
      .run(String(userId), String(planId))
    appendPlanEvent(db, {
      planId, userId, revision: row.revision, type: 'plan.superseded', now,
      payload: { byPlanId: nextId, byRevision: Number(row.revision) + 1 },
    })
  }).immediate()
  return getGoalPlan({ userId, planId: nextId })
}

function defaultEvidenceLoader({ userId, turnId }) {
  const resolved = resolveTurnSession({ userId, turnId })
  if (resolved?.status !== 'found') return []
  // listTurnEvents caps a single call at 2_000 rows, so a long turn's terminal
  // event can fall past the first page. Keyset-page the full retained history
  // (the store asserts per-page contiguity) instead of verifying a truncated scan.
  const events = []
  let after = -1
  while (true) {
    const page = listTurnEvents({ userId, sessionId: resolved.sessionId, turnId, after, limit: 500 })
    if (page.length === 0) break
    const last = page.at(-1)
    if (!Number.isSafeInteger(last.sequence) || last.sequence <= after) {
      fail(GOAL_PLAN_ERROR_CODES.EVIDENCE_REQUIRED, 'evidence event cursor did not advance')
    }
    events.push(...page)
    after = last.sequence
    if (page.length < 500) break
  }
  return events
}

function resolveStepEvidence({ userId, sessionId, acceptance, status, evidence, now, loadEvidenceEvents }) {
  if (status !== 'done') {
    return { storedEvidence: {}, verified: 0, turnId: null, toolCallId: null }
  }
  const requestedEvidence = normalizeStepEvidence(evidence)
  const normalized = requestedEvidence?.manualConfirmed
    ? Object.freeze({ ...requestedEvidence, confirmedBy: String(userId) }) : requestedEvidence
  if (!normalized) {
    fail(GOAL_PLAN_ERROR_CODES.EVIDENCE_REQUIRED, 'a done step requires evidence with a turnId')
  }
  const events = loadEvidenceEvents({ userId, turnId: normalized.turnId })
  // The session and the step's own acceptance decide whether this evidence
  // proves *this* step, not merely that some tool succeeded somewhere.
  const verdict = verifyStepEvidence({ events, evidence: normalized, sessionId, acceptance })
  if (!verdict.verified) {
    const error = new GoalPlanError(
      GOAL_PLAN_ERROR_CODES.EVIDENCE_REQUIRED,
      `step evidence rejected: ${verdict.code}`,
    )
    error.evidenceCode = verdict.code
    error.detail = verdict.detail
    throw error
  }
  return {
    storedEvidence: {
      ...normalized,
      verifiedAt: now,
      code: verdict.code,
      // Persist *which* acceptance conditions passed so a user or the UI can
      // explain the approval instead of just showing a green check.
      satisfied: verdict.satisfied.map((item) => item.label),
      acceptanceEvidence: verdict.satisfied.map((item) => ({ label: item.label, toolCallIds: [...item.toolCallIds] })),
    },
    verified: 1,
    turnId: normalized.turnId,
    toolCallId: normalized.toolCallId || null,
  }
}

function completePlanIfFinished(db, { planId, userId, revision, now }) {
  const counts = db.prepare(`
    SELECT
      SUM(CASE WHEN status NOT IN ('done', 'skipped') THEN 1 ELSE 0 END) AS remaining,
      SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skipped
    FROM goal_plan_steps WHERE plan_id = ?
  `).get(String(planId))
  // `skipped` means "not required", so a plan with nothing pending, in
  // progress or blocked is finished. The skipped count is recorded so
  // completion is never silently equivalent to "every step done".
  if (Number(counts?.remaining || 0) !== 0) return false
  db.prepare("UPDATE goal_plans SET status = 'completed' WHERE user_id = ? AND id = ?")
    .run(String(userId), String(planId))
  appendPlanEvent(db, {
    planId, userId, revision, type: 'plan.completed', now,
    payload: { skippedSteps: Number(counts?.skipped || 0) },
  })
  return true
}

/** Update one step. `done` requires evidence that verifies against Turn events. */
export function setGoalStepStatus({
  userId, planId, stepId, status, evidence = null, expectedVersion = null, now = Date.now(),
  loadEvidenceEvents = defaultEvidenceLoader,
} = {}) {
  const db = getDb()
  const plan = loadPlanRow(db, userId, planId)
  if (!plan) fail(GOAL_PLAN_ERROR_CODES.NOT_FOUND, 'goal plan not found')
  if (plan.status !== 'approved') {
    fail(GOAL_PLAN_ERROR_CODES.PLAN_NOT_APPROVED, `plan must be approved before steps can change (status ${plan.status})`)
  }
  const stepRow = db.prepare('SELECT * FROM goal_plan_steps WHERE plan_id = ? AND id = ?')
    .get(String(planId), String(stepId))
  if (!stepRow) fail(GOAL_PLAN_ERROR_CODES.STEP_NOT_FOUND, 'goal plan step not found')
  const nextStatus = String(status || '').trim()
  if (!GOAL_STEP_STATUSES.includes(nextStatus)) {
    fail(GOAL_PLAN_ERROR_CODES.INVALID_INPUT, `invalid step status ${status}`)
  }
  if (!STEP_TRANSITIONS[stepRow.status]?.has(nextStatus)) {
    fail(GOAL_PLAN_ERROR_CODES.INVALID_TRANSITION, `cannot move step from ${stepRow.status} to ${nextStatus}`)
  }  const stepAcceptance = normalizeStepAcceptance(parseJsonColumn(stepRow.acceptance_json, []))
  if (nextStatus === 'skipped' && stepAcceptance.declared) {
    // A step with machine-checkable acceptance is required work: skipping it
    // would let the plan claim success without doing it. Block it (which emits
    // a replanning signal) or rewrite the plan instead.
    fail(
      GOAL_PLAN_ERROR_CODES.INVALID_TRANSITION,
      'a step with declared acceptance cannot be skipped; mark it blocked or rewrite the plan',
    )
  }
  assertExpectedVersion(plan, expectedVersion)
  const resolved = resolveStepEvidence({
    userId,
    sessionId: plan.session_id || null,
    acceptance: stepAcceptance,
    status: nextStatus,
    evidence,
    now,
    loadEvidenceEvents,
  })

  try {
    db.transaction(() => {
      bumpPlanVersion(db, { userId, planId, expectedVersion: plan.version, now })
      db.prepare(`
        UPDATE goal_plan_steps
        SET status = ?, evidence_json = ?, evidence_verified = ?,
            evidence_turn_id = ?, evidence_tool_call_id = ?, updated_at = ?
        WHERE plan_id = ? AND id = ?
      `).run(nextStatus, JSON.stringify(resolved.storedEvidence), resolved.verified,
        resolved.turnId, resolved.toolCallId, now, String(planId), String(stepId))
      appendPlanEvent(db, {
        planId, userId, revision: plan.revision, type: 'step.status', now,
        payload: {
          stepId: String(stepId), status: nextStatus, evidenceVerified: resolved.verified === 1,
        },
      })
      if (nextStatus === 'blocked' && stepRow.status !== 'blocked') {
        // Signal for both the agent and the user: this step will not finish
        // without a decision, so a rewrite or a human edit is now required.
        appendPlanEvent(db, {
          planId, userId, revision: plan.revision, type: 'plan.replan_required', now,
          payload: { stepId: String(stepId), reason: 'step_blocked' },
        })
      }
      // `skipped` also removes actionable work, so the plan must be allowed to
      // finish here; otherwise the status and the prompt disagree.
      if (nextStatus === 'done' || nextStatus === 'skipped') {
        completePlanIfFinished(db, { planId, userId, revision: plan.revision, now })
      }
    }).immediate()
  } catch (error) {
    // The partial unique index on (user_id, evidence_turn_id, evidence_tool_call_id)
    // is what stops one tool call from being cited as proof for several steps.
    if (/UNIQUE constraint failed: goal_plan_steps\.user_id/.test(String(error?.message || ''))) {
      const conflict = new GoalPlanError(
        GOAL_PLAN_ERROR_CODES.EVIDENCE_ALREADY_USED,
        'that tool call is already cited as evidence for another step',
      )
      conflict.evidenceCode = GOAL_PLAN_ERROR_CODES.EVIDENCE_ALREADY_USED
      throw conflict
    }
    throw error
  }
  return getGoalPlan({ userId, planId })
}

export function getGoalPlan({ userId, planId } = {}) {
  const db = getDb()
  const row = loadPlanRow(db, userId, planId)
  if (!row) return null
  return Object.freeze({
    ...rowToPlan(row),
    steps: listStepRows(db, row.id).map(rowToStep),
  })
}

/** Session-scoped lookup; unrelated recent plans must never hide this binding. */
export function findActiveGoalPlanForSession({ userId, sessionId } = {}) {
  if (!userId || !sessionId) return null
  const db = getDb()
  return db.transaction(() => {
    const row = db.prepare(`
      SELECT id FROM goal_plans
      WHERE user_id = ? AND session_id = ? AND status IN ('awaiting_approval', 'approved')
      ORDER BY CASE status WHEN 'awaiting_approval' THEN 0 ELSE 1 END,
        updated_at DESC, created_at DESC, id ASC LIMIT 1
    `).get(String(userId), String(sessionId))
    return row ? getGoalPlan({ userId, planId: row.id }) : null
  })()
}

export function listGoalPlans({ userId, status = null, sessionId = null, limit = 50 } = {}) {
  const db = getDb()
  const bounded = Math.min(Math.max(1, Math.trunc(Number(limit)) || 50), 200)
  const conditions = ['user_id = ?']
  const parameters = [String(userId)]
  if (status) { conditions.push('status = ?'); parameters.push(String(status)) }
  if (sessionId != null) { conditions.push('session_id = ?'); parameters.push(String(sessionId)) }
  const rows = db.prepare(`SELECT * FROM goal_plans WHERE ${conditions.join(' AND ')} ORDER BY updated_at DESC, id DESC LIMIT ?`)
    .all(...parameters, bounded)
  return rows.map(rowToPlan)
}

export function listGoalPlanEvents({ userId, planId, limit = 200 } = {}) {
  const bounded = Math.min(Math.max(1, Number(limit) || 200), 1_000)
  return getDb().prepare(`
    SELECT * FROM goal_plan_events WHERE user_id = ? AND plan_id = ? ORDER BY id LIMIT ?
  `).all(String(userId), String(planId), bounded).map((row) => ({
    id: row.id,
    planId: row.plan_id,
    revision: row.revision,
    type: row.type,
    payload: (() => { try { return JSON.parse(row.payload_json || '{}') } catch { return {} } })(),
    createdAt: row.created_at,
  }))
}

/**
 * Bounded event history. Events are an audit trail, not a transcript: for every
 * plan (or the one named plan) keep the newest `keepPerPlan` events and drop
 * the rest, oldest first. Without an explicit planId the bound is applied
 * **per plan**, never as a single user-wide budget.
 */
export function pruneGoalPlanEvents({ userId, planId = null, keepPerPlan = DEFAULT_EVENT_RETENTION_PER_PLAN } = {}) {
  const keep = Math.min(Math.max(1, Number(keepPerPlan) || DEFAULT_EVENT_RETENTION_PER_PLAN), 10_000)
  const db = getDb()
  const result = db.prepare(`
    DELETE FROM goal_plan_events
    WHERE user_id = ?
      AND (? IS NULL OR plan_id = ?)
      AND id IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (PARTITION BY plan_id ORDER BY id DESC) AS rn
          FROM goal_plan_events
          WHERE user_id = ?
        ) WHERE rn > ?
      )
  `).run(String(userId), planId ? String(planId) : null, planId ? String(planId) : null,
    String(userId), keep)
  return { deleted: Number(result.changes) || 0, keepPerPlan: keep }
}
