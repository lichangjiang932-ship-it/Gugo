import assert from 'node:assert/strict'
import test from 'node:test'
import { authorizeRequestedDirectory } from '../src/lib/jobDirectoryRequest.js'

test('目录授权提交成功后才恢复原 Job', async () => {
  const order = []
  const result = await authorizeRequestedDirectory({
    jobId: 'job-1',
    path: 'D:\\Reports',
    accessMode: 'read_only',
    purpose: '读取报告',
  }, {
    grantPath: async (input) => {
      order.push(['grant', input])
      return { ok: true }
    },
    steer: async (jobId, content) => {
      order.push(['steer', { jobId, content }])
      return { accepted: true, job: { id: jobId, status: 'queued' } }
    },
  })

  assert.deepEqual(order[0], ['grant', { path: 'D:\\Reports', accessMode: 'read_only' }])
  assert.equal(order[1][0], 'steer')
  assert.equal(order[1][1].jobId, 'job-1')
  assert.match(order[1][1].content, /\[directory_authorization\]/)
  assert.match(order[1][1].content, /D:\\\\Reports/)
  assert.equal(result.path, 'D:\\Reports')
  assert.equal(result.job.status, 'queued')
})

test('系统选择器取消时不授权也不恢复 Job', async () => {
  let grants = 0
  let steers = 0
  const result = await authorizeRequestedDirectory({ jobId: 'job-1', usePicker: true }, {
    pickDirectory: async () => ({ ok: true, path: null }),
    grantPath: async () => { grants += 1 },
    steer: async () => { steers += 1 },
  })
  assert.equal(result.cancelled, true)
  assert.equal(grants, 0)
  assert.equal(steers, 0)
})

test('目录授权失败时绝不恢复 Job', async () => {
  let steers = 0
  await assert.rejects(() => authorizeRequestedDirectory({
    jobId: 'job-1',
    path: 'D:\\Private',
    accessMode: 'read_write',
  }, {
    grantPath: async () => { throw new Error('grant denied') },
    steer: async () => { steers += 1 },
  }), /grant denied/)
  assert.equal(steers, 0)
})
