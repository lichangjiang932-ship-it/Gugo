/**
 * Goal-plan REST client.
 *
 * Mirrors `gugo goal` and the loop's `goal_*` tools: the panel reads and writes
 * the same persisted plan, so a step shown as done here has host-verified
 * evidence behind it rather than a client-side checkbox.
 */
import { getAuthToken } from './accountClient.js'

function authHeaders() {
  const token = getAuthToken?.()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

async function jsonOk(resp) {
  const text = await resp.text()
  let data
  try { data = text ? JSON.parse(text) : {} } catch { data = { raw: text } }
  if (!resp.ok || data?.ok === false) {
    const err = new Error(data?.error || `HTTP ${resp.status}`)
    err.status = resp.status
    err.code = data?.code || null
    err.evidenceCode = data?.evidenceCode || null
    err.currentVersion = data?.currentVersion ?? null
    throw err
  }
  return data
}

function post(path, body) {
  return fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body || {}),
  }).then(jsonOk)
}

export async function listGoalPlansApi({ status, sessionId, limit } = {}) {
  const params = new URLSearchParams()
  if (status) params.set('status', status)
  if (sessionId) params.set('sessionId', sessionId)
  if (limit) params.set('limit', String(limit))
  const resp = await fetch(`/api/goals/list?${params.toString()}`, { headers: authHeaders() })
  return jsonOk(resp)
}

export async function showGoalPlanApi(planId) {
  const params = new URLSearchParams({ planId: String(planId || '') })
  const resp = await fetch(`/api/goals/show?${params.toString()}`, { headers: authHeaders() })
  return jsonOk(resp)
}

export function createGoalPlanApi({ objective, steps, sessionId, requireApproval = true }) {
  return post('/api/goals/create', { objective, steps, sessionId, requireApproval })
}

export function approveGoalPlanApi({ planId, expectedVersion }) {
  return post('/api/goals/approve', { planId, expectedVersion })
}

export function setGoalStepStatusApi({ planId, stepId, status, evidence, expectedVersion }) {
  return post('/api/goals/step', { planId, stepId, status, evidence, expectedVersion })
}

export function rewriteGoalPlanApi({ planId, objective, steps, requireApproval = true, expectedVersion }) {
  return post('/api/goals/rewrite', { planId, objective, steps, requireApproval, expectedVersion })
}

/** Non-terminal plans first, so the panel shows what is still actionable. */
export const ACTIVE_GOAL_STATUSES = Object.freeze(['awaiting_approval', 'approved'])

export function pickActivePlan(plans = []) {
  const list = Array.isArray(plans) ? plans : []
  for (const status of ACTIVE_GOAL_STATUSES) {
    const match = list.find((plan) => plan?.status === status)
    if (match) return match
  }
  return list[0] || null
}
