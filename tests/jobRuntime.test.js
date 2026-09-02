import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.APP_DATA_DIR = path.join(os.tmpdir(), 'yma-job-runtime-tests', String(process.pid))
process.env.MODEL_BASE_URL = 'http://127.0.0.1:11434/v1'
process.env.MODEL_NAME = 'test-model'

const {
  JobRuntime,
  createDefaultExecuteStep,
  recoverInterruptedJobs,
} = await import('../server/services/jobRuntime.js')
const { getApprovalMode, setApprovalMode } = await import('../server/services/approvalSettingsStore.js')
const { registerPlugin, unregisterPlugin } = await import('../server/plugins/pluginRegistry.js')
const { updateJob, updateJobStep } = await import('../server/services/jobStore.js')
const {
  recordModelProviderReadiness,
  upsertModelProvider,
} = await import('../server/services/modelProviderStore.js')
const {
  getJobTurnCheckpoint,
  saveJobTurnCheckpoint,
} = await import('../server/services/jobTurnCheckpointStore.js')
const { setUserToolPermission } = await import('../server/db.js')
const {
  attachJobBudget,
  getJobBudget,
  releaseJobBudget,
} = await import('../server/utils/jobBudget.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

const TEST_USER = issueTestSession().userId
const OTHER_USER = issueTestSession().userId

let toolPolicyProbeSequence = 0
async function modelVisibleJobToolNames(userId) {
  toolPolicyProbeSequence += 1
  let visibleNames = null
  const executeStep = createDefaultExecuteStep({
    runModelWithTools: async ({ tools }) => {
      visibleNames ??= tools.map((spec) => spec?.function?.name).filter(Boolean)
      return { content: 'No execution evidence yet.', toolCalls: [] }
    },
  })
  await executeStep({
    job: {
      id: `job-tool-policy-probe-${toolPolicyProbeSequence}`,
      userId,
      title: 'Code-mode tool policy probe',
      prompt: 'Use JavaScript computation to calculate 20 plus 22.',
      steps: [],
    },
    step: {
      id: `job-tool-policy-probe-step-${toolPolicyProbeSequence}`,
      kind: 'execute',
    },
    signal: new AbortController().signal,
  })
  return visibleNames || []
}

test('direct runtime creation is gated and explicit retry safely refreshes a changed provider revision', async () => {
  const isolatedUser = issueTestSession().userId
  let plannerCalls = 0
  let executionCalls = 0
  const runtime = new JobRuntime({
    planner: (prompt) => {
      plannerCalls += 1
      return { title: prompt, steps: [{ kind: 'execute', title: '执行' }] }
    },
    executeStep: async () => {
      executionCalls += 1
      return { ok: true, output: { text: 'unexpected' } }
    },
  })

  await assert.rejects(
    runtime.createJob('missing model', { userId: isolatedUser, env: {} }),
    (error) => error?.code === 'MODEL_CONFIG_MISSING',
  )
  await assert.rejects(
    runtime.createPlan({
      userId: isolatedUser,
      title: 'missing structured model',
      steps: [{ kind: 'execute', title: '执行' }],
      env: {},
    }),
    (error) => error?.code === 'MODEL_CONFIG_MISSING',
  )
  assert.equal(plannerCalls, 0)

  const provider = upsertModelProvider({
    userId: isolatedUser,
    provider: {
      key: `job-binding-${Date.now()}`,
      label: 'Job binding provider',
      baseUrl: 'https://models.example.test/v1',
      models: ['bound-model'],
      defaultModel: 'bound-model',
      enabled: true,
      isDefault: true,
    },
  })
  recordModelProviderReadiness({
    userId: isolatedUser,
    id: provider.id,
    readiness: { chat: true, tools: true, agent: true, mode: 'agent' },
  })
  const job = await runtime.createJob('strict provider binding', {
    userId: isolatedUser,
    modelProviderId: provider.id,
    env: {},
  })
  assert.equal(job.modelProviderId, provider.id)
  assert.equal(job.modelConfigRevision, provider.configRevision)

  const updatedProvider = upsertModelProvider({
    userId: isolatedUser,
    provider: {
      ...provider,
      baseUrl: 'https://changed.example.test/v1',
      models: ['bound-model'],
      defaultModel: 'bound-model',
    },
  })
  assert.equal(await runtime.runOneTick(), true)
  const failed = runtime.getJob(job.id, { userId: isolatedUser })
  assert.equal(failed.status, 'failed')
  assert.equal(executionCalls, 0)
  assert.equal(failed.events.at(-1)?.payload?.code, 'MODEL_PROVIDER_CONFIG_CHANGED')

  assert.throws(
    () => runtime.retryJob(job.id, { userId: isolatedUser }),
    (error) => error?.code === 'MODEL_PROVIDER_UNVERIFIED',
  )
  assert.equal(runtime.getJob(job.id, { userId: isolatedUser }).status, 'failed')
  assert.equal(runtime.getJob(job.id, { userId: isolatedUser }).modelConfigRevision, provider.configRevision)

  recordModelProviderReadiness({
    userId: isolatedUser,
    id: updatedProvider.id,
    readiness: { chat: true, tools: true, agent: true, mode: 'agent' },
  })
  const retried = runtime.retryJob(job.id, { userId: isolatedUser })
  assert.equal(retried.status, 'queued')
  assert.equal(retried.modelConfigRevision, updatedProvider.configRevision)
  const retryPayload = retried.events.at(-1)?.payload
  assert.deepEqual({
    previousModelProviderId: retryPayload?.previousModelProviderId,
    previousModelConfigRevision: retryPayload?.previousModelConfigRevision,
    modelProviderId: retryPayload?.modelProviderId,
    modelConfigRevision: retryPayload?.modelConfigRevision,
  }, {
    previousModelProviderId: provider.id,
    previousModelConfigRevision: provider.configRevision,
    modelProviderId: updatedProvider.id,
    modelConfigRevision: updatedProvider.configRevision,
  })
  await runtime.drain()
  assert.equal(runtime.getJob(job.id, { userId: isolatedUser }).status, 'completed')
  assert.ok(executionCalls > 0)
})

test('structured plans persist their exact provider revision', async () => {
  const isolatedUser = issueTestSession().userId
  const provider = upsertModelProvider({
    userId: isolatedUser,
    provider: {
      key: `structured-binding-${Date.now()}`,
      label: 'Structured plan provider',
      baseUrl: 'https://structured.example.test/v1',
      models: ['structured-model'],
      defaultModel: 'structured-model',
      enabled: true,
      isDefault: true,
    },
  })
  recordModelProviderReadiness({
    userId: isolatedUser,
    id: provider.id,
    readiness: { chat: true, tools: true, agent: true, mode: 'agent' },
  })
  const runtime = new JobRuntime({ planner: stubPlanner })
  const job = await runtime.createPlan({
    userId: isolatedUser,
    title: 'Persist provider snapshot',
    prompt: 'Run the structured task',
    steps: [{ kind: 'execute', title: 'Execute' }],
    modelName: 'structured-model',
    modelProviderId: provider.id,
    modelConfigRevision: provider.configRevision,
    env: {},
  })
  assert.equal(job.modelName, 'structured-model')
  assert.equal(job.modelProviderId, provider.id)
  assert.equal(job.modelConfigRevision, provider.configRevision)
})

test('job model selection is passed to planning and survives storage reloads', async () => {
  let plannedWith = null
  const runtime = new JobRuntime({
    planner: (prompt, options) => {
      plannedWith = options.modelName
      return stubPlanner(prompt)
    },
  })

  const job = await runtime.createJob('use the selected model', {
    userId: TEST_USER,
    modelName: ' selected-model ',
  })
  assert.equal(plannedWith, 'selected-model')
  assert.equal(job.modelName, 'selected-model')

  const reloadedRuntime = new JobRuntime({
    planner: stubPlanner,
    executeStep: async ({ step }) => ({ ok: true, output: { text: step.title } }),
  })
  assert.equal(reloadedRuntime.getJob(job.id, { userId: TEST_USER }).modelName, 'selected-model')
  await reloadedRuntime.drain()
})

async function waitFor(predicate, { timeoutMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('timed out waiting for runtime condition')
}

/**
 * ★ 固定的 plan,替代真 planner。
 *
 * 这个用例测的是「runtime 会不会按顺序跑完 plan 里的 step」,
 * 不是「planner 会规划出什么」。原来走真 planner 意味着:
 * 单个用例 67 秒、要配 API key、而且模型多插一个 execute step 断言就红
 * —— 测的东西和红的原因完全无关。
 */
function stubPlanner(prompt) {
  return {
    title: String(prompt || '').slice(0, 200),
    steps: [
      { kind: 'plan', title: '规划' },
      { kind: 'batch_item', title: '第 1 份' },
      { kind: 'batch_item', title: '第 2 份' },
      { kind: 'verify', title: '校验' },
      { kind: 'finalize', title: '收尾' },
    ],
  }
}

test('runtime completes queued child steps in order', async () => {
  const executed = []
  const runtime = new JobRuntime({
    planner: stubPlanner,
    executeStep: async ({ step }) => {
      executed.push(step.kind)
      return { ok: true, output: { text: step.title } }
    },
  })

  const job = await runtime.createJob('生成 2 份文本摘要', { userId: TEST_USER })
  await runtime.drain()
  const loaded = runtime.getJob(job.id, { userId: TEST_USER })

  assert.equal(loaded.status, 'completed')
  assert.deepEqual(executed, ['plan', 'batch_item', 'batch_item', 'verify', 'finalize'])
  assert.deepEqual(loaded.steps.map((step) => step.status), ['completed', 'completed', 'completed', 'completed', 'completed'])
})

test('runtime retries fixable verification and only completes after a passing verdict', async () => {
  let verificationRuns = 0
  const runtime = new JobRuntime({
    executeStep: async ({ step }) => {
      if (step.kind === 'verify') {
        verificationRuns += 1
        const acceptance = verificationRuns === 1
          ? { verdict: 'fixable', summary: 'One check still fails', issues: ['check A'], evidence: [] }
          : { verdict: 'pass', summary: 'All checks pass', issues: [], evidence: ['check A passed'] }
        return {
          ok: acceptance.verdict === 'pass',
          acceptance,
          output: { text: acceptance.summary, acceptance },
        }
      }
      return { ok: true, output: { text: step.title, complete: true } }
    },
  })
  const job = await runtime.createPlan({
    userId: TEST_USER,
    title: 'repair verification',
    prompt: 'repair and verify',
    steps: [{ kind: 'execute', title: 'work' }],
  })

  await runtime.drain()

  const loaded = runtime.getJob(job.id, { userId: TEST_USER })
  assert.equal(loaded.status, 'completed')
  assert.equal(verificationRuns, 2)
  const verify = loaded.steps.find((step) => step.kind === 'verify')
  assert.equal(verify.output.acceptance.verdict, 'pass')
  assert.equal(verify.output.repairAttempts, 1)
  assert.ok(loaded.events.some((event) => event.type === 'verification_repair_started'))
  assert.ok(loaded.events.some((event) => (
    event.type === 'task_reviewed' && event.payload?.acceptance?.verdict === 'pass'
  )))
})

test('runtime bounds repeated verification repairs and preserves the failed verdict', async () => {
  let verificationRuns = 0
  const runtime = new JobRuntime({
    executeStep: async ({ step }) => {
      if (step.kind === 'verify') {
        verificationRuns += 1
        const acceptance = {
          verdict: 'fixable',
          summary: 'The same assertion still fails',
          issues: ['persistent failure'],
          evidence: [],
        }
        return { ok: false, acceptance, error: acceptance.summary, output: { acceptance } }
      }
      return { ok: true, output: { text: step.title, complete: true } }
    },
  })
  const job = await runtime.createPlan({
    userId: TEST_USER,
    title: 'bounded repair',
    prompt: 'do not loop forever',
    steps: [{ kind: 'execute', title: 'work' }],
  })

  await runtime.drain()

  const loaded = runtime.getJob(job.id, { userId: TEST_USER })
  assert.equal(loaded.status, 'failed')
  assert.equal(verificationRuns, 2)
  const verify = loaded.steps.find((step) => step.kind === 'verify')
  assert.equal(verify.status, 'failed')
  assert.equal(verify.output.acceptance.verdict, 'fixable')
  assert.equal(verify.output.repairAttempts, 1)
  assert.ok(loaded.events.some((event) => event.type === 'verification_repair_stalled'))
  assert.ok(loaded.events.some((event) => (
    event.type === 'task_reviewed' && event.payload?.acceptance?.verdict === 'fixable'
  )))
})

test('finalize rejection cannot transition a job to completed', async () => {
  const runtime = new JobRuntime({
    executeStep: async ({ step }) => {
      if (step.kind === 'finalize') {
        return {
          ok: false,
          error: 'Required deliverable is missing',
          output: {
            phase: 'finalize',
            complete: false,
            summary: 'Required deliverable is missing',
            issues: ['missing deliverable'],
          },
        }
      }
      return { ok: true, output: { text: step.title } }
    },
  })
  const job = await runtime.createPlan({
    userId: TEST_USER,
    title: 'finalization gate',
    prompt: 'produce required output',
    steps: [{ kind: 'execute', title: 'work' }],
  })

  await runtime.drain()

  const loaded = runtime.getJob(job.id, { userId: TEST_USER })
  assert.equal(loaded.status, 'failed')
  const finalize = loaded.steps.find((step) => step.kind === 'finalize')
  assert.equal(finalize.status, 'failed')
  assert.equal(finalize.output.complete, false)
  assert.equal(loaded.events.some((event) => event.type === 'completed'), false)
})

test('goal jobs always pause for durable plan approval regardless of the global approval mode', async () => {
  const executed = []
  const runtime = new JobRuntime({
    planner: stubPlanner,
    executeStep: async ({ step }) => {
      executed.push(step.kind)
      return { ok: true, output: { text: step.title } }
    },
  })
  setApprovalMode({ userId: TEST_USER, mode: 'bypass' })

  try {
    const job = await runtime.createJob('完成一个长期目标', {
      userId: TEST_USER,
      requirePlanApproval: true,
    })
    assert.equal(job.steps.find((step) => step.kind === 'plan').input.requirePlanApproval, true)

    await runtime.runOneTick()
    const proposed = runtime.getJob(job.id, { userId: TEST_USER })
    assert.equal(proposed.status, 'waiting')
    assert.deepEqual(executed, ['plan'])
    assert.ok(proposed.events.some((event) => event.type === 'plan_proposed'))
    assert.equal(getApprovalMode({ userId: TEST_USER }), 'bypass')

    const approval = runtime.approvePlan(job.id, { userId: TEST_USER })
    assert.equal(approval.approved, true)
    assert.equal(approval.mode, 'bypass')
    await runtime.drain()

    const completed = runtime.getJob(job.id, { userId: TEST_USER })
    assert.equal(completed.status, 'completed')
    assert.deepEqual(executed, ['plan', 'batch_item', 'batch_item', 'verify', 'finalize'])
  } finally {
    setApprovalMode({ userId: TEST_USER, mode: 'normal' })
  }
})

test('trusted runtime task plan guard forces durable approval without rewriting either plan source', async () => {
  const observedSources = []
  const executed = []
  await registerPlugin({
    id: 'task-plan-guard-test',
    name: 'Task plan guard test',
    version: '1.0.0',
    contributes: ['service:task-plan-guard'],
  }, (ctx) => {
    ctx.services.provide('task-plan-guard', {
      review(scope) {
        assert.equal(Object.isFrozen(scope), true)
        assert.equal(Object.isFrozen(scope.steps), true)
        observedSources.push(scope.planningSource)
        return {
          decision: 'require_approval',
          steps: [{ title: 'plugin must not replace host steps' }],
        }
      },
    })
  })

  const runtime = new JobRuntime({
    planner: (prompt) => ({ ...stubPlanner(prompt), planningSource: 'model' }),
    executeStep: async ({ step }) => {
      executed.push(step.kind)
      return { ok: true, output: { text: step.title } }
    },
  })

  try {
    const generated = await runtime.createJob('guard generated plan', { userId: TEST_USER })
    const generatedPlan = generated.steps.find((step) => step.kind === 'plan')
    assert.equal(generatedPlan.input.requirePlanApproval, true)
    assert.deepEqual(generatedPlan.input.planGuard, {
      pluginId: 'task-plan-guard-test',
      service: 'task-plan-guard',
      mode: 'approval_only',
      decision: 'require_approval',
    })
    assert.deepEqual(generated.steps.map((step) => step.title), ['规划', '第 1 份', '第 2 份', '校验', '收尾'])
    assert.deepEqual(generated.events.find((event) => event.type === 'created').payload.planGuard, generatedPlan.input.planGuard)

    await runtime.runOneTick()
    const waiting = runtime.getJob(generated.id, { userId: TEST_USER })
    assert.equal(waiting.status, 'waiting')
    assert.deepEqual(executed, ['plan'])
    assert.deepEqual(waiting.events.find((event) => event.type === 'plan_proposed').payload.planGuard, generatedPlan.input.planGuard)
    const executeStep = waiting.steps.find((step) => step.kind === 'batch_item')
    for (const action of [
      () => runtime.retryJob(waiting.id, { userId: TEST_USER }),
      () => runtime.retryStep(waiting.id, executeStep.id, { userId: TEST_USER }),
      () => runtime.completeStep(waiting.id, executeStep.id, { userId: TEST_USER, evidence: [] }),
    ]) {
      assert.throws(action, (error) => error?.code === 'JOB_PLAN_APPROVAL_REQUIRED')
    }
    assert.equal(runtime.getJob(waiting.id, { userId: TEST_USER }).status, 'waiting')
    assert.equal(runtime.approvePlan(waiting.id, { userId: TEST_USER }).approved, true)

    const structured = await runtime.createPlan({
      userId: TEST_USER,
      title: 'guard structured plan',
      prompt: 'run a user-authored structured plan',
      steps: [{ id: 'work', title: 'User-authored work', kind: 'execute' }],
    })
    assert.equal(structured.steps[0].kind, 'plan')
    assert.equal(structured.steps[0].input.requirePlanApproval, true)
    assert.equal(structured.steps[1].title, 'User-authored work')
    assert.equal(structured.events.find((event) => event.type === 'created').payload.planGuard.decision, 'require_approval')
    assert.deepEqual(observedSources, ['model', 'user'])
  } finally {
    assert.equal(await unregisterPlugin('task-plan-guard-test'), true)
  }
})

test('a guarded plan that fails before proposal can retry and still requires approval', async () => {
  let planAttempts = 0
  let targetJobId = null
  const runtime = new JobRuntime({
    planner: stubPlanner,
    taskPlanGuard: async () => ({
      requirePlanApproval: true,
      guard: {
        pluginId: 'recovery-policy-plugin',
        service: 'task-plan-guard',
        mode: 'approval_only',
        decision: 'require_approval',
      },
    }),
    executeStep: async ({ job, step }) => {
      if (job.id === targetJobId && step.kind === 'plan') {
        planAttempts += 1
        if (planAttempts === 1) return { ok: false, error: 'plan presentation failed', output: {} }
      }
      return { ok: true, output: { text: step.title } }
    },
  })

  const job = await runtime.createJob('retry guarded plan', { userId: TEST_USER })
  targetJobId = job.id
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (runtime.getJob(job.id, { userId: TEST_USER })?.status === 'failed') break
    if (!await runtime.runOneTick()) break
  }
  assert.equal(runtime.getJob(job.id, { userId: TEST_USER }).status, 'failed')

  assert.equal(runtime.retryJob(job.id, { userId: TEST_USER }).status, 'queued')
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (runtime.getJob(job.id, { userId: TEST_USER })?.status === 'waiting') break
    if (!await runtime.runOneTick()) break
  }
  const waiting = runtime.getJob(job.id, { userId: TEST_USER })
  assert.equal(waiting.status, 'waiting')
  assert.equal(planAttempts, 2)
  assert.ok(waiting.events.some((event) => event.type === 'plan_proposed'))
})

