import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.APP_DATA_DIR = path.join(os.tmpdir(), 'yma-job-store-tests', String(process.pid))

const {
  appendJobArtifact,
  appendJobEvent,
  appendJobSteps,
  createJob,
  getJobWithChildren,
  listJobArtifacts,
  listJobEvents,
  listJobs,
  updateJob,
} = await import('../server/jobStore.js')

test('job store persists parent job, child steps, events, and artifacts', () => {
  const job = createJob({
    id: 'job-1',
    title: '生成 3 份周报',
    prompt: '生成 3 份周报',
    status: 'queued',
  })
  appendJobSteps('job-1', [
    { id: 'step-1', title: '规划任务', kind: 'plan' },
    { id: 'step-2', title: '生成周报', kind: 'batch_item' },
  ])
  appendJobEvent({ jobId: 'job-1', type: 'created', message: '已创建' })
  appendJobArtifact({
    id: 'artifact-1',
    jobId: 'job-1',
    stepId: 'step-2',
    type: 'docx',
    title: '周报',
    url: '/api/artifacts/report.docx',
    filename: 'report.docx',
  })
  updateJob('job-1', { status: 'running', progress: 50 })

  const loaded = getJobWithChildren('job-1')
  assert.equal(job.id, 'job-1')
  assert.equal(listJobs()[0].status, 'running')
  assert.equal(loaded.steps.length, 2)
  assert.equal(listJobEvents('job-1')[0].message, '已创建')
  assert.equal(listJobArtifacts('job-1')[0].filename, 'report.docx')
})

