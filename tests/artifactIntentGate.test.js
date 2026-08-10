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
import { validateHtmlArtifactSource } from '../server/services/artifactGen.js'

const nameOf = (specs) => specs.map((s) => s?.function?.name)
const ARTIFACT_GENERATOR_NAMES = [
  'create_docx',
  'create_html_app',
  'create_pptx',
  'create_xlsx',
  'generate_image',
]

function forgedArtifactArgs(name) {
  if (name === 'generate_image') return { prompt: 'An unrelated verification image' }
  return { title: 'Unrequested artifact', paragraphs: [{ text: 'Must not be generated' }] }
}

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

test('explicit image production unlocks only generate_image', () => {
  assert.deepEqual(
    [...allowedArtifactTools('生成一张产品海报图片')],
    ['generate_image'],
  )
  assert.equal(detectArtifactIntent('why did generate_image run?').image, false)
})

test('chat project-check turn does not inherit artifact generators from an older Word request', async () => {
  const currentPrompt = 'Run only run_project_check and report whether the project tests pass.'
  let visibleNames = []
  let modelCalls = 0
  const executions = []

  const result = await runToolsLoop({
    job: {
      id: 'chat-project-check-after-word',
      userId: 'intent-user',
      origin: 'chat',
      prompt: currentPrompt,
      userPrompt: currentPrompt,
    },
    step: { id: 'chat-project-check-after-word', kind: 'chat' },
    messages: [
      { role: 'user', content: 'Create a Word document with the release notes.' },
      { role: 'assistant', content: 'The Word document is ready.' },
      { role: 'user', content: currentPrompt },
    ],
    intentMode: 'execute',
    toolSpecs: SERVER_TOOL_SPECS,
    enableToolHooks: false,
    runModel: async ({ tools }) => {
      modelCalls += 1
      if (modelCalls === 1) {
        visibleNames = nameOf(tools)
        return {
          content: '',
          toolCalls: [{
            id: 'project-check-only',
            type: 'function',
            function: { name: 'run_project_check', arguments: JSON.stringify({ check: 'test' }) },
          }],
        }
      }
      return { content: 'Project checks passed.', toolCalls: [] }
    },
    executeTool: async ({ name }) => {
      executions.push(name)
      return { ok: true, check: 'test', exitCode: 0, stdout: 'passed', stderr: '' }
    },
  })

  assert.ok(visibleNames.includes('run_project_check'))
  for (const name of ARTIFACT_GENERATOR_NAMES) {
    assert.equal(visibleNames.includes(name), false, `${name} leaked into a project-check-only turn`)
  }
  assert.deepEqual(executions, ['run_project_check'])
  assert.deepEqual(result.artifactIds, [])
})

for (const generatorName of ['create_docx', 'generate_image']) {
  test(`chat project-check turn rejects forged ${generatorName} before execution`, async () => {
    const currentPrompt = 'Run only run_project_check and report whether the project tests pass.'
    const outcomes = []
    let attempted = false
    let executorCalls = 0

    await runToolsLoop({
      job: {
        id: `chat-forged-${generatorName}`,
        userId: 'intent-user',
        origin: 'chat',
        prompt: currentPrompt,
        userPrompt: currentPrompt,
      },
      step: { id: `chat-forged-${generatorName}`, kind: 'chat' },
      messages: [{ role: 'user', content: currentPrompt }],
      intentMode: 'execute',
      toolSpecs: SERVER_TOOL_SPECS,
      maxIters: 1,
      enableToolHooks: false,
      requestToolApproval: async ({ args }) => ({ proceed: true, args }),
      runModel: async ({ toolChoice }) => {
        if (toolChoice === 'none' || attempted) return { content: 'The forged call was rejected.', toolCalls: [] }
        attempted = true
        return {
          content: '',
          toolCalls: [{
            id: `forged-${generatorName}`,
            type: 'function',
            function: {
              name: generatorName,
              arguments: JSON.stringify(forgedArtifactArgs(generatorName)),
            },
          }],
        }
      },
      executeTool: async () => {
        executorCalls += 1
        return { ok: true, artifactId: `unexpected-${generatorName}` }
      },
      onToolCompleted: async (outcome) => outcomes.push(outcome),
    })

    assert.equal(executorCalls, 0)
    assert.equal(outcomes.length, 1)
    assert.equal(outcomes[0].result?.ok, false)
    assert.equal(outcomes[0].result?.code, 'artifact_tool_not_requested')
    assert.equal(outcomes[0].artifactId, null)
  })
}

