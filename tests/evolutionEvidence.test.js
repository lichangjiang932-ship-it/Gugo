import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-evolution-evidence-'))
process.env.APP_DATA_DIR = tempDir
process.env.APP_DB_PATH = path.join(tempDir, 'app.db')

const { createAppServer } = await import('../server/appServer.js')
const { closeDb, getDb } = await import('../server/db.js')
const { appendJobEvent, createJob } = await import('../server/services/jobStore.js')
const { upsertSession } = await import('../server/services/sessionStore.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

const server = createAppServer({ getEnv: () => ({}) })
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

function auth(token) {
  return { Authorization: `Bearer ${token}` }
}

async function postFeedback(token, payload) {
  return fetch(`${origin}/api/evolution/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth(token) },
    body: JSON.stringify(payload),
  })
}

test.after(async () => {
  await new Promise((resolve) => server.close(resolve))
  closeDb()
  fs.rmSync(tempDir, { recursive: true, force: true })
})

test('evolution evidence persists explicit feedback and exposes only user-scoped whitelisted evidence', async () => {
  const alice = issueTestSession({ email: 'evolution-alice@example.com' })
  const bob = issueTestSession({ email: 'evolution-bob@example.com' })
  upsertSession({ id: 'alice-chat', userId: alice.userId, title: 'Alice chat' })
  upsertSession({ id: 'bob-chat', userId: bob.userId, title: 'Bob chat' })

  assert.equal((await fetch(`${origin}/api/evolution/evidence`)).status, 401)

  const saved = await postFeedback(alice.token, {
    feedback: ' Keep verification evidence visible. ',
    sessionId: 'alice-chat',
  })
  assert.equal(saved.status, 201)
  const savedBody = await saved.json()
  assert.equal(savedBody.evidence.source, 'user_feedback')
  assert.equal(savedBody.evidence.feedback, 'Keep verification evidence visible.')
  assert.equal(savedBody.evidence.sessionId, 'alice-chat')

  const crossSession = await postFeedback(alice.token, {
    feedback: 'Do not bind this to another owner.',
    sessionId: 'bob-chat',
  })
  assert.equal(crossSession.status, 201)
  assert.equal((await crossSession.json()).evidence.sessionId, null)

  await postFeedback(bob.token, {
    feedback: 'BOB_PRIVATE_FEEDBACK',
    sessionId: 'bob-chat',
  })

  createJob({
    id: 'alice-reviewed-job',
    userId: alice.userId,
    title: 'Reviewed job',
    prompt: 'ALICE_PRIVATE_PROMPT',
    modelName: 'worker-model',
  })
  appendJobEvent({
    jobId: 'alice-reviewed-job',
    stepId: 'verify-step',
    type: 'task_reviewed',
    code: 'JOB_TASK_REVIEWED',
    params: { verdict: 'fixable' },
    now: 50,
    payload: {
      acceptance: {
        verdict: 'fixable',
        summary: 'One assertion still fails.',
        issues: ['missing readback'],
        evidence: ['npm test: one failed'],
        source: 'independent_reviewer',
        reviewer: {
          independent: true,
          mode: 'distinct_model_review',
          workerModel: 'worker-model',
          reviewerModel: 'reviewer-model',
          error: 'REVIEWER_PRIVATE_ERROR',
        },
        rawTranscript: 'RAW_PRIVATE_TRANSCRIPT',
      },
      repairAttempts: 1,
      secret: 'PAYLOAD_PRIVATE_SECRET',
    },
  })

  createJob({
    id: 'bob-reviewed-job',
    userId: bob.userId,
    title: 'Bob job',
    prompt: 'BOB_PRIVATE_PROMPT',
  })
  appendJobEvent({
    jobId: 'bob-reviewed-job',
    type: 'task_reviewed',
    code: 'JOB_TASK_REVIEWED',
    params: { verdict: 'pass' },
    payload: { acceptance: { verdict: 'pass', summary: 'BOB_PRIVATE_REVIEW' } },
  })

  const response = await fetch(`${origin}/api/evolution/evidence?limit=20`, {
    headers: auth(alice.token),
  })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const corpus = await response.json()
  assert.equal(corpus.schemaVersion, 1)
  assert.equal(corpus.evidence.filter((item) => item.source === 'user_feedback').length, 2)
  const review = corpus.evidence.find((item) => item.source === 'task_review')
  assert.equal(review.signal, 'fixable')
  assert.equal(review.jobId, 'alice-reviewed-job')
  assert.deepEqual(review.review, {
    verdict: 'fixable',
    summary: 'One assertion still fails.',
    issues: ['missing readback'],
    evidence: ['npm test: one failed'],
    repairAttempts: 1,
    reviewer: {
      independent: true,
      mode: 'distinct_model_review',
      workerModel: 'worker-model',
      reviewerModel: 'reviewer-model',
    },
  })
  assert.doesNotMatch(
    JSON.stringify(corpus),
    /BOB_PRIVATE|ALICE_PRIVATE_PROMPT|RAW_PRIVATE|REVIEWER_PRIVATE_ERROR|PAYLOAD_PRIVATE_SECRET/,
  )
  assert.equal(
    getDb().prepare('SELECT COUNT(*) AS count FROM evolution_feedback WHERE user_id = ?').get(alice.userId).count,
    2,
  )
})

test('evolution evidence validates feedback and bounded query limits', async () => {
  const session = issueTestSession({ email: 'evolution-validation@example.com' })
  const empty = await postFeedback(session.token, { feedback: '   ' })
  assert.equal(empty.status, 400)
  assert.equal((await empty.json()).error.code, 'EVOLUTION_FEEDBACK_REQUIRED')

  const oversized = await postFeedback(session.token, { feedback: 'x'.repeat(4_001) })
  assert.equal(oversized.status, 400)
  assert.equal((await oversized.json()).error.code, 'EVOLUTION_FEEDBACK_TOO_LARGE')

  const invalidLimit = await fetch(`${origin}/api/evolution/evidence?limit=201`, {
    headers: auth(session.token),
  })
  assert.equal(invalidLimit.status, 400)
  assert.equal((await invalidLimit.json()).error.code, 'EVOLUTION_LIMIT_INVALID')

  const wrongMethod = await fetch(`${origin}/api/evolution/evidence`, {
    method: 'POST',
    headers: auth(session.token),
  })
  assert.equal(wrongMethod.status, 405)
})
