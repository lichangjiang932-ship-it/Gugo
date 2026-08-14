import test from 'node:test'
import assert from 'node:assert/strict'

import { createJobBudget } from '../server/utils/jobBudget.js'
import { createToolLoopGuard } from '../server/utils/toolCallHarness.js'

/* ------------------------------------------------------------------ *
 * 预算:模型延迟不该吃掉「干活时间」配额
 * ------------------------------------------------------------------ */

test('等模型的时间从墙钟预算里扣掉 —— 本地模型慢不该导致预算耗尽', () => {
  let clock = 0
  const budget = createJobBudget({
    maxTotalCalls: 100,
    maxWallMs: 60_000,
    now: () => clock,
  })

  // 模拟本地模型:每轮等 40 秒,然后跑一个很快的工具
  for (let round = 0; round < 5; round += 1) {
    clock += 40_000              // 等模型
    budget.trackModelMs(40_000)  // 声明这段是模型延迟
    clock += 100                 // 工具真正干活
    const result = budget.consume(1)
    assert.equal(result.ok, true, `第 ${round + 1} 轮不该超预算`)
  }

  // 总共过去了 200 秒,远超 60 秒墙钟 —— 但其中 200 秒都在等模型,
  // 真正的「干活时间」只有 500ms。
  const snapshot = budget.snapshot()
  assert.ok(snapshot.elapsed < 1000, `干活时间应该很小，实际 ${snapshot.elapsed}ms`)
  assert.equal(snapshot.modelMs, 200_000)
})

test('工具本身耗时过长仍然会超墙钟预算 —— 熔断能力没被削弱', () => {
  let clock = 0
  const budget = createJobBudget({ maxTotalCalls: 100, maxWallMs: 10_000, now: () => clock })
  clock += 11_000 // 工具自己跑了 11 秒,没有 trackModelMs
  const result = budget.consume(1)
  assert.equal(result.ok, false)
  assert.match(result.reason, /wall-clock/)
})

test('调用次数上限仍然有效', () => {
  const budget = createJobBudget({ maxTotalCalls: 3, maxWallMs: 60_000 })
  assert.equal(budget.consume(1).ok, true)
  assert.equal(budget.consume(1).ok, true)
  assert.equal(budget.consume(1).ok, true)
  const over = budget.consume(1)
  assert.equal(over.ok, false)
  assert.match(over.reason, /tool call budget/)
})

test('snapshot 能还原进度 —— 重启后接着算而不是从零开始', () => {
  let clock = 100_000
  const budget = createJobBudget({
    maxTotalCalls: 10,
    maxWallMs: 60_000,
    initialUsed: 4,
    initialElapsedMs: 5_000,
    initialModelMs: 3_000,
    now: () => clock,
  })
  const snap = budget.snapshot()
  assert.equal(snap.used, 4)
  assert.equal(snap.modelMs, 3_000)
  // initialElapsedMs 是 snapshot().elapsed 保存的净工作时长，不含模型等待。
  assert.equal(snap.elapsed, 5_000)
})

/* ------------------------------------------------------------------ *
 * 熔断:模型写错参数 ≠ 环境有问题
 * ------------------------------------------------------------------ */

test('模型连续写错工具参数不会过早熔断 —— 小模型需要多几次自我纠正机会', () => {
  const guard = createToolLoopGuard({ maxConsecutiveErrors: 6, maxAuthoringErrors: 20 })
  // 连续 10 次参数校验失败。按旧逻辑第 6 次就熔断了。
  for (let i = 0; i < 10; i += 1) {
    const verdict = guard.after({ ok: false, code: 'tool_arguments_validation_failed', error: 'bad json' })
    assert.equal(verdict.ok, true, `第 ${i + 1} 次参数错误不该熔断`)
  }
  // 但也不是无限容忍
  for (let i = 0; i < 12; i += 1) {
    guard.after({ ok: false, code: 'invalid_tool_arguments', error: 'bad json' })
  }
  assert.equal(guard.snapshot().consecutiveAuthoringErrors >= 20, true)
  assert.equal(guard.before({ name: 'read_file', args: { path: 'x' } }).ok, false)
})

