import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.APP_DATA_DIR = path.join(os.tmpdir(), 'yma-job-tools-tests', String(process.pid))

const { SERVER_TOOL_SPECS, runToolsLoop } = await import('../server/services/jobTools.js')
const {
  createDefaultExecuteStep,
  JobRuntime,
  runPlanningExploration,
  selectPlanningToolSpecs,
} = await import('../server/services/jobRuntime.js')
const { issueTestSession } = await import('./helpers/testAuth.js')
const { getDb } = await import('../server/db.js')

const TEST_USER = issueTestSession().userId

test('chat compaction uses the real session id and checkpoints its archive recovery', async () => {
  const sessionId = 'chat-compaction-real-session'
  const checkpoints = []
  const result = await runToolsLoop({
    job: {
      id: 'chat-compaction-turn',
      userId: TEST_USER,
      sessionId,
      origin: 'chat',
      title: 'Continue a long chat',
      prompt: 'Continue',
    },
    step: { id: 'chat-compaction-turn', kind: 'chat' },
    messages: Array.from({ length: 12 }, (_, index) => ({
      role: index % 2 ? 'assistant' : 'user',
      content: `long message ${index} ${'x'.repeat(400)}`,
    })),
    contextWindow: 512,
    toolSpecs: [],
    runModel: async ({ messages }) => ({
      content: messages.some((message) => /evidence digest|archived conversation/i.test(message?.content || ''))
        ? 'Compaction evidence digest.'
        : 'Done after compaction.',
      toolCalls: [],
    }),
    saveCheckpoint: async (state) => {
      checkpoints.push(structuredClone(state))
      return true
    },
  })

  assert.ok(result.recovery?.archiveId)
  assert.equal(checkpoints.at(-1).recovery.archiveId, result.recovery.archiveId)
  assert.equal(
    getDb().prepare('SELECT session_id FROM compaction_archive WHERE id = ?').get(result.recovery.archiveId).session_id,
    sessionId,
  )
})

test('SERVER_TOOL_SPECS exposes artifact, web, git mutation, and connected-app tools', () => {
  const names = SERVER_TOOL_SPECS.map((spec) => spec.function.name)
  for (const required of [
    'create_pptx',
    'create_docx',
    'create_xlsx',
    'web_search',
    'fetch_url',
    'git_commit',
    'git_push',
    'git_rollback',
    'connected_app_list',
    'notion_search',
    'github_get_file',
  ]) {
    assert.ok(names.includes(required), `${required} missing from SERVER_TOOL_SPECS`)
  }
  for (const spec of SERVER_TOOL_SPECS) {
    assert.equal(spec.type, 'function')
    assert.ok(spec.function.parameters, `${spec.function.name} missing parameters`)
  }
})

test('planning exploration runs three isolated read-only explorers concurrently and synthesizes their findings', async () => {
  const planningNames = selectPlanningToolSpecs('修复项目刷新').map((spec) => spec.function.name)
  assert.ok(planningNames.includes('grep_code'))
  assert.ok(planningNames.includes('read_file'))
  assert.equal(planningNames.includes('write_file'), false)
  assert.equal(planningNames.includes('bash_exec'), false)
  assert.equal(planningNames.some((name) => name.startsWith('browser_')), false)

  let rounds = 0
  let activeFirstPasses = 0
  let maxActiveFirstPasses = 0
  const executed = []
  const roles = new Set()
  let executionGuardSeen = false
  const exploration = await runPlanningExploration({
    prompt: '修复项目刷新',
    messages: [{ role: 'user', content: '先探索相关代码和验证入口' }],
    userId: TEST_USER,
    runModelWithTools: async ({ messages }) => {
      rounds += 1
      executionGuardSeen ||= messages.some((message) => (
        message.role === 'system' && message.content.includes('[DIRECT EXECUTION REQUIRED]')
      ))
      const toolResult = messages.find((message) => message.role === 'tool')
      if (!toolResult) {
        const rolePrompt = messages.find((message) => message.role === 'system' && message.content.includes('planning swarm'))?.content || ''
        roles.add(rolePrompt)
        activeFirstPasses += 1
        maxActiveFirstPasses = Math.max(maxActiveFirstPasses, activeFirstPasses)
        await new Promise((resolve) => setImmediate(resolve))
        activeFirstPasses -= 1
        return {
          content: '',
          toolCalls: [{ id: 'explore-1', name: 'grep_code', arguments: JSON.stringify({ pattern: 'refresh' }) }],
        }
      }
      return { content: `已探索：${toolResult.content}`, toolCalls: [] }
    },
    executeTool: async ({ name, args }) => {
      executed.push({ name, args })
      return { ok: true, matches: ['src/router.js:10'] }
    },
    synthesizeModel: async ({ messages }) => {
      const payload = JSON.parse(messages.at(-1).content)
      assert.equal(payload.findings.length, 3)
      assert.equal(new Set(payload.findings.map((item) => item.transcriptRef)).size, 3)
      return payload.findings.map((item) => item.text).join('\n')
    },
  })
  assert.equal(rounds, 6)
  assert.equal(executionGuardSeen, false)
  assert.equal(roles.size, 3)
  assert.ok(maxActiveFirstPasses > 1)
  assert.deepEqual(executed, Array.from({ length: 3 }, () => ({
    name: 'grep_code',
    args: { pattern: 'refresh', case_sensitive: false, word: false, max_results: 50 },
  })))
  assert.match(exploration, /src\\?\/router\.js|src\/router\.js/)
})

