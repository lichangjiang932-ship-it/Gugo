import { getDb } from '../db.js'
import { runRuntimePluginCheckpointReferenceWrite } from './runtimePluginLifecycleCoordinator.js'

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

function canonicalJsonValue(value) {
  if (Array.isArray(value)) return value.map(canonicalJsonValue)
  if (!value || typeof value !== 'object') return value
  return Object.keys(value).sort().reduce((result, key) => {
    result[key] = canonicalJsonValue(value[key])
    return result
  }, {})
}

function stateJson(state) {
  return JSON.stringify(canonicalJsonValue(state))
}

export function nextJobCheckpointWriteSequence(state) {
  const current = Number(state?.checkpointWriteSequence)
  const next = Number.isSafeInteger(current) && current > 0 ? current + 1 : 1
  if (!Number.isSafeInteger(next)) {
    throw Object.assign(new Error('job checkpoint write sequence exhausted'), {
      code: 'JOB_CHECKPOINT_SEQUENCE_EXHAUSTED',
    })
  }
  return next
}

function mapCheckpoint(row) {
  if (!row) return null
  return {
    jobId: row.job_id,
    stepId: row.step_id,
    userId: row.user_id,
    state: parseState(row.state_json),
    revision: Math.max(1, Number(row.revision) || 1),
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

export function saveJobTurnCheckpoint({
  jobId,
  stepId,
  userId,
  state,
  checkpointWriteSequence = state?.checkpointWriteSequence ?? null,
  now = Date.now(),
} = {}) {
  if (!state || typeof state !== 'object') throw new Error('checkpoint state must be an object')
  if (!ownsStep({ jobId, stepId, userId })) return null
  const embeddedWriteSequence = state?.checkpointWriteSequence
  const numericWriteSequence = Number(checkpointWriteSequence)
  const hasWriteSequence = Number.isSafeInteger(numericWriteSequence) && numericWriteSequence > 0
  if (checkpointWriteSequence != null && !hasWriteSequence) {
    throw new Error('checkpointWriteSequence must be a positive safe integer')
  }
  if (embeddedWriteSequence != null) {
    const numericEmbeddedWriteSequence = Number(embeddedWriteSequence)
    if (!Number.isSafeInteger(numericEmbeddedWriteSequence) || numericEmbeddedWriteSequence <= 0) {
      throw new Error('state.checkpointWriteSequence must be a positive safe integer')
    }
    if (hasWriteSequence && numericEmbeddedWriteSequence !== numericWriteSequence) {
      throw Object.assign(new Error('checkpointWriteSequence does not match checkpoint state'), {
        code: 'JOB_CHECKPOINT_SEQUENCE_MISMATCH',
      })
    }
  }
  const normalized = {
    ...state,
    ...(hasWriteSequence ? { checkpointWriteSequence: numericWriteSequence } : {}),
    version: CHECKPOINT_VERSION,
  }
  return runRuntimePluginCheckpointReferenceWrite(normalized, () => {
    getDb().prepare(`
      INSERT INTO job_turn_checkpoints
        (step_id, job_id, user_id, state_json, created_at, updated_at, revision)
      VALUES (?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(step_id) DO UPDATE SET
        state_json = excluded.state_json,
        updated_at = excluded.updated_at,
        revision = job_turn_checkpoints.revision + 1
      WHERE job_turn_checkpoints.job_id = excluded.job_id
        AND job_turn_checkpoints.user_id = excluded.user_id
        AND (
          json_extract(job_turn_checkpoints.state_json, '$.checkpointWriteSequence') IS NULL
          OR (
            json_extract(excluded.state_json, '$.checkpointWriteSequence') IS NOT NULL
            AND json_extract(excluded.state_json, '$.checkpointWriteSequence')
              > json_extract(job_turn_checkpoints.state_json, '$.checkpointWriteSequence')
          )
        )
    `).run(stepId, jobId, userId, stateJson(normalized), now, now)
    return getJobTurnCheckpoint({ jobId, stepId, userId })
  })
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
    costEvidenceComplete: true,
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
  const checkpointWriteSequence = nextJobCheckpointWriteSequence(checkpoint.state)
  return saveJobTurnCheckpoint({
    jobId,
    stepId,
    userId,
    state: {
      ...checkpoint.state,
      checkpointWriteSequence,
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