test('runtime delivers a terminal event to its owner through the event hub', async () => {
  const received = []
  const runtime = new JobRuntime({
    planner: stubPlanner,
    executeStep: async ({ step }) => ({ ok: true, output: { text: step.title } }),
  })
  const unsubscribe = runtime.subscribe(TEST_USER, (event) => received.push(event))
  const job = await runtime.createJob('内存泄漏检查', { userId: TEST_USER })
  try {
    await runtime.drain()
    assert.equal(runtime.getJob(job.id, { userId: TEST_USER }).status, 'completed')
    assert.ok(received.some((event) => event.jobId === job.id && event.type === 'completed'))
  } finally {
    unsubscribe()
  }
})

test('runtime preserves the one-argument global event subscription form', () => {
  const runtime = new JobRuntime({
    planner: stubPlanner,
    executeStep: async ({ step }) => ({ ok: true, output: { text: step.title } }),
  })
  const received = []
  const unsubscribe = runtime.subscribe((event) => received.push(event))
  const event = { jobId: 'compatibility-probe', type: 'progress' }

  runtime.emit(event)

  assert.deepEqual(received, [event])
  assert.equal(unsubscribe(), true)
})

test('terminal cleanup only releases the budget generation held by its tick', async () => {
  const userId = issueTestSession().userId
  let originalBudget = null
  let replacementBudget = null
  const runtime = new JobRuntime({
    executeStep: async ({ job }) => {
      assert.strictEqual(getJobBudget(job), originalBudget)
      assert.equal(releaseJobBudget(job, originalBudget), true)
      replacementBudget = attachJobBudget(job, { initialModelCalls: 7 })
      throw new Error('force the old tick through terminal cleanup')
    },
  })
  const job = await runtime.createPlan({
    userId,
    title: 'budget generation cleanup',
    prompt: 'verify stale cleanup fencing',
    steps: [{ kind: 'execute', title: 'replace the budget generation' }],
  })
  originalBudget = attachJobBudget(job, { initialModelCalls: 1 })

  try {
    assert.equal(await runtime.runOneTick(), true)
    assert.equal(runtime.getJob(job.id, { userId }).status, 'failed')
    assert.ok(replacementBudget)
    assert.strictEqual(getJobBudget(job), replacementBudget)
    assert.equal(replacementBudget.snapshot().modelCalls, 7)
  } finally {
    releaseJobBudget(job, replacementBudget)
  }
})

