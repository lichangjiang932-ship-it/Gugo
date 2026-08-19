import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-task-grant-persistence-'))
process.env.APP_DATA_DIR = tempDir

const { closeDb } = await import('../server/db.js')
const { createJob, getJob } = await import('../server/services/jobStore.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

test.after(() => {
  closeDb()
  fs.rmSync(tempDir, { recursive: true, force: true })
})

test('scheduled job provenance and grants survive a database restart', () => {
  const { userId } = issueTestSession({ email: `task-grant-persist-${process.pid}@example.com` })
  const grants = [{ tool: 'bash_exec', target: ['git', 'pull'], scope: 'forever' }]
  createJob({
    id: 'job-cron-persisted',
    userId,
    title: 'Persisted cron job',
    prompt: 'git pull',
    sourceType: 'cron',
    sourceId: 'cron-persisted',
    grants,
  })

  closeDb()
  const restored = getJob('job-cron-persisted', { userId })
  assert.equal(restored.sourceType, 'cron')
  assert.equal(restored.sourceId, 'cron-persisted')
  assert.deepEqual(restored.grants, grants)
})
