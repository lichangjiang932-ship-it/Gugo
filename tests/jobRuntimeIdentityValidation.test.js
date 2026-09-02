import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.APP_DATA_DIR = path.join(
  os.tmpdir(),
  'yma-job-runtime-identity-tests',
  String(process.pid),
)

const { getDb } = await import('../server/db.js')
const { JobRuntime } = await import('../server/services/jobRuntime.js')

function persistenceCounts(db) {
  return Object.fromEntries(['jobs', 'job_steps', 'job_events'].map((table) => [
    table,
    db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count,
  ]))
}

test('job creation rejects invalid owner identities before planning or persistence', async () => {
  const db = getDb()
  const whitespaceUserId = '   '
  const binaryUserId = Buffer.from('binary-job-owner')
  const now = Date.now()
  const insertUser = db.prepare(
    'INSERT INTO users (id, email, created_at, updated_at) VALUES (?, ?, ?, ?)',
  )
  insertUser.run(whitespaceUserId, 'invalid-whitespace-owner@example.test', now, now)
  insertUser.run(binaryUserId, 'invalid-binary-owner@example.test', now, now)

  let bindingCalls = 0
  let plannerCalls = 0
  const runtime = new JobRuntime({
    planner: () => {
      plannerCalls += 1
      return { title: 'must not run', steps: [{ kind: 'execute', title: 'must not persist' }] }
    },
  })
  runtime.resolveModelBinding = () => {
    bindingCalls += 1
    return {
      modelName: 'test-model',
      providerId: null,
      configRevision: null,
      env: {},
    }
  }

  const before = persistenceCounts(db)
  try {
    for (const userId of [whitespaceUserId, binaryUserId]) {
      await assert.rejects(
        runtime.createJob('must fail', { userId }),
        (error) => error instanceof TypeError
          && error.message === 'createJob requires a non-empty userId string',
      )
      await assert.rejects(
        runtime.createPlan({
          userId,
          title: 'must fail',
          prompt: 'must fail',
          steps: [{ kind: 'execute', title: 'must not persist' }],
        }),
        (error) => error instanceof TypeError
          && error.message === 'createPlan requires a non-empty userId string',
      )
    }

    assert.equal(bindingCalls, 0)
    assert.equal(plannerCalls, 0)
    assert.deepEqual(persistenceCounts(db), before)
  } finally {
    db.prepare('DELETE FROM users WHERE email IN (?, ?)').run(
      'invalid-whitespace-owner@example.test',
      'invalid-binary-owner@example.test',
    )
  }
})
