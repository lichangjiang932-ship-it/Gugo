import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * 回归:子代理工具循环读错了 tool call 的字段名。
 *
 * 上游返回的是 OpenAI wire 形状 { id, type, function: { name, arguments: "<json>" } },
 * 而循环里直接读 tc.name / tc.arguments —— 两个都是 undefined。后果:
 *   1. 每次工具调用都以 undefined 派发 → 全部返回 unknown subagent tool: undefined
 *      (连 request_clarification 这种纯内存工具也失败)
 *   2. 回填给上游的 assistant 消息变成 function:{} → 下一轮上游 400
 *      → 异常冒到 runSubagent → 整个 "Agent · explore" 标记 failed
 *
 * jobTools.runToolsLoop 一直是对的,只有这条路径漏了归一化。
 */

process.env.APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-subcalls-'))
process.env.WORKSPACE_FS_ENABLED = '1'

const { getDb } = await import('../server/db.js')
const { grantLocalPath } = await import('../server/services/localFileAccessService.js')
const { SUBAGENT_TYPES, _testing } = await import('../server/services/subagentRuntime.js')

const USER = 'subcall-user'
const now = Date.now()
getDb().prepare('INSERT INTO users (id,email,created_at,updated_at) VALUES (?,?,?,?)')
  .run(USER, 'subcalls@example.com', now, now)

const project = fs.mkdtempSync(path.join(os.tmpdir(), 'subcall-proj-'))
fs.writeFileSync(path.join(project, 'package.json'), '{"name":"demo"}')
fs.writeFileSync(path.join(project, 'main.py'), 'import os\ndef main():\n    pass\n')
grantLocalPath({ userId: USER, rootPath: project, accessMode: 'read_only' })