for (const stepKind of ['plan', 'verify', 'finalize']) {
  test(`${stepKind} step neither exposes nor executes artifact generators from the original Word prompt`, async () => {
    const outcomes = []
    const executions = []
    let visibleNames = []
    let attempted = false

    await runToolsLoop({
      job: {
        id: `${stepKind}-word-scope`,
        userId: 'intent-user',
        origin: 'job',
        prompt: 'Create a Word document with the quarterly report.',
      },
      step: { id: `${stepKind}-word-scope`, kind: stepKind, input: { acceptance: [] } },
      messages: [{
        role: 'user',
        content: 'Original task: Create a Word document with the quarterly report. Inspect and report verification evidence only.',
      }],
      intentMode: 'execute',
      executionGuardMode: 'read_only_exploration',
      toolSpecs: SERVER_TOOL_SPECS,
      maxIters: 1,
      enableToolHooks: false,
      requestToolApproval: async ({ args }) => ({ proceed: true, args }),
      runModel: async ({ tools, toolChoice }) => {
        if (toolChoice === 'none' || attempted) return { content: `${stepKind} complete.`, toolCalls: [] }
        attempted = true
        visibleNames = nameOf(tools)
        return {
          content: '',
          toolCalls: ['create_docx', 'generate_image'].map((name) => ({
            id: `${stepKind}-forged-${name}`,
            type: 'function',
            function: { name, arguments: JSON.stringify(forgedArtifactArgs(name)) },
          })),
        }
      },
      executeTool: async ({ name }) => {
        executions.push(name)
        return { ok: true, artifactId: `unexpected-${stepKind}-${name}` }
      },
      onToolCompleted: async (outcome) => outcomes.push(outcome),
    })

    assert.ok(visibleNames.includes('run_project_check'))
    for (const name of ARTIFACT_GENERATOR_NAMES) {
      assert.equal(visibleNames.includes(name), false, `${name} leaked into the ${stepKind} step`)
    }
    assert.deepEqual(executions, [])
    assert.deepEqual(outcomes.map((outcome) => outcome.result?.code), [
      'artifact_tool_not_requested',
      'artifact_tool_not_requested',
    ])
    assert.ok(outcomes.every((outcome) => outcome.artifactId === null))
  })
}

