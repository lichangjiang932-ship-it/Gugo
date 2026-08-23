import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.APP_DATA_DIR = path.join(os.tmpdir(), 'gugo-job-model-recovery-runtime', String(process.pid))
process.env.MODEL_BASE_URL = 'https://job-recovery.example.test/v1'
process.env.MODEL_NAME = 'job-recovery-model'

const {
  JobRuntime,
  createDefaultExecuteStep,
  getJobRuntime,
  setJobRuntimeForTesting,
} = await import('../server/services/jobRuntime.js')
const { createAppServer } = await import('../server/appServer.js')
const { createJobRuntimeCore } = await import('../server/services/runtimeCore.js')
const {
  getJobTurnCheckpoint,
  makeJobTurnCheckpointResumable,
  nextJobCheckpointWriteSequence,
  saveJobTurnCheckpoint,
} = await import('../server/services/jobTurnCheckpointStore.js')
const {
  getPendingJobModelRequestRecovery,
  resolvePendingJobModelRequest,
} = await import('../server/services/jobModelRequestRecoveryService.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

const owner = issueTestSession()
const outsider = issueTestSession()
const userId = owner.userId
let providerCalls = 0
const failedResponseBoundaries = new Set()
const crashAfterAppliedUsage = new Set()
const failedAppliedUsageBoundaries = new Set()
const appliedUsageCheckpoints = new Map()
const HISTORICAL_BUDGET = Object.freeze({
  used: 3,
  modelMs: 17,
  modelCalls: 2,
  modelTokens: 41,
  costUsd: 0.2,
})
const RECOVERED_USAGE = Object.freeze({
  promptTokens: 120,
  cacheHitTokens: 20,
  completionTokens: 30,
})
const RECOVERED_COST_USD = 0.0123

const runtimeCore = createJobRuntimeCore({
  writeCheckpoint(input) {
    if (input?.state?.modelInvocation?.status === 'completed'
      && !failedResponseBoundaries.has(input.jobId)) {
      failedResponseBoundaries.add(input.jobId)
      throw new Error('simulated crash after the provider response')
    }
    const saved = saveJobTurnCheckpoint(input)
    if (input?.state?.modelInvocation?.status === 'completed'
      && input.state.modelInvocation.usageApplied === true) {
      appliedUsageCheckpoints.set(input.jobId, structuredClone(input.state))
      if (crashAfterAppliedUsage.has(input.jobId)
        && !failedAppliedUsageBoundaries.has(input.jobId)) {
        failedAppliedUsageBoundaries.add(input.jobId)
        // The lease coordinator commits a synchronous transaction around the
        // checkpoint callback. A synchronous throw would roll the save back;
        // rejecting after the callback returns models a crash after commit.
        return Promise.reject(new Error('simulated crash after accounted usage was persisted'))
      }
    }
    return saved
  },
  resumeCheckpoint: makeJobTurnCheckpointResumable,
})

const runtime = new JobRuntime({
  runtimeCore,
  executeStep: createDefaultExecuteStep({
    runtimeCore,
    enableServerTools: true,
    runModelWithTools: async () => {
      providerCalls += 1
      return {
        content: `provider-response-${providerCalls}`,
        toolCalls: [],
        usage: RECOVERED_USAGE,
        costUsd: RECOVERED_COST_USD,
      }
    },
    reconcileModelRequest: async () => ({
      contractVersion: 1,
      source: 'provider',
      outcome: 'unsupported',
      reconciledAt: Date.now(),
    }),
  }),
})

function resolutionArgs(pending, resolution) {
  return {
    userId,
    jobId: pending.jobId,
    stepId: pending.stepId,
    expectedCheckpointRevision: pending.checkpointRevision,
    modelRequestId: pending.modelRequestId,
    requestFingerprint: pending.requestFingerprint,
    providerId: pending.providerId,
    modelName: pending.modelName,
    configRevision: pending.configRevision,
    idempotencyKey: pending.idempotencyKey,
    verificationConfirmed: true,
    confirmModelRequestId: pending.modelRequestId,
    resolution,
    ...(resolution === 'completed'
      ? {
          response: {
            content: 'manually verified response',
            toolCalls: [],
            usage: RECOVERED_USAGE,
            costUsd: RECOVERED_COST_USD,
          },
          receipt: { providerRequestId: `receipt-${pending.modelRequestId}` },
        }
      : { receipt: { checkedAt: Date.now() } }),
  }
}

async function createCrashedJob(title) {
  const created = await runtime.createPlan({
    userId,
    title,
    prompt: title,
    steps: [{ kind: 'analysis', title: 'Analyze exactly once' }],
  })
  const step = created.steps.find((item) => item.kind === 'analysis')
  assert.ok(step)
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await runtime.runOneTick()
    const current = runtime.getJob(created.id, { userId })
    if (current.status === 'failed') break
  }
  const failed = runtime.getJob(created.id, { userId })
  assert.equal(failed.status, 'failed')
  const checkpoint = getJobTurnCheckpoint({ jobId: created.id, stepId: step.id, userId })
  assert.equal(checkpoint?.state?.modelInvocation?.status, 'in_flight')
  const withHistory = saveJobTurnCheckpoint({
    jobId: created.id,
    stepId: step.id,
    userId,
    state: {
      ...checkpoint.state,
      checkpointWriteSequence: nextJobCheckpointWriteSequence(checkpoint.state),
      budget: {
        ...checkpoint.state.budget,
        ...HISTORICAL_BUDGET,
      },
    },
  })
  return { job: failed, step, checkpoint: withHistory }
}