/** 上游真实返回的形状 —— 名字和参数都在 function 里,arguments 是 JSON 字符串 */
function wireCall(name, args) {
  return {
    content: '',
    toolCalls: [{ id: `call-${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
  }
}

/** 跑一轮循环,把每次工具结果和回填的 assistant 消息都记下来 */
async function runLoop(script) {
  let step = 0
  const toolResults = []
  const echoes = []
  const callModel = async ({ messages }) => {
    const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant' && m.tool_calls)
    if (lastAssistant) {
      for (const tc of lastAssistant.tool_calls) echoes.push(tc)
    }
    const toolMsgs = messages.filter((m) => m.role === 'tool')
    while (toolResults.length < toolMsgs.length) {
      toolResults.push(JSON.parse(toolMsgs[toolResults.length].content))
    }
    return script[step++] || { content: '完成', toolCalls: [] }
  }
  const result = await _testing.subagentToolsLoop({
    messages: [
      { role: 'system', content: SUBAGENT_TYPES.explore.system },
      { role: 'user', content: `阅读 ${project}` },
    ],
    tools: SUBAGENT_TYPES.explore.tools,
    userId: USER,
    callModel,
  })
  return { result, text: result.text, toolResults, echoes }
}

test('★ 回归:wire 形状的 tool call 能正确派发,不再是 unknown tool: undefined', async () => {
  const { toolResults } = await runLoop([
    wireCall('read_file', { path: path.join(project, 'package.json') }),
  ])
  assert.equal(toolResults.length, 1)
  assert.notEqual(toolResults[0].ok, false, `read_file 应成功,实际: ${toolResults[0].error}`)
})

test('★ 回归:回填给上游的 assistant 消息必须带 name 和字符串 arguments', async () => {
  const { echoes } = await runLoop([
    wireCall('read_file', { path: path.join(project, 'package.json') }),
  ])
  assert.ok(echoes.length > 0, '应有回填的 assistant tool_calls')
  for (const tc of echoes) {
    // function:{} 会让下一轮上游直接 400,进而让整个 run 失败
    assert.ok(tc.function?.name, 'tool_call.function.name 不能为空')
    assert.equal(typeof tc.function?.arguments, 'string')
    assert.notEqual(tc.function.arguments, 'undefined', 'arguments 不能是字符串 "undefined"')
    assert.doesNotThrow(() => JSON.parse(tc.function.arguments), 'arguments 必须是合法 JSON')
  }
})

test('探索类子代理能用 list_directory(以前工具集里根本没有)', async () => {
  const names = SUBAGENT_TYPES.explore.tools.map((t) => t.function.name)
  assert.ok(names.includes('list_directory'), '探索一个陌生项目必须能先列目录')

  const { toolResults } = await runLoop([wireCall('list_directory', { path: project })])
  assert.notEqual(toolResults[0].ok, false, `list_directory 应成功,实际: ${toolResults[0].error}`)
})

test('grep_code 在已授权目录里可用', async () => {
  const { toolResults } = await runLoop([wireCall('grep_code', { pattern: 'import', path: project })])
  assert.notEqual(toolResults[0].ok, false, `grep_code 应成功,实际: ${toolResults[0].error}`)
})

test('request_clarification 是纯内存工具,任何情况下都不该失败', async () => {
  const { result, text } = await runLoop([wireCall('request_clarification', { question: '要看哪部分?' })])
  assert.equal(result.paused, true)
  assert.match(text, /需要澄清/, '应把澄清问题作为最终输出返回')
})

test('参数已是对象(非字符串)时也能处理', async () => {
  const { toolResults } = await runLoop([{
    content: '',
    toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: path.join(project, 'package.json') } }],
  }])
  assert.notEqual(toolResults[0].ok, false, '兼容非 wire 形状,不能只认一种')
})

test('上游中途失败时降级为部分结果,而不是整个 run 失败', async () => {
  let step = 0
  const callModel = async () => {
    step += 1
    if (step === 1) return wireCall('read_file', { path: path.join(project, 'package.json') })
    throw Object.assign(new Error('upstream 500'), { status: 500 })
  }
  const result = await _testing.subagentToolsLoop({
    messages: [{ role: 'user', content: 'x' }],
    tools: SUBAGENT_TYPES.explore.tools,
    userId: USER,
    callModel,
  })
  // 已经查到的东西必须留下来,不能整个丢掉
  assert.equal(result.interrupted, true)
  assert.match(result.text, /探索中断/)
  assert.match(result.text, /已经查到的信息/)
})

test('同一轮的独立只读工具最多 4 路并行,结果仍按调用顺序回填', async () => {
  let modelStep = 0
  let active = 0
  let maxActive = 0
  const seenResults = []
  const callModel = async ({ messages }) => {
    modelStep += 1
    if (modelStep === 1) {
      return {
        content: '',
        toolCalls: [
          { id: 'r1', function: { name: 'read_file', arguments: '{"path":"a"}' } },
          { id: 'r2', function: { name: 'read_file', arguments: '{"path":"b"}' } },
          { id: 'r3', function: { name: 'read_file', arguments: '{"path":"c"}' } },
        ],
      }
    }
    seenResults.push(...messages.filter((m) => m.role === 'tool').map((m) => JSON.parse(m.content).value))
    return { content: 'done', toolCalls: [] }
  }
  const executeTool = async (_name, args) => {
    active += 1
    maxActive = Math.max(maxActive, active)
    const delay = args.path === 'a' ? 30 : args.path === 'b' ? 10 : 1
    await new Promise((resolve) => setTimeout(resolve, delay))
    active -= 1
    return { ok: true, value: args.path }
  }

  const text = await _testing.subagentToolsLoop({
    messages: [{ role: 'user', content: 'parallel reads' }],
    tools: SUBAGENT_TYPES.explore.tools,
    userId: USER,
    callModel,
    executeTool,
  })
  assert.equal(text.text, 'done')
  assert.equal(maxActive, 3)
  assert.deepEqual(seenResults, ['a', 'b', 'c'])
})

test('含非只读工具的混合批次保持串行', async () => {
  let modelStep = 0
  let active = 0
  let maxActive = 0
  const callModel = async () => {
    modelStep += 1
    if (modelStep === 1) {
      return {
        content: '',
        toolCalls: [
          { id: 'm1', function: { name: 'read_file', arguments: '{"path":"a"}' } },
          { id: 'm2', function: { name: 'reflect', arguments: '{"observation":"x","next_step":"done"}' } },
        ],
      }
    }
    return { content: 'done', toolCalls: [] }
  }
  const executeTool = async () => {
    active += 1
    maxActive = Math.max(maxActive, active)
    await new Promise((resolve) => setTimeout(resolve, 5))
    active -= 1
    return { ok: true }
  }

  await _testing.subagentToolsLoop({
    messages: [{ role: 'user', content: 'mixed calls' }],
    tools: SUBAGENT_TYPES.general.tools,
    userId: USER,
    callModel,
    executeTool,
  })
  assert.equal(maxActive, 1)
})

test('每用户超过 8 个运行槽时排队而不是 429,且等待可中止', async () => {
  const limiterUser = `limiter-${Date.now()}`
  const leases = Array.from({ length: _testing.MAX_CONCURRENT_PER_USER }, () => _testing.createSlotLease(limiterUser))
  await Promise.all(leases.map((lease) => lease.acquire()))

  const ninth = _testing.createSlotLease(limiterUser)
  const ninthAcquired = ninth.acquire()
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.deepEqual(_testing.getLimiterSnapshot(limiterUser), { active: 8, queued: 1 })

  leases[0].release()
  await ninthAcquired
  assert.deepEqual(_testing.getLimiterSnapshot(limiterUser), { active: 8, queued: 0 })

  const controller = new AbortController()
  const cancelled = _testing.createSlotLease(limiterUser)
  const cancelledAcquire = cancelled.acquire(controller.signal)
  controller.abort()
  await assert.rejects(cancelledAcquire, { name: 'AbortError' })
  assert.deepEqual(_testing.getLimiterSnapshot(limiterUser), { active: 8, queued: 0 })

  for (const lease of leases) lease.release()
  ninth.release()
  assert.deepEqual(_testing.getLimiterSnapshot(limiterUser), { active: 0, queued: 0 })
})

test('父代理等待嵌套任务时归还运行槽,8 个父任务不会互相死锁', async () => {
  const limiterUser = `nested-${Date.now()}`
  const parents = Array.from({ length: _testing.MAX_CONCURRENT_PER_USER }, () => _testing.createSlotLease(limiterUser))
  await Promise.all(parents.map((lease) => lease.acquire()))

  const nested = Promise.all(parents.map((parent) => _testing.withYieldedSlot(parent, null, async () => {
    const child = _testing.createSlotLease(limiterUser)
    await child.acquire()
    child.release()
    return 'done'
  })))
  const results = await Promise.race([
    nested,
    new Promise((_, reject) => setTimeout(() => reject(new Error('nested slot handoff deadlocked')), 500)),
  ])
  assert.deepEqual(results, Array(8).fill('done'))
  assert.deepEqual(_testing.getLimiterSnapshot(limiterUser), { active: 8, queued: 0 })

  for (const lease of parents) lease.release()
  assert.deepEqual(_testing.getLimiterSnapshot(limiterUser), { active: 0, queued: 0 })
})

test('整棵子代理树沿用调用方传入的同一预算对象', async () => {
  const budget = {
    calls: 0,
    consume() {
      this.calls += 1
      return { ok: true }
    },
  }
  let modelStep = 0
  let observedBudget = null
  const result = await _testing.subagentToolsLoop({
    messages: [{ role: 'user', content: 'delegate' }],
    tools: SUBAGENT_TYPES.general.tools,
    userId: USER,
    budget,
    approveTool: async ({ args }) => ({ proceed: true, args }),
    callModel: async () => {
      modelStep += 1
      if (modelStep === 1) return wireCall('Agent', { prompt: 'child', subagent_type: 'general' })
      return { content: 'done', toolCalls: [] }
    },
    executeTool: async (_name, _args, options) => {
      observedBudget = options.budget
      return { ok: true }
    },
  })
  assert.equal(result.text, 'done')
  assert.equal(observedBudget, budget)
  assert.ok(budget.calls >= 1)
})

test('nested Agent calls inherit the selected skills through the subagent tool adapter', async () => {
  let modelStep = 0
  let nestedOptions = null
  const result = await _testing.subagentToolsLoop({
    messages: [{ role: 'user', content: 'delegate with the active skill' }],
    tools: SUBAGENT_TYPES.general.tools,
    userId: USER,
    skillIds: ['webpage', 'webpage'],
    skillDefinitions: [{
      id: 'webpage',
      name: 'Inline webpage',
      systemPrompt: 'Use the inherited webpage workflow.',
    }],
    approveTool: async ({ args }) => ({ proceed: true, args }),
    callModel: async () => {
      modelStep += 1
      if (modelStep === 1) return wireCall('Agent', { prompt: 'child', subagent_type: 'general' })
      return { content: 'done', toolCalls: [] }
    },
    executeTool: async (name, _args, options) => {
      assert.equal(name, 'Agent')
      nestedOptions = options
      return { ok: true }
    },
  })

  assert.equal(result.text, 'done')
  assert.deepEqual(nestedOptions?.skillIds, ['webpage'])
  assert.equal(nestedOptions?.skillDefinitions?.[0]?.id, 'webpage')
  assert.match(nestedOptions?.skillDefinitions?.[0]?.systemPrompt || '', /gugo-skill-quality:v1/)
})

test('审批只复用同一树内工具名和完整参数完全相同的人工批准', async () => {
  const context = (await import('../server/services/subagentRuntime.js')).createSubagentApprovalContext()
  let approvalRequests = 0
  const approveTool = async ({ args }) => {
    approvalRequests += 1
    return { proceed: true, args, approvalId: `approval-${approvalRequests}` }
  }
  const request = (args) => _testing.requestTreeApproval({
    context,
    approveTool,
    userId: USER,
    toolName: 'write_file',
    args,
  })

  const first = await request({ path: 'a.txt', content: 'same' })
  const repeated = await request({ content: 'same', path: 'a.txt' })
  await request({ path: 'a.txt', content: 'different' })
  assert.equal(first.reused, undefined)
  assert.equal(repeated.reused, true)
  assert.equal(approvalRequests, 2, '不同完整参数必须重新审批')
})

test('自动放行和编辑后的审批都不会进入子代理审批缓存', async () => {
  const { createSubagentApprovalContext } = await import('../server/services/subagentRuntime.js')
  for (const gate of [
    { proceed: true },
    { proceed: true, approvalId: 'edited-1', edited: true, args: { path: 'edited.txt' } },
  ]) {
    const context = createSubagentApprovalContext()
    let calls = 0
    const approveTool = async () => {
      calls += 1
      return gate
    }
    const options = {
      context,
      approveTool,
      userId: USER,
      toolName: 'write_file',
      args: { path: 'a.txt', content: 'x' },
    }
    await _testing.requestTreeApproval(options)
    await _testing.requestTreeApproval(options)
    assert.equal(calls, 2)
  }
})
