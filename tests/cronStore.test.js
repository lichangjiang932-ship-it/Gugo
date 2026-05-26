import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.APP_DATA_DIR = path.join(os.tmpdir(), 'yma-cron-store-tests', String(process.pid))

const {
  createCronJob,
  deleteCronJob,
  getCronJob,
  listCronJobs,
  updateCronJob,
} = await import('../server/services/cronStore.js')
const { closeDb } = await import('../server/db.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

test.after(() => {
  closeDb()
})

test('createCronJob/listCronJobs/updateCronJob/deleteCronJob', () => {
  const { userId } = issueTestSession()
  const created = createCronJob({
    userId,
    title: 'Daily digest',
    kind: 'cron',
    scheduleType: 'every',
    scheduleValue: '60000',
    execType: 'direct_notify',
    execPayload: { title: 'Digest', body: 'Review inbox' },
  })

  assert.ok(created.id)
  assert.equal(created.userId, userId)
  assert.equal(created.enabled, true)
  assert.ok(created.nextRunAt)

  const listed = listCronJobs({ userId })
  assert.ok(listed.some((job) => job.id === created.id))

  const updated = updateCronJob(created.id, {
    enabled: false,
    title: 'Paused digest',
  }, { userId })
  assert.equal(updated.title, 'Paused digest')
  assert.equal(updated.enabled, false)
  assert.equal(updated.nextRunAt, null)

  assert.equal(deleteCronJob(created.id, { userId }), 1)
  assert.equal(getCronJob(created.id, { userId }), null)
})
