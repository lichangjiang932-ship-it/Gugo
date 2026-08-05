import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.APP_DATA_DIR = path.join(os.tmpdir(), 'yma-job-runtime-tests', String(process.pid))

const {
  JobRuntime,
  createDefaultExecuteStep,
  recoverInterruptedJobs,
} = await import('../server/services/jobRuntime.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

const TEST_USER = issueTestSession().userId
const OTHER_USER = issueTestSession().userId

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

  const job = await runtime.createJob('生成 2 份周报', { userId: TEST_USER })
  await runtime.drain()
  const loaded = runtime.getJob(job.id, { userId: TEST_USER })

  assert.equal(loaded.status, 'completed')
  assert.deepEqual(executed, ['plan', 'batch_item', 'batch_item', 'verify', 'finalize'])
  assert.deepEqual(loaded.steps.map((step) => step.status), ['completed', 'completed', 'completed', 'completed', 'completed'])
})

test('D6: jobUserCache is evicted once a job reaches a terminal state', async () => {
  const runtime = new JobRuntime({
    planner: stubPlanner,
    executeStep: async ({ step }) => ({ ok: true, output: { text: step.title } }),
  })
  const job = await runtime.createJob('内存泄漏检查', { userId: TEST_USER })
  assert.ok(runtime.jobUserCache.has(job.id), 'cache populated while job runs')
  await runtime.drain()
  assert.equal(runtime.getJob(job.id, { userId: TEST_USER }).status, 'completed')
  assert.equal(runtime.jobUserCache.has(job.id), false, 'cache entry removed after completion')
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

test('default executor turns generated text into a downloadable artifact', async () => {
  const artifactId = `artifact-${process.pid}-${Date.now()}`
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
    }),
  })

  const job = await runtime.createJob('整理会议纪要并导出', { userId: TEST_USER })
  await runtime.drain()
  const loaded = runtime.getJob(job.id, { userId: TEST_USER })

  assert.equal(loaded.artifacts.length, 1)
  assert.equal(loaded.artifacts[0].filename, 'result.docx')
  assert.equal(loaded.steps[1].output.text, '结果：整理会议纪要并导出')
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

test('structured plans are normalized into runnable steps', async () => {
  const executed = []
  const runtime = new JobRuntime({
    executeStep: async ({ step }) => {
      executed.push(step.title)
      return { ok: true, output: { text: step.title } }
    },
  })

  const job = runtime.createPlan({
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

test('manual step completion persists verification evidence', () => {
  const runtime = new JobRuntime()
  const job = runtime.createPlan({
    userId: TEST_USER,
    title: '人工验收',
    prompt: '记录验收证据',
    steps: [{ id: 'verify', title: '完成验收' }],
  })

  let completed
  for (const step of job.steps) {
    completed = runtime.completeStep(job.id, step.id, {
      userId: TEST_USER,
      evidence: step.kind === 'verify' ? ['npm test 通过'] : [],
    })
  }

  assert.equal(completed.status, 'completed')
  assert.deepEqual(completed.steps.find((step) => step.kind === 'verify').output.evidence, ['npm test 通过'])
  assert.ok(completed.events.some((event) => event.type === 'step_completed'))
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
