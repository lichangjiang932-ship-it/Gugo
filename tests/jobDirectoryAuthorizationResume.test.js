import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-job-directory-resume-'))
const authorizedDir = path.join(tempDir, 'authorized-output')
fs.mkdirSync(authorizedDir)
process.env.APP_DATA_DIR = tempDir

const { closeDb } = await import('../server/db.js')
const { JobRuntime } = await import('../server/services/jobRuntime.js')
const { setApprovalMode } = await import('../server/services/approvalSettingsStore.js')
const { grantLocalPath } = await import('../server/services/localFileAccessService.js')
const { appendJobEvent, updateJob } = await import('../server/services/jobStore.js')
const { getJobTurnCheckpoint, saveJobTurnCheckpoint } = await import('../server/services/jobTurnCheckpointStore.js')
const { getJobWake, scheduleJobWake } = await import('../server/services/jobWakeStore.js')
const { runToolLoop, SERVER_TOOL_SPECS } = await import('../server/services/toolLoopRuntime.js')
const { handleJobRequest } = await import('../server/routes/jobRoutes.js')
const { resumeJobDirectoryAuthorization } = await import('../src/lib/jobClient.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

test.after(() => {
  closeDb()
  fs.rmSync(tempDir, { recursive: true, force: true })
})

async function createWaitingDirectoryJob() {
  const { userId } = issueTestSession()
  setApprovalMode({ userId, mode: 'normal' })
  const runtime = new JobRuntime({
    planner: (prompt) => ({
      title: 'Directory authorization job',
      prompt,
      steps: [{ id: 'execute', title: 'Write PDF output', kind: 'execute', status: 'queued' }],
    }),
    executeStep: async () => ({
      paused: true,
      truncated: true,
      clarification: {
        question: 'Choose an output directory.',
        request_type: 'directory',
        access_mode: 'read_write',
        suggested_path: authorizedDir,
        purpose: 'Write the processed PDF.',
      },
      output: { text: '' },
    }),
  })
  const created = await runtime.createJob('Process this PDF', { userId })
  assert.equal(await runtime.runOneTick(), true)
  const waiting = runtime.getJob(created.id, { userId })
  assert.equal(waiting.status, 'waiting')
  const suspension = waiting.events.at(-1)
  assert.equal(suspension.type, 'awaiting_user')
  const stepId = suspension.stepId || waiting.steps[0].id
  saveJobTurnCheckpoint({
    jobId: created.id,
    stepId,
    userId,
    state: {
      messages: [{ role: 'user', content: 'Process this PDF.' }],
      final: { paused: true },
    },
  })
  return { runtime, userId, jobId: created.id, stepId }
}

test('persisted read-write directory grant resumes the paused Job checkpoint with a verified marker', async () => {
  const { runtime, userId, jobId, stepId } = await createWaitingDirectoryJob()
  const grant = grantLocalPath({ userId, rootPath: authorizedDir, accessMode: 'read_write' })
  assert.equal(grant.resourceType, 'directory')

  const result = runtime.resumeDirectoryAuthorization(jobId, {
    userId,
    path: authorizedDir,
    accessMode: 'read_write',
  })
  assert.equal(result.resumed, true)
  assert.equal(result.job.status, 'queued')

  const checkpoint = getJobTurnCheckpoint({ jobId, stepId, userId })
  assert.equal(checkpoint.state.final, null)
  assert.deepEqual(checkpoint.state.directoryAuthorizationResolution, {
    type: 'directory_authorization',
    approved: true,
    path: authorizedDir,
    access_mode: 'read_write',
    resource_type: 'directory',
    awaiting_event_id: result.job.events.find((event) => event.type === 'awaiting_user').id,
    step_id: stepId,
    grant_id: grant.id,
  })
  const marker = checkpoint.state.messages.find((message) => (
    message.role === 'system' && String(message.content).includes('[JOB_DIRECTORY_RESOLUTION:')
  ))
  assert.ok(marker)
  assert.match(marker.content, /already persisted and verified/)
  assert.match(marker.content, /read_write/)
  assert.equal(marker.content.includes(JSON.stringify(authorizedDir)), true)
  const resumedEvent = result.job.events.at(-1)
  assert.equal(resumedEvent.type, 'directory_authorization_resumed')
  assert.equal(resumedEvent.payload.grantId, grant.id)
  const replay = runtime.resumeDirectoryAuthorization(jobId, {
    userId,
    path: authorizedDir,
    accessMode: 'read_write',
  })
  assert.equal(replay.resumed, true)
  assert.equal(replay.idempotent, true)
  assert.equal(
    replay.job.events.filter((event) => event.type === 'directory_authorization_resumed').length,
    1,
  )
  runtime.requestCancel(jobId, { userId })
  await runtime.runOneTick()
})

test('old directory suspension cannot resume a later sleeping wait or cancel its wake', async () => {
  const { runtime, userId, jobId, stepId } = await createWaitingDirectoryJob()
  grantLocalPath({ userId, rootPath: authorizedDir, accessMode: 'read_write' })
  const wakeAt = Date.now() + 60_000
  scheduleJobWake({ jobId, stepId, userId, wakeAt, reason: 'later scheduled wait' })
  updateJob(jobId, { status: 'waiting' })
  appendJobEvent({
    jobId,
    stepId,
    type: 'sleeping',
    message: 'Waiting for the scheduled wake.',
    payload: { wakeAt, reason: 'later scheduled wait' },
  })

  const result = runtime.resumeDirectoryAuthorization(jobId, {
    userId,
    path: authorizedDir,
    accessMode: 'read_write',
  })
  assert.equal(result.resumed, false)
  assert.match(result.error, /not waiting for directory authorization/)
  assert.equal(getJobWake({ jobId, userId }).status, 'scheduled')
  assert.equal(runtime.getJob(jobId, { userId }).status, 'waiting')
})

test('notification failure metadata does not hide the active directory suspension', async () => {
  const { runtime, userId, jobId, stepId } = await createWaitingDirectoryJob()
  grantLocalPath({ userId, rootPath: authorizedDir, accessMode: 'read_write' })
  appendJobEvent({
    jobId,
    stepId,
    type: 'notification_failed',
    message: 'Clarification notification failed.',
    payload: { notificationKind: 'job_clarification' },
  })

  const result = runtime.resumeDirectoryAuthorization(jobId, {
    userId,
    path: authorizedDir,
    accessMode: 'read_write',
  })
  assert.equal(result.resumed, true)
  assert.equal(result.job.status, 'queued')
  runtime.requestCancel(jobId, { userId })
  await runtime.runOneTick()
})

test('Job remains waiting when the requested directory grant is missing or does not match', async () => {
  const missing = await createWaitingDirectoryJob()
  const missingResult = missing.runtime.resumeDirectoryAuthorization(missing.jobId, {
    userId: missing.userId,
    path: authorizedDir,
    accessMode: 'read_write',
  })
  assert.equal(missingResult.resumed, false)
  assert.match(missingResult.error, /not persisted/)
  assert.equal(missing.runtime.getJob(missing.jobId, { userId: missing.userId }).status, 'waiting')

  const mismatched = await createWaitingDirectoryJob()
  grantLocalPath({ userId: mismatched.userId, rootPath: authorizedDir, accessMode: 'read_write' })
  const wrongMode = mismatched.runtime.resumeDirectoryAuthorization(mismatched.jobId, {
    userId: mismatched.userId,
    path: authorizedDir,
    accessMode: 'read_only',
  })
  assert.equal(wrongMode.resumed, false)
  assert.match(wrongMode.error, /access mode does not match/)
  assert.equal(mismatched.runtime.getJob(mismatched.jobId, { userId: mismatched.userId }).status, 'waiting')

  const wrongPath = path.join(tempDir, `other-output-${Date.now()}`)
  fs.mkdirSync(wrongPath)
  grantLocalPath({ userId: mismatched.userId, rootPath: wrongPath, accessMode: 'read_write' })
  const pathMismatch = mismatched.runtime.resumeDirectoryAuthorization(mismatched.jobId, {
    userId: mismatched.userId,
    path: wrongPath,
    accessMode: 'read_write',
  })
  assert.equal(pathMismatch.resumed, false)
  assert.match(pathMismatch.error, /path does not match/)
  assert.equal(mismatched.runtime.getJob(mismatched.jobId, { userId: mismatched.userId }).status, 'waiting')
})

test('resumed Job reuses its checkpoint marker and continues to write the authorized PDF output', async () => {
  const { userId } = issueTestSession()
  setApprovalMode({ userId, mode: 'normal' })
  const outputPath = path.join(authorizedDir, `processed-${Date.now()}.pdf`)
  let modelCalls = 0
  let directoryRequests = 0
  const executeStep = async ({ job, step }) => {
    if (step.kind !== 'execute') return { ok: true, output: { text: `${step.kind} complete` } }
    const result = await runToolLoop({
      job,
      step,
      messages: [{ role: 'user', content: 'Process the PDF and write it to the authorized output directory.' }],
      toolSpecs: SERVER_TOOL_SPECS.filter((spec) => (
        ['request_directory', 'list_directory', 'read_file'].includes(spec.function.name)
      )),
      approvalMode: 'off',
      loadCheckpoint: () => getJobTurnCheckpoint({ jobId: job.id, stepId: step.id, userId }),
      saveCheckpoint: (state) => saveJobTurnCheckpoint({ jobId: job.id, stepId: step.id, userId, state }),
      requestToolApproval: async ({ args }) => ({ proceed: true, args }),
      runModel: async ({ messages, tools }) => {
        modelCalls += 1
        if (modelCalls === 1) {
          const initialToolNames = tools.map((spec) => spec.function.name)
          assert.deepEqual(initialToolNames.sort(), ['list_directory', 'read_file', 'request_directory'])
          for (const unavailable of ['write_file', 'edit_file', 'bash_exec']) {
            assert.equal(initialToolNames.includes(unavailable), false, unavailable)
          }
          return {
            content: '',
            toolCalls: [{ id: 'directory', type: 'function', function: { name: 'request_directory', arguments: JSON.stringify({
              purpose: 'Write the processed PDF.', access_mode: 'read_write', suggested_path: authorizedDir,
            }) } }],
          }
        }
        const marker = messages.find((message) => message?.role === 'system' && String(message.content).includes('[JOB_DIRECTORY_RESOLUTION:'))
        assert.ok(marker, 'the resumed model call must receive the persisted Job directory marker')
        assert.match(marker.content, /already persisted and verified/)
        const resumedToolNames = tools.map((spec) => spec.function.name)
        for (const restoredName of ['list_directory', 'read_file', 'write_file', 'edit_file', 'bash_exec']) {
          assert.equal(resumedToolNames.includes(restoredName), true, restoredName)
        }
        if (modelCalls === 2) {
          return {
            content: '',
            toolCalls: [{ id: 'write-output', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({
              path: outputPath, content: '%PDF-1.4\nprocessed', encoding: 'utf8',
            }) } }],
          }
        }
        return { content: 'Processed PDF written to the authorized directory.', toolCalls: [] }
      },
      executeTool: async ({ name, args }) => {
        if (name === 'request_directory') {
          directoryRequests += 1
          return { ok: true, paused: true, clarification: {
            question: 'Choose an output directory.', request_type: 'directory', access_mode: args.access_mode,
            suggested_path: args.suggested_path, purpose: args.purpose,
          } }
        }
        assert.equal(name, 'write_file')
        fs.writeFileSync(args.path, args.content, args.encoding)
        return { ok: true, path: args.path }
      },
    })
    return {
      ok: !result.paused,
      paused: !!result.paused,
      truncated: !!result.paused,
      clarification: result.clarification || null,
      output: { text: result.text },
    }
  }
  const runtime = new JobRuntime({
    planner: (prompt) => ({ title: 'PDF output', prompt, steps: [{ id: 'execute', title: 'Write PDF', kind: 'execute', status: 'queued' }] }),
    executeStep,
  })
  const job = await runtime.createJob('Process a PDF', { userId })
  assert.equal(await runtime.runOneTick(), true)
  assert.equal(runtime.getJob(job.id, { userId }).status, 'waiting')
  grantLocalPath({ userId, rootPath: authorizedDir, accessMode: 'read_write' })
  assert.equal(runtime.resumeDirectoryAuthorization(job.id, { userId, path: authorizedDir, accessMode: 'read_write' }).resumed, true)
  await runtime.drain()
  assert.equal(fs.readFileSync(outputPath, 'utf8'), '%PDF-1.4\nprocessed')
  assert.equal(directoryRequests, 1, 'the resumed loop must not request the same directory again')
  assert.equal(runtime.getJob(job.id, { userId }).status, 'completed')
})