test('verify checkpoint resume rejects pending artifact generators before execution', async () => {
  const currentPrompt = 'Original task: Create a Word document. Resume verification and report evidence only.'
  const pendingCalls = ['create_docx', 'generate_image'].map((name) => ({
    id: `checkpoint-${name}`,
    name,
    args: forgedArtifactArgs(name),
    argumentsText: JSON.stringify(forgedArtifactArgs(name)),
    parseError: null,
    checkpointStatus: 'pending',
    checkpointApprovalId: null,
  }))
  const checkpoint = {
    messages: [
      { role: 'user', content: currentPrompt },
      {
        role: 'assistant',
        content: null,
        tool_calls: pendingCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.argumentsText },
        })),
      },
    ],
    toolCalls: pendingCalls,
    artifactIds: [],
    iterations: 0,
  }
  const outcomes = []
  let executorCalls = 0
  let modelCalls = 0

  const result = await runToolsLoop({
    job: {
      id: 'verify-artifact-checkpoint',
      userId: 'intent-user',
      origin: 'job',
      prompt: 'Create a Word document.',
    },
    step: { id: 'verify-artifact-checkpoint', kind: 'verify', input: { acceptance: [] } },
    messages: [{ role: 'user', content: currentPrompt }],
    intentMode: 'execute',
    executionGuardMode: 'read_only_exploration',
    toolSpecs: SERVER_TOOL_SPECS,
    maxIters: 2,
    enableToolHooks: false,
    loadCheckpoint: async () => ({ state: checkpoint }),
    saveCheckpoint: async () => true,
    requestToolApproval: async ({ args }) => ({ proceed: true, args }),
    executeTool: async () => {
      executorCalls += 1
      return { ok: true, artifactId: 'unexpected-checkpoint-artifact' }
    },
    onToolCompleted: async (outcome) => outcomes.push(outcome),
    runModel: async ({ messages }) => {
      modelCalls += 1
      const codes = messages
        .filter((message) => message.role === 'tool')
        .map((message) => JSON.parse(message.content).code)
      assert.deepEqual(codes, ['artifact_tool_not_requested', 'artifact_tool_not_requested'])
      return { content: 'Checkpoint artifact calls were rejected.', toolCalls: [] }
    },
  })

  assert.equal(executorCalls, 0)
  assert.equal(modelCalls, 1)
  assert.deepEqual(outcomes.map((outcome) => outcome.result?.code), [
    'artifact_tool_not_requested',
    'artifact_tool_not_requested',
  ])
  assert.ok(outcomes.every((outcome) => outcome.artifactId === null))
  assert.deepEqual(result.artifactIds, [])
})

