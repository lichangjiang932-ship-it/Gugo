import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-evolution-dataset-'))
process.env.APP_DATA_DIR = tempDir
process.env.APP_DB_PATH = path.join(tempDir, 'app.db')

const { createAppServer } = await import('../server/appServer.js')
const { closeDb } = await import('../server/db.js')
const { appendJobEvent, createJob } = await import('../server/services/jobStore.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

const server = createAppServer({ getEnv: () => ({}) })
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

function headers(token, json = false) {
  return {
    Authorization: `Bearer ${token}`,
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  }
}

async function feedback(token, value) {
  const response = await fetch(`${origin}/api/evolution/feedback`, {
    method: 'POST',
    headers: headers(token, true),
    body: JSON.stringify({ feedback: value }),
  })
  assert.equal(response.status, 201)
  return (await response.json()).evidence
}

async function dataset(token) {
  const response = await fetch(`${origin}/api/evolution/dataset?limit=200`, {
    headers: headers(token),
  })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  return (await response.json()).dataset
}

async function exclude(token, evidenceId, excluded, reason = null) {
  return fetch(`${origin}/api/evolution/exclusions`, {
    method: 'POST',
    headers: headers(token, true),
    body: JSON.stringify({ evidenceId, excluded, reason }),
  })
}

test.after(async () => {
  await new Promise((resolve) => server.close(resolve))
  closeDb()
  fs.rmSync(tempDir, { recursive: true, force: true })
})

test('curation redacts, deduplicates, clusters, fingerprints, and reversibly excludes evidence', async () => {
  const alice = issueTestSession({ email: 'dataset-alice@example.com' })
  const bob = issueTestSession({ email: 'dataset-bob@example.com' })
  const first = await feedback(
    alice.token,
    'token=alpha-secret contact alice@example.com at C:\\Users\\Alice\\private.txt',
  )
  const duplicate = await feedback(
    alice.token,
    'token=beta-secret contact bob@example.net at D:\\home\\different.txt',
  )
  const bobEvidence = await feedback(bob.token, 'BOB_PRIVATE_DATASET_EVIDENCE')

  createJob({
    id: 'dataset-review-job',
    userId: alice.userId,
    title: 'Dataset review',
    prompt: 'private prompt',
  })
  appendJobEvent({
    jobId: 'dataset-review-job',
    stepId: 'verification-step',
    type: 'task_reviewed',
    message: 'Structured review',
    now: 100,
    payload: {
      acceptance: {
        verdict: 'fixable',
        summary: 'Verification test failed at /home/alice/project/test.js',
        issues: ['Assertion failed with Bearer private-token-value'],
        evidence: ['npm test: 1 failed'],
        reviewer: {
          independent: true,
          mode: 'distinct_model_review',
          workerModel: 'worker@example.com',
          reviewerModel: 'reviewer-model',
        },
      },
      repairAttempts: 1,
    },
  })

  const initial = await dataset(alice.token)
  assert.equal(initial.schemaVersion, 1)
  assert.equal(initial.evidenceSchemaVersion, 1)
  assert.match(initial.curationVersion, /^\d{4}-\d{2}-\d{2}-v\d+$/)
  assert.match(initial.datasetFingerprint, /^[a-f0-9]{64}$/)
  assert.deepEqual(initial.summary, {
    sourceEvidenceCount: 3,
    includedEvidenceCount: 3,
    excludedEvidenceCount: 0,
    deduplicatedRecordCount: 2,
  })
  const feedbackRecord = initial.records.find((record) => record.source === 'user_feedback')
  assert.equal(feedbackRecord.occurrenceCount, 2)
  assert.deepEqual(feedbackRecord.evidenceIds.sort(), [first.id, duplicate.id].sort())
  assert.equal(feedbackRecord.cluster, 'user_feedback')
  assert.match(feedbackRecord.contentFingerprint, /^[a-f0-9]{64}$/)
  const reviewRecord = initial.records.find((record) => record.source === 'task_review')
  assert.equal(reviewRecord.cluster, 'verification')
  assert.equal(initial.clusters.find((cluster) => cluster.id === 'verification').evidenceCount, 1)

  const serialized = JSON.stringify(initial)
  assert.doesNotMatch(serialized, /alpha-secret|beta-secret|alice@example|bob@example|private-token-value|worker@example|C:\\Users|\/home\/alice/u)
  assert.match(serialized, /\[REDACTED\]/)
  assert.match(serialized, /\[EMAIL\]/)
  assert.match(serialized, /\[LOCAL_PATH\]/)
  assert.equal((await dataset(alice.token)).datasetFingerprint, initial.datasetFingerprint)

  const excluded = await exclude(alice.token, first.id, true, 'duplicate sample')
  assert.equal(excluded.status, 200)
  assert.equal((await excluded.json()).exclusion.excluded, true)
  const afterExclusion = await dataset(alice.token)
  assert.notEqual(afterExclusion.datasetFingerprint, initial.datasetFingerprint)
  assert.deepEqual(afterExclusion.summary, {
    sourceEvidenceCount: 3,
    includedEvidenceCount: 2,
    excludedEvidenceCount: 1,
    deduplicatedRecordCount: 2,
  })
  assert.equal(
    afterExclusion.records.find((record) => record.source === 'user_feedback').occurrenceCount,
    1,
  )

  const exclusions = await fetch(`${origin}/api/evolution/exclusions`, {
    headers: headers(alice.token),
  })
  assert.equal(exclusions.status, 200)
  assert.deepEqual((await exclusions.json()).exclusions.map((item) => item.evidenceId), [first.id])

  const crossUser = await exclude(alice.token, bobEvidence.id, true, 'must fail')
  assert.equal(crossUser.status, 404)
  assert.equal((await crossUser.json()).error.code, 'EVOLUTION_EVIDENCE_NOT_FOUND')

  const restored = await exclude(alice.token, first.id, false)
  assert.equal(restored.status, 200)
  assert.equal((await restored.json()).exclusion.excluded, false)
  assert.equal((await dataset(alice.token)).datasetFingerprint, initial.datasetFingerprint)

  const raw = await fetch(`${origin}/api/evolution/evidence?limit=200`, {
    headers: headers(alice.token),
  })
  const rawJson = JSON.stringify(await raw.json())
  assert.match(rawJson, /alpha-secret/)
  assert.doesNotMatch(rawJson, /BOB_PRIVATE_DATASET_EVIDENCE/)
})

test('curation rejects invalid exclusion mutations and exposes no candidate apply endpoint', async () => {
  const session = issueTestSession({ email: 'dataset-validation@example.com' })
  const item = await feedback(session.token, 'validation sample')

  const invalidId = await exclude(session.token, '../escape', true, 'bad id')
  assert.equal(invalidId.status, 400)
  assert.equal((await invalidId.json()).error.code, 'EVOLUTION_EVIDENCE_ID_INVALID')

  const invalidFlag = await fetch(`${origin}/api/evolution/exclusions`, {
    method: 'POST',
    headers: headers(session.token, true),
    body: JSON.stringify({ evidenceId: item.id, excluded: 'yes' }),
  })
  assert.equal(invalidFlag.status, 400)
  assert.equal((await invalidFlag.json()).error.code, 'EVOLUTION_EXCLUDED_FLAG_INVALID')

  const sanitizedReason = await exclude(
    session.token,
    item.id,
    true,
    'token=reason-secret contact curator@example.com at C:\\Users\\Curator\\notes.txt',
  )
  assert.equal(sanitizedReason.status, 200)
  const reasonBody = JSON.stringify(await sanitizedReason.json())
  assert.doesNotMatch(reasonBody, /reason-secret|curator@example|C:\\Users/)
  assert.match(reasonBody, /\[REDACTED\].*\[EMAIL\].*\[LOCAL_PATH\]/)

  const reasonTooLarge = await exclude(session.token, item.id, true, 'x'.repeat(501))
  assert.equal(reasonTooLarge.status, 400)
  assert.equal((await reasonTooLarge.json()).error.code, 'EVOLUTION_EXCLUSION_REASON_TOO_LARGE')

  const apply = await fetch(`${origin}/api/evolution/candidates/not-a-candidate/apply`, {
    method: 'POST',
    headers: headers(session.token, true),
    body: '{}',
  })
  assert.equal(apply.status, 404)
})