test('真实执行失败仍然按原规则在第 6 次熔断', () => {
  const guard = createToolLoopGuard({ maxConsecutiveErrors: 6 })
  for (let i = 0; i < 5; i += 1) {
    assert.equal(guard.after({ ok: false, error: 'ENOENT' }).ok, true)
  }
  const sixth = guard.after({ ok: false, error: 'ENOENT' })
  assert.equal(sixth.ok, false, '第 6 次真实失败应该熔断')
})

test('成功一次就把两个错误计数都清零', () => {
  const guard = createToolLoopGuard({ maxConsecutiveErrors: 6, maxAuthoringErrors: 20 })
  guard.after({ ok: false, error: 'boom' })
  guard.after({ ok: false, code: 'invalid_tool_arguments', error: 'bad' })
  guard.after({ ok: true, data: 'fine' })
  const snap = guard.snapshot()
  assert.equal(snap.consecutiveErrors, 0)
  assert.equal(snap.consecutiveAuthoringErrors, 0)
})

test('参数错误和执行失败交替出现时,两个计数器互不污染', () => {
  const guard = createToolLoopGuard({ maxConsecutiveErrors: 6, maxAuthoringErrors: 20 })
  // 5 次参数错 + 5 次执行失败,交替。任一计数器都没到阈值,不该熔断。
  for (let i = 0; i < 5; i += 1) {
    assert.equal(guard.after({ ok: false, code: 'invalid_tool_arguments' }).ok, true)
    assert.equal(guard.after({ ok: false, error: 'ENOENT' }).ok, true)
  }
  const snap = guard.snapshot()
  assert.equal(snap.consecutiveAuthoringErrors, 5)
  assert.equal(snap.consecutiveErrors, 5)
})

test('重复调用熔断不受影响', () => {
  const guard = createToolLoopGuard({ maxRepeatedCalls: 3 })
  const call = { name: 'read_file', args: { path: 'a.txt' } }
  for (let i = 0; i < 3; i += 1) {
    assert.equal(guard.before(call).ok, true)
  }
  const fourth = guard.before(call)
  assert.equal(fourth.ok, false)
  assert.equal(fourth.result.code, 'repeated_tool_call')
})

test('同一工具不断更换错误参数会触发分级策略提示而非低阈值熔断', () => {
  const guard = createToolLoopGuard({
    maxSameToolFailures: 20,
    maxConsecutiveErrors: 99,
    sameToolFailureAdvisoryThresholds: [3, 5, 8],
  })
  const advisories = []
  for (let index = 0; index < 8; index += 1) {
    const verdict = guard.afterCall(
      { name: 'read_file', args: { path: `missing-${index}.txt` } },
      { ok: false, error: 'ENOENT' },
    )
    assert.equal(verdict.ok, true)
    if (verdict.advisory) advisories.push(verdict.advisory)
  }
  assert.deepEqual(advisories.map((item) => item.level), [1, 2, 3])
  assert.deepEqual(advisories.map((item) => item.count), [3, 5, 8])
  assert.equal(advisories.every((item) => item.code === 'tool_failure_strategy_required'), true)
})

test('跨参数熔断不抢占小模型的参数自纠错预算且真实成功会重置计数', () => {
  const guard = createToolLoopGuard({
    maxSameToolFailures: 20,
    maxAuthoringErrors: 20,
    sameToolFailureAdvisoryThresholds: [2],
  })
  for (let index = 0; index < 10; index += 1) {
    assert.equal(guard.afterCall(
      { name: 'read_file', args: { path: `attempt-${index}` } },
      { ok: false, code: 'tool_arguments_validation_failed', error: 'bad path shape' },
    ).ok, true)
  }
  guard.afterCall({ name: 'read_file', args: { path: 'missing-a' } }, { ok: false, error: 'ENOENT' })
  assert.equal(
    guard.afterCall(
      { name: 'read_file', args: { path: 'missing-b' } },
      { ok: false, error: 'ENOENT' },
    ).advisory.level,
    1,
  )
  assert.equal(guard.afterCall({ name: 'read_file', args: { path: 'found.txt' } }, { ok: true, data: [] }).ok, true)
  assert.equal(guard.afterCall(
    { name: 'read_file', args: { path: 'missing-c' } },
    { ok: false, error: 'ENOENT' },
  ).ok, true, 'a successful result from the same tool must reset its stale failure count')
  assert.deepEqual(guard.snapshot().failedTools, { read_file: 1 })
  assert.deepEqual(guard.snapshot().pendingToolAdvisoryThresholds, {})
})

