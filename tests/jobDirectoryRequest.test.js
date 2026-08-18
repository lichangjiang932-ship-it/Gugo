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
    resume: async (jobId, payload) => {
      order.push(['resume', { jobId, payload }])
      return { resumed: true, job: { id: jobId, status: 'queued' } }
    },
  })

  assert.deepEqual(order[0], ['grant', { path: 'D:\\Reports', accessMode: 'read_only', scope: 'session' }])
  assert.equal(order[1][0], 'resume')
  assert.equal(order[1][1].jobId, 'job-1')
  assert.equal(order[1][1].payload.path, 'D:\\Reports')
  assert.equal(order[1][1].payload.accessMode, 'read_only')
  assert.equal(typeof order[1][1].payload.purpose, 'string')
  assert.equal(result.path, 'D:\\Reports')
  assert.equal(result.scope, 'session')
  assert.equal(result.job.status, 'queued')
})

test('目录路径为空时不授权也不恢复 Job', async () => {
  let grants = 0
  let resumes = 0
  await assert.rejects(() => authorizeRequestedDirectory({ jobId: 'job-1' }, {
    grantPath: async () => { grants += 1 },
    resume: async () => { resumes += 1 },
  }), /directory path is required/)
  assert.equal(grants, 0)
  assert.equal(resumes, 0)
})

test('目录授权失败时绝不恢复 Job', async () => {
  let resumes = 0
  await assert.rejects(() => authorizeRequestedDirectory({
    jobId: 'job-1',
    path: 'D:\\Private',
    accessMode: 'read_write',
  }, {
    grantPath: async () => { throw new Error('grant denied') },
    resume: async () => { resumes += 1 },
  }), /grant denied/)
  assert.equal(resumes, 0)
})