test('runtime honors cancellation before the next step starts', async () => {
  const executed = []
  const runtime = new JobRuntime({
    planner: stubPlanner,
    executeStep: async ({ step }) => {
      executed.push(step.kind)
      return { ok: true, output: { text: step.title } }
    },
  })

  const job = await runtime.createJob('生成 2 份周报', { userId: TEST_USER })
  await runtime.runOneTick()
  runtime.requestCancel(job.id, { userId: TEST_USER })
  await runtime.drain()

  assert.deepEqual(executed, ['plan'])
  assert.equal(runtime.getJob(job.id, { userId: TEST_USER }).status, 'cancelled')
})

test('runtime aborts an in-flight step when cancellation is requested', async () => {
  let sawAbort = false
  const runtime = new JobRuntime({
    planner: stubPlanner,
    executeStep: async ({ signal }) => new Promise((resolve, reject) => {
      if (signal.aborted) {
        sawAbort = true
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        return
      }
      signal.addEventListener('abort', () => {
        sawAbort = true
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      }, { once: true })
    }),
  })

  const job = await runtime.createJob('生成长文', { userId: TEST_USER })
  const runningTick = runtime.runOneTick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  runtime.requestCancel(job.id, { userId: TEST_USER })
  await runningTick

  const loaded = runtime.getJob(job.id, { userId: TEST_USER })
  assert.equal(sawAbort, true)
  assert.equal(loaded.status, 'cancelled')
  assert.equal(loaded.steps[0].status, 'cancelled')
})

