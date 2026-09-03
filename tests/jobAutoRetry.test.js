import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.APP_DATA_DIR = path.join(os.tmpdir(), 'gugo-job-auto-retry-tests', String(process.pid))

const { JobRuntime } = await import('../server/services/jobRuntime.js')
const { nextJobAutoRetry } = await import('../server/services/jobAutoRetryPolicy.js')
const { resolveJobAutoRetrySchedule } = await import('../server/services/jobAutoRetryRuntime.js')
const {
  claimDueJobWakes,
  DEFAULT_AUTO_RETRY_WAKE_CLAIM_MS,
  getJobWake,
  scheduleJobWake,
} = await import('../server/services/jobWakeStore.js')
const {
  blockClaimedAutoRetryWakeTransition,
} = await import('../server/services/jobRuntimeTransitionStore.js')
const { listJobSteering } = await import('../server/services/jobSteeringStore.js')
const {
  createSideEffectScope,
  getSideEffectExecutionLedger,
} = await import('../server/services/sideEffectExecutionLedger.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

const modelBindingResolver = () => ({
  providerId: null,
  modelName: 'auto-retry-model',
  configRevision: null,
  env: {
    MODEL_BASE_URL: 'https://models.example.test/v1',
    MODEL_NAME: 'auto-retry-model',
  },
})

const planner = (prompt) => ({
  title: prompt,
  prompt,
  steps: [{ kind: 'execute', title: 'Execute safely' }],
})

function transientFailure() {
  return Object.assign(new Error('temporary upstream outage'), { status: 503 })
}

test('auto-retry is opt-in, bounded, exponential, and excludes unsafe failure classes', () => {
  const enabledJob = {
    autoRetry: { enabled: true, maxAttempts: 2, attempts: 0, baseDelayMs: 1_000 },
  }
  assert.equal(nextJobAutoRetry(enabledJob, { failureCode: 'MODEL_UPSTREAM_ERROR', now: 10 }).wakeAt, 1_010)
  assert.equal(nextJobAutoRetry({
    autoRetry: { ...enabledJob.autoRetry, attempts: 1 },
  }, { failureCode: 'MODEL_RATE_LIMITED', now: 10 }).wakeAt, 2_010)
  assert.equal(nextJobAutoRetry({
    autoRetry: { ...enabledJob.autoRetry, attempts: 2 },
  }, { failureCode: 'MODEL_UPSTREAM_ERROR', now: 10 }), null)
  assert.equal(nextJobAutoRetry({ autoRetry: { ...enabledJob.autoRetry, enabled: false } }, {
    failureCode: 'MODEL_UPSTREAM_ERROR',
  }), null)
  for (const code of [
    'MODEL_TIMEOUT',
    'MODEL_CONFIG_MISSING',
    'MODEL_AUTH_FAILED',
    'PERMISSION_DENIED',
    'JOB_PLAN_APPROVAL_REQUIRED',
    'JOB_CANCEL_REQUESTED',
  ]) {
    assert.equal(nextJobAutoRetry(enabledJob, { failureCode: code }), null, code)
  }
  assert.equal(resolveJobAutoRetrySchedule({
    job: { ...enabledJob, id: 'job', userId: 'user', status: 'awaiting_approval' },
    step: { id: 'step' },
    modelFailure: { code: 'MODEL_UPSTREAM_ERROR' },
  }), null)
  assert.equal(resolveJobAutoRetrySchedule({
    job: { ...enabledJob, id: 'job', userId: 'user', status: 'cancel_requested', cancelRequested: true },
    step: { id: 'step' },
    modelFailure: { code: 'MODEL_UPSTREAM_ERROR' },
  }), null)
})

test('an opted-in job retries a safe transient failure through the durable retryStep path', async (t) => {
  const { userId } = issueTestSession({ email: `auto-retry-${Date.now()}@example.com` })
  let executions = 0
  let transientFailures = 0
  const runtime = new JobRuntime({
    planner,
    modelBindingResolver,
    executeStep: async ({ step }) => {
      if (step.kind !== 'execute') return { ok: true, output: { text: `${step.kind} passed` } }
      executions += 1
      if (executions === 1) {
        transientFailures += 1
        throw transientFailure()
      }
      return { ok: true, output: { text: 'completed after retry' } }
    },
  })
  t.after(async () => { await runtime.shutdown() })
  const created = await runtime.createJob('retry transient failure', { userId, autoRetry: true })
  assert.equal(created.autoRetry.enabled, true)
  assert.equal(created.autoRetry.attempts, 0)

  await runtime.runOneTick()
  const waiting = runtime.getJob(created.id, { userId })
  assert.equal(waiting.status, 'waiting')
  assert.equal(waiting.autoRetry.attempts, 1)
  assert.equal(waiting.events.at(-1)?.type, 'auto_retry_scheduled')
  const wake = getJobWake({ jobId: created.id, userId })
  assert.equal(wake.kind, 'auto_retry')
  assert.ok(wake.wakeAt >= wake.createdAt + 1_000)

  scheduleJobWake({
    jobId: created.id,
    stepId: wake.stepId,
    userId,
    wakeAt: Date.now() - 1,
    wakeKind: 'auto_retry',
    reason: wake.reason,
  })
  await Promise.all([
    runtime.runOneTick(),
    runtime.runOneTick(),
    runtime.runOneTick(),
    runtime.runOneTick(),
  ])
  await runtime.drain()

  const completed = runtime.getJob(created.id, { userId })
  assert.equal(completed.status, 'completed')
  assert.equal(executions, 2)
  assert.equal(transientFailures, 1)
  assert.equal(completed.events.filter((event) => event.type === 'auto_retry_started').length, 1)
  assert.equal(completed.events.filter((event) => event.type === 'auto_retry_blocked').length, 0)
})

test('a runtime restart recovers the crash window after an auto-retry wake is armed', async (t) => {
  const { userId } = issueTestSession({ email: `auto-retry-restart-${Date.now()}@example.com` })
  let executions = 0
  const executeStep = async ({ step }) => {
    if (step.kind !== 'execute') return { ok: true, output: { text: `${step.kind} passed` } }
    executions += 1
    if (executions === 1) throw transientFailure()
    return { ok: true, output: { text: 'completed after restart recovery' } }
  }
  const firstRuntime = new JobRuntime({ planner, modelBindingResolver, executeStep })
  t.after(async () => { await firstRuntime.shutdown() })
  const created = await firstRuntime.createJob('recover an armed retry', { userId, autoRetry: true })
  await firstRuntime.runOneTick()

  const scheduledWake = getJobWake({ jobId: created.id, userId })
  const crashClaimedAt = Date.now() - DEFAULT_AUTO_RETRY_WAKE_CLAIM_MS - 100
  scheduleJobWake({
    jobId: created.id,
    stepId: scheduledWake.stepId,
    userId,
    wakeAt: crashClaimedAt - 1,
    wakeKind: 'auto_retry',
    reason: scheduledWake.reason,
    now: crashClaimedAt - 2,
  })

  // Simulate the old crash boundary: the wake scan arms the failed job, then
  // the process exits before runtime retryStep can run.
  const [armedWake] = claimDueJobWakes({ now: crashClaimedAt })
  assert.equal(armedWake.jobId, created.id)
  const interrupted = firstRuntime.getJob(created.id, { userId })
  assert.equal(interrupted.status, 'failed')
  assert.equal(interrupted.steps[0].status, 'failed')
  const claimedWake = getJobWake({ jobId: created.id, userId })
  assert.equal(claimedWake.status, 'fired')
  assert.ok(claimedWake.claimToken)
  assert.deepEqual(
    claimDueJobWakes({ now: crashClaimedAt + 1 }).filter((wake) => wake.jobId === created.id),
    [],
  )
  assert.equal(interrupted.events.filter((event) => event.type === 'auto_retry_started').length, 0)
  await firstRuntime.shutdown()

  const secondRuntime = new JobRuntime({ planner, modelBindingResolver, executeStep })
  t.after(async () => { await secondRuntime.shutdown() })
  await secondRuntime.drain()

  const completed = secondRuntime.getJob(created.id, { userId })
  assert.equal(completed.status, 'completed')
  assert.equal(executions, 2)
  assert.equal(getJobWake({ jobId: created.id, userId }).status, 'fired')
  assert.equal(completed.events.filter((event) => event.type === 'auto_retry_started').length, 1)
  assert.deepEqual(claimDueJobWakes().filter((wake) => wake.jobId === created.id), [])
})

test('a replacement claim fences stale finalize, cancel, and cross-user attempts', async (t) => {
  const { userId } = issueTestSession({ email: `auto-retry-aba-${Date.now()}@example.com` })
  const { userId: otherUserId } = issueTestSession({
    email: `auto-retry-aba-other-${Date.now()}@example.com`,
  })
  let executions = 0
  const runtime = new JobRuntime({
    planner,
    modelBindingResolver,
    executeStep: async ({ step }) => {
      if (step.kind !== 'execute') return { ok: true, output: { text: `${step.kind} passed` } }
      executions += 1
      if (executions === 1) throw transientFailure()
      return { ok: true, output: { text: 'completed after fenced recovery' } }
    },
  })
  t.after(async () => { await runtime.shutdown() })
  const created = await runtime.createJob('fence a stale retry claimant', { userId, autoRetry: true })
  await runtime.runOneTick()

  const scheduled = getJobWake({ jobId: created.id, userId })
  const replacementAt = Date.now()
  const firstClaimedAt = replacementAt - DEFAULT_AUTO_RETRY_WAKE_CLAIM_MS - 100
  scheduleJobWake({
    jobId: created.id,
    stepId: scheduled.stepId,
    userId,
    wakeAt: firstClaimedAt - 1,
    wakeKind: 'auto_retry',
    reason: scheduled.reason,
    now: firstClaimedAt - 2,
  })
  const [firstClaim] = claimDueJobWakes({ now: firstClaimedAt })
  const [replacementClaim] = claimDueJobWakes({ now: replacementAt })
  assert.equal(firstClaim.jobId, created.id)
  assert.equal(replacementClaim.jobId, created.id)
  assert.notEqual(replacementClaim.claimToken, firstClaim.claimToken)

  assert.deepEqual(blockClaimedAutoRetryWakeTransition({
    jobId: created.id,
    stepId: replacementClaim.stepId,
    userId: otherUserId,
    wakeAt: replacementClaim.wakeAt,
    claimedAt: replacementClaim.firedAt,
    retryAttempt: replacementClaim.retryAttempt,
    claimToken: replacementClaim.claimToken,
  }), { changed: false, event: null })
  assert.throws(
    () => runtime.retryStep(created.id, firstClaim.stepId, {
      userId,
      resetBudget: false,
      preserveModelSnapshot: true,
      automatic: true,
      autoRetryWake: firstClaim,
    }),
    (error) => /automatic-retry wake claim was lost/.test(String(error?.message || '')),
  )
  assert.deepEqual(blockClaimedAutoRetryWakeTransition({
    jobId: created.id,
    stepId: firstClaim.stepId,
    userId,
    wakeAt: firstClaim.wakeAt,
    claimedAt: firstClaim.firedAt,
    retryAttempt: firstClaim.retryAttempt,
    claimToken: firstClaim.claimToken,
  }), { changed: false, event: null })
  assert.equal(getJobWake({ jobId: created.id, userId }).claimToken, replacementClaim.claimToken)

  runtime.retryStep(created.id, replacementClaim.stepId, {
    userId,
    resetBudget: false,
    preserveModelSnapshot: true,
    automatic: true,
    autoRetryWake: replacementClaim,
  })
  await runtime.drain()

  const completed = runtime.getJob(created.id, { userId })
  assert.equal(completed.status, 'completed')
  assert.equal(executions, 2)
  assert.equal(completed.events.filter((event) => event.type === 'auto_retry_started').length, 1)
  assert.equal(completed.events.filter((event) => event.type === 'auto_retry_blocked').length, 0)
})

test('a transient retry dispatch failure leaves the fenced claim recoverable', async (t) => {
  const { userId } = issueTestSession({ email: `auto-retry-dispatch-${Date.now()}@example.com` })
  let executions = 0
  const runtime = new JobRuntime({
    planner,
    modelBindingResolver,
    executeStep: async ({ step }) => {
      if (step.kind !== 'execute') return { ok: true, output: { text: `${step.kind} passed` } }
      executions += 1
      if (executions === 1) throw transientFailure()
      return { ok: true, output: { text: 'completed after dispatch recovery' } }
    },
  })
  t.after(async () => { await runtime.shutdown() })
  const created = await runtime.createJob('recover a transient retry dispatcher failure', {
    userId,
    autoRetry: true,
  })
  await runtime.runOneTick()
  const scheduled = getJobWake({ jobId: created.id, userId })
  scheduleJobWake({
    jobId: created.id,
    stepId: scheduled.stepId,
    userId,
    wakeAt: Date.now() - 1,
    wakeKind: 'auto_retry',
    reason: scheduled.reason,
  })

  const retryStep = runtime.retryStep.bind(runtime)
  let interruptedClaim = null
  runtime.retryStep = (_jobId, _stepId, options) => {
    interruptedClaim = options.autoRetryWake
    throw Object.assign(new Error('database temporarily busy'), { code: 'SQLITE_BUSY' })
  }
  await runtime.runOneTick()
  runtime.retryStep = retryStep

  assert.ok(interruptedClaim?.claimToken)
  assert.equal(getJobWake({ jobId: created.id, userId }).claimToken, interruptedClaim.claimToken)
  let interrupted = runtime.getJob(created.id, { userId })
  assert.equal(interrupted.status, 'failed')
  assert.equal(interrupted.events.filter((event) => event.type === 'auto_retry_blocked').length, 0)

  const [recoveredClaim] = claimDueJobWakes({
    now: interruptedClaim.firedAt + DEFAULT_AUTO_RETRY_WAKE_CLAIM_MS + 1,
  })
  assert.equal(recoveredClaim.jobId, created.id)
  assert.notEqual(recoveredClaim.claimToken, interruptedClaim.claimToken)
  retryStep(created.id, recoveredClaim.stepId, {
    userId,
    resetBudget: false,
    preserveModelSnapshot: true,
    automatic: true,
    autoRetryWake: recoveredClaim,
  })
  await runtime.drain()

  interrupted = runtime.getJob(created.id, { userId })
  assert.equal(interrupted.status, 'completed')
  assert.equal(executions, 2)
  assert.equal(interrupted.events.filter((event) => event.type === 'auto_retry_started').length, 1)
  assert.equal(interrupted.events.filter((event) => event.type === 'auto_retry_blocked').length, 0)
})

test('a finalized retry wake cannot revive after the bounded retry fails terminally', async (t) => {
  const { userId } = issueTestSession({ email: `auto-retry-terminal-${Date.now()}@example.com` })
  let executions = 0
  const runtime = new JobRuntime({
    planner,
    modelBindingResolver,
    executeStep: async ({ step }) => {
      if (step.kind !== 'execute') return { ok: true, output: { text: `${step.kind} passed` } }
      executions += 1
      throw transientFailure()
    },
  })
  t.after(async () => { await runtime.shutdown() })
  const created = await runtime.createJob('do not revive a completed wake claim', {
    userId,
    autoRetry: { enabled: true, maxAttempts: 1, baseDelayMs: 1_000 },
  })
  await runtime.runOneTick()
  const scheduled = getJobWake({ jobId: created.id, userId })
  scheduleJobWake({
    jobId: created.id,
    stepId: scheduled.stepId,
    userId,
    wakeAt: Date.now() - 1,
    wakeKind: 'auto_retry',
    reason: scheduled.reason,
  })
  await runtime.drain()

  const failed = runtime.getJob(created.id, { userId })
  const finalizedWake = getJobWake({ jobId: created.id, userId })
  assert.equal(failed.status, 'failed')
  assert.equal(failed.autoRetry.attempts, 1)
  assert.equal(executions, 2)
  assert.equal(finalizedWake.status, 'fired')
  assert.equal(finalizedWake.claimToken, undefined)
  assert.equal(failed.events.filter((event) => event.type === 'auto_retry_started').length, 1)
  assert.deepEqual(
    claimDueJobWakes({ now: Date.now() + DEFAULT_AUTO_RETRY_WAKE_CLAIM_MS * 2 })
      .filter((wake) => wake.jobId === created.id),
    [],
  )
})

test('user cancellation silently clears an in-flight auto-retry claim', async (t) => {
  const { userId } = issueTestSession({ email: `auto-retry-cancel-${Date.now()}@example.com` })
  const runtime = new JobRuntime({
    planner,
    modelBindingResolver,
    executeStep: async ({ step }) => {
      if (step.kind !== 'execute') return { ok: true, output: { text: `${step.kind} passed` } }
      throw transientFailure()
    },
  })
  t.after(async () => { await runtime.shutdown() })
  const created = await runtime.createJob('cancel a claimed retry', { userId, autoRetry: true })
  await runtime.runOneTick()
  const scheduled = getJobWake({ jobId: created.id, userId })
  scheduleJobWake({
    jobId: created.id,
    stepId: scheduled.stepId,
    userId,
    wakeAt: Date.now() - 1,
    wakeKind: 'auto_retry',
    reason: scheduled.reason,
  })
  const [claim] = claimDueJobWakes()
  assert.equal(claim.jobId, created.id)
  assert.ok(claim.claimToken)

  const cancelling = runtime.requestCancel(created.id, { userId })
  const cancelledWake = getJobWake({ jobId: created.id, userId })
  assert.equal(cancelling.status, 'cancel_requested')
  assert.equal(cancelledWake.status, 'cancelled')
  assert.equal(cancelledWake.claimToken, undefined)
  assert.deepEqual(blockClaimedAutoRetryWakeTransition({
    jobId: created.id,
    stepId: claim.stepId,
    userId,
    wakeAt: claim.wakeAt,
    claimedAt: claim.firedAt,
    retryAttempt: claim.retryAttempt,
    claimToken: claim.claimToken,
  }), { changed: false, event: null })
  await runtime.drain()

  const cancelled = runtime.getJob(created.id, { userId })
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(cancelled.events.filter((event) => event.type === 'auto_retry_blocked').length, 0)
})

test('an unknown side effect added during backoff cancels one claimed retry without looping', async (t) => {
  const { userId } = issueTestSession({ email: `auto-retry-late-side-effect-${Date.now()}@example.com` })
  let executions = 0
  const runtime = new JobRuntime({
    planner,
    modelBindingResolver,
    executeStep: async () => {
      executions += 1
      throw transientFailure()
    },
  })
  t.after(async () => { await runtime.shutdown() })
  const created = await runtime.createJob('block unsafe late replay', { userId, autoRetry: true })
  await runtime.runOneTick()

  const waiting = runtime.getJob(created.id, { userId })
  const step = waiting.steps[0]
  const ledger = getSideEffectExecutionLedger()
  const input = {
    scope: createSideEffectScope({ job: waiting, step }),
    toolCallId: 'late-unknown-write',
    idempotencyKey: `job:${created.id}:step:${step.id}:tool:late-unknown-write`,
    toolName: 'write_file',
    args: { path: 'late-result.txt', content: 'unknown outcome' },
  }
  ledger.prepare(input)
  ledger.markExecuting(input)
  ledger.markUnknown(input)
  const wake = getJobWake({ jobId: created.id, userId })
  scheduleJobWake({
    jobId: created.id,
    stepId: wake.stepId,
    userId,
    wakeAt: Date.now() - 1,
    wakeKind: 'auto_retry',
    reason: wake.reason,
  })

  await Promise.all([runtime.runOneTick(), runtime.runOneTick(), runtime.runOneTick()])
  await runtime.runOneTick()

  const blocked = runtime.getJob(created.id, { userId })
  assert.equal(blocked.status, 'failed')
  assert.equal(executions, 1)
  const blockedWake = getJobWake({ jobId: created.id, userId })
  assert.equal(blockedWake.status, 'cancelled')
  assert.equal(blockedWake.claimToken, undefined)
  assert.equal(blocked.events.filter((event) => event.type === 'auto_retry_started').length, 0)
  assert.equal(blocked.events.filter((event) => event.type === 'auto_retry_blocked').length, 1)
})

test('steering during auto-retry backoff waits for the durable wake and is consumed by the retry', async (t) => {
  const { userId } = issueTestSession({ email: `auto-retry-steering-${Date.now()}@example.com` })
  let executions = 0
  const consumedSteering = []
  const runtime = new JobRuntime({
    planner,
    modelBindingResolver,
    executeStep: async ({ claimSteering, acknowledgeSteering }) => {
      executions += 1
      if (executions === 1) throw transientFailure()
      const steering = claimSteering()
      consumedSteering.push(...steering.messages.map((message) => message.content))
      acknowledgeSteering(steering.leaseId)
      return { ok: true, output: { text: 'completed with updated direction' } }
    },
  })
  t.after(async () => { await runtime.shutdown() })
  const created = await runtime.createJob('retry with later direction', { userId, autoRetry: true })
  await runtime.runOneTick()

  const scheduledWake = getJobWake({ jobId: created.id, userId })
  const steering = runtime.steerJob(created.id, {
    userId,
    content: 'Use the revised output format.',
  })
  const waiting = runtime.getJob(created.id, { userId })
  assert.equal(steering.accepted, true)
  assert.equal(waiting.status, 'waiting')
  assert.equal(waiting.steps[0].status, 'failed')
  assert.equal(getJobWake({ jobId: created.id, userId }).status, 'scheduled')
  assert.equal(getJobWake({ jobId: created.id, userId }).wakeAt, scheduledWake.wakeAt)
  assert.deepEqual(
    listJobSteering({ jobId: created.id, userId, status: 'queued' }).map((message) => message.content),
    ['Use the revised output format.'],
  )

  scheduleJobWake({
    jobId: created.id,
    stepId: scheduledWake.stepId,
    userId,
    wakeAt: Date.now() - 1,
    wakeKind: 'auto_retry',
    reason: scheduledWake.reason,
  })
  await runtime.drain()

  const completed = runtime.getJob(created.id, { userId })
  assert.equal(completed.status, 'completed')
  assert.deepEqual(consumedSteering, ['Use the revised output format.'])
  assert.equal(listJobSteering({ jobId: created.id, userId, status: 'queued' }).length, 0)
})

test('unknown durable side effects block automatic replay even for a transient model failure', async (t) => {
  const { userId } = issueTestSession({ email: `auto-retry-unknown-${Date.now()}@example.com` })
  const runtime = new JobRuntime({
    planner,
    modelBindingResolver,
    executeStep: async ({ job, step }) => {
      const ledger = getSideEffectExecutionLedger()
      const input = {
        scope: createSideEffectScope({ job, step }),
        toolCallId: 'unknown-write-call',
        idempotencyKey: `job:${job.id}:step:${step.id}:tool:unknown-write-call`,
        toolName: 'write_file',
        args: { path: 'result.txt', content: 'possibly written' },
      }
      ledger.prepare(input)
      ledger.markExecuting(input)
      ledger.markUnknown(input)
      throw transientFailure()
    },
  })
  t.after(async () => { await runtime.shutdown() })
  const created = await runtime.createJob('do not duplicate writes', { userId, autoRetry: true })
  await runtime.runOneTick()

  const failed = runtime.getJob(created.id, { userId })
  assert.equal(failed.status, 'failed')
  assert.equal(failed.autoRetry.attempts, 0)
  assert.equal(getJobWake({ jobId: created.id, userId }), null)
  assert.equal(failed.events.at(-1)?.type, 'failed')
})
