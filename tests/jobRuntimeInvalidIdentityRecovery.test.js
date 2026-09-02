import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.APP_DATA_DIR = path.join(
  os.tmpdir(),
  'yma-job-runtime-invalid-recovery-tests',
  String(process.pid),
)

const { getDb } = await import('../server/db.js')
const { JobRuntime } = await import('../server/services/jobRuntime.js')
const { runJobRuntimeTick } = await import('../server/services/jobRuntimeTick.js')
const { createJob: createStoredJob } = await import('../server/services/jobStore.js')

function insertUser(db, { id, email, now }) {
  db.prepare(
    'INSERT INTO users (id, email, created_at, updated_at) VALUES (?, ?, ?, ?)',
  ).run(id, email, now, now)
}

function insertJob(db, { id, userId, status, now }) {
  db.prepare(`
    INSERT INTO jobs
      (id, user_id, title, prompt, status, progress, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 0, ?, ?)
  `).run(id, userId, String(id), 'recover safely', status, now, now)
  db.prepare(`
    INSERT INTO job_steps
      (id, job_id, title, kind, status, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, 'plan', 'running', 0, ?, ?)
  `).run(`step-${String(id)}`, id, 'recover safely', now, now)
}

function jobState(db, id) {
  return db.prepare('SELECT status, error FROM jobs WHERE id = ?').get(id)
}

function recoveryEventCount(db, id) {
  return db.prepare(`
    SELECT COUNT(*) AS count
      FROM job_events
     WHERE job_id = ? AND type IN ('recovered', 'approval_recovered')
  `).get(id).count
}

test('invalid persisted identities stay inert while valid jobs still recover', async () => {
  const db = getDb()
  const validUserId = 'valid-recovery-owner'
  const whitespaceUserId = '   '
  const binaryUserId = Buffer.from('binary-recovery-owner')
  const whitespaceJobId = ' \t '
  const fixtures = [
    { id: 'invalid-whitespace-owner-job', userId: whitespaceUserId, status: 'running' },
    { id: 'invalid-binary-owner-job', userId: binaryUserId, status: 'planning' },
    { id: whitespaceJobId, userId: validUserId, status: 'running' },
  ]
  const now = Date.now()
  insertUser(db, {
    id: validUserId,
    email: 'runtime-invalid-recovery-valid@example.test',
    now,
  })
  insertUser(db, {
    id: whitespaceUserId,
    email: 'runtime-invalid-recovery-whitespace@example.test',
    now,
  })
  insertUser(db, {
    id: binaryUserId,
    email: 'runtime-invalid-recovery-binary@example.test',
    now,
  })
  fixtures.forEach((fixture, index) => insertJob(db, { ...fixture, now: now + index }))
  insertJob(db, {
    id: 'valid-recovery-job',
    userId: validUserId,
    status: 'running',
    now: now + fixtures.length,
  })

  const jobsBeforeStoreChecks = db.prepare('SELECT COUNT(*) AS count FROM jobs').get().count
  assert.throws(
    () => createStoredJob({ id: '   ', userId: validUserId, title: 'invalid', prompt: 'invalid' }),
    /non-empty jobId string/u,
  )
  assert.throws(
    () => createStoredJob({
      id: 'invalid-store-owner-job',
      userId: Buffer.from('invalid-store-owner'),
      title: 'invalid',
      prompt: 'invalid',
    }),
    /non-empty userId string/u,
  )
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM jobs').get().count, jobsBeforeStoreChecks)

  let runtime
  try {
    assert.doesNotThrow(() => {
      runtime = new JobRuntime({
        modelBindingResolver: () => ({
          modelName: 'test-model',
          providerId: null,
          configRevision: null,
          env: {},
        }),
        executeStep: async () => ({ ok: true, output: { text: 'done' } }),
      })
    })

    for (const fixture of fixtures) {
      assert.deepEqual(jobState(db, fixture.id), { status: fixture.status, error: null })
      assert.equal(recoveryEventCount(db, fixture.id), 0)
      assert.equal(
        db.prepare('SELECT status FROM job_steps WHERE job_id = ?').get(fixture.id).status,
        'running',
      )
    }

    assert.deepEqual(jobState(db, 'valid-recovery-job'), { status: 'queued', error: null })
    assert.equal(recoveryEventCount(db, 'valid-recovery-job'), 1)
    assert.equal(
      db.prepare('SELECT status FROM job_steps WHERE job_id = ?').get('valid-recovery-job').status,
      'queued',
    )

    db.prepare("UPDATE jobs SET status = 'completed' WHERE id = ?").run('valid-recovery-job')
    assert.equal(await runtime.runOneTick(), false)
    for (const fixture of fixtures) {
      assert.equal(jobState(db, fixture.id).status, fixture.status)
      assert.equal(recoveryEventCount(db, fixture.id), 0)
    }
  } finally {
    runtime?.stop()
    db.prepare(`
      DELETE FROM users
       WHERE email LIKE 'runtime-invalid-recovery-%@example.test'
    `).run()
  }
})

test('invalid or mismatched persisted wake owners are ignored before caching', async () => {
  const cacheCalls = []
  const emitted = []
  const result = await runJobRuntimeTick.call({
    activeJobIds: new Set(),
    cacheJobOwner: (...args) => cacheCalls.push(args),
    emit: (event) => emitted.push(event),
  }, {
    claimDueJobWakes: () => [
      { jobId: 'mismatched-wake-job', userId: 'user-b', kind: 'resume' },
      { jobId: 'invalid-wake-job', userId: Buffer.from('binary-owner'), kind: 'resume' },
    ],
    getJobRow: (jobId) => ({
      id: jobId,
      userId: jobId === 'mismatched-wake-job' ? 'user-a' : Buffer.from('binary-owner'),
    }),
    listRecoverableJobs: () => [],
    SUSPENDED_JOB_STATUSES: new Set(),
  })

  assert.equal(result, false)
  assert.deepEqual(cacheCalls, [])
  assert.deepEqual(emitted, [])
})