test('scheduler runs different jobs concurrently, prevents overlap, and refills freed capacity', async () => {
  const started = []
  const releases = new Map()
  const executionCounts = new Map()
  let active = 0
  let maxActive = 0
  const runtime = new JobRuntime({
    tickMs: 5,
    maxConcurrency: 2,
    planner: (prompt) => ({
      title: prompt,
      steps: [{ kind: 'execute', title: 'execute once' }],
    }),
    executeStep: async ({ job }) => {
      started.push(job.id)
      executionCounts.set(job.id, (executionCounts.get(job.id) || 0) + 1)
      active += 1
      maxActive = Math.max(maxActive, active)
      try {
        await new Promise((resolve) => releases.set(job.id, resolve))
        return { ok: true, output: { text: job.id } }
      } finally {
        active -= 1
      }
    },
  })

  const first = await runtime.createJob('first', { userId: TEST_USER })
  const second = await runtime.createJob('second', { userId: OTHER_USER })
  runtime.start()
  let third = null

  try {
    await waitFor(() => started.length === 2)
    assert.deepEqual(new Set(started), new Set([first.id, second.id]))
    assert.equal(maxActive, 2)
    assert.equal(executionCounts.get(first.id), 1)
    assert.equal(executionCounts.get(second.id), 1)

    third = await runtime.createJob('third', { userId: TEST_USER })
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(started.includes(third.id), false, 'full capacity must not start a third job')

    releases.get(first.id)()
    await waitFor(() => started.includes(third.id))
    assert.equal(executionCounts.get(first.id), 1, 'a running job must never overlap itself')
    assert.equal(executionCounts.get(third.id), 1)
    assert.equal(maxActive, 2)
  } finally {
    runtime.stop()
    for (const release of releases.values()) release()
    await waitFor(() => runtime.activeJobIds.size === 0)
  }
})

test('recovery returns interrupted running work to queued', () => {
  const recovered = recoverInterruptedJobs([
    { id: 'job-1', status: 'running' },
    { id: 'job-2', status: 'completed' },
  ])
  assert.deepEqual(recovered, [{ id: 'job-1', status: 'queued' }])
})