test('runToolsLoop re-evaluates artifact intent from current user messages even with explicit tool specs', async () => {
  let visibleNames = []
  let modelCalls = 0
  const result = await runToolsLoop({
    job: { id: 'job-dynamic-intent', userId: TEST_USER, title: '整理讨论', prompt: '整理刚才的讨论' },
    step: { id: 'step-dynamic-intent', kind: 'execute' },
    messages: [{ role: 'user', content: '现在把它整理成 Word 文档' }],
    toolSpecs: SERVER_TOOL_SPECS,
    runModel: async ({ tools }) => {
      modelCalls += 1
      visibleNames = tools.map((spec) => spec.function.name)
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [{
            id: 'dynamic-docx',
            function: {
              name: 'create_docx',
              arguments: JSON.stringify({ title: '讨论整理', paragraphs: [{ text: '结论' }] }),
            },
          }],
        }
      }
      return { content: 'Word 文档已生成。', toolCalls: [] }
    },
    requestToolApproval: async ({ args }) => ({ proceed: true, args }),
    enableToolHooks: false,
    executeTool: async () => ({
      ok: true,
      artifactId: 'dynamic-docx-artifact',
      filename: '讨论整理.docx',
      url: '/api/artifacts/dynamic-docx-artifact',
    }),
  })
  assert.ok(visibleNames.includes('create_docx'))
  assert.equal(visibleNames.includes('create_pptx'), false)
  assert.deepEqual(result.artifactIds, ['dynamic-docx-artifact'])
})

test('chat directory review reads representative files before accepting a filename-only final', async () => {
  const listing = JSON.stringify({
    ok: true,
    path: 'D:\\demo',
    entries: [
      { name: '.env', type: 'file' },
      { name: 'dashboard.py', type: 'file' },
      { name: 'MANUAL.md', type: 'file' },
      { name: 'README.md', type: 'file' },
      { name: 'package.json', type: 'file' },
      { name: 'main.py', type: 'file' },
      { name: 'logo.png', type: 'file' },
    ],
  })
  const prompt = [
    '[VERIFIED LOCAL FILESYSTEM ACCESS]',
    'Path: D:\\demo',
    'Tool: list_directory',
    'Succeeded: yes',
    listing,
  ].join('\n')
  let modelCalls = 0
  const executed = []
  const completedModelText = []

  const result = await runToolsLoop({
    job: {
      id: 'directory-review-turn',
      userId: TEST_USER,
      origin: 'chat',
      sessionId: 'directory-review-session',
      prompt,
      userPrompt: 'Read and understand D:\\demo as a project',
    },
    step: { id: 'directory-review-turn', kind: 'chat' },
    messages: [{ role: 'user', content: prompt }],
    maxIters: 4,
    runModel: async ({ messages }) => {
      modelCalls += 1
      assert.equal(messages.filter((message) => message.role === 'tool' && message.name === 'read_file').length, 3)
      return { content: 'Grounded in representative file contents.', toolCalls: [] }
    },
    executeTool: async ({ name, args }) => {
      executed.push({ name, path: args.path })
      return { ok: true, path: args.path, content: `contents of ${args.path}` }
    },
    onModelPhase: async ({ phase, content }) => {
      if (phase === 'completed') completedModelText.push(content)
    },
  })

  assert.equal(result.text, 'Grounded in representative file contents.')
  assert.equal(modelCalls, 1)
  assert.deepEqual(executed, [
    { name: 'read_file', path: 'D:\\demo\\README.md' },
    { name: 'read_file', path: 'D:\\demo\\package.json' },
    { name: 'read_file', path: 'D:\\demo\\main.py' },
  ])
  assert.deepEqual(completedModelText, ['Grounded in representative file contents.'])
})

