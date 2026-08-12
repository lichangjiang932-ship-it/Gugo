import { getDb } from '../db.js'

const CHECKPOINT_VERSION = 1

function parseState(value) {
  if (!value) return null
  try {
    const state = JSON.parse(value)
    return state && typeof state === 'object' ? state : null
  } catch {
    return null
  }
}

function mapCheckpoint(row) {
  if (!row) return null
  return {
    jobId: row.job_id,
    stepId: row.step_id,
    userId: row.user_id,
    state: parseState(row.state_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function ownsStep({ jobId, stepId, userId }) {
  if (!jobId || !stepId || !userId) return false
  return !!getDb().prepare(`
    SELECT 1
      FROM job_steps AS step
      JOIN jobs AS job ON job.id = step.job_id
     WHERE step.id = ? AND step.job_id = ? AND job.user_id = ?
  `).get(stepId, jobId, userId)
}

export function getJobTurnCheckpoint({ jobId, stepId, userId } = {}) {
  if (!jobId || !stepId || !userId) return null
  return mapCheckpoint(getDb().prepare(`
    SELECT * FROM job_turn_checkpoints
     WHERE job_id = ? AND step_id = ? AND user_id = ?
  `).get(jobId, stepId, userId))
}

export function saveJobTurnCheckpoint({ jobId, stepId, userId, state, now = Date.now() } = {}) {
  if (!state || typeof state !== 'object') throw new Error('checkpoint state must be an object')
  if (!ownsStep({ jobId, stepId, userId })) return null
  const normalized = { ...state, version: CHECKPOINT_VERSION }
  getDb().prepare(`
    INSERT INTO job_turn_checkpoints
      (step_id, job_id, user_id, state_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(step_id) DO UPDATE SET
      state_json = excluded.state_json,
      updated_at = excluded.updated_at
    WHERE job_turn_checkpoints.job_id = excluded.job_id
      AND job_turn_checkpoints.user_id = excluded.user_id
  `).run(stepId, jobId, userId, JSON.stringify(normalized), now, now)
  return getJobTurnCheckpoint({ jobId, stepId, userId })
}

function resetCheckpointBudget(budget) {
  if (!budget || typeof budget !== 'object') return budget || null
  return {
    ...budget,
    used: 0,
    elapsed: 0,
    modelMs: 0,
    modelCalls: 0,
    modelTokens: 0,
    costUsd: 0,
  }
}

export function makeJobTurnCheckpointResumable({
  jobId,
  stepId,
  userId,
  resetBudget = false,
} = {}) {
  const checkpoint = getJobTurnCheckpoint({ jobId, stepId, userId })
  if (!checkpoint?.state) return checkpoint
  const hasTerminalResult = checkpoint.state.final != null
  const hasBudgetToReset = resetBudget && checkpoint.state.budget && typeof checkpoint.state.budget === 'object'
  if (!hasTerminalResult && !hasBudgetToReset) return checkpoint
  const retryIterationWindowStart = resetBudget
    ? Math.max(0, Number(checkpoint.state.iterations) || 0)
    : checkpoint.state.iterationWindowStart
  return saveJobTurnCheckpoint({
    jobId,
    stepId,
    userId,
    state: {
      ...checkpoint.state,
      ...(hasTerminalResult ? { final: null } : {}),
      ...(hasBudgetToReset ? { budget: resetCheckpointBudget(checkpoint.state.budget) } : {}),
      ...(resetBudget ? { iterationWindowStart: retryIterationWindowStart } : {}),
    },
  })
}

export function deleteJobTurnCheckpoint({ jobId, stepId, userId } = {}) {
  if (!jobId || !stepId || !userId) return 0
  return getDb().prepare(`
    DELETE FROM job_turn_checkpoints
     WHERE job_id = ? AND step_id = ? AND user_id = ?
  `).run(jobId, stepId, userId).changes || 0
}

export function deleteJobTurnCheckpoints({ jobId, userId } = {}) {
  if (!jobId || !userId) return 0
  return getDb().prepare(`
    DELETE FROM job_turn_checkpoints WHERE job_id = ? AND user_id = ?
  `).run(jobId, userId).changes || 0
}
