import { getDb } from './db.js'

function parseJson(value, fallback = null) {
  if (value == null || value === '') return fallback
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function mapJob(row) {
  if (!row) return null
  return {
    id: row.id,
    title: row.title,
    prompt: row.prompt,
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

function mapStep(row) {
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

function mapEvent(row) {
  if (!row) return null
  return {
    id: row.id,
    jobId: row.job_id,
    stepId: row.step_id,
    type: row.type,
    message: row.message,
    payload: parseJson(row.payload_json),
    createdAt: row.created_at,
  }
}

function mapArtifact(row) {
  if (!row) return null
  return {
    id: row.id,
    jobId: row.job_id,
    stepId: row.step_id,
    type: row.type,
    title: row.title,
    url: row.url,
    filename: row.filename,
    createdAt: row.created_at,
  }
}

export function createJob({
  id,
  title,
  prompt,
  status = 'queued',
  progress = 0,
  now = Date.now(),
}) {
  getDb().prepare(`
    INSERT INTO jobs (id, title, prompt, status, progress, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, title, prompt, status, progress, now, now)
  return getJob(id)
}

export function getJob(id) {
  return mapJob(getDb().prepare('SELECT * FROM jobs WHERE id = ?').get(id))
}

export function listJobs({ limit = 100 } = {}) {
  return getDb()
    .prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?')
    .all(limit)
    .map(mapJob)
}

export function updateJob(id, updates = {}, now = Date.now()) {
  const current = getJob(id)
  if (!current) return null
  const next = {
    status: updates.status ?? current.status,
    progress: updates.progress ?? current.progress,
    cancelRequested: updates.cancelRequested ?? current.cancelRequested,
    startedAt: updates.startedAt ?? current.startedAt,
    finishedAt: updates.finishedAt ?? current.finishedAt,
    error: updates.error ?? current.error,
  }
  getDb().prepare(`
    UPDATE jobs
    SET status = ?, progress = ?, cancel_requested = ?, updated_at = ?, started_at = ?, finished_at = ?, error = ?
    WHERE id = ?
  `).run(
    next.status,
    next.progress,
    next.cancelRequested ? 1 : 0,
    now,
    next.startedAt,
    next.finishedAt,
    next.error,
    id,
  )
  return getJob(id)
}

export function appendJobSteps(jobId, steps = [], now = Date.now()) {
  const stmt = getDb().prepare(`
    INSERT INTO job_steps
      (id, job_id, parent_step_id, title, kind, status, sort_order, input_json, created_at, updated_at)
    VALUES
      (@id, @jobId, @parentStepId, @title, @kind, @status, @sortOrder, @inputJson, @createdAt, @updatedAt)
  `)
  const tx = getDb().transaction((rows) => {
    rows.forEach((step, index) => {
      stmt.run({
        id: step.id,
        jobId,
        parentStepId: step.parentStepId || null,
        title: step.title,
        kind: step.kind,
        status: step.status || 'queued',
        sortOrder: step.sortOrder ?? index,
        inputJson: step.input == null ? null : JSON.stringify(step.input),
        createdAt: now,
        updatedAt: now,
      })
    })
  })
  tx(steps)
}

export function getJobStep(stepId) {
  return mapStep(getDb().prepare('SELECT * FROM job_steps WHERE id = ?').get(stepId))
}

export function listJobSteps(jobId) {
  return getDb()
    .prepare('SELECT * FROM job_steps WHERE job_id = ? ORDER BY sort_order ASC')
    .all(jobId)
    .map(mapStep)
}

export function listQueuedSteps(jobId) {
  return getDb()
    .prepare("SELECT * FROM job_steps WHERE job_id = ? AND status = 'queued' ORDER BY sort_order ASC")
    .all(jobId)
    .map(mapStep)
}

export function updateJobStep(stepId, updates = {}, now = Date.now()) {
  const current = getJobStep(stepId)
  if (!current) return null
  const next = {
    status: updates.status ?? current.status,
    output: updates.output ?? current.output,
    error: updates.error ?? current.error,
    startedAt: updates.startedAt ?? current.startedAt,
    finishedAt: updates.finishedAt ?? current.finishedAt,
  }
  getDb().prepare(`
    UPDATE job_steps
    SET status = ?, output_json = ?, error = ?, updated_at = ?, started_at = ?, finished_at = ?
    WHERE id = ?
  `).run(
    next.status,
    next.output == null ? null : JSON.stringify(next.output),
    next.error,
    now,
    next.startedAt,
    next.finishedAt,
    stepId,
  )
  return getJobStep(stepId)
}

export function appendJobEvent({
  jobId,
  stepId = null,
  type,
  message,
  payload = null,
  now = Date.now(),
}) {
  const info = getDb().prepare(`
    INSERT INTO job_events (job_id, step_id, type, message, payload_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(jobId, stepId, type, message, payload == null ? null : JSON.stringify(payload), now)
  return mapEvent(getDb().prepare('SELECT * FROM job_events WHERE id = ?').get(info.lastInsertRowid))
}

export function listJobEvents(jobId, { afterId = 0 } = {}) {
  return getDb()
    .prepare('SELECT * FROM job_events WHERE job_id = ? AND id > ? ORDER BY id ASC')
    .all(jobId, afterId)
    .map(mapEvent)
}

export function appendJobArtifact({
  id,
  jobId,
  stepId = null,
  type,
  title,
  url,
  filename = null,
  now = Date.now(),
}) {
  getDb().prepare(`
    INSERT INTO job_artifacts (id, job_id, step_id, type, title, url, filename, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, jobId, stepId, type, title, url, filename, now)
  return listJobArtifacts(jobId).find((artifact) => artifact.id === id) || null
}

export function listJobArtifacts(jobId) {
  return getDb()
    .prepare('SELECT * FROM job_artifacts WHERE job_id = ? ORDER BY created_at ASC')
    .all(jobId)
    .map(mapArtifact)
}

export function getJobWithChildren(id) {
  const job = getJob(id)
  if (!job) return null
  return {
    ...job,
    steps: listJobSteps(id),
    events: listJobEvents(id),
    artifacts: listJobArtifacts(id),
  }
}

export function listRecoverableJobs() {
  return getDb()
    .prepare(`
      SELECT * FROM jobs
      WHERE status IN ('queued', 'planning', 'running', 'waiting', 'cancel_requested')
      ORDER BY created_at ASC
    `)
    .all()
    .map(mapJob)
}