async function createTruncatedCheckpointJob(runtime, prompt) {
  const job = await runtime.createJob(prompt, { userId: TEST_USER })
  await runtime.drain()
  const failed = runtime.getJob(job.id, { userId: TEST_USER })
  assert.equal(failed.status, 'failed')
  const step = failed.steps[0]
  const checkpoint = getJobTurnCheckpoint({
    jobId: job.id,
    stepId: step.id,
    userId: TEST_USER,
  })
  assert.equal(checkpoint?.state?.final?.noProgress, true)
  return { job, step, checkpoint }
}

function truncatedCheckpointRuntime() {
  return new JobRuntime({
    planner: (prompt) => ({
      title: prompt,
      steps: [{ kind: 'execute', title: 'durable execution' }],
    }),
    executeStep: async ({ job, step }) => {
      const messages = [
        { role: 'user', content: job.prompt },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'read-completed-once',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"README.md"}' },
          }],
        },
        {
          role: 'tool',
          tool_call_id: 'read-completed-once',
          name: 'read_file',
          content: '{"ok":true,"content":"durable evidence"}',
        },
      ]
      saveJobTurnCheckpoint({
        jobId: job.id,
        stepId: step.id,
        userId: job.userId,
        state: {
          messages,
          toolCalls: [],
          artifactIds: [],
          iterations: 3,
          budget: { used: 1, maxTotalCalls: 20, elapsed: 25, maxWallMs: 60_000 },
          final: {
            text: 'partial result',
            iterations: 3,
            incomplete: true,
            noProgress: true,
            reason: 'repeated tool call',
          },
        },
      })
      return {
        ok: false,
        truncated: true,
        incomplete: true,
        noProgress: true,
        reason: 'repeated tool call',
        output: { text: 'partial result', artifactIds: [], toolIterations: 3 },
      }
    },
  })
}

test('retryStep keeps durable tool results and only clears the terminal checkpoint marker', async () => {
  const runtime = truncatedCheckpointRuntime()
  const { job, step, checkpoint } = await createTruncatedCheckpointJob(runtime, 'resume one failed step')

  runtime.retryStep(job.id, step.id, { userId: TEST_USER })

  const resumed = getJobTurnCheckpoint({ jobId: job.id, stepId: step.id, userId: TEST_USER })
  assert.equal(resumed?.state?.final, null)
  assert.deepEqual(resumed?.state?.messages, checkpoint.state.messages)
  assert.deepEqual(resumed?.state?.budget, {
    ...checkpoint.state.budget,
    used: 0,
    elapsed: 0,
    modelMs: 0,
    modelCalls: 0,
    modelTokens: 0,
    costUsd: 0,
    costEvidenceComplete: true,
  })
  assert.equal(resumed?.state?.iterationWindowStart, checkpoint.state.iterations)
  assert.equal(runtime.getJob(job.id, { userId: TEST_USER }).steps[0].status, 'queued')
})

test('retryJob keeps failed-step checkpoints resumable instead of deleting progress', async () => {
  const runtime = truncatedCheckpointRuntime()
  const { job, step, checkpoint } = await createTruncatedCheckpointJob(runtime, 'resume a failed job')

  runtime.retryJob(job.id, { userId: TEST_USER })

  const resumed = getJobTurnCheckpoint({ jobId: job.id, stepId: step.id, userId: TEST_USER })
  assert.equal(resumed?.state?.final, null)
  assert.deepEqual(resumed?.state?.messages, checkpoint.state.messages)
  assert.deepEqual(resumed?.state?.budget, {
    ...checkpoint.state.budget,
    used: 0,
    elapsed: 0,
    modelMs: 0,
    modelCalls: 0,
    modelTokens: 0,
    costUsd: 0,
    costEvidenceComplete: true,
  })
  assert.equal(resumed?.state?.iterationWindowStart, checkpoint.state.iterations)
  assert.equal(runtime.getJob(job.id, { userId: TEST_USER }).status, 'queued')
})

test('retryJob and retryStep reject a provider revision change while a model request is in flight', async () => {
  const userId = issueTestSession().userId
  const modelName = `retry-checkpoint-model-${Date.now()}`
  const provider = upsertModelProvider({
    userId,
    provider: {
      key: `retry-checkpoint-provider-${Date.now()}`,
      label: 'Retry checkpoint provider',
      baseUrl: 'https://retry-checkpoint-v1.example.test/v1',
      models: [modelName],
      defaultModel: modelName,
      enabled: true,
      isDefault: true,
    },
  })
  recordModelProviderReadiness({
    userId,
    id: provider.id,
    readiness: { chat: true, tools: true, agent: true, mode: 'agent' },
  })

  let modelCalls = 0
  const runtime = new JobRuntime({
    planner: (prompt) => ({
      title: prompt,
      steps: [{ kind: 'execute', title: 'Durable model request' }],
    }),
    executeStep: async () => {
      modelCalls += 1
      return { ok: true, output: { text: 'must not run' } }
    },
  })
  const created = await runtime.createJob('preserve the old model request binding', {
    userId,
    modelName,
    modelProviderId: provider.id,
    env: {},
  })
  const step = created.steps.find((item) => item.kind === 'execute') || created.steps[0]
  updateJobStep(step.id, { status: 'failed', error: 'process stopped after provider accepted request' })
  updateJob(created.id, {
    status: 'failed',
    error: 'checkpoint flush failed',
    finishedAt: Date.now(),
  })
  const modelRequestId = `mr_${'a'.repeat(48)}`
  saveJobTurnCheckpoint({
    jobId: created.id,
    stepId: step.id,
    userId,
    state: {
      messages: [{ role: 'user', content: 'bill this request once' }],
      iterations: 1,
      modelInvocation: {
        version: 2,
        id: modelRequestId,
        idempotencyKey: modelRequestId,
        fingerprint: 'b'.repeat(64),
        providerId: provider.id,
        modelName,
        configRevision: provider.configRevision,
        iteration: 1,
        attempt: 1,
        status: 'in_flight',
      },
    },
  })

  const updatedProvider = upsertModelProvider({
    userId,
    provider: {
      ...provider,
      baseUrl: 'https://retry-checkpoint-v2.example.test/v1',
      models: [modelName],
      defaultModel: modelName,
    },
  })
  recordModelProviderReadiness({
    userId,
    id: updatedProvider.id,
    readiness: { chat: true, tools: true, agent: true, mode: 'agent' },
  })
  assert.notEqual(updatedProvider.configRevision, provider.configRevision)

  const beforeJob = runtime.getJob(created.id, { userId })
  const beforeCheckpoint = getJobTurnCheckpoint({ jobId: created.id, stepId: step.id, userId })
  const assertBlockedWithoutWrites = (action) => {
    assert.throws(
      action,
      (error) => error?.code === 'MODEL_REQUEST_OUTCOME_UNKNOWN'
        && error?.modelRequestId === modelRequestId
        && error?.configRevision === provider.configRevision
        && error?.targetConfigRevision === updatedProvider.configRevision,
    )
    const afterJob = runtime.getJob(created.id, { userId })
    assert.equal(afterJob.status, beforeJob.status)
    assert.equal(afterJob.modelProviderId, beforeJob.modelProviderId)
    assert.equal(afterJob.modelConfigRevision, beforeJob.modelConfigRevision)
    assert.equal(afterJob.steps.find((item) => item.id === step.id)?.status, 'failed')
    assert.equal(afterJob.events.length, beforeJob.events.length)
    assert.deepEqual(
      getJobTurnCheckpoint({ jobId: created.id, stepId: step.id, userId }),
      beforeCheckpoint,
    )
    assert.equal(modelCalls, 0)
  }

  assertBlockedWithoutWrites(() => runtime.retryStep(created.id, step.id, { userId }))
  assertBlockedWithoutWrites(() => runtime.retryJob(created.id, { userId }))
})

