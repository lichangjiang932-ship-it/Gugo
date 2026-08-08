import assert from 'node:assert/strict'
import test from 'node:test'
import {
  allowedArtifactTools,
  detectArtifactIntent,
  expectsFileArtifact,
  isFileArtifactTool,
  parseSkillIdFromPrompt,
} from '../server/services/artifactIntent.js'
import { runToolsLoop, SERVER_TOOL_SPECS, selectJobToolSpecs } from '../server/services/jobTools.js'
import { buildFinalOutput, shouldCompileDocx } from '../server/services/jobWorkflow.js'

const nameOf = (specs) => specs.map((s) => s?.function?.name)

// ── 事故回归:代码任务不该看得见 create_pptx ────────────────────────────

test('code task cannot even see file-artifact tools', () => {
  const specs = selectJobToolSpecs({ prompt: '修复量化交易平台页面刷新时数据丢失的 bug' })
  const names = nameOf(specs)
  assert.ok(!names.includes('create_pptx'), 'create_pptx 必须对代码任务不可见')
  assert.ok(!names.includes('create_docx'))
  assert.ok(!names.includes('create_xlsx'))
  assert.ok(!names.includes('create_html_app'))
  // 非文件类工具一个都不能被误伤
  const nonArtifact = nameOf(SERVER_TOOL_SPECS).filter((n) => !isFileArtifactTool(n))
  for (const n of nonArtifact) assert.ok(names.includes(n), `${n} 被误过滤`)
})

test('ordinary model discussion cannot see docx or pptx tools', () => {
  const names = nameOf(selectJobToolSpecs({
    prompt: '为什么云端模型可以，你是我的本地模型好不好',
  }))
  assert.equal(names.includes('create_docx'), false)
  assert.equal(names.includes('create_pptx'), false)
  assert.equal(names.includes('create_xlsx'), false)
})

test('explicit ppt request unlocks only create_pptx', () => {
  const names = nameOf(selectJobToolSpecs({ prompt: '帮我做一个关于新能源行业的 PPT' }))
  assert.ok(names.includes('create_pptx'))
  assert.ok(!names.includes('create_xlsx'))
})

test('ppt-family skill prefixes unlock create_pptx even without artifact nouns', () => {
  // S6 回归：/ppt-master 做演示 没有 "PPT/幻灯片" 关键词，但技能前缀必须解锁
  for (const prompt of [
    '/ppt-master 做演示',
    '/axippt 帮我做科技风演示',
    '/htmlppt 生成网页',
    '/guizang-ppt 做分享',
  ]) {
    assert.equal(detectArtifactIntent(prompt).pptx, true, prompt)
    assert.equal(detectArtifactIntent(prompt).docx, false, prompt)
  }
  // 非文件类技能前缀不得解锁
  assert.equal(detectArtifactIntent('/connector-operator 帮我查 GitHub').pptx, false)
})

test('negative and diagnostic PPT mentions never authorize PPT generation', () => {
  for (const prompt of [
    '不要生成 PPT，只在聊天里回答',
    '修复自动生成 PPT 的问题',
    '为什么它会突然变成幻灯片？',
    '我没有让他生成，他自动生成了 pptx 文件',
    '还有在生成幻灯片.pptx文件，我没有让他生成，他自动生成，你深入解读代码，彻底修复',
    '确保不会随意生成幻灯片了',
    '检查 create_pptx 工具为什么被调用',
    'do not create a ppt',
    'fix automatic slide generation',
  ]) {
    const intent = detectArtifactIntent(prompt)
    assert.equal(intent.pptx, false, prompt)
    assert.equal(allowedArtifactTools(prompt).has('create_pptx'), false, prompt)
  }
})

test('explicit production wording still authorizes PPT generation', () => {
  for (const prompt of [
    '帮我做一个关于新能源行业的 PPT',
    '给我一份路演稿',
    'make a 5 page product intro ppt',
    '/ppt 讲讲量子计算',
  ]) {
    assert.equal(detectArtifactIntent(prompt).pptx, true, prompt)
  }
})

test('explicit document wording authorizes DOCX without weakening negative guards', () => {
  for (const prompt of [
    '导出测试文档',
    '整理会议纪要并导出',
    '写个 Word',
    '编写一份周报',
  ]) {
    assert.equal(detectArtifactIntent(prompt).docx, true, prompt)
  }
  for (const prompt of [
    '不要生成文档，只在聊天里回答',
    '修复自动生成报告的问题',
    '检查 create_docx 工具为什么被调用',
  ]) {
    assert.equal(detectArtifactIntent(prompt).docx, false, prompt)
  }
})

test('slash skill unlocks its matching artifact tool', () => {
  assert.equal(parseSkillIdFromPrompt('/ppt 讲讲量子计算'), 'ppt')
  for (const alias of ['htmlppt', 'axippt', 'ppt-master', 'guizang-ppt']) {
    assert.equal(parseSkillIdFromPrompt(`/${alias} 做演示`), 'ppt')
  }
  const names = nameOf(selectJobToolSpecs({ prompt: '/excel 汇总季度数据', skillId: 'excel' }))
  assert.ok(names.includes('create_xlsx'))
  assert.ok(!names.includes('create_pptx'))

  const webpageNames = nameOf(selectJobToolSpecs({
    prompt: '/webpage 帮我生成一个网页来介绍本地模型',
    skillId: 'webpage',
  }))
  assert.ok(webpageNames.includes('create_html_app'))
  assert.ok(!webpageNames.includes('create_pptx'))
})