test('job retries preserve budget for completed and not_sent manual resolutions', async () => {
  for (const retryKind of ['step', 'job']) {
    for (const resolution of ['completed', 'not_sent']) {
    const callsBefore = providerCalls
    const { job, step, checkpoint } = await createCrashedJob(`recover-${retryKind}-${resolution}`)
    assert.equal(providerCalls, callsBefore + 1)
    const pending = getPendingJobModelRequestRecovery({ userId, jobId: job.id, stepId: step.id })
    assert.equal(pending.checkpointRevision, checkpoint.revision)
    const resolved = resolvePendingJobModelRequest(resolutionArgs(pending, resolution))
    assert.equal(resolved.status, 'resolved_pending_resume')
    const materialized = getJobTurnCheckpoint({ jobId: job.id, stepId: step.id, userId })
    if (resolution === 'completed') {
      assert.equal(materialized.state.modelInvocation.usageApplied, false)
    }

    if (retryKind === 'step') {
      runtime.retryStep(job.id, step.id, { userId, resetBudget: true })
    } else {
      runtime.retryJob(job.id, { userId })
    }
    const resumable = getJobTurnCheckpoint({ jobId: job.id, stepId: step.id, userId })
    assert.equal(resumable.state.final, null)
    assert.equal(resumable.state.budget.used, HISTORICAL_BUDGET.used)
    assert.equal(resumable.state.budget.modelMs, HISTORICAL_BUDGET.modelMs)
    assert.equal(resumable.state.budget.modelCalls, HISTORICAL_BUDGET.modelCalls)
    assert.equal(resumable.state.budget.modelTokens, HISTORICAL_BUDGET.modelTokens)
    assert.equal(resumable.state.budget.costUsd, HISTORICAL_BUDGET.costUsd)
    await runtime.runOneTick()

    const recovered = runtime.getJob(job.id, { userId })
    const recoveredStep = recovered.steps.find((item) => item.id === step.id)
    assert.equal(recoveredStep.status, 'completed', JSON.stringify({
      resolution,
      error: recovered.error,
      events: recovered.events?.slice(-4),
      checkpoint: getJobTurnCheckpoint({ jobId: job.id, stepId: step.id, userId }),
      providerCalls,
    }, null, 2))
    assert.equal(
      providerCalls,
      callsBefore + (resolution === 'completed' ? 1 : 2),
      resolution === 'completed'
        ? 'a verified completed response must be replayed without another provider request'
        : 'a verified not-sent request must be submitted exactly once',
    )
    const applied = appliedUsageCheckpoints.get(job.id)
    assert.ok(applied, 'the accounted response must be durably checkpointed')
    assert.equal(applied.modelInvocation.usageApplied, true)
    assert.equal(applied.budget.used, HISTORICAL_BUDGET.used)
    assert.equal(applied.budget.modelCalls, HISTORICAL_BUDGET.modelCalls + 1)
    assert.equal(
      applied.budget.modelTokens,
      HISTORICAL_BUDGET.modelTokens
        + RECOVERED_USAGE.promptTokens
        - RECOVERED_USAGE.cacheHitTokens
        + RECOVERED_USAGE.completionTokens,
    )
    assert.equal(applied.budget.costUsd, HISTORICAL_BUDGET.costUsd + RECOVERED_COST_USD)
    runtime.requestCancel(job.id, { userId })
    await runtime.runOneTick()
    }
  }
})