test('default executor turns generated text into a downloadable artifact', async () => {
  const artifactId = `artifact-${process.pid}-${Date.now()}`
  let validatedArtifact = null
  const runtime = new JobRuntime({
    // 这个用例断言 step.output.text 等于模型原样返回的内容,
    // 所以不能用带 batch_item 的 stubPlanner —— 批量步骤会往 prompt 里
    // 追加「这是批量任务中的第 N 项」。用最简单的单步 plan。
    planner: (prompt) => ({
      title: String(prompt || '').slice(0, 200),
      steps: [
        { kind: 'plan', title: '规划' },
        { kind: 'execute', title: '执行' },
      ],
    }),
    executeStep: createDefaultExecuteStep({
      enableServerTools: false,
      runModel: async ({ userPrompt }) => `结果：${userPrompt}`,
      createDocxImpl: async () => ({
        id: artifactId,
        type: 'docx',
        title: '任务结果',
        url: '/api/artifacts/result.docx',
        filename: 'result.docx',
      }),
      validateGeneratedArtifact: async (input) => {
        validatedArtifact = input
        return { ok: true, format: 'docx' }
      },
    }),
  })

  const job = await runtime.createJob('整理会议纪要并导出', { userId: TEST_USER })
  await runtime.drain()
  const loaded = runtime.getJob(job.id, { userId: TEST_USER })

  assert.equal(loaded.status, 'completed')
  assert.equal(loaded.artifacts.length, 1)
  assert.equal(loaded.artifacts[0].filename, 'result.docx')
  assert.equal(loaded.steps[1].output.text, '结果：整理会议纪要并导出')
  assert.deepEqual(validatedArtifact, {
    filePath: undefined,
    filename: 'result.docx',
    toolName: 'create_docx',
    artifactType: 'docx',
  })
})

test('default finalize executor validates an automatic DOCX before registering it', async () => {
  const artifactDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-invalid-auto-docx-'))
  const invalidArtifactPath = path.join(artifactDirectory, 'invalid.docx')
  fs.writeFileSync(invalidArtifactPath, 'not a DOCX package')
  const executeStep = createDefaultExecuteStep({
    enableServerTools: false,
    artifactDirectory,
    createDocxImpl: async () => ({
      id: 'invalid-docx',
      type: 'docx',
      title: 'Invalid',
      filename: 'invalid.docx',
      fullPath: invalidArtifactPath,
      url: '/api/artifacts/invalid.docx',
    }),
    validateGeneratedArtifact: async () => {
      throw new Error('DOCX package is invalid')
    },
  })

  await assert.rejects(
    () => executeStep({
      job: {
        id: 'job-invalid-auto-docx',
        userId: TEST_USER,
        title: 'Invalid document',
        prompt: '整理会议纪要并导出',
        artifacts: [],
        steps: [{ kind: 'execute', output: { text: 'Generated text' } }],
      },
      step: { id: 'finalize-invalid-auto-docx', kind: 'finalize' },
      signal: new AbortController().signal,
    }),
    /DOCX package is invalid/,
  )
  assert.equal(fs.existsSync(invalidArtifactPath), false)
  fs.rmSync(artifactDirectory, { recursive: true, force: true })
})

test('default finalize executor rejects an incomplete final output', async () => {
  const executeStep = createDefaultExecuteStep({ enableServerTools: false })
  const result = await executeStep({
    job: {
      id: 'job-final-output-gate',
      userId: TEST_USER,
      title: 'Required PDF',
      prompt: '生成并交付 PDF 文件',
      artifacts: [],
      steps: [
        { kind: 'execute', status: 'completed', output: { text: 'Drafted content' } },
        {
          kind: 'verify',
          status: 'completed',
          output: {
            text: 'Checks pass',
            acceptance: { verdict: 'pass', summary: 'Checks pass', issues: [], evidence: ['checked'] },
          },
        },
        { kind: 'finalize', status: 'running' },
      ],
    },
    step: { id: 'finalize-gate', kind: 'finalize' },
    signal: new AbortController().signal,
  })

  assert.equal(result.ok, false)
  assert.equal(result.output.complete, false)
  assert.match(result.error, /部分完成/)
  assert.deepEqual(result.output.missingDeliverables, ['pdf'])
  assert.ok(result.output.issues.some((issue) => /缺少 PDF 文档/.test(issue)))
})

test('default executor forwards cancellation signals to the model runner', async () => {
  const controller = new AbortController()
  let receivedSignal = null
  const executeStep = createDefaultExecuteStep({
    enableServerTools: false,
    runModel: async ({ signal }) => {
      receivedSignal = signal
      return '完成'
    },
  })

  await executeStep({
    job: { title: '测试任务', prompt: '生成摘要', steps: [] },
    step: { kind: 'execute' },
    signal: controller.signal,
  })

  assert.equal(receivedSignal, controller.signal)
})