test('chat directory listing request does not trigger representative project reads', async () => {
  const listing = JSON.stringify({
    ok: true,
    path: 'D:\\demo',
    entries: [{ name: 'README.md', type: 'file' }],
  })
  let modelCalls = 0
  let executeCalls = 0
  const result = await runToolsLoop({
    job: {
      id: 'directory-list-turn',
      userId: TEST_USER,
      origin: 'chat',
      sessionId: 'directory-list-session',
      prompt: `Path: D:\\demo\nTool: list_directory\nSucceeded: yes\n${listing}`,
      userPrompt: 'List the files in D:\\demo',
    },
    step: { id: 'directory-list-turn', kind: 'chat' },
    messages: [{ role: 'user', content: 'List the files in D:\\demo' }],
    runModel: async () => {
      modelCalls += 1
      return { content: 'Here is the directory listing.', toolCalls: [] }
    },
    executeTool: async () => {
      executeCalls += 1
      return { ok: true }
    },
  })

  assert.equal(result.text, 'Here is the directory listing.')
  assert.equal(modelCalls, 1)
  assert.equal(executeCalls, 0)
})

test('runToolsLoop does not carry artifact intent over from older user history', async () => {
  let visibleNames = []
  await runToolsLoop({
    job: { id: 'job-current-intent', userId: TEST_USER, title: '修复代码', prompt: '修复当前代码问题' },
    step: { id: 'step-current-intent', kind: 'execute' },
    messages: [
      { role: 'user', content: '先生成一份产品发布 PPT' },
      { role: 'assistant', content: 'PPT 已完成。' },
      { role: 'user', content: '现在只修复登录页的空指针错误' },
    ],
    toolSpecs: SERVER_TOOL_SPECS,
    runModel: async ({ tools }) => {
      visibleNames = tools.map((spec) => spec.function.name)
      return { content: '已修复。', toolCalls: [] }
    },
  })

  assert.equal(visibleNames.includes('create_pptx'), false)
  assert.equal(visibleNames.includes('create_docx'), false)
  assert.equal(visibleNames.includes('create_xlsx'), false)
})

test('runToolsLoop calls create_docx once, persists artifact, returns final text', async () => {
  let modelInvocations = 0
  const runModel = async () => {
    modelInvocations += 1
    if (modelInvocations === 1) {
      return {
        content: '',
        toolCalls: [{
          id: 'call-1',
          type: 'function',
          function: {
            name: 'create_docx',
            arguments: JSON.stringify({
              title: '会议纪要',
              paragraphs: [{ heading: 1, text: '今天我们讨论了' }],
            }),
          },
        }],
      }
    }
    return { content: '已生成会议纪要文档。', toolCalls: [] }
  }

  // 用注入的 executeTool 避开 jobStore FK 约束(测试 job 没入库)
  const calls = []
  const fakeExecute = async ({ name, args }) => {
    calls.push({ name, args })
    return { ok: true, artifactId: `art-fake-${calls.length}`, filename: 'result.docx', url: '/api/artifacts/result.docx' }
  }

  const job = { id: 'job-tools-1', userId: TEST_USER, title: '会议纪要' }
  const step = { id: 'step-1', kind: 'execute' }
  const result = await runToolsLoop({
    job,
    step,
    messages: [{ role: 'user', content: '把这次会议整理成 Word 文档' }],
    runModel,
    executeTool: fakeExecute,
  })

  assert.equal(modelInvocations, 2, 'should iterate exactly twice (tool call + final reply)')
  assert.equal(result.text, '已生成会议纪要文档。')
  assert.equal(result.artifactIds.length, 1)
  assert.equal(result.artifactIds[0], 'art-fake-1')
  assert.equal(calls[0].name, 'create_docx')
  assert.equal(calls[0].args.title, '会议纪要')
})

