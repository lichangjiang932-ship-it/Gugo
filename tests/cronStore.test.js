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
    grants: [{ tool: 'publish_report', target: { channelId: 'C-ops' }, scope: 'forever' }],
  })

  assert.ok(created.id)
  assert.equal(created.userId, userId)
  assert.equal(created.enabled, true)
  assert.ok(created.nextRunAt)
  assert.deepEqual(created.grants, [
    { tool: 'publish_report', target: { channelId: 'C-ops' }, scope: 'forever' },
  ])

  const listed = listCronJobs({ userId })
  assert.ok(listed.some((job) => job.id === created.id))

  const updated = updateCronJob(created.id, {
    enabled: false,
    title: 'Paused digest',
    grants: [{ tool: 'bash_exec', target: ['git', 'pull'], scope: 'this-run' }],
  }, { userId })
  assert.equal(updated.title, 'Paused digest')
  assert.equal(updated.enabled, false)
  assert.equal(updated.nextRunAt, null)
  assert.deepEqual(updated.grants, [
    { tool: 'bash_exec', target: ['git', 'pull'], scope: 'this-run' },
  ])

  assert.equal(deleteCronJob(created.id, { userId }), 1)
  assert.equal(getCronJob(created.id, { userId }), null)
})

test('cron store rejects imprecise or local-write grants', () => {
  const { userId } = issueTestSession()
  const base = {
    userId,
    title: 'Invalid grant',
    kind: 'cron',
    scheduleType: 'every',
    scheduleValue: '60000',
    execType: 'agent_session',
    execPayload: { prompt: 'test' },
  }
  assert.throws(
    () => createCronJob({ ...base, grants: [{ tool: 'bash_exec', target: ['git', '*'] }] }),
    /wildcards/,
  )
  assert.throws(
    () => createCronJob({ ...base, grants: [{ tool: 'write_file', target: { path: 'x.txt' } }] }),
    /cannot be auto-authorized/,
  )
})