test('reporting execution evidence is not mistaken for a DOCX request', () => {
  for (const prompt of [
    '请报告真实 exitCode；不要只口头说明。',
    '然后报告测试结果和 stdout。',
    '请报告当前状态与错误原因。',
    'Please report the actual exit code and test result.',
  ]) {
    assert.equal(detectArtifactIntent(prompt).docx, false, prompt)
    assert.equal(allowedArtifactTools(prompt).has('create_docx'), false, prompt)
  }

  for (const prompt of [
    '请生成一份测试报告',
    '写一份报告说明测试结果',
    'Create a report of the actual exit code',
  ]) {
    assert.equal(detectArtifactIntent(prompt).docx, true, prompt)
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

test('slash artifact skills stay locked to one generator unless multiple file formats are explicit', () => {
  assert.deepEqual(
    detectArtifactIntent('/webpage build a website for a quarterly report'),
    { pptx: false, docx: false, xlsx: false, html: true, image: false },
  )
  assert.deepEqual(
    detectArtifactIntent('/doc create a report with a spreadsheet-style table'),
    { pptx: false, docx: true, xlsx: false, html: false, image: false },
  )
  assert.deepEqual(
    detectArtifactIntent('/ppt present the quarterly report'),
    { pptx: true, docx: false, xlsx: false, html: false, image: false },
  )
  assert.deepEqual(
    [...allowedArtifactTools('/webpage build a website and also export a Word document')].sort(),
    ['create_docx', 'create_html_app'],
  )
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

test('webpage delivery retries natural-language fallback until a real artifact exists', async () => {
  const deltas = []
  const executions = []
  const visibleToolNames = []
  let modelCalls = 0
  const result = await runToolsLoop({
    job: { id: 'webpage-delivery-guard', userId: 'intent-user', origin: 'chat', prompt: '/webpage build a product page' },
    step: { id: 'webpage-delivery-guard', kind: 'chat' },
    messages: [{ role: 'user', content: '/webpage build a product page' }],
    skillId: 'webpage',
    toolSpecs: SERVER_TOOL_SPECS,
    enableToolHooks: false,
    requestToolApproval: async ({ args }) => ({ proceed: true, args }),
    onModelDelta: async ({ text }) => deltas.push(text),
    executeTool: async ({ name, args }) => {
      executions.push({ name, args })
      return { ok: true, artifactId: 'guarded-html-1', filename: 'product.html', url: '/api/artifacts/product.html' }
    },
    runModel: async ({ messages, tools }) => {
      modelCalls += 1
      visibleToolNames.push(tools.map((tool) => tool.function.name))
      if (modelCalls === 1) {
        return { content: 'Copy this HTML into a new file and save it as product.html.', toolCalls: [] }
      }
      if (modelCalls === 2) {
        assert.ok(messages.some((message) => String(message.content || '').includes('[PERSISTED ARTIFACT DELIVERY REQUIRED]')))
        return {
          content: '',
          toolCalls: [{
            id: 'guarded-html-call',
            function: {
              name: 'create_html_app',
              arguments: JSON.stringify({
                title: 'Product',
                html: '<!doctype html><html><body><main>Product</main></body></html>',
              }),
            },
          }],
        }
      }
      return { content: 'The webpage is ready.', toolCalls: [] }
    },
  })

  assert.equal(modelCalls, 3)
  assert.equal(executions.length, 1)
  assert.equal(executions[0].name, 'create_html_app')
  assert.deepEqual(result.artifactIds, ['guarded-html-1'])
  assert.equal(result.text, 'The webpage is ready.')
  assert.equal(deltas.join(''), 'The webpage is ready.')
  assert.equal(visibleToolNames[0].includes('request_directory'), false)
})

test('webpage delivery rejects handoff prose disguised as HTML and accepts the corrected tool call', async () => {
  const executions = []
  let modelCalls = 0
  const fakeHtml = `<!doctype html><html><body><main><p>
    网页代码已生成。复制上面的完整代码，新建文件并粘贴保存为 product.html，然后双击用浏览器打开。
  </p></main></body></html>`
  const realHtml = '<!doctype html><html><body><main><h1>Product</h1><section><p>Fast and reliable.</p></section></main></body></html>'

  const result = await runToolsLoop({
    job: { id: 'webpage-invalid-html-retry', userId: 'intent-user', origin: 'chat', prompt: '/webpage build a product page' },
    step: { id: 'webpage-invalid-html-retry', kind: 'chat' },
    messages: [{ role: 'user', content: '/webpage build a product page' }],
    skillId: 'webpage',
    toolSpecs: SERVER_TOOL_SPECS,
    enableToolHooks: false,
    requestToolApproval: async ({ args }) => ({ proceed: true, args }),
    executeTool: async ({ name, args }) => {
      executions.push({ name, html: args.html })
      try {
        validateHtmlArtifactSource(args.html)
      } catch (error) {
        return { ok: false, code: 'invalid_html_artifact', error: error.message }
      }
      return { ok: true, artifactId: 'real-html-artifact', filename: 'product.html', url: '/api/artifacts/product.html' }
    },
    runModel: async ({ messages }) => {
      modelCalls += 1
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [{
            id: 'fake-html-call',
            function: { name: 'create_html_app', arguments: JSON.stringify({ title: 'Product', html: fakeHtml }) },
          }],
        }
      }
      if (modelCalls === 2) {
        assert.ok(messages.some((message) => (
          message.role === 'tool' && String(message.content || '').includes('delivery instructions')
        )))
        return {
          content: '',
          toolCalls: [{
            id: 'real-html-call',
            function: { name: 'create_html_app', arguments: JSON.stringify({ title: 'Product', html: realHtml }) },
          }],
        }
      }
      return { content: 'The real webpage is ready.', toolCalls: [] }
    },
  })

  assert.equal(modelCalls, 3)
  assert.deepEqual(executions.map(({ name }) => name), ['create_html_app', 'create_html_app'])
  assert.deepEqual(result.artifactIds, ['real-html-artifact'])
  assert.equal(result.text, 'The real webpage is ready.')
})

test('webpage slash skill does not require a docx for quarterly report content', async () => {
  const executions = []
  let modelCalls = 0
  const prompt = '/webpage build a website for a quarterly report'
  const result = await runToolsLoop({
    job: { id: 'webpage-quarterly-report', userId: 'intent-user', origin: 'chat', prompt },
    step: { id: 'webpage-quarterly-report', kind: 'chat' },
    messages: [{ role: 'user', content: prompt }],
    skillId: 'webpage',
    toolSpecs: SERVER_TOOL_SPECS,
    enableToolHooks: false,
    requestToolApproval: async ({ args }) => ({ proceed: true, args }),
    executeTool: async ({ name }) => {
      executions.push(name)
      return { ok: true, artifactId: 'quarterly-html', filename: 'quarterly-report.html', url: '/api/artifacts/quarterly-report.html' }
    },
    runModel: async () => {
      modelCalls += 1
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [{
            id: 'quarterly-html-call',
            function: {
              name: 'create_html_app',
              arguments: JSON.stringify({
                title: 'Quarterly report',
                html: '<!doctype html><html><body><main>Quarterly report</main></body></html>',
              }),
            },
          }],
        }
      }
      return { content: 'The quarterly report website is ready.', toolCalls: [] }
    },
  })

  assert.equal(modelCalls, 2)
  assert.deepEqual(executions, ['create_html_app'])
  assert.deepEqual(result.artifactIds, ['quarterly-html'])
  assert.equal(result.text, 'The quarterly report website is ready.')
})

test('a multi-file request without a slash skill still requires every requested artifact', async () => {
  const executions = []
  let modelCalls = 0
  const prompt = 'Create a Word document and export an Excel spreadsheet'
  const result = await runToolsLoop({
    job: { id: 'multi-artifact-request', userId: 'intent-user', origin: 'chat', prompt },
    step: { id: 'multi-artifact-request', kind: 'chat' },
    messages: [{ role: 'user', content: prompt }],
    toolSpecs: SERVER_TOOL_SPECS,
    enableToolHooks: false,
    requestToolApproval: async ({ args }) => ({ proceed: true, args }),
    executeTool: async ({ name }) => {
      executions.push(name)
      return {
        ok: true,
        artifactId: `${name}-artifact`,
        filename: name === 'create_docx' ? 'summary.docx' : 'summary.xlsx',
      }
    },
    runModel: async () => {
      modelCalls += 1
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [
            {
              id: 'multi-docx-call',
              function: {
                name: 'create_docx',
                arguments: JSON.stringify({ title: 'Summary', paragraphs: [{ text: 'Summary' }] }),
              },
            },
            {
              id: 'multi-xlsx-call',
              function: {
                name: 'create_xlsx',
                arguments: JSON.stringify({ title: 'Summary', sheets: [{ name: 'Data', rows: [['Item'], ['Value']] }] }),
              },
            },
          ],
        }
      }
      return { content: 'Both files are ready.', toolCalls: [] }
    },
  })

  assert.equal(modelCalls, 2)
  assert.deepEqual(executions.sort(), ['create_docx', 'create_xlsx'])
  assert.deepEqual(result.artifactIds.sort(), ['create_docx-artifact', 'create_xlsx-artifact'])
  assert.equal(result.text, 'Both files are ready.')
})