test('runToolsLoop stops at maxIters when model keeps calling tools', async () => {
  let calls = 0
  const runModel = async () => {
    calls += 1
    return {
      content: '',
      toolCalls: [{
        id: `call-${calls}`,
        type: 'function',
        function: { name: 'create_docx', arguments: JSON.stringify({ title: `T${calls}`, paragraphs: [{ text: 'x' }] }) },
      }],
    }
  }
  let execCount = 0
  const fakeExecute = async () => {
    execCount += 1
    return { ok: true, artifactId: `art-${execCount}` }
  }

  const job = { id: 'job-tools-2', userId: TEST_USER, title: 'runaway' }
  const step = { id: 'step-2', kind: 'execute' }
  const result = await runToolsLoop({
    job,
    step,
    messages: [{ role: 'user', content: '反复生成 Word 文档 loop' }],
    runModel,
    executeTool: fakeExecute,
    maxIters: 3,
  })

  assert.equal(calls, 4, '3 轮工具调用 + 1 次收尾总结')
  assert.equal(result.artifactIds.length, 3, '工具调用仍严格封顶在 maxIters')
  // ★ 到达上限后不再静默返回空文本 —— 必须给用户一个交代
  assert.ok(result.text, '达到迭代上限时应有收尾说明,不能是空字符串')
})

test('runToolsLoop rejects malformed artifact args without executing or claiming delivery', async () => {
  let calls = 0
  let toolResult = null
  const runModel = async ({ messages }) => {
    calls += 1
    if (calls === 1) {
      return {
        content: '',
        toolCalls: [{ id: 'c1', type: 'function', function: { name: 'create_pptx', arguments: '{not json' } }],
      }
    }
    toolResult = messages.find((message) => message.role === 'tool') || null
    return { content: 'done', toolCalls: [] }
  }
  const job = { id: 'job-tools-3', userId: TEST_USER, title: 'bad args' }
  const step = { id: 'step-3', kind: 'execute' }
  let executeCount = 0
  await assert.rejects(
    runToolsLoop({
      job, step,
      messages: [{ role: 'user', content: '请生成一个测试用 pptx' }],
      runModel,
      maxIters: 2,
      executeTool: async () => {
        executeCount += 1
        return { ok: true }
      },
    }),
    (error) => error?.code === 'ARTIFACT_NOT_CREATED',
  )
  assert.equal(executeCount, 0, '损坏参数绝不能静默变成 {} 后落到执行器')
  assert.equal(JSON.parse(toolResult.content).code, 'invalid_tool_arguments')
})

test('job tool loop can execute connected_app_list with the job owner', async () => {
  let calls = 0
  let toolResult = null
  const result = await runToolsLoop({
    job: { id: 'job-connectors', userId: TEST_USER },
    step: { id: 'step-connectors' },
    messages: [{ role: 'user', content: '列出已连接应用' }],
    runModel: async ({ messages }) => {
      calls += 1
      if (calls === 1) {
        return { content: '', toolCalls: [{ id: 'apps-1', name: 'connected_app_list', arguments: '{}' }] }
      }
      toolResult = messages.find((message) => message.role === 'tool')?.content || ''
      return { content: '已检查连接应用。', toolCalls: [] }
    },
  })
  assert.equal(result.text, '已检查连接应用。')
  assert.match(toolResult, /"ok":true/)
})

test('runToolsLoop 为缺失 id 的调用生成 id,并让结果严格配对', async () => {
  let assistantCallId = null
  let resultCallId = null
  let invocations = 0
  const result = await runToolsLoop({
    job: { id: 'job-id-repair', userId: TEST_USER, title: 'id repair' },
    step: { id: 'step-id-repair', kind: 'execute' },
    messages: [{ role: 'user', content: 'read' }],
    runModel: async ({ messages }) => {
      invocations += 1
      if (invocations === 1) {
        return { content: '', toolCalls: [{ name: 'read_file', arguments: { path: 'README.md' } }] }
      }
      assistantCallId = messages.find((message) => message.role === 'assistant' && message.tool_calls)?.tool_calls[0]?.id
      resultCallId = messages.find((message) => message.role === 'tool')?.tool_call_id
      return { content: 'done', toolCalls: [] }
    },
    executeTool: async () => ({ ok: true, content: 'ok' }),
  })

  assert.equal(result.text, 'done')
  assert.ok(assistantCallId)
  assert.equal(resultCallId, assistantCallId)
})