/* ------------------------------------------------------------------ *
 * 集成:预算耗尽 / 模型报错都不能空手而归
 * ------------------------------------------------------------------ */

const os = await import('node:os')
const path = await import('node:path')
process.env.APP_DATA_DIR = path.join(os.tmpdir(), 'yma-continuity-tests', String(process.pid))
const { runToolsLoop, SERVER_TOOL_SPECS } = await import('../server/services/jobTools.js')
const { attachJobBudget } = await import('../server/utils/jobBudget.js')

function fakeReadTool() {
  return async () => ({ ok: true, data: '文件内容' })
}

test('预算耗尽时必须给出收尾总结,绝不返回空文本', async () => {
  const job = { id: 'job-budget-wrapup', userId: null, title: 't', prompt: '读一堆文件' }
  // 把预算压到 2 次调用,保证很快耗尽
  attachJobBudget(job, { maxTotalCalls: 2, maxWallMs: 600_000 })

  let modelCalls = 0
  const runModel = async ({ toolChoice }) => {
    modelCalls += 1
    // 收尾调用(toolChoice: 'none')时给出总结
    if (toolChoice === 'none') {
      return { content: '我读了几个文件，进展是 A 和 B，还差 C。', toolCalls: [] }
    }
    // 其余轮次一直调工具,直到把预算烧光
    return {
      content: '',
      toolCalls: [{
        id: `call-${modelCalls}`,
        type: 'function',
        function: { name: 'read_file', arguments: JSON.stringify({ path: `f${modelCalls}.txt` }) },
      }],
    }
  }

  const result = await runToolsLoop({
    job,
    step: { id: 'step-budget', kind: 'execute' },
    messages: [{ role: 'user', content: '读一堆文件' }],
    runModel,
    executeTool: fakeReadTool(),
  })

  assert.equal(result.budgetExceeded, true, '应该确实是预算耗尽路径')
  assert.equal(result.incomplete, true)
  // ★ 这是整个批次最关键的一条断言:
  // 原实现在这条路径上直接 return finalText,而 finalText 必然是 '' ——
  // 用户看到「任务跑了很久然后一个字都没有」,即「做到一半没后续」。
  assert.ok(result.text && result.text.trim().length > 0, '预算耗尽也必须有文字交代')
  assert.match(result.text, /进展|预算/)
})

test('模型中途报错 → 降级成部分结果,不丢已完成的工具成果', async () => {
  const job = { id: 'job-degrade', userId: null, title: 't', prompt: '干活' }

  let modelCalls = 0
  const runModel = async () => {
    modelCalls += 1
    if (modelCalls === 1) {
      return {
        content: '',
        toolCalls: [{
          id: 'call-1',
          type: 'function',
          function: { name: 'read_file', arguments: JSON.stringify({ path: 'important.txt' }) },
        }],
      }
    }
    // 第二轮上游炸了 —— 原实现会 throw 掉整个 step,第一轮的成果全丢
    const error = new Error('Bad Request')
    error.status = 400
    throw error
  }

  const result = await runToolsLoop({
    job,
    step: { id: 'step-degrade', kind: 'execute' },
    messages: [{ role: 'user', content: '干活' }],
    runModel,
    executeTool: async () => ({ ok: true, data: '这是重要发现' }),
  })

  assert.equal(result.interrupted, true)
  assert.match(result.text, /任务中断/)
  // 第一轮工具查到的东西必须还在
  assert.match(result.text, /这是重要发现/)
})

test('第一轮就报错仍然向上抛 —— 没有任何成果时降级没有意义', async () => {
  const job = { id: 'job-fail-fast', userId: null, title: 't', prompt: '干活' }
  await assert.rejects(
    () => runToolsLoop({
      job,
      step: { id: 'step-fail-fast', kind: 'execute' },
      messages: [{ role: 'user', content: '干活' }],
      runModel: async () => { throw new Error('端点不可达') },
      executeTool: fakeReadTool(),
    }),
    /端点不可达/,
  )
})

