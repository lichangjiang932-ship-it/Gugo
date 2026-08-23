import { getDb } from '../db.js'
import { assertManagedArtifactMutationAllowed } from './userDataClearGuard.js'
import { normalizeTaskGrants } from '../utils/taskGrants.js'

const STRUCTURED_EVIDENCE_STEP_KINDS = new Set(['execute', 'batch_item', 'verify'])
const COMPLETION_EVIDENCE_TYPE_ALIASES = new Map([
  ['tool', 'tool_result'],
  ['tool_result', 'tool_result'],
  ['test', 'check'],
  ['test_result', 'check'],
  ['check', 'check'],
  ['check_result', 'check'],
  ['artifact', 'artifact'],
  ['artifact_result', 'artifact'],
  ['readback', 'readback'],
  ['file_readback', 'readback'],
  ['user_confirmation', 'user_confirmation'],
])

function boundedText(value, maxLength) {
  const text = typeof value === 'string' ? value.trim() : ''
  return text ? text.slice(0, maxLength) : ''
}

function completionEvidenceError(code, message) {
  return Object.assign(new Error(message), { code, statusCode: 422 })
}

function normalizeCompletionEvidenceEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
  const type = COMPLETION_EVIDENCE_TYPE_ALIASES.get(boundedText(entry.type, 64).toLowerCase())
  const summary = boundedText(entry.summary, 2_000)
  if (!type || !summary) return null

  if (type === 'tool_result') {
    const toolCallId = boundedText(entry.toolCallId, 256)
    if (!toolCallId || entry.ok !== true) return null
    return { type, summary, toolCallId, ok: true }
  }
  if (type === 'check') {
    const command = boundedText(entry.command, 4_000)
    const passed = entry.ok === true || entry.exitCode === 0
    if (!command || !passed) return null
    return {
      type,
      summary,
      command,
      ok: true,
      ...(Number.isInteger(entry.exitCode) ? { exitCode: entry.exitCode } : {}),
    }
  }
  if (type === 'artifact') {
    const artifactId = boundedText(entry.artifactId, 256)
    if (!artifactId) return null
    return { type, summary, artifactId }
  }
  if (type === 'readback') {
    const path = boundedText(entry.path, 2_000)
    if (!path || entry.ok !== true) return null
    return { type, summary, path, ok: true }
  }
  if (entry.confirmed !== true) return null
  return { type, summary, confirmed: true }
}

export function requiresStructuredCompletionEvidence(step) {
  return STRUCTURED_EVIDENCE_STEP_KINDS.has(String(step?.kind || '').trim().toLowerCase())
}