test('text tool protocol from a local model becomes a real webpage artifact call', async () => {
  const deltas = []
  const executions = []
  let modelCalls = 0
  const result = await runToolsLoop({
    job: { id: 'webpage-text-protocol', userId: 'intent-user', origin: 'chat', prompt: '/webpage 帮我生成一个网页' },
    step: { id: 'webpage-text-protocol', kind: 'chat' },
    messages: [{ role: 'user', content: '/webpage 帮我生成一个网页' }],
    skillId: 'webpage',
    toolSpecs: SERVER_TOOL_SPECS,
    enableToolHooks: false,
    requestToolApproval: async ({ args }) => ({ proceed: true, args }),
    onModelDelta: async ({ text }) => deltas.push(text),
    executeTool: async ({ name, args }) => {
      executions.push({ name, args })
      return { ok: true, artifactId: 'html-artifact-1', filename: 'local-model.html', url: '/api/artifacts/local-model.html' }
    },
    runModel: async ({ messages }) => {
      modelCalls += 1
      if (modelCalls === 1) {
        return {
          content: '<tool_call>{"name":"create_html_app","arguments":{"title":"本地模型","html":"<!doctype html><html><body><main>完成</main></body></html>"}}</tool_call>',
          toolCalls: [],
        }
      }
      assert.ok(messages.some((message) => message.role === 'tool' && message.name === 'create_html_app'))
      return { content: '网页已生成。', toolCalls: [] }
    },
  })

  assert.equal(executions.length, 1)
  assert.equal(executions[0].name, 'create_html_app')
  assert.match(executions[0].args.html, /<main>完成<\/main>/)
  assert.deepEqual(result.artifactIds, ['html-artifact-1'])
  assert.equal(result.text, '网页已生成。')
  assert.equal(deltas.join('').includes('<tool_call>'), false)
})

test('text tool protocol ids stay unique across model iterations', async () => {
  const executions = []
  let modelCalls = 0
  const result = await runToolsLoop({
    job: { id: 'local-text-turn', userId: 'intent-user', origin: 'chat', prompt: '搜索两次并总结' },
    step: { id: 'local-text-step', kind: 'chat' },
    messages: [{ role: 'user', content: '搜索两次并总结' }],
    toolSpecs: SERVER_TOOL_SPECS,
    enableToolHooks: false,
    requestToolApproval: async ({ args }) => ({ proceed: true, args }),
    executeTool: async ({ name, args, toolCallId, idempotencyKey }) => {
      executions.push({ name, args, toolCallId, idempotencyKey })
      return { ok: true, results: [] }
    },
    runModel: async () => {
      modelCalls += 1
      if (modelCalls <= 2) {
        return {
          content: `<tool_call>{"name":"web_search","arguments":{"query":"round-${modelCalls}"}}</tool_call>`,
          toolCalls: [],
        }
      }
      return { content: '两轮搜索均已完成。', toolCalls: [] }
    },
  })

  assert.equal(result.text, '两轮搜索均已完成。')
  assert.equal(executions.length, 2)
  assert.deepEqual(executions.map((entry) => entry.toolCallId), [
    'text-tool-local-text-turn-i1-c1',
    'text-tool-local-text-turn-i2-c1',
  ])
  assert.equal(new Set(executions.map((entry) => entry.idempotencyKey)).size, 2)
  assert.match(executions[0].idempotencyKey, /text-tool-local-text-turn-i1-c1$/)
  assert.match(executions[1].idempotencyKey, /text-tool-local-text-turn-i2-c1$/)
})

test('environment flags cannot disable the artifact safety gate', () => {
  const prev = process.env.JOB_ARTIFACT_TOOL_GATE
  process.env.JOB_ARTIFACT_TOOL_GATE = 'off'
  try {
    const names = nameOf(selectJobToolSpecs({ prompt: '修一个 bug' }))
    assert.equal(names.includes('create_pptx'), false)
    assert.equal(names.includes('create_docx'), false)
    assert.equal(names.includes('create_xlsx'), false)
  } finally {
    if (prev === undefined) delete process.env.JOB_ARTIFACT_TOOL_GATE
    else process.env.JOB_ARTIFACT_TOOL_GATE = prev
  }
})