test('directory authorization resume client and Job route preserve path and access mode', async () => {
  let clientRequest = null
  const clientResult = await resumeJobDirectoryAuthorization('job/client', {
    path: authorizedDir,
    accessMode: 'read_write',
    fetchImpl: async (url, options) => {
      clientRequest = { url, options }
      return new Response(JSON.stringify({ resumed: true, job: { id: 'job/client', status: 'queued' } }), {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      })
    },
  })
  assert.equal(clientResult.resumed, true)
  assert.equal(clientRequest.url, '/api/jobs/job%2Fclient/directory-authorization/resume')
  assert.deepEqual(JSON.parse(clientRequest.options.body), { path: authorizedDir, accessMode: 'read_write' })

  const auth = issueTestSession()
  let routeInput = null
  const routeServer = createServer((req, res) => {
    void handleJobRequest(req, res, {
      resumeDirectoryAuthorization(jobId, input) {
        if (jobId === 'missing-job') return null
        if (jobId === 'waiting-job') return { resumed: false, error: 'grant is missing' }
        routeInput = { jobId, ...input }
        return { resumed: true, job: { id: jobId, status: 'queued' } }
      },
    })
  })
  await new Promise((resolve) => routeServer.listen(0, '127.0.0.1', resolve))
  try {
    const origin = `http://127.0.0.1:${routeServer.address().port}`
    const response = await fetch(`${origin}/api/jobs/route-job/directory-authorization/resume`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: authorizedDir, accessMode: 'read_write' }),
    })
    assert.equal(response.status, 202)
    assert.equal((await response.json()).resumed, true)

    const missing = await fetch(`${origin}/api/jobs/missing-job/directory-authorization/resume`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: authorizedDir, accessMode: 'read_write' }),
    })
    assert.equal(missing.status, 404)

    const conflict = await fetch(`${origin}/api/jobs/waiting-job/directory-authorization/resume`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: authorizedDir, accessMode: 'read_write' }),
    })
    assert.equal(conflict.status, 409)
  } finally {
    await new Promise((resolve) => routeServer.close(resolve))
  }
  assert.deepEqual(routeInput, {
    jobId: 'route-job',
    userId: auth.userId,
    path: authorizedDir,
    accessMode: 'read_write',
  })
})