test('用户主动取消不被降级吞掉 —— AbortError 必须继续上抛', async () => {
  const job = { id: 'job-abort', userId: null, title: 't', prompt: '干活' }
  let modelCalls = 0
  await assert.rejects(
    () => runToolsLoop({
      job,
      step: { id: 'step-abort', kind: 'execute' },
      messages: [{ role: 'user', content: '干活' }],
      runModel: async () => {
        modelCalls += 1
        if (modelCalls === 1) {
          return {
            content: '',
            toolCalls: [{
              id: 'c1',
              type: 'function',
              function: { name: 'read_file', arguments: JSON.stringify({ path: 'a.txt' }) },
            }],
          }
        }
        const err = new Error('aborted')
        err.name = 'AbortError'
        throw err
      },
      executeTool: fakeReadTool(),
    }),
    (error) => error.name === 'AbortError',
  )
})

test('托管附件优先使用本地读取且不暴露云盘发现或目录授权工具', async () => {
  const wantedNames = new Set(['read_file', 'request_directory', 'dropbox_list_files', 'google_drive_search'])
  const toolSpecs = SERVER_TOOL_SPECS.filter((item) => wantedNames.has(item?.function?.name))
  let observed
  const result = await runToolsLoop({
    job: {
      id: 'job-managed-attachment',
      userId: 'attachment-user',
      origin: 'chat',
      prompt: '分析我上传的报告',
      hasManagedAttachments: true,
      managedAttachments: [{ uri: 'attachment://report-id', name: 'report.pdf' }],
    },
    step: { id: 'step-managed-attachment', kind: 'chat' },
    messages: [{ role: 'user', content: '[GUGO_MANAGED_ATTACHMENT id="report-id" uri="attachment://report-id" name="report.pdf"]' }],
    toolSpecs,
    maxIters: 1,
    enableToolHooks: false,
    runModel: async (request) => {
      observed = request
      return { content: '已分析上传文件', toolCalls: [] }
    },
  })
  const names = observed.tools.map((item) => item.function.name)
  assert.ok(names.includes('read_file'))
  assert.equal(names.includes('request_directory'), false)
  assert.equal(names.includes('dropbox_list_files'), false)
  assert.equal(names.includes('google_drive_search'), false)
  assert.match(observed.messages.map((item) => item.content || '').join('\n'), /attachment:\/\/report-id/)
  assert.equal(result.text, '已分析上传文件')
})

test('编号步骤要求直接执行，且无工具证据时不能接受模型凭空声称完成', async () => {
  let observedMessages = []
  const result = await runToolsLoop({
    job: { id: 'job-direct-execution', userId: null, origin: 'chat', prompt: '1. 创建文件\n2. 写入内容\n3. 检查结果' },
    step: { id: 'step-direct-execution', kind: 'chat' },
    messages: [{ role: 'user', content: '1. 创建文件\n2. 写入内容\n3. 检查结果' }],
    toolSpecs: [],
    maxIters: 1,
    enableToolHooks: false,
    runModel: async ({ messages }) => {
      observedMessages = messages
      return { content: '已完成', toolCalls: [] }
    },
  })
  const systemText = observedMessages.filter((item) => item.role === 'system').map((item) => item.content).join('\n')
  assert.match(systemText, /\[DIRECT EXECUTION REQUIRED\]/)
  assert.match(systemText, /Do not merely print a script/)
  assert.equal(result.incomplete, true)
  assert.equal(result.reason, 'execution_evidence_missing')
  assert.match(result.text, /尚未完成|实际执行结果/)
})

