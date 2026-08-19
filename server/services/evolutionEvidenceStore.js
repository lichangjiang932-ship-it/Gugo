import { randomUUID } from 'node:crypto'

import { getDb } from '../db.js'

const MAX_FEEDBACK_CHARS = 4_000
const DEFAULT_LIMIT = 100
const MAX_LIMIT = 200
const REVIEW_VERDICTS = new Set(['pass', 'fixable', 'blocked', 'needs_user'])

function serviceError(code, message, statusCode = 400) {
  return Object.assign(new Error(message), { code, statusCode })
}

function boundedText(value, maxLength) {
  const text = typeof value === 'string' ? value.trim() : ''
  return text ? text.slice(0, maxLength) : ''
}

function parseJson(value) {
  try { return JSON.parse(value || '{}') } catch { return {} }
}

function normalizeLimit(value) {
  if (value == null || value === '') return DEFAULT_LIMIT
  const limit = Number(value)
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw serviceError('EVOLUTION_LIMIT_INVALID', `limit must be an integer between 1 and ${MAX_LIMIT}`)
  }
  return limit
}

function feedbackView(row) {
  return {
    id: `feedback:${row.id}`,
    source: 'user_feedback',
    signal: 'explicit_feedback',
    sessionId: row.session_id || null,
    createdAt: row.created_at,
    feedback: boundedText(row.body, MAX_FEEDBACK_CHARS),
  }
}

function boundedList(value, maxItems = 50, maxChars = 2_000) {
  return (Array.isArray(value) ? value : [])
    .map((item) => boundedText(item, maxChars))
    .filter(Boolean)
    .slice(0, maxItems)
}

function reviewerView(row) {
  const payload = parseJson(row.payload_json)
  const acceptance = payload?.acceptance && typeof payload.acceptance === 'object'
    ? payload.acceptance
    : {}
  const reviewer = acceptance?.reviewer && typeof acceptance.reviewer === 'object'
    ? acceptance.reviewer
    : payload?.reviewer && typeof payload.reviewer === 'object'
      ? payload.reviewer
      : {}
  const verdictValue = boundedText(acceptance.verdict, 32).toLowerCase()
  const verdict = REVIEW_VERDICTS.has(verdictValue) ? verdictValue : 'unknown'
  return {
    id: `task-review:${row.id}`,
    source: 'task_review',
    signal: verdict,
    jobId: row.job_id,
    stepId: row.step_id || null,
    createdAt: row.created_at,
    review: {
      verdict,
      summary: boundedText(acceptance.summary, 2_000),
      issues: boundedList(acceptance.issues),
      evidence: boundedList(acceptance.evidence),
      repairAttempts: Number.isInteger(payload.repairAttempts) ? payload.repairAttempts : 0,
      reviewer: {
        independent: reviewer.independent === true,
        mode: boundedText(reviewer.mode, 128) || null,
        workerModel: boundedText(reviewer.workerModel, 512) || null,
        reviewerModel: boundedText(reviewer.reviewerModel, 512) || null,
      },
    },
  }
}

export function appendEvolutionFeedback({ userId, sessionId = null, feedback, now = Date.now() }) {
  const owner = boundedText(userId, 256)
  const body = typeof feedback === 'string' ? feedback.trim() : ''
  const requestedSession = boundedText(sessionId, 256) || null
  if (!owner) throw serviceError('EVOLUTION_USER_REQUIRED', 'userId is required')
  if (!body) throw serviceError('EVOLUTION_FEEDBACK_REQUIRED', 'feedback is required')
  if (body.length > MAX_FEEDBACK_CHARS) {
    throw serviceError('EVOLUTION_FEEDBACK_TOO_LARGE', `feedback must not exceed ${MAX_FEEDBACK_CHARS} characters`)
  }
  const timestamp = Number(now)
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw serviceError('EVOLUTION_TIMESTAMP_INVALID', 'now must be a non-negative safe integer')
  }
  const db = getDb()
  const session = requestedSession
    && db.prepare(`
      SELECT 1 FROM sessions
      WHERE token = ? AND user_id = ? AND (id IS NOT NULL OR title IS NOT NULL)
    `).get(requestedSession, owner)
    ? requestedSession
    : null
  const id = randomUUID()
  db.prepare(`
    INSERT INTO evolution_feedback (id, user_id, session_id, body, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, owner, session, body, timestamp)
  return feedbackView(db.prepare('SELECT * FROM evolution_feedback WHERE id = ? AND user_id = ?').get(id, owner))
}

export function listEvolutionEvidence({ userId, limit: limitValue } = {}) {
  const owner = boundedText(userId, 256)
  if (!owner) throw serviceError('EVOLUTION_USER_REQUIRED', 'userId is required')
  const limit = normalizeLimit(limitValue)
  const db = getDb()
  const feedback = db.prepare(`
    SELECT id, session_id, body, created_at
    FROM evolution_feedback
    WHERE user_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(owner, limit).map(feedbackView)
  const reviews = db.prepare(`
    SELECT event.id, event.job_id, event.step_id, event.payload_json, event.created_at
    FROM job_events AS event
    JOIN jobs AS job ON job.id = event.job_id
    WHERE job.user_id = ? AND event.type = 'task_reviewed'
    ORDER BY event.created_at DESC, event.id DESC
    LIMIT ?
  `).all(owner, limit).map(reviewerView)
  return [...feedback, ...reviews]
    .sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id))
    .slice(0, limit)
}