test('default executor maps an incomplete tool loop to a truncated failed step result', async () => {
  let modelCalls = 0
  const executeStep = createDefaultExecuteStep({
    runModelWithTools: async () => {
      modelCalls += 1
      return { content: 'The requested fix is complete.', toolCalls: [] }
    },
  })

  const result = await executeStep({
    job: {
      id: 'job-incomplete-tool-loop',
      userId: null,
      title: 'Fix login',
      prompt: 'Fix login.js and verify the result.',
      steps: [],
    },
    step: { id: 'step-incomplete-tool-loop', kind: 'execute' },
    signal: new AbortController().signal,
  })

  assert.equal(modelCalls, 2)
  assert.equal(result.ok, false)
  assert.equal(result.truncated, true)
  assert.equal(result.incomplete, true)
  assert.equal(result.reason, 'execution_evidence_missing')
})

test('background jobs hide run_code when every trusted execution switch is disabled', async () => {
  const userId = issueTestSession({ email: 'job-run-code-switch@example.com' }).userId
  const savedLocalCodeExecution = process.env.LOCAL_CODE_EXECUTION_ENABLED
  const savedWorkspaceShell = process.env.WORKSPACE_SHELL_ENABLED
  setUserToolPermission({ userId, toolName: 'run_code', enabled: true })
  try {
    process.env.LOCAL_CODE_EXECUTION_ENABLED = '0'
    process.env.WORKSPACE_SHELL_ENABLED = '0'
    const disabledNames = await modelVisibleJobToolNames(userId)
    assert.equal(disabledNames.includes('run_code'), false)
    assert.ok(disabledNames.includes('manage_todos'))

    process.env.LOCAL_CODE_EXECUTION_ENABLED = '1'
    const enabledNames = await modelVisibleJobToolNames(userId)
    assert.equal(enabledNames.includes('run_code'), true)
  } finally {
    if (savedLocalCodeExecution === undefined) delete process.env.LOCAL_CODE_EXECUTION_ENABLED
    else process.env.LOCAL_CODE_EXECUTION_ENABLED = savedLocalCodeExecution
    if (savedWorkspaceShell === undefined) delete process.env.WORKSPACE_SHELL_ENABLED
    else process.env.WORKSPACE_SHELL_ENABLED = savedWorkspaceShell
  }
})

test('background jobs hide run_code when the user explicitly disables it', async () => {
  const userId = issueTestSession({ email: 'job-run-code-user-override@example.com' }).userId
  const savedLocalCodeExecution = process.env.LOCAL_CODE_EXECUTION_ENABLED
  const savedWorkspaceShell = process.env.WORKSPACE_SHELL_ENABLED
  try {
    process.env.LOCAL_CODE_EXECUTION_ENABLED = '1'
    process.env.WORKSPACE_SHELL_ENABLED = '0'
    setUserToolPermission({ userId, toolName: 'run_code', enabled: false })

    const visibleNames = await modelVisibleJobToolNames(userId)
    assert.equal(visibleNames.includes('run_code'), false)
    assert.ok(visibleNames.includes('manage_todos'))
  } finally {
    setUserToolPermission({ userId, toolName: 'run_code', enabled: true })
    if (savedLocalCodeExecution === undefined) delete process.env.LOCAL_CODE_EXECUTION_ENABLED
    else process.env.LOCAL_CODE_EXECUTION_ENABLED = savedLocalCodeExecution
    if (savedWorkspaceShell === undefined) delete process.env.WORKSPACE_SHELL_ENABLED
    else process.env.WORKSPACE_SHELL_ENABLED = savedWorkspaceShell
  }
})

test('execute steps require real tool evidence even when the prompt verb is not in the heuristic list', async () => {
  let modelCalls = 0
  const executeStep = createDefaultExecuteStep({
    runModelWithTools: async () => {
      modelCalls += 1
      return { content: 'The release checklist is reconciled.', toolCalls: [] }
    },
  })

  const result = await executeStep({
    job: {
      id: 'job-explicit-execute-contract',
      userId: null,
      title: 'Release checklist reconciliation',
      prompt: 'Release checklist reconciliation.',
      steps: [],
    },
    step: { id: 'step-explicit-execute-contract', kind: 'execute' },
    signal: new AbortController().signal,
  })

  assert.equal(modelCalls, 2)
  assert.equal(result.ok, false)
  assert.equal(result.incomplete, true)
  assert.equal(result.reason, 'execution_evidence_missing')
  assert.doesNotMatch(result.output.text, /is reconciled/i)
})

test('default executor does not deny generic file and shell capabilities when no Office generator matches', async () => {
  let capturedMessages = []
  const executeStep = createDefaultExecuteStep({
    runModelWithTools: async ({ messages }) => {
      capturedMessages = messages
      return { content: 'No execution yet.', toolCalls: [] }
    },
  })

  await executeStep({
    job: {
      id: 'job-generic-file-capability-prompt',
      userId: null,
      title: 'Update text file',
      prompt: '将 Task 1 写入 D:\\desktop\\answer.txt。',
      steps: [],
    },
    step: { id: 'step-generic-file-capability-prompt', kind: 'execute' },
    signal: new AbortController().signal,
  })

  const systemText = capturedMessages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n')
  assert.doesNotMatch(systemText, /系统也没有给你生成文件的工具/)
  assert.match(systemText, /以本轮实际工具列表为准/)
  assert.match(systemText, /Shell/)
})

test('structured plans are normalized into runnable steps', async () => {
  const executed = []
  const runtime = new JobRuntime({
    executeStep: async ({ step }) => {
      executed.push(step.title)
      return { ok: true, output: { text: step.title } }
    },
  })

  const job = await runtime.createPlan({
    userId: TEST_USER,
    title: '结构化计划',
    prompt: '执行结构化计划',
    steps: [
      { id: 'inspect', title: '检查现状', action: '读取项目', verification: ['记录现状'] },
      { id: 'change', title: '完成修改', action: '修改项目', acceptance: '测试通过' },
    ],
  })

  assert.equal(job.status, 'queued')
  assert.deepEqual(job.steps.map((step) => step.kind), ['execute', 'execute', 'verify', 'finalize'])
  assert.deepEqual(job.steps.map((step) => step.status), ['queued', 'queued', 'queued', 'queued'])
  assert.equal(job.steps[0].input.action, '读取项目')
  await runtime.drain()
  assert.deepEqual(executed.slice(0, 2), ['检查现状', '完成修改'])
  assert.equal(executed.length, 4)
  assert.equal(runtime.getJob(job.id, { userId: TEST_USER }).status, 'completed')
})