test('a second replay of accounted manual usage neither calls the provider nor counts usage again', async () => {
  const callsBefore = providerCalls
  const { job, step } = await createCrashedJob('recover-completed-twice')
  assert.equal(providerCalls, callsBefore + 1)
  const pending = getPendingJobModelRequestRecovery({ userId, jobId: job.id, stepId: step.id })
  resolvePendingJobModelRequest(resolutionArgs(pending, 'completed'))

  crashAfterAppliedUsage.add(job.id)
  runtime.retryStep(job.id, step.id, { userId, resetBudget: true })
  await runtime.runOneTick()
  const firstFailure = runtime.getJob(job.id, { userId })
  assert.equal(firstFailure.status, 'failed')
  assert.equal(failedAppliedUsageBoundaries.has(job.id), true, JSON.stringify({
    error: firstFailure.error,
    events: firstFailure.events?.slice(-4),
    checkpoint: getJobTurnCheckpoint({ jobId: job.id, stepId: step.id, userId }),
    providerCalls,
  }, null, 2))
  const firstReplay = getJobTurnCheckpoint({ jobId: job.id, stepId: step.id, userId })
  assert.ok(firstReplay, 'accounted usage must survive the simulated crash')
  assert.equal(firstReplay.state.modelInvocation.usageApplied, true)
  assert.equal(firstReplay.state.budget.modelCalls, HISTORICAL_BUDGET.modelCalls + 1)
  const firstTokens = firstReplay.state.budget.modelTokens
  const firstCost = firstReplay.state.budget.costUsd
  assert.equal(providerCalls, callsBefore + 1)

  runtime.retryStep(job.id, step.id, { userId, resetBudget: true })
  await runtime.runOneTick()

  const recovered = runtime.getJob(job.id, { userId })
  const recoveredStep = recovered.steps.find((item) => item.id === step.id)
  assert.equal(recoveredStep.status, 'completed')
  assert.equal(
    getJobTurnCheckpoint({ jobId: job.id, stepId: step.id, userId }),
    null,
    'a successful replay clears its completed checkpoint',
  )
  const secondReplay = appliedUsageCheckpoints.get(job.id)
  assert.ok(secondReplay)
  assert.equal(secondReplay.modelInvocation.usageApplied, true)
  assert.equal(secondReplay.budget.modelCalls, HISTORICAL_BUDGET.modelCalls + 1)
  assert.equal(secondReplay.budget.modelTokens, firstTokens)
  assert.equal(secondReplay.budget.costUsd, firstCost)
  assert.equal(providerCalls, callsBefore + 1)
  runtime.requestCancel(job.id, { userId })
  await runtime.runOneTick()
})

