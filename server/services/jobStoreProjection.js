import { normalizeTaskGrants } from '../utils/taskGrants.js'
import { mapJobAutoRetry } from './jobAutoRetryPersistence.js'

function parseJson(value, fallback = null) {
  if (value == null || value === '') return fallback
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

export function mapJob(row) {
  if (!row) return null
  return {
    id: row.id,
    userId: row.user_id || null,
    title: row.title,
    prompt: row.prompt,
    modelName: row.model_name || null,
    modelProviderId: row.model_provider_id || null,
    modelConfigRevision: Number.isInteger(row.model_config_revision) ? row.model_config_revision : null,
    sourceType: row.source_type || null,
    sourceId: row.source_id || null,
    grants: (() => {
      try {
        return normalizeTaskGrants(parseJson(row.grants_json, []))
      } catch {
        return []
      }
    })(),
    autoRetry: mapJobAutoRetry(row),
    status: row.status,
    progress: row.progress,
    cancelRequested: !!row.cancel_requested,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    error: row.error,
  }
}

export function mapStep(row) {
  if (!row) return null
  return {
    id: row.id,
    jobId: row.job_id,
    parentStepId: row.parent_step_id,
    title: row.title,
    kind: row.kind,
    status: row.status,
    sortOrder: row.sort_order,
    input: parseJson(row.input_json),
    output: parseJson(row.output_json),
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  }
}

export function mapArtifact(row) {
  if (!row) return null
  return {
    id: row.id,
    jobId: row.job_id,
    userId: row.user_id || null,
    stepId: row.step_id,
    type: row.type,
    title: row.title,
    url: row.url,
    filename: row.filename,
    createdAt: row.created_at,
  }
}