for (const delivery of [
  { label: 'HTML', skillId: 'webpage', prompt: '/webpage build a product page' },
  { label: 'PPTX', skillId: 'ppt', prompt: '/ppt build a product deck' },
  { label: 'DOCX', skillId: 'doc', prompt: '/doc build a product brief' },
  { label: 'XLSX', skillId: 'excel', prompt: '/excel build a product table' },
]) {
  test(`${delivery.label} delivery fails explicitly instead of completing with a fake preview`, async () => {
    await assert.rejects(
      runToolsLoop({
        job: { id: `${delivery.skillId}-delivery-failure`, userId: 'intent-user', origin: 'chat', prompt: delivery.prompt },
        step: { id: `${delivery.skillId}-delivery-failure`, kind: 'chat' },
        messages: [{ role: 'user', content: delivery.prompt }],
        skillId: delivery.skillId,
        toolSpecs: SERVER_TOOL_SPECS,
        maxIters: 2,
        enableToolHooks: false,
        runModel: async () => ({ content: 'The requested file is ready. Save this answer locally.', toolCalls: [] }),
      }),
      (error) => error?.code === 'ARTIFACT_NOT_CREATED',
    )
  })
}

test('an image artifact cannot satisfy a webpage delivery requirement', async () => {
  const deltas = []
  const executions = []
  let modelCalls = 0
  const prompt = '/webpage build a product page and also create a hero image'
  const result = await runToolsLoop({
    job: { id: 'webpage-image-bypass', userId: 'intent-user', origin: 'chat', prompt },
    step: { id: 'webpage-image-bypass', kind: 'chat' },
    messages: [{ role: 'user', content: prompt }],
    skillId: 'webpage',
    toolSpecs: SERVER_TOOL_SPECS,
    enableToolHooks: false,
    requestToolApproval: async ({ args }) => ({ proceed: true, args }),
    onModelDelta: async ({ text }) => deltas.push(text),
    executeTool: async ({ name }) => {
      executions.push(name)
      return name === 'generate_image'
        ? { ok: true, artifactId: 'image-artifact', filename: 'hero.png', url: '/api/artifacts/hero.png' }
        : { ok: true, artifactId: 'html-artifact', filename: 'product.html', url: '/api/artifacts/product.html' }
    },
    runModel: async ({ messages }) => {
      modelCalls += 1
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [{ id: 'hero-call', function: { name: 'generate_image', arguments: JSON.stringify({ prompt: 'hero' }) } }],
        }
      }
      if (modelCalls === 2) return { content: 'The webpage is ready.', toolCalls: [] }
      if (modelCalls === 3) {
        assert.ok(messages.some((message) => String(message.content || '').includes('create_html_app')))
        return {
          content: '',
          toolCalls: [{
            id: 'html-after-image',
            function: {
              name: 'create_html_app',
              arguments: JSON.stringify({ title: 'Product', html: '<!doctype html><html><body><main>Product</main></body></html>' }),
            },
          }],
        }
      }
      return { content: 'The real webpage is ready.', toolCalls: [] }
    },
  })

  assert.deepEqual(executions, ['generate_image', 'create_html_app'])
  assert.deepEqual(result.artifactIds, ['image-artifact', 'html-artifact'])
  assert.equal(result.text, 'The real webpage is ready.')
  assert.equal(deltas.join(''), 'The real webpage is ready.')
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
  assert.deepEqual(detectArtifactIntent('Make a PPT report'), {
    pptx: true, docx: false, xlsx: false, html: false, image: false,
  })
  assert.deepEqual(detectArtifactIntent('做一份 PPT 汇报'), {
    pptx: true, docx: false, xlsx: false, html: false, image: false,
  })
  assert.deepEqual(detectArtifactIntent('同时生成 PPT 以及 Word 文档'), {
    pptx: true, docx: true, xlsx: false, html: false, image: false,
  })
  assert.equal(shouldCompileDocx('生成 PPT 并导出'), false)
})

test('artifact expectation is false for plain code work', () => {
  assert.equal(expectsFileArtifact('把登录接口的 500 错误修掉'), false)
  assert.equal(allowedArtifactTools('把登录接口的 500 错误修掉').size, 0)
})

test('prebuilt tool specs do not short-circuit intent re-evaluation', async () => {
  let visibleNames = []
  let modelCalls = 0
  await runToolsLoop({
    job: { id: 'intent-recheck', userId: 'intent-user', prompt: '先分析数据' },
    step: { id: 'intent-step' },
    messages: [{ role: 'user', content: '改为整理成 Word 文档并下载' }],
    toolSpecs: SERVER_TOOL_SPECS,
    runModel: async ({ tools }) => {
      modelCalls += 1
      visibleNames = nameOf(tools)
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [{
            id: 'intent-docx',
            function: {
              name: 'create_docx',
              arguments: JSON.stringify({ title: 'Analysis', paragraphs: [{ text: 'done' }] }),
            },
          }],
        }
      }
      return { content: 'done', toolCalls: [] }
    },
    executeTool: async () => ({
      ok: true,
      artifactId: 'intent-docx-artifact',
      filename: 'analysis.docx',
      url: '/api/artifacts/analysis.docx',
    }),
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
