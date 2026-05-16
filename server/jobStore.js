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
    userId: row.user_id || null,
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
    userId: row.user_id || null,
    stepId: row.step_id,
    type: row.type,
    title: row.title,
    url: row.url,
    filename: row.filename,
    createdAt: row.created_at,
  }
}

/**
 * 新建后台作业。`userId` 是必填——P0 之后所有作业都必须归属到某个用户,
 * 任何调用方忘记传都会被这里早早抛错,避免落库后变成「无主作业」。
 */
export function createJob({
  id,
  userId,
  title,
  prompt,
  status = 'queued',
  progress = 0,
  now = Date.now(),
}) {
  if (!userId) throw new Error('createJob requires userId')
  getDb().prepare(`
    INSERT INTO jobs (id, user_id, title, prompt, status, progress, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, userId, title, prompt, status, progress, now, now)
  return getJob(id)
}

/**
 * 读取作业。如果传了 `userId`,会再做一次归属校验,
 * 让接入 API 路由的鉴权代码可以直接复用,不必再写额外 if。
 */
export function getJob(id, { userId } = {}) {
  const row = getDb().prepare('SELECT * FROM jobs WHERE id = ?').get(id)
  if (!row) return null
  if (userId && row.user_id && row.user_id !== userId) return null
  return mapJob(row)
}

export function listJobs({ userId, limit = 100 } = {}) {
  if (userId) {
    return getDb()
      .prepare('SELECT * FROM jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(userId, limit)
      .map(mapJob)
  }
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

/**
 * 新增作业产物。`userId` 必填——artifact 是下载路由的最终授权依据,
 * 必须把归属直接写在产物行上,后面 handleArtifactDownload 就能 O(1) 判定。
 */
export function appendJobArtifact({
  id,
  jobId,
  userId,
  stepId = null,
  type,
  title,
  url,
  filename = null,
  now = Date.now(),
}) {
  if (!userId) throw new Error('appendJobArtifact requires userId')
  getDb().prepare(`
    INSERT INTO job_artifacts (id, job_id, user_id, step_id, type, title, url, filename, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, jobId, userId, stepId, type, title, url, filename, now)
  return listJobArtifacts(jobId).find((artifact) => artifact.id === id) || null
}

export function listJobArtifacts(jobId) {
  return getDb()
    .prepare('SELECT * FROM job_artifacts WHERE job_id = ? ORDER BY created_at ASC')
    .all(jobId)
    .map(mapArtifact)
}

/**
 * 按产物 id 直接查询,主要给下载路由用——它已经从 URL 拿到唯一 id,
 * 不需要再二次过滤 job_id。返回 userId 让上层做 ownership 校验。
 */
export function getArtifactById(artifactId) {
  return mapArtifact(getDb().prepare('SELECT * FROM job_artifacts WHERE id = ?').get(artifactId))
}

/**
 * 按 filename 查询。下载路由从 URL 拿到 filename,没法直接 O(1) 查 id,
 * 所以需要这条额外索引——filename 在 newArtifactPath 里已经全局唯一(timestamp + 8 字节随机)。
 */
export function getArtifactByFilename(filename) {
  return mapArtifact(getDb().prepare('SELECT * FROM job_artifacts WHERE filename = ?').get(filename))
}

export function getJobWithChildren(id, { userId } = {}) {
  const job = getJob(id, { userId })
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