test('同一工具低次数失败会收到策略提示并允许后续方案成功', async () => {
  const readFile = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'read_file')
  const listDirectory = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'list_directory')
  let modelCalls = 0
  let readAttempts = 0
  let alternateStrategySucceeded = false
  let advisorySeenByModel = false
  let advisoryCheckpointed = false
  const result = await runToolsLoop({
    job: { id: 'job-changing-arguments', userId: null, origin: 'chat', prompt: '读取目标文件' },
    step: { id: 'step-changing-arguments', kind: 'chat' },
    messages: [{ role: 'user', content: '读取目标文件' }],
    toolSpecs: [readFile, listDirectory],
    maxIters: 20,
    enableToolHooks: false,
    saveCheckpoint: async (checkpoint) => {
      const systemText = checkpoint.messages
        .filter((item) => item.role === 'system')
        .map((item) => item.content)
        .join('\n')
      if (systemText.includes('[TOOL FAILURE STRATEGY REQUIRED]')) {
        advisoryCheckpointed = true
      }
      return true
    },
    runModel: async ({ messages }) => {
      modelCalls += 1
      const systemText = messages
        .filter((item) => item.role === 'system')
        .map((item) => item.content)
        .join('\n')
      advisorySeenByModel ||= systemText.includes('[TOOL FAILURE STRATEGY REQUIRED]')
      if (alternateStrategySucceeded) {
        return { content: '已改用目录枚举并找到 target.txt。', toolCalls: [] }
      }
      if (advisorySeenByModel) {
        return {
          content: '',
          toolCalls: [{
            id: 'list-after-advisory',
            type: 'function',
            function: { name: 'list_directory', arguments: JSON.stringify({ path: '.' }) },
          }],
        }
      }
      return {
        content: '',
        toolCalls: [{
          id: `read-${modelCalls}`,
          type: 'function',
          function: { name: 'read_file', arguments: JSON.stringify({ path: `missing-${modelCalls}.txt` }) },
        }],
      }
    },
    executeTool: async ({ name }) => {
      if (name === 'list_directory') {
        alternateStrategySucceeded = true
        return { ok: true, data: ['target.txt'] }
      }
      readAttempts += 1
      return { ok: false, code: 'ENOENT', error: 'not found' }
    },
  })
  assert.equal(result.noProgress, undefined)
  assert.equal(result.incomplete, undefined)
  assert.equal(result.text, '已改用目录枚举并找到 target.txt。')
  assert.equal(readAttempts, 4)
  assert.equal(alternateStrategySucceeded, true)
  assert.equal(advisorySeenByModel, true)
  assert.equal(advisoryCheckpointed, true)
})