test('manual step completion persists verification evidence', async () => {
  const runtime = new JobRuntime()
  const job = await runtime.createPlan({
    userId: TEST_USER,
    title: '人工验收',
    prompt: '记录验收证据',
    steps: [{ id: 'verify', title: '完成验收' }],
  })

  let completed
  for (const step of job.steps) {
    const evidence = step.kind === 'execute'
      ? [{ type: 'tool_result', summary: 'Work executed', toolCallId: `tool-${step.id}`, ok: true }]
      : step.kind === 'verify'
        ? [{ type: 'check', summary: 'npm test passed', command: 'npm test', exitCode: 0 }]
        : []
    completed = runtime.completeStep(job.id, step.id, {
      userId: TEST_USER,
      evidence,
    })
  }

  assert.equal(completed.status, 'completed')
  assert.deepEqual(completed.steps.find((step) => step.kind === 'verify').output.evidence, [{
    type: 'check',
    summary: 'npm test passed',
    command: 'npm test',
    ok: true,
    exitCode: 0,
  }])
  assert.ok(completed.events.some((event) => event.type === 'step_completed'))
})

test('manual completion cannot bypass a rejected structured acceptance verdict', async () => {
  const runtime = new JobRuntime()
  const job = await runtime.createPlan({
    userId: TEST_USER,
    title: 'Manual acceptance gate',
    prompt: 'Verify before completion',
    steps: [{ id: 'verify', title: 'Verify', kind: 'verify' }],
  })
  const verify = job.steps.find((step) => step.kind === 'verify')
  const finalize = job.steps.find((step) => step.kind === 'finalize')
  updateJobStep(verify.id, {
    output: {
      acceptance: {
        verdict: 'blocked',
        summary: 'External dependency unavailable',
        issues: ['dependency unavailable'],
        evidence: [],
      },
    },
  })

  runtime.completeStep(job.id, verify.id, {
    userId: TEST_USER,
    evidence: [{ type: 'check', summary: 'dependency probe completed', command: 'probe-dependency', ok: true }],
  })
  const completed = runtime.completeStep(job.id, finalize.id, { userId: TEST_USER })

  assert.equal(completed.status, 'failed')
  assert.equal(completed.error, 'External dependency unavailable')
  assert.equal(completed.events.some((event) => event.type === 'completed'), false)
})

test('manual execution completion rejects missing evidence without changing job state', async () => {
  const runtime = new JobRuntime()
  const job = await runtime.createPlan({
    userId: TEST_USER,
    title: 'Evidence required',
    prompt: 'Execute and verify work',
    steps: [{ id: 'work', title: 'Execute work', kind: 'execute' }],
  })
  const step = job.steps.find((item) => item.kind === 'execute')
  const eventsBefore = job.events.length

  assert.throws(
    () => runtime.completeStep(job.id, step.id, { userId: TEST_USER, evidence: [] }),
    (error) => error?.code === 'JOB_COMPLETION_EVIDENCE_REQUIRED',
  )
  assert.throws(
    () => runtime.completeStep(job.id, step.id, { userId: TEST_USER, evidence: ['done'] }),
    (error) => error?.code === 'JOB_COMPLETION_EVIDENCE_INVALID',
  )

  const unchanged = runtime.getJob(job.id, { userId: TEST_USER })
  assert.equal(unchanged.status, 'queued')
  assert.equal(unchanged.progress, 0)
  assert.equal(unchanged.steps.find((item) => item.id === step.id).status, 'queued')
  assert.equal(unchanged.events.length, eventsBefore)
})

test('manual plan and prose completion remain compatible without evidence', async () => {
  const runtime = new JobRuntime()
  const job = await runtime.createPlan({
    userId: TEST_USER,
    title: 'Compatible plan',
    prompt: 'Plan before execution',
    steps: [
      { id: 'plan-only', title: 'Plan work', kind: 'plan' },
      { id: 'chat-only', title: 'Explain work', kind: 'chat' },
    ],
  })
  const planStep = job.steps.find((item) => item.kind === 'plan')
  const chatStep = job.steps.find((item) => item.kind === 'chat')

  runtime.completeStep(job.id, planStep.id, { userId: TEST_USER })
  const updated = runtime.completeStep(job.id, chatStep.id, { userId: TEST_USER })
  for (const stepId of [planStep.id, chatStep.id]) {
    assert.equal(updated.steps.find((item) => item.id === stepId).status, 'completed')
    assert.deepEqual(updated.steps.find((item) => item.id === stepId).output.evidence, [])
  }
})

test('default executor injects background skill and memory context without blocking on context failure', async () => {
  let capturedMessages = []
  let contextInput = null
  const executeStep = createDefaultExecuteStep({
    enableServerTools: false,
    preparePromptContext: (input) => {
      contextInput = input
      return {
        messages: [
          { role: 'system', content: '# Skills\nwriter instructions' },
          { role: 'system', content: '# Long-term memory\nproject fact' },
        ],
        skillIds: ['writer'],
      }
    },
    runModel: async ({ messages }) => {
      capturedMessages = messages
      return 'done'
    },
  })
  await executeStep({
    job: { userId: TEST_USER, title: 'context job', prompt: '/writer draft release notes', steps: [] },
    step: { kind: 'execute' },
    signal: new AbortController().signal,
  })
  assert.deepEqual(contextInput.skillIds, ['writer'])
  assert.equal(contextInput.query, 'draft release notes')
  assert.ok(capturedMessages.some((message) => message.content.includes('writer instructions')))
  assert.ok(capturedMessages.some((message) => message.content.includes('project fact')))

  let fallbackCalled = false
  const fallback = createDefaultExecuteStep({
    enableServerTools: false,
    preparePromptContext: () => { throw new Error('memory unavailable') },
    runModel: async () => {
      fallbackCalled = true
      return 'fallback'
    },
  })
  const result = await fallback({
    job: { userId: TEST_USER, title: 'fallback job', prompt: 'keep running', steps: [] },
    step: { kind: 'execute' },
    signal: new AbortController().signal,
  })
  assert.equal(fallbackCalled, true)
  assert.equal(result.output.text, 'fallback')
})

test('non-document tasks are not forced into a Word artifact', async () => {
  let docxCalls = 0
  const runtime = new JobRuntime({
    planner: stubPlanner,
    executeStep: createDefaultExecuteStep({
      enableServerTools: false,
      runModel: async ({ userPrompt }) => `结果：${userPrompt}`,
      createDocxImpl: async () => {
        docxCalls += 1
        return { id: 'unexpected', type: 'docx', title: 'unexpected', url: '/unexpected.docx' }
      },
    }),
  })

  const job = await runtime.createJob('修复项目 bug 并运行测试', { userId: TEST_USER })
  await runtime.drain()
  const loaded = runtime.getJob(job.id, { userId: TEST_USER })

  assert.equal(docxCalls, 0)
  assert.equal(loaded.artifacts.length, 0)
  assert.equal(loaded.steps.at(-1).output.summary, '任务已执行并完成验证')
})