test('jobRuntime end-to-end: model calling create_pptx persists artifact under job.userId', async () => {
  let executeCalls = 0
  const runtime = new JobRuntime({
    executeStep: createDefaultExecuteStep({
      runModelWithTools: async ({ messages }) => {
        executeCalls += 1
        // 只在 execute step 第一次调用时返回 tool_call,之后立刻收尾
        const userMsg = messages.find((m) => m.role === 'user')?.content || ''
        if (userMsg.includes('PPT') && executeCalls === 1) {
          return {
            content: '',
            toolCalls: [{
              id: 'c1', type: 'function',
              function: {
                name: 'create_pptx',
                arguments: JSON.stringify({
                  title: '季度汇报',
                  slides: [{ title: 'Q3 概览', bullets: ['增长 12%', 'NPS +8'] }],
                }),
              },
            }],
          }
        }
        return { content: '已生成 PPT。', toolCalls: [] }
      },
    }),
  })

  const job = await runtime.createJob('做一份 PPT 汇报', { userId: TEST_USER })
  await runtime.drain()
  const loaded = runtime.getJob(job.id, { userId: TEST_USER })

  assert.equal(loaded.status, 'completed')
  // execute step + finalize step 各 1 个 artifact(execute 的 pptx + finalize 的 docx 汇总)
  assert.ok(loaded.artifacts.length >= 1, 'should produce at least one artifact')
  const pptx = loaded.artifacts.find((a) => a.filename?.endsWith('.pptx'))
  assert.ok(pptx, 'should have pptx artifact')
  assert.equal(pptx.userId, TEST_USER, 'artifact should be owned by job.userId')
})

// ───────────────── Harness 修复:工具集 / 截断 / 步骤间上下文 ─────────────────

test('manage_todos 在 job 循环的工具集里(system prompt 让调它,以前却不存在)', () => {
  const names = SERVER_TOOL_SPECS.map((s) => s.function.name)
  assert.ok(names.includes('manage_todos'), 'system prompt 指示模型调 manage_todos,工具集必须提供它')
  // 所有 spec 结构合法,避免 getBuiltinSpec 拿到 undefined 混进去
  for (const spec of SERVER_TOOL_SPECS) {
    assert.equal(spec.type, 'function')
    assert.ok(spec.function?.name, 'spec 必须有名字')
    assert.ok(spec.function?.parameters, `${spec.function.name} 缺 parameters`)
  }
})

test('manage_todos 可被真实调用并回执进度(不再是 unknown tool)', async () => {
  const runModel = async ({ messages }) => {
    const called = messages.some((m) => m.role === 'tool' && m.name === 'manage_todos')
    if (called) return { content: '计划已记录。', toolCalls: [] }
    return {
      content: '',
      toolCalls: [{
        id: 'call-todo',
        type: 'function',
        function: {
          name: 'manage_todos',
          arguments: JSON.stringify({
            todos: [
              { content: '收集数据', status: 'completed', activeForm: '正在收集数据' },
              { content: '生成报告', status: 'in_progress', activeForm: '正在生成报告' },
            ],
          }),
        },
      }],
    }
  }

  const job = { id: 'job-todos', userId: TEST_USER, title: 'todos' }
  const step = { id: 'step-todos', kind: 'execute' }
  const result = await runToolsLoop({
    job,
    step,
    messages: [{ role: 'user', content: '做个多步任务' }],
    runModel,
    maxIters: 3,
  })
  assert.equal(result.text, '计划已记录。')
})

test('工具输出截断后仍是合法 JSON,且显式标注被截断', async () => {
  const huge = 'x'.repeat(50_000)
  let toolMessage = null
  const runModel = async ({ messages }) => {
    const found = messages.find((m) => m.role === 'tool')
    if (found) {
      toolMessage = found
      return { content: '收到。', toolCalls: [] }
    }
    return {
      content: '',
      toolCalls: [{
        id: 'call-big',
        type: 'function',
        function: { name: 'read_file', arguments: JSON.stringify({ path: 'big.txt' }) },
      }],
    }
  }
  const fakeExecute = async () => ({ ok: true, content: huge })

  await runToolsLoop({
    job: { id: 'job-clip', userId: TEST_USER, title: 'clip' },
    step: { id: 'step-clip', kind: 'execute' },
    messages: [{ role: 'user', content: '读个大文件' }],
    runModel,
    executeTool: fakeExecute,
    maxIters: 3,
  })

  assert.ok(toolMessage, '应有工具结果回填进对话')
  // ★ 关键:以前是 JSON.stringify 后直接 slice,会把 JSON 从中间切断
  let parsed
  assert.doesNotThrow(() => { parsed = JSON.parse(toolMessage.content) }, '截断后必须仍是合法 JSON')
  assert.equal(parsed._truncated, true, '必须显式告诉模型内容被省略了')
})