test('hallucinated PPT calls are rejected before any executor runs', async () => {
  let modelCalls = 0
  let executorCalls = 0
  let toolResult
  await runToolsLoop({
    job: { id: 'no-ppt', userId: 'intent-user', prompt: '修复自动生成 PPT 的问题' },
    step: { id: 'no-ppt-step' },
    messages: [{ role: 'user', content: '不要生成 PPT，只修复问题' }],
    toolSpecs: SERVER_TOOL_SPECS,
    runModel: async ({ messages }) => {
      modelCalls += 1
      if (modelCalls === 1) {
        return { content: '', toolCalls: [{ id: 'bad-ppt', name: 'create_pptx', arguments: '{"title":"wrong","slides":[]}' }] }
      }
      toolResult = messages.find((message) => message.role === 'tool')
      return { content: '已拒绝未授权产物并继续处理原任务。', toolCalls: [] }
    },
    executeTool: async () => {
      executorCalls += 1
      return { ok: true }
    },
  })
  assert.equal(executorCalls, 0)
  assert.equal(JSON.parse(toolResult.content).code, 'artifact_tool_not_requested')
})

// ── 意图判定 ─────────────────────────────────────────────────────────

test('ppt intent suppresses the looser docx keywords', () => {
  const intent = detectArtifactIntent('生成 PPT 并导出')
  assert.equal(intent.pptx, true)
  assert.equal(intent.docx, false, '「导出」不该在已有 pptx 意图时再触发 docx')
  assert.equal(shouldCompileDocx('生成 PPT 并导出'), false)
})

test('artifact expectation is false for plain code work', () => {
  assert.equal(expectsFileArtifact('把登录接口的 500 错误修掉'), false)
  assert.equal(allowedArtifactTools('把登录接口的 500 错误修掉').size, 0)
})

test('prebuilt tool specs do not short-circuit intent re-evaluation', async () => {
  let visibleNames = []
  await runToolsLoop({
    job: { id: 'intent-recheck', userId: 'intent-user', prompt: '先分析数据' },
    step: { id: 'intent-step' },
    messages: [{ role: 'user', content: '改为整理成 Word 文档并下载' }],
    toolSpecs: SERVER_TOOL_SPECS,
    runModel: async ({ tools }) => {
      visibleNames = nameOf(tools)
      return { content: 'done', toolCalls: [] }
    },
  })
  assert.ok(visibleNames.includes('create_docx'))
  assert.ok(!visibleNames.includes('create_pptx'))
})

// ── finalize 三源对账 ────────────────────────────────────────────────

test('final output flags failed steps instead of claiming success', () => {
  const output = buildFinalOutput({
    prompt: '修复刷新 bug',
    steps: [
      { kind: 'execute', status: 'completed', output: { text: '改了 store' } },
      { kind: 'execute', status: 'failed', title: '重启服务', output: { text: '' } },
    ],
  })
  assert.equal(output.complete, false)
  assert.ok(output.issues.length > 0)
  assert.match(output.summary, /部分完成/)
})

test('final output flags verification text that admits failure', () => {
  const output = buildFinalOutput({
    prompt: '修复刷新 bug',
    steps: [
      { kind: 'execute', status: 'completed', output: { text: '改了 store' } },
      { kind: 'verify', status: 'completed', output: { text: '回归测试未通过，仍有错误' } },
    ],
  })
  assert.equal(output.complete, false)
  assert.match(output.text, /未达成项/)
})

test('final output stays clean when everything really passed', () => {
  const output = buildFinalOutput({
    prompt: '修复刷新 bug',
    steps: [
      { kind: 'execute', status: 'completed', output: { text: '改了 store' } },
      { kind: 'verify', status: 'completed', output: { text: '回归测试通过' } },
    ],
  })
  assert.equal(output.complete, true)
  assert.equal(output.issues.length, 0)
})

// ★ 回归:verify 提示词会把「完成标准」原样回显，里面含有
//   「没有已知阻塞问题」这类否定式表述。早期版本用裸词匹配「阻塞问题」，
//   把每一个正常任务都误判成「部分完成」。
test('echoed acceptance criteria do not count as verification failure', () => {
  const output = buildFinalOutput({
    prompt: '修复项目 bug 并运行测试',
    steps: [
      { kind: 'execute', status: 'completed', output: { text: '已修复' } },
      {
        kind: 'verify',
        status: 'completed',
        output: {
          text: [
            '原始任务：修复项目 bug 并运行测试',
            '现在进入验证与修正阶段。检查此前产出是否真正满足任务。',
            '完成标准：',
            '- 结果可直接使用且没有已知阻塞问题',
            '- 相关检查或测试通过',
            '',
            '验收结论：已运行测试，全部通过。',
          ].join('\n'),
        },
      },
    ],
  })
  assert.equal(output.complete, true, `不该被误判：${output.issues.join('；')}`)
})

// ★ 回归:finalize 步骤在计算自己的输出时状态仍是 running，
//   不能把它自己算成「未走到完成状态」的步骤。
test('in-flight finalize step does not count itself as unfinished', () => {
  const output = buildFinalOutput({
    prompt: '修复项目 bug',
    steps: [
      { kind: 'execute', status: 'completed', output: { text: '已修复' } },
      { kind: 'verify', status: 'completed', output: { text: '测试通过' } },
      { kind: 'finalize', status: 'running', output: {} },
    ],
  })
  assert.equal(output.complete, true, `不该被误判：${output.issues.join('；')}`)
})