test('job model-request recovery HTTP endpoints are owner-isolated and resume a materialized response', async () => {
  const previousRuntime = getJobRuntime()
  const callsBefore = providerCalls
  const { job, step } = await createCrashedJob('recover-through-http')
  assert.equal(providerCalls, callsBefore + 1)
  setJobRuntimeForTesting(runtime)
  const server = createAppServer({
    getEnv: () => ({
      MODEL_BASE_URL: process.env.MODEL_BASE_URL,
      MODEL_NAME: process.env.MODEL_NAME,
    }),
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const pathname = `/api/jobs/${encodeURIComponent(job.id)}/steps/${encodeURIComponent(step.id)}/model-request-recovery`

  try {
    const hidden = await fetch(`${origin}${pathname}`, {
      headers: { Authorization: `Bearer ${outsider.token}` },
    })
    assert.equal(hidden.status, 404)

    const pendingResponse = await fetch(`${origin}${pathname}`, {
      headers: { Authorization: `Bearer ${owner.token}` },
    })
    assert.equal(pendingResponse.status, 200)
    const { recovery: pending } = await pendingResponse.json()
    assert.equal(pending.status, 'unknown')

    const completedResolution = {
      checkpointRevision: pending.checkpointRevision,
      modelRequestId: pending.modelRequestId,
      requestFingerprint: pending.requestFingerprint,
      providerId: pending.providerId,
      modelName: pending.modelName,
      configRevision: pending.configRevision,
      idempotencyKey: pending.idempotencyKey,
      verificationConfirmed: true,
      confirmModelRequestId: pending.modelRequestId,
      resolution: 'completed',
      receipt: { providerRequestId: `http-${pending.modelRequestId}` },
    }
    for (const invalidResponse of [
      { label: 'missing' },
      { label: 'array', value: [] },
      { label: 'empty object', value: {} },
      { label: 'empty response', value: { content: '', toolCalls: [] } },
      { label: 'invalid content type', value: { content: {} } },
      { label: 'invalid toolCalls type', value: { content: 'text', toolCalls: {} } },
      { label: 'invalid tool call', value: { toolCalls: [{}] } },
    ]) {
      const invalidResolve = await fetch(`${origin}${pathname}/resolve`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${owner.token}`,
        },
        body: JSON.stringify({
          ...completedResolution,
          ...(Object.hasOwn(invalidResponse, 'value')
            ? { response: invalidResponse.value }
            : {}),
        }),
      })
      assert.equal(invalidResolve.status, 400, invalidResponse.label)
      const invalidBody = await invalidResolve.json()
      assert.equal(invalidBody.error.code, 'JOB_MODEL_REQUEST_RECOVERY_INVALID')
      assert.equal(invalidBody.error.retryable, false)
      assert.match(invalidBody.error.message, /^response must /u)
      const unchangedResponse = await fetch(`${origin}${pathname}`, {
        headers: { Authorization: `Bearer ${owner.token}` },
      })
      assert.equal(unchangedResponse.status, 200)
      const unchanged = (await unchangedResponse.json()).recovery
      assert.equal(unchanged.status, 'unknown')
      assert.equal(unchanged.checkpointRevision, pending.checkpointRevision)
    }

    const resolveResponse = await fetch(`${origin}${pathname}/resolve`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${owner.token}`,
      },
      body: JSON.stringify({
        ...completedResolution,
        response: { content: 'HTTP-verified provider response', toolCalls: [] },
      }),
    })
    assert.equal(resolveResponse.status, 200)
    const resolvedBody = await resolveResponse.json()
    assert.equal(resolvedBody.recovery.status, 'resolved_pending_resume')
    assert.equal(resolvedBody.recovery.resolution, 'completed')
    assert.equal(resolvedBody.resume.ready, true)

    const resumeResponse = await fetch(`${origin}${pathname}/resume`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${owner.token}` },
    })
    assert.equal(resumeResponse.status, 202)
    assert.equal((await resumeResponse.json()).job.status, 'queued')

    await runtime.runOneTick()
    const recovered = runtime.getJob(job.id, { userId })
    assert.equal(recovered.steps.find((item) => item.id === step.id)?.status, 'completed')
    assert.equal(providerCalls, callsBefore + 1, 'HTTP-resumed completed response must not call the provider again')
  } finally {
    await new Promise((resolve) => server.close(resolve))
    setJobRuntimeForTesting(previousRuntime)
  }
})