export function validateStructuredCompletionEvidence(evidence) {
  if (!Array.isArray(evidence) || evidence.length === 0) {
    return {
      ok: false,
      code: 'JOB_COMPLETION_EVIDENCE_REQUIRED',
      error: 'Structured completion evidence is required for this step.',
    }
  }
  const normalized = evidence.map(normalizeCompletionEvidenceEntry)
  if (normalized.some((entry) => !entry)) {
    return {
      ok: false,
      code: 'JOB_COMPLETION_EVIDENCE_INVALID',
      error: 'Completion evidence must use a supported structured evidence shape.',
    }
  }
  return { ok: true, evidence: normalized }
}

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
  modelName = null,
  modelProviderId = null,
  modelConfigRevision = null,
  sourceType = null,
  sourceId = null,
  grants = [],
  status = 'queued',
  progress = 0,
  now = Date.now(),
}) {
  if (!userId) throw new Error('createJob requires userId')
  const selectedModel = boundedText(modelName, 512) || null
  const selectedProviderId = boundedText(modelProviderId, 512) || null
  const selectedConfigRevision = Number(modelConfigRevision)
  const normalizedConfigRevision = Number.isInteger(selectedConfigRevision) && selectedConfigRevision > 0
    ? selectedConfigRevision
    : null
  if ((selectedProviderId === null) !== (normalizedConfigRevision === null)) {
    throw new Error('modelProviderId and modelConfigRevision must be provided together')
  }
  const normalizedSourceType = boundedText(sourceType, 64) || null
  const normalizedSourceId = boundedText(sourceId, 512) || null
  const normalizedGrants = normalizeTaskGrants(grants)
  if ((normalizedSourceType === null) !== (normalizedSourceId === null)) {
    throw new Error('sourceType and sourceId must be provided together')
  }
  getDb().prepare(`
    INSERT INTO jobs (
      id, user_id, title, prompt, model_name, model_provider_id, model_config_revision,
      source_type, source_id, grants_json, status, progress, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    userId,
    title,
    prompt,
    selectedModel,
    selectedProviderId,
    normalizedConfigRevision,
    normalizedSourceType,
    normalizedSourceId,
    JSON.stringify(normalizedGrants),
    status,
    progress,
    now,
    now,
  )
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
    prompt: updates.prompt ?? current.prompt,
    status: updates.status ?? current.status,
    progress: updates.progress ?? current.progress,
    cancelRequested: updates.cancelRequested ?? current.cancelRequested,
    startedAt: updates.startedAt ?? current.startedAt,
    finishedAt: updates.finishedAt ?? current.finishedAt,
    error: updates.error ?? current.error,
  }
  getDb().prepare(`
    UPDATE jobs
    SET prompt = ?, status = ?, progress = ?, cancel_requested = ?, updated_at = ?, started_at = ?, finished_at = ?, error = ?
    WHERE id = ?
  `).run(
    next.prompt,
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

/**
 * Refresh the immutable model snapshot only for an explicit user retry.
 * Automatic recovery must keep using the original snapshot so config drift is
 * detected before execution resumes.
 */
export function updateJobModelSnapshot(id, {
  userId,
  modelName,
  modelProviderId = null,
  modelConfigRevision = null,
} = {}, now = Date.now()) {
  if (!userId) throw new Error('updateJobModelSnapshot requires userId')
  const current = getJob(id, { userId })
  if (!current) return null
  const selectedModel = boundedText(modelName, 512) || null
  const selectedProviderId = boundedText(modelProviderId, 512) || null
  const selectedRevision = Number(modelConfigRevision)
  const normalizedRevision = Number.isInteger(selectedRevision) && selectedRevision > 0
    ? selectedRevision
    : null
  if (!selectedModel) throw new Error('modelName is required')
  if ((selectedProviderId === null) !== (normalizedRevision === null)) {
    throw new Error('modelProviderId and modelConfigRevision must be provided together')
  }
  getDb().prepare(`
    UPDATE jobs
    SET model_name = ?, model_provider_id = ?, model_config_revision = ?, updated_at = ?
    WHERE id = ? AND user_id = ?
  `).run(selectedModel, selectedProviderId, normalizedRevision, now, id, userId)
  return getJob(id, { userId })
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

function replacePendingJobStepsInDb(db, jobId, steps = [], now = Date.now()) {
  const insert = db.prepare(`
    INSERT INTO job_steps
      (id, job_id, parent_step_id, title, kind, status, sort_order, input_json, created_at, updated_at)
    VALUES
      (@id, @jobId, @parentStepId, @title, @kind, @status, @sortOrder, @inputJson, @createdAt, @updatedAt)
  `)
  const immutable = db.prepare(`
    SELECT COUNT(*) AS count
      FROM job_steps
     WHERE job_id = ?
       AND kind <> 'plan'
       AND status NOT IN ('queued', 'pending')
  `).get(jobId)
  if (immutable.count > 0) throw new Error('plan steps can no longer be edited after execution starts')
  db.prepare(`
    DELETE FROM job_steps
     WHERE job_id = ?
       AND kind <> 'plan'
       AND status IN ('queued', 'pending')
  `).run(jobId)
  steps.forEach((step, index) => insert.run({
    id: step.id,
    jobId,
    parentStepId: step.parentStepId || null,
    title: step.title,
    kind: step.kind,
    status: step.status || 'queued',
    sortOrder: step.sortOrder ?? index + 1,
    inputJson: step.input == null ? null : JSON.stringify(step.input),
    createdAt: now,
    updatedAt: now,
  }))
}

export function replacePendingJobSteps(jobId, steps = [], now = Date.now()) {
  const db = getDb()
  const tx = db.transaction((rows) => replacePendingJobStepsInDb(db, jobId, rows, now))
  tx(steps)
  return listJobSteps(jobId)
}

/**
 * Atomically approve the latest durable plan proposal. The caller supplies the
 * semantic digest function so this storage layer stays independent from the
 * policy module (which already depends on job creation/storage).
 */
export function approveJobPlan({
  jobId,
  userId,
  proposalEventId,
  proposalPlanDigest,
  approvedPlanDigest,
  replacementSteps = null,
  edited = false,
  previousMode = null,
  contract,
  version,
  computePlanDigest,
  now = Date.now(),
} = {}) {
  if (!jobId || !userId) throw new Error('approveJobPlan requires jobId and userId')
  if (typeof computePlanDigest !== 'function') throw new Error('approveJobPlan requires computePlanDigest')
  const expectedProposalId = Number(proposalEventId)
  if (!Number.isInteger(expectedProposalId) || expectedProposalId < 1) {
    throw new Error('approveJobPlan requires a valid proposalEventId')
  }
  const db = getDb()
  const transaction = db.transaction(() => {
    const jobRow = db.prepare('SELECT * FROM jobs WHERE id = ? AND user_id = ?').get(jobId, userId)
    if (!jobRow) return { status: 'not_found' }

    const latestProposal = mapEvent(db.prepare(`
      SELECT * FROM job_events
       WHERE job_id = ? AND type = 'plan_proposed'
       ORDER BY id DESC
       LIMIT 1
    `).get(jobId))
    if (!latestProposal || latestProposal.id !== expectedProposalId) {
      return {
        status: 'proposal_changed',
        proposalEventId: latestProposal?.id || null,
      }
    }
    const currentSteps = db.prepare('SELECT * FROM job_steps WHERE job_id = ? ORDER BY sort_order ASC')
      .all(jobId)
      .map(mapStep)
    const currentPlanDigest = computePlanDigest(currentSteps)
    const approvalEvents = db.prepare(`
      SELECT * FROM job_events
       WHERE job_id = ? AND type = 'plan_approved'
       ORDER BY id DESC
    `).all(jobId).map(mapEvent)
    const existingApproval = approvalEvents.find((event) => (
      event.payload?.contract === contract
        && event.payload?.version === version
        && Number(event.payload?.proposalEventId) === expectedProposalId
        && event.payload?.proposalPlanDigest === proposalPlanDigest
        && event.payload?.approvedPlanDigest === approvedPlanDigest
    ))
    if (existingApproval && currentPlanDigest === approvedPlanDigest) {
      return {
        status: 'approved',
        idempotent: true,
        event: existingApproval,
        approvedPlanDigest,
      }
    }

    if (jobRow.status !== 'waiting') return { status: 'not_waiting' }
    const latestSuspension = mapEvent(db.prepare(`
      SELECT * FROM job_events
       WHERE job_id = ? AND type IN ('plan_proposed', 'awaiting_user')
       ORDER BY id DESC
       LIMIT 1
    `).get(jobId))
    if (latestSuspension?.type !== 'plan_proposed' || latestSuspension.id !== expectedProposalId) {
      return { status: 'not_waiting_for_plan' }
    }
    if (latestProposal.payload?.contract !== contract
      || latestProposal.payload?.version !== version
      || latestProposal.payload?.planDigest !== proposalPlanDigest) {
      return { status: 'proposal_contract_invalid' }
    }
    if (currentPlanDigest !== proposalPlanDigest) {
      return {
        status: 'plan_changed',
        currentPlanDigest,
      }
    }

    if (replacementSteps !== null) {
      replacePendingJobStepsInDb(db, jobId, replacementSteps, now)
    }
    const finalSteps = db.prepare('SELECT * FROM job_steps WHERE job_id = ? ORDER BY sort_order ASC')
      .all(jobId)
      .map(mapStep)
    const finalPlanDigest = computePlanDigest(finalSteps)
    if (finalPlanDigest !== approvedPlanDigest) {
      const error = new Error('approved plan digest did not match the persisted plan')
      error.code = 'JOB_PLAN_APPROVAL_DIGEST_MISMATCH'
      throw error
    }

    const update = db.prepare(`
      UPDATE jobs
         SET status = 'queued', error = NULL, finished_at = NULL, updated_at = ?
       WHERE id = ? AND user_id = ? AND status = 'waiting'
    `).run(now, jobId, userId)
    if (update.changes !== 1) {
      const error = new Error('job plan approval lost its compare-and-swap race')
      error.code = 'JOB_PLAN_APPROVAL_CAS_FAILED'
      throw error
    }

    const stepCount = finalSteps.filter((step) => step.kind !== 'plan').length
    const payload = {
      contract,
      version,
      scope: 'job',
      proposalEventId: expectedProposalId,
      proposalPlanDigest,
      approvedPlanDigest: finalPlanDigest,
      previousMode,
      mode: previousMode,
      edited: edited === true,
      stepCount,
    }
    const info = db.prepare(`
      INSERT INTO job_events (job_id, step_id, type, message, payload_json, created_at)
      VALUES (?, NULL, 'plan_approved', ?, ?, ?)
    `).run(
      jobId,
      'Plan approved; execution has been requeued',
      JSON.stringify(payload),
      now,
    )
    const event = mapEvent(db.prepare('SELECT * FROM job_events WHERE id = ?').get(info.lastInsertRowid))
    return {
      status: 'approved',
      idempotent: false,
      event,
      approvedPlanDigest: finalPlanDigest,
    }
  })
  return transaction()
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

export function completeJobStep(stepId, {
  evidence = [],
  output = null,
  completedAt = Date.now(),
} = {}) {
  const current = getJobStep(stepId)
  if (!current) return null

  let storedEvidence
  if (requiresStructuredCompletionEvidence(current)) {
    const validation = validateStructuredCompletionEvidence(evidence)
    if (!validation.ok) throw completionEvidenceError(validation.code, validation.error)
    storedEvidence = validation.evidence
  } else {
    // Plan, finalize, chat, and other prose-only steps keep their legacy
    // completion contract. Only evidence-bearing execution steps are hardened.
    storedEvidence = Array.isArray(evidence) ? evidence.filter(Boolean) : []
  }

  const priorOutput = current.output && typeof current.output === 'object' && !Array.isArray(current.output)
    ? current.output
    : {}
  const suppliedOutput = output && typeof output === 'object' && !Array.isArray(output)
    ? output
    : {}
  return updateJobStep(stepId, {
    status: 'completed',
    output: {
      ...priorOutput,
      ...suppliedOutput,
      evidence: storedEvidence,
      completedAt,
    },
    error: null,
    finishedAt: completedAt,
  }, completedAt)
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
  const db = getDb()
  return db.transaction(() => {
    assertManagedArtifactMutationAllowed(
      db,
      'Artifacts cannot change while local data is being cleared',
    )
    db.prepare(`
      INSERT INTO job_artifacts (id, job_id, user_id, step_id, type, title, url, filename, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, jobId, userId, stepId, type, title, url, filename, now)
    return mapArtifact(db.prepare(
      'SELECT * FROM job_artifacts WHERE id = ? AND user_id = ?',
    ).get(id, userId))
  }).immediate()
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

export function listArtifactsByFilename(filename) {
  if (!filename) return []
  return getDb().prepare('SELECT * FROM job_artifacts WHERE filename = ? ORDER BY created_at ASC')
    .all(filename)
    .map(mapArtifact)
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
      WHERE status IN ('queued', 'planning', 'running', 'waiting', 'awaiting_approval', 'cancel_requested')
      ORDER BY created_at ASC
    `)
    .all()
    .map(mapJob)
}