test('pending 策略提示在 checkpoint 中断后恢复且不会重放已完成工具', async () => {
  const readFile = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'read_file')
  const listDirectory = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'list_directory')
  const job = {
    id: 'job-advisory-checkpoint-resume',
    userId: null,
    origin: 'chat',
    prompt: '读取目标文件',
  }
  const step = { id: 'step-advisory-checkpoint-resume', kind: 'chat' }
  const messages = [{ role: 'user', content: '读取目标文件' }]
  let interruptedCheckpoint = null
  let initialModelCalls = 0
  let initialReadExecutions = 0

  await assert.rejects(
    runToolsLoop({
      job,
      step,
      messages,
      toolSpecs: [readFile, listDirectory],
      maxIters: 20,
      enableToolHooks: false,
      runModel: async () => {
        initialModelCalls += 1
        return {
          content: '',
          toolCalls: [{
            id: 'crash-read-' + initialModelCalls,
            type: 'function',
            function: {
              name: 'read_file',
              arguments: JSON.stringify({ path: 'missing-' + initialModelCalls + '.txt' }),
            },
          }],
        }
      },
      executeTool: async () => {
        initialReadExecutions += 1
        return { ok: false, code: 'ENOENT', error: 'not found' }
      },
      saveCheckpoint: async (checkpoint) => {
        const hasAdvisoryMessage = checkpoint.messages.some((item) => (
          item.role === 'system'
            && String(item.content || '').includes('[TOOL FAILURE STRATEGY REQUIRED]')
        ))
        if (checkpoint.loopGuard?.pendingToolAdvisoryThresholds?.read_file === 4
          && !hasAdvisoryMessage) {
          interruptedCheckpoint = JSON.parse(JSON.stringify(checkpoint))
          throw new Error('simulated advisory checkpoint interruption')
        }
        return true
      },
    }),
    /simulated advisory checkpoint interruption/,
  )

  assert.equal(initialReadExecutions, 4)
  assert.equal(interruptedCheckpoint.loopGuard.pendingToolAdvisoryThresholds.read_file, 4)
  assert.deepEqual(interruptedCheckpoint.loopGuard.firedToolAdvisoryThresholds, {})
  assert.equal(interruptedCheckpoint.toolCalls[0].checkpointStatus, 'completed')

  let resumedReadExecutions = 0
  let directoryExecutions = 0
  let maxAdvisoryMessagesSeen = 0
  let finalCheckpoint = null
  const result = await runToolsLoop({
    job: { ...job },
    step,
    messages,
    toolSpecs: [readFile, listDirectory],
    maxIters: 20,
    enableToolHooks: false,
    loadCheckpoint: async () => interruptedCheckpoint,
    saveCheckpoint: async (checkpoint) => {
      finalCheckpoint = JSON.parse(JSON.stringify(checkpoint))
      return true
    },
    runModel: async ({ messages: modelMessages }) => {
      const advisoryCount = modelMessages.filter((item) => (
        item.role === 'system'
          && String(item.content || '').includes('[TOOL FAILURE STRATEGY REQUIRED]')
      )).length
      maxAdvisoryMessagesSeen = Math.max(maxAdvisoryMessagesSeen, advisoryCount)
      if (directoryExecutions === 0) {
        return {
          content: '',
          toolCalls: [{
            id: 'resume-list',
            type: 'function',
            function: { name: 'list_directory', arguments: JSON.stringify({ path: '.' }) },
          }],
        }
      }
      return { content: '恢复后改用目录枚举并找到 target.txt。', toolCalls: [] }
    },
    executeTool: async ({ name }) => {
      if (name === 'read_file') {
        resumedReadExecutions += 1
        return { ok: false, code: 'ENOENT', error: 'must not replay' }
      }
      directoryExecutions += 1
      return { ok: true, data: ['target.txt'] }
    },
  })

  assert.equal(result.text, '恢复后改用目录枚举并找到 target.txt。')
  assert.equal(resumedReadExecutions, 0)
  assert.equal(directoryExecutions, 1)
  assert.equal(maxAdvisoryMessagesSeen, 1)
  assert.deepEqual(finalCheckpoint.loopGuard.firedToolAdvisoryThresholds, { read_file: 4 })
  assert.deepEqual(finalCheckpoint.loopGuard.pendingToolAdvisoryThresholds, {})
  assert.equal(finalCheckpoint.messages.filter((item) => (
    item.role === 'system'
      && String(item.content || '').includes('[TOOL FAILURE STRATEGY REQUIRED]')
  )).length, 1)
})

test('运行时在第 20 次同工具失败后保留硬上限机器码', async () => {
  const readFile = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'read_file')
  const job = {
    id: 'job-same-tool-hard-limit',
    userId: null,
    origin: 'chat',
    prompt: '读取目标文件',
  }
  let modelToolRounds = 0
  let executions = 0
  let finalCheckpointCode = null
  const result = await runToolsLoop({
    job,
    step: { id: 'step-same-tool-hard-limit', kind: 'chat' },
    messages: [{ role: 'user', content: '读取目标文件' }],
    toolSpecs: [readFile],
    maxIters: 25,
    enableToolHooks: false,
    saveCheckpoint: async (checkpoint) => {
      if (checkpoint.final?.code) finalCheckpointCode = checkpoint.final.code
      return true
    },
    runModel: async ({ toolChoice }) => {
      if (toolChoice === 'none') {
        return { content: '已达到工具失败硬上限。', toolCalls: [] }
      }
      modelToolRounds += 1
      return {
        content: '',
        toolCalls: [{
          id: 'hard-limit-read-' + modelToolRounds,
          type: 'function',
          function: {
            name: 'read_file',
            arguments: JSON.stringify({ path: 'missing-' + modelToolRounds + '.txt' }),
          },
        }],
      }
    },
    executeTool: async () => {
      executions += 1
      return { ok: false, code: 'ENOENT', error: 'not found' }
    },
  })

  assert.equal(executions, 20)
  assert.equal(modelToolRounds, 20)
  assert.equal(result.noProgress, true)
  assert.equal(result.code, 'tool_no_progress_hard_limit')
  assert.equal(finalCheckpointCode, 'tool_no_progress_hard_limit')
})
