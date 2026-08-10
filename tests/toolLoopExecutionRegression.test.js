import test from 'node:test'
import assert from 'node:assert/strict'

import { buildServerToolsConfig } from '../src/pages/ChatSplit/serverTurnFlow.js'
import { createInitialState } from '../src/store/appStateBootstrap.js'
import { applyServerToolsConfig } from '../server/services/turnToolSpecs.js'

const { runToolsLoop, SERVER_TOOL_SPECS } = await import('../server/services/jobTools.js')
const { registerDynamicTool, unregisterDynamicTool } = await import('../server/services/toolRegistry.js')
const { createJobBudget } = await import('../server/utils/jobBudget.js')

test('executes tool calls returned by the model response that crosses the token budget', async () => {
  const bashExec = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'bash_exec')
  const runtimeBudget = createJobBudget({
    maxModelCalls: 5,
    maxModelTokens: 5,
    maxCostUsd: 10,
  })
  let modelCalls = 0
  let executed = false

  const result = await runToolsLoop({
    job: {
      id: 'job-budget-partial-tool-call',
      userId: null,
      origin: 'chat',
      prompt: 'Run a local command and report its real result.',
    },
    step: { id: 'step-budget-partial-tool-call', kind: 'execute' },
    messages: [{ role: 'user', content: 'Run a local command and report its real result.' }],
    intentMode: 'execute',
    toolSpecs: [bashExec],
    runtimeBudget,
    maxIters: 3,
    enableToolHooks: false,
    runModel: async () => {
      modelCalls += 1
      return {
        content: '',
        toolCalls: [{
          id: 'budget-crossing-command',
          type: 'function',
          function: { name: 'bash_exec', arguments: JSON.stringify({ command: 'echo ok' }) },
        }],
        usage: { promptTokens: 4, completionTokens: 4 },
      }
    },
    executeTool: async ({ name }) => {
      assert.equal(name, 'bash_exec')
      executed = true
      return { ok: true, exitCode: 0, stdout: 'ok' }
    },
  })

  assert.equal(executed, true)
  assert.equal(modelCalls, 1, 'the exhausted budget must block every later provider request')
  assert.equal(result.budgetExceeded, true)
  assert.equal(result.incomplete, true)
})

test('execution reasoning runaway is retried into a substantive tool call and persisted', async () => {
  const writeFile = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'write_file')
  const readFile = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'read_file')
  const outputPath = 'D:\\authorized\\reasoning-recovered.txt'
  const phases = []
  let checkpoint = null
  let modelCalls = 0
  let executedWrites = 0

  const result = await runToolsLoop({
    job: {
      id: 'execution-reasoning-recovery-job',
      userId: null,
      origin: 'chat',
      prompt: `Create ${outputPath}, then read it back to verify the result.`,
    },
    step: { id: 'execution-reasoning-recovery-step', kind: 'chat' },
    messages: [{
      role: 'user',
      content: `Create ${outputPath}, then read it back to verify the result.`,
    }],
    intentMode: 'execute',
    toolSpecs: [writeFile, readFile],
    maxIters: 6,
    enableToolHooks: false,
    onModelPhase: async (phase) => phases.push(phase),
    saveCheckpoint: async (state) => {
      checkpoint = structuredClone(state)
      return true
    },
    runModel: async ({ messages }) => {
      modelCalls += 1
      if (modelCalls === 1) {
        const error = new Error('reasoning exceeded execution ceiling')
        error.code = 'REASONING_RUNAWAY'
        throw error
      }
      if (modelCalls === 2) {
        const systemText = messages
          .filter((message) => message.role === 'system')
          .map((message) => message.content)
          .join('\n')
        assert.match(systemText, /\[EXECUTION REASONING RECOVERY REQUIRED\]/)
        assert.match(systemText, /Begin the next response with one substantive available tool call/)
        return {
          content: '',
          toolCalls: [{
            id: 'write-after-reasoning-recovery',
            type: 'function',
            function: {
              name: 'write_file',
              arguments: JSON.stringify({ path: outputPath, content: 'RECOVERED' }),
            },
          }],
        }
      }
      if (modelCalls === 3) {
        return {
          content: '',
          toolCalls: [{
            id: 'verify-after-reasoning-recovery',
            type: 'function',
            function: {
              name: 'read_file',
              arguments: JSON.stringify({ path: outputPath }),
            },
          }],
        }
      }
      return { content: 'Created and verified reasoning-recovered.txt.', toolCalls: [] }
    },
    executeTool: async ({ name }) => {
      if (name === 'write_file') {
        executedWrites += 1
        return { ok: true, path: outputPath }
      }
      assert.equal(name, 'read_file')
      return { ok: true, path: outputPath, content: 'RECOVERED' }
    },
  })

  assert.equal(result.text, 'Created and verified reasoning-recovered.txt.')
  assert.equal(executedWrites, 1)
  assert.equal(modelCalls, 4)
  assert.equal(phases.some((phase) => phase.reason === 'reasoning_runaway'), true)
  assert.equal(checkpoint?.completionGuards?.executionReasoningRetries, 1)
})

test('default client config keeps bash_exec available through a read-only local PDF execution turn', async () => {
  const pdfPath = 'D:\\destok\\answer-sheet.pdf'
  const injectedPrompt = [
    '[LOCAL PATH ACCESS GRANTED] The user explicitly authorized these local paths:',
    `- ${pdfPath} (file)`,
    'Access mode: read only.',
    'Reuse this exact absolute path.',
  ].join('\n')
  const toolsConfig = buildServerToolsConfig(createInitialState().toolsConfig, {
    paths: [pdfPath],
    accessMode: 'read_only',
    resources: [{ path: pdfPath, resourceType: 'file' }],
  })
  const toolSpecs = applyServerToolsConfig(SERVER_TOOL_SPECS, toolsConfig)
  let modelCalls = 0
  let executed = false

  const result = await runToolsLoop({
    job: {
      id: 'job-default-code-execution-pdf',
      userId: null,
      origin: 'chat',
      prompt: injectedPrompt,
      userPrompt: `Run a local command while working with ${pdfPath} and report the result.`,
    },
    step: { id: 'step-default-code-execution-pdf', kind: 'chat' },
    messages: [{ role: 'user', content: injectedPrompt }],
    intentMode: 'execute',
    toolSpecs,
    maxIters: 3,
    enableToolHooks: false,
    runModel: async ({ tools }) => {
      modelCalls += 1
      const names = tools.map((item) => item?.function?.name)
      assert.ok(names.includes('bash_exec'))
      if (modelCalls > 1) return { content: 'The command completed successfully.', toolCalls: [] }
      return {
        content: '',
        toolCalls: [{
          id: 'run-read-only-command',
          type: 'function',
          function: { name: 'bash_exec', arguments: JSON.stringify({ command: 'git status --short' }) },
        }],
      }
    },
    executeTool: async ({ name }) => {
      assert.equal(name, 'bash_exec')
      executed = true
      return { ok: true, exitCode: 0, stdout: '' }
    },
  })

  assert.equal(executed, true)
  assert.equal(result.text, 'The command completed successfully.')
})

test('ordinary numbered questions do not force direct execution', async () => {
  let observedMessages = []
  const result = await runToolsLoop({
    job: {
      id: 'job-numbered-question',
      userId: null,
      origin: 'chat',
      prompt: '请解释下面三点：\n1. 缓存命中率\n2. 上下文窗口\n3. 温度参数',
    },
    step: { id: 'step-numbered-question', kind: 'chat' },
    messages: [{ role: 'user', content: '请解释下面三点：\n1. 缓存命中率\n2. 上下文窗口\n3. 温度参数' }],
    toolSpecs: [],
    maxIters: 1,
    enableToolHooks: false,
    runModel: async ({ messages }) => {
      observedMessages = messages
      return { content: '解释完成', toolCalls: [] }
    },
  })
  const systemText = observedMessages
    .filter((item) => item.role === 'system')
    .map((item) => item.content)
    .join('\n')
  assert.doesNotMatch(systemText, /\[DIRECT EXECUTION REQUIRED\]/)
  assert.equal(result.text, '解释完成')
})

test('direct execution cannot finish as prose before any substantive tool succeeds', async () => {
  const readFile = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'read_file')
  const observedRequests = []
  let modelCalls = 0
  let toolCalls = 0
  const result = await runToolsLoop({
    job: {
      id: 'job-direct-execution-evidence',
      userId: null,
      origin: 'chat',
      prompt: '执行以下步骤：\n1. 打开 README.md\n2. 检查内容并给出结论',
    },
    step: { id: 'step-direct-execution-evidence', kind: 'chat' },
    messages: [{ role: 'user', content: '执行以下步骤：\n1. 打开 README.md\n2. 检查内容并给出结论' }],
    toolSpecs: [readFile],
    maxIters: 4,
    enableToolHooks: false,
    runModel: async ({ messages }) => {
      modelCalls += 1
      observedRequests.push(structuredClone(messages))
      if (modelCalls === 1) return { content: '你可以自己打开 README.md 查看。', toolCalls: [] }
      if (modelCalls === 2) {
        return {
          content: '',
          toolCalls: [{
            id: 'read-readme',
            type: 'function',
            function: { name: 'read_file', arguments: JSON.stringify({ path: 'README.md' }) },
          }],
        }
      }
      return { content: '已实际读取并检查 README.md。', toolCalls: [] }
    },
    executeTool: async ({ name }) => {
      toolCalls += 1
      assert.equal(name, 'read_file')
      return { ok: true, content: '# Gugo' }
    },
  })

  assert.equal(modelCalls, 3)
  assert.equal(toolCalls, 1)
  assert.equal(result.text, '已实际读取并检查 README.md。')
  const correction = observedRequests[1]
    .filter((item) => item.role === 'system')
    .map((item) => item.content)
    .join('\n')
  assert.match(correction, /\[EXECUTION EVIDENCE REQUIRED\]/)
})

test('a malformed search cannot turn available execution tools into a fake clarification blocker', async () => {
  const names = ['grep_code', 'request_clarification', 'bash_exec', 'write_file', 'read_file']
  const specs = names.map((name) => SERVER_TOOL_SPECS.find((item) => item?.function?.name === name))
  assert.equal(specs.every(Boolean), true)

  const observedRequests = []
  const executed = []
  let modelCalls = 0
  const pdfPath = 'D:\\desktop\\ielts-answer.pdf'
  const result = await runToolsLoop({
    job: {
      id: 'job-pdf-capability-recovery',
      userId: null,
      origin: 'chat',
      prompt: `将作文写入 ${pdfPath} 的 Task 1。`,
    },
    step: { id: 'step-pdf-capability-recovery', kind: 'chat' },
    messages: [{ role: 'user', content: `将作文写入 ${pdfPath} 的 Task 1。` }],
    intentMode: 'execute',
    toolSpecs: specs,
    maxIters: 7,
    enableToolHooks: false,
    runModel: async ({ messages, tools }) => {
      modelCalls += 1
      observedRequests.push(structuredClone(messages))
      assert.deepEqual(tools.map((item) => item.function.name).sort(), [...names].sort())
      if (modelCalls === 1) {
        const systemText = messages.filter((item) => item.role === 'system').map((item) => item.content).join('\n')
        assert.match(systemText, /\[AVAILABLE TOOL CAPABILITIES\]/)
        assert.match(systemText, /bash_exec/)
        assert.match(systemText, /write_file/)
        return {
          content: '',
          toolCalls: [{
            id: 'search-without-pattern',
            type: 'function',
            function: { name: 'grep_code', arguments: '{}' },
          }],
        }
      }
      if (modelCalls === 2) {
        const previous = JSON.parse(messages.findLast((item) => item.role === 'tool').content)
        assert.equal(previous.code, 'tool_arguments_validation_failed')
        assert.match(previous.error, /pattern/)
        return {
          content: '我无法直接编辑 PDF 或生成 PNG 图像（工具集限制）。',
          toolCalls: [{
            id: 'fake-capability-clarification',
            type: 'function',
            function: {
              name: 'request_clarification',
              arguments: JSON.stringify({
                question: '我无法直接编辑 PDF 或生成 PNG 图像（工具集限制）。你要选择其他方式吗？',
                blocker_kind: 'other',
              }),
            },
          }],
        }
      }
      if (modelCalls === 3) {
        const previous = JSON.parse(messages.findLast((item) => item.role === 'tool').content)
        assert.equal(previous.code, 'clarification_capability_contradicted')
        assert.deepEqual(previous.availableTools, ['bash_exec', 'write_file'])
        return {
          content: '',
          toolCalls: [{
            id: 'update-pdf-with-python',
            type: 'function',
            function: {
              name: 'bash_exec',
              arguments: JSON.stringify({
                command: `python update_pdf.py "${pdfPath}"`,
                expected_outputs: [pdfPath],
              }),
            },
          }],
        }
      }
      if (modelCalls === 4) {
        return {
          content: '',
          toolCalls: [{
            id: 'verify-updated-pdf',
            type: 'function',
            function: { name: 'read_file', arguments: JSON.stringify({ path: pdfPath }) },
          }],
        }
      }
      if (modelCalls === 5) {
        return { content: 'Task 1 已写入 PDF 并读回验证。', toolCalls: [] }
      }
      if (modelCalls === 6) {
        const systemText = messages
          .filter((item) => item.role === 'system')
          .map((item) => item.content)
          .join('\n')
        assert.match(systemText, /\[PDF LAYOUT VERIFICATION REQUIRED\]/)
        return {
          content: '',
          toolCalls: [{
            id: 'verify-updated-pdf-layout',
            type: 'function',
            function: {
              name: 'bash_exec',
              arguments: JSON.stringify({ command: 'python verify_pdf_layout.py' }),
            },
          }],
        }
      }
      return { content: 'Task 1 已写入 PDF 并读回验证。', toolCalls: [] }
    },
    executeTool: async ({ name, args }) => {
      executed.push(name)
      if (name === 'bash_exec') {
        return {
          ok: true,
          exitCode: 0,
          stdout: args.command.includes('verify_pdf_layout.py')
            ? 'PDF_LAYOUT_VERIFICATION_OK\n'
            : 'updated',
          stderr: '',
          cwd: 'D:\\workspace',
        }
      }
      if (name === 'read_file') {
        return {
          ok: true,
          path: pdfPath,
          content: 'Task 1 response',
          mimeType: 'application/pdf',
          extractionStatus: 'text',
          requiresVision: false,
        }
      }
      throw new Error(`unexpected executor call: ${name}`)
    },
  })

  assert.deepEqual(executed, ['bash_exec', 'read_file', 'bash_exec'])
  assert.equal(modelCalls, 7)
  assert.equal(result.paused, undefined)
  assert.equal(result.incomplete, undefined, JSON.stringify(result))
  assert.equal(result.text, 'Task 1 已写入 PDF 并读回验证。')
  const correction = observedRequests[2].findLast((item) => item.role === 'tool')
  assert.match(correction.content, /clarification_capability_contradicted/)
})

test('path authorization failures cannot be reframed as missing PDF or PNG capability', async () => {
  const names = [
    'grep_code',
    'list_directory',
    'request_clarification',
    'request_directory',
    'bash_exec',
    'write_file',
  ]
  const specs = names.map((name) => SERVER_TOOL_SPECS.find((item) => item?.function?.name === name))
  assert.equal(specs.every(Boolean), true)

  const executed = []
  const observedRequests = []
  let modelCalls = 0
  const outputDirectory = 'D:\\destok'
  const result = await runToolsLoop({
    job: {
      id: 'job-local-pdf-path-recovery',
      userId: null,
      origin: 'chat',
      prompt: '把已完成的作文写入 D:\\destok\\雅思写作最新答题纸.pdf，并生成页面 PNG 预览。',
    },
    step: { id: 'step-local-pdf-path-recovery', kind: 'chat' },
    messages: [{
      role: 'user',
      content: '把已完成的作文写入 D:\\destok\\雅思写作最新答题纸.pdf，并生成页面 PNG 预览。',
    }],
    intentMode: 'execute',
    toolSpecs: specs,
    maxIters: 8,
    enableToolHooks: false,
    runModel: async ({ messages }) => {
      modelCalls += 1
      observedRequests.push(structuredClone(messages))
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [{
            id: 'grep-relative-dot',
            type: 'function',
            function: {
              name: 'grep_code',
              arguments: JSON.stringify({ pattern: 'Task 1', path: '.' }),
            },
          }],
        }
      }
      if (modelCalls === 2) {
        const previous = JSON.parse(messages.findLast((item) => item.role === 'tool').content)
        assert.equal(previous.code, 'ABSOLUTE_PATH_REQUIRED')
        return {
          content: '',
          toolCalls: [{
            id: 'list-guessed-parent',
            type: 'function',
            function: {
              name: 'list_directory',
              arguments: JSON.stringify({ path: outputDirectory }),
            },
          }],
        }
      }
      if (modelCalls === 3) {
        const previous = JSON.parse(messages.findLast((item) => item.role === 'tool').content)
        assert.equal(previous.code, 'PATH_NOT_AUTHORIZED')
        return {
          content: '',
          toolCalls: [{
            id: 'list-relative-dot',
            type: 'function',
            function: {
              name: 'list_directory',
              arguments: JSON.stringify({ path: '.' }),
            },
          }],
        }
      }
      if (modelCalls === 4) {
        const previous = JSON.parse(messages.findLast((item) => item.role === 'tool').content)
        assert.equal(previous.code, 'ABSOLUTE_PATH_REQUIRED')
        return {
          content: '我无法直接编辑 PDF 或生成 PNG 图像（工具集限制）。',
          toolCalls: [{
            id: 'fake-path-capability-clarification',
            type: 'function',
            function: {
              name: 'request_clarification',
              arguments: JSON.stringify({
                question: '我无法直接编辑 PDF 或生成 PNG 图像（工具集限制）。',
                blocker_kind: 'other',
              }),
            },
          }],
        }
      }
      if (modelCalls === 5) {
        const previous = JSON.parse(messages.findLast((item) => item.role === 'tool').content)
        assert.equal(previous.code, 'clarification_capability_contradicted')
        assert.deepEqual(previous.availableTools, ['bash_exec', 'write_file'])
        assert.match(previous.hint, /request_directory/)
        assert.deepEqual(previous.requiredAction, {
          tool: 'request_directory',
          access_mode: 'read_write',
          suggested_path: outputDirectory,
        })
        return {
          content: '',
          toolCalls: [{
            id: 'request-writable-output-directory',
            type: 'function',
            function: {
              name: 'request_directory',
              arguments: JSON.stringify({
                purpose: '写入 PDF 并在同一输出目录生成 PNG 预览。',
                access_mode: 'read_write',
                suggested_path: outputDirectory,
              }),
            },
          }],
        }
      }
      throw new Error(`unexpected model call ${modelCalls}`)
    },
    executeTool: async ({ name, args }) => {
      executed.push({ name, args })
      if (name === 'grep_code') {
        return {
          ok: false,
          code: 'ABSOLUTE_PATH_REQUIRED',
          error: '必须使用已授权文件的绝对路径。',
          path: args.path,
        }
      }
      if (name === 'list_directory' && args.path === outputDirectory) {
        return {
          ok: false,
          code: 'PATH_NOT_AUTHORIZED',
          error: '父目录未获得授权。',
          path: args.path,
          suggestGrantPath: outputDirectory,
          requiredAccessMode: 'read_only',
        }
      }
      if (name === 'list_directory') {
        return {
          ok: false,
          code: 'ABSOLUTE_PATH_REQUIRED',
          error: '没有 workspace 时不能使用相对路径。',
          path: args.path,
        }
      }
      if (name === 'request_directory') {
        return {
          ok: true,
          paused: true,
          clarification: {
            question: 'Please choose and authorize a directory so this task can continue.',
            blocker_kind: 'permission',
            request_type: 'directory',
            access_mode: args.access_mode,
            suggested_path: args.suggested_path,
            purpose: args.purpose,
          },
        }
      }
      throw new Error(`unexpected executor call: ${name}`)
    },
  })

  assert.deepEqual(executed.map((item) => item.name), [
    'grep_code',
    'list_directory',
    'list_directory',
    'request_directory',
  ])
  assert.equal(modelCalls, 5)
  assert.equal(result.paused, true)
  assert.equal(result.clarification.request_type, 'directory')
  assert.equal(result.clarification.access_mode, 'read_write')
  assert.equal(result.clarification.suggested_path, outputDirectory)
  const rejectedClarification = observedRequests[4].findLast((item) => item.role === 'tool')
  assert.match(rejectedClarification.content, /clarification_capability_contradicted/)
})

test('capability-denial clarifications are checked outside direct-execution turns', async () => {
  const names = ['request_clarification', 'bash_exec', 'write_file']
  const specs = names.map((name) => SERVER_TOOL_SPECS.find((item) => item?.function?.name === name))
  assert.equal(specs.every(Boolean), true)

  let modelCalls = 0
  let executorCalls = 0
  const result = await runToolsLoop({
    job: {
      id: 'job-answer-mode-capability-denial',
      userId: null,
      origin: 'background',
      prompt: 'Which document formats are supported?',
    },
    step: { id: 'step-answer-mode-capability-denial', kind: 'chat' },
    messages: [{ role: 'user', content: 'Which document formats are supported?' }],
    toolSpecs: specs,
    maxIters: 3,
    enableToolHooks: false,
    runModel: async ({ messages }) => {
      modelCalls += 1
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [{
            id: 'answer-mode-fake-capability',
            type: 'function',
            function: {
              name: 'request_clarification',
              arguments: JSON.stringify({
                question: '我无法直接编辑 PDF 或生成 PNG 图像（工具集限制）。',
                blocker_kind: 'other',
              }),
            },
          }],
        }
      }
      const previous = JSON.parse(messages.findLast((item) => item.role === 'tool').content)
      assert.equal(previous.code, 'clarification_capability_contradicted')
      return { content: 'The listed tools support file and script-based document workflows.', toolCalls: [] }
    },
    executeTool: async () => {
      executorCalls += 1
      throw new Error('fake clarification must not reach the executor')
    },
  })

  assert.equal(modelCalls, 2)
  assert.equal(executorCalls, 0)
  assert.equal(result.paused, undefined)
  assert.equal(result.text, 'The listed tools support file and script-based document workflows.')
})

test('artifact delivery rejects a fake missing-capability clarification and continues to generation', async () => {
  const createPptx = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'create_pptx')
  const clarification = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'request_clarification')
  let modelCalls = 0
  let generatorCalls = 0
  const result = await runToolsLoop({
    job: { id: 'artifact-capability-job', userId: null, origin: 'chat', prompt: '/ppt Q3 strategy' },
    step: { id: 'artifact-capability-step', kind: 'chat' },
    messages: [{ role: 'user', content: '/ppt Q3 strategy' }],
    skillId: 'ppt',
    toolSpecs: [createPptx, clarification],
    maxIters: 5,
    enableToolHooks: false,
    runModel: async ({ messages }) => {
      modelCalls += 1
      if (modelCalls === 1) {
        const systemText = messages.filter((item) => item.role === 'system').map((item) => item.content).join('\n')
        assert.match(systemText, /\[AVAILABLE TOOL CAPABILITIES\]/)
        return {
          content: '',
          toolCalls: [{
            id: 'fake-artifact-clarification',
            type: 'function',
            function: {
              name: 'request_clarification',
              arguments: JSON.stringify({
                question: 'My toolset does not have file generation capabilities. Should I only give you an outline?',
                blocker_kind: 'other',
              }),
            },
          }],
        }
      }
      if (modelCalls === 2) {
        const previous = JSON.parse(messages.findLast((item) => item.role === 'tool').content)
        assert.equal(previous.code, 'clarification_capability_contradicted')
        assert.deepEqual(previous.availableTools, ['create_pptx'])
        return {
          content: '',
          toolCalls: [{
            id: 'create-real-pptx',
            type: 'function',
            function: {
              name: 'create_pptx',
              arguments: JSON.stringify({ title: 'Q3 strategy', slides: [{ title: 'Priorities' }] }),
            },
          }],
        }
      }
      return { content: 'The presentation was created.', toolCalls: [] }
    },
    executeTool: async ({ name }) => {
      assert.equal(name, 'create_pptx')
      generatorCalls += 1
      return { ok: true, artifactId: 'pptx-artifact-1' }
    },
  })

  assert.equal(modelCalls, 3)
  assert.equal(generatorCalls, 1)
  assert.equal(result.paused, undefined)
  assert.deepEqual(result.artifactIds, ['pptx-artifact-1'])
})

test('a real execution failure still allows a specific clarification', async () => {
  const writeFile = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'write_file')
  const clarification = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'request_clarification')
  let modelCalls = 0
  const executed = []
  const result = await runToolsLoop({
    job: { id: 'real-permission-blocker-job', userId: null, origin: 'chat', prompt: 'Create result.txt now.' },
    step: { id: 'real-permission-blocker-step', kind: 'chat' },
    messages: [{ role: 'user', content: 'Create result.txt now.' }],
    intentMode: 'execute',
    toolSpecs: [writeFile, clarification],
    maxIters: 4,
    enableToolHooks: false,
    runModel: async () => {
      modelCalls += 1
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [{
            id: 'denied-write',
            type: 'function',
            function: { name: 'write_file', arguments: '{"path":"result.txt","content":"done"}' },
          }],
        }
      }
      return {
        content: '',
        toolCalls: [{
          id: 'permission-clarification',
          type: 'function',
          function: {
            name: 'request_clarification',
            arguments: JSON.stringify({
              question: 'The runtime cannot write files because access was denied. Please grant write permission.',
              blocker_kind: 'permission',
            }),
          },
        }],
      }
    },
    executeTool: async ({ name, args }) => {
      executed.push(name)
      if (name === 'write_file') {
        return { ok: false, code: 'FILESYSTEM_WRITE_DENIED', error: 'access denied', status: 403 }
      }
      return {
        ok: true,
        paused: true,
        clarification: { question: args.question, blocker_kind: args.blocker_kind },
      }
    },
  })

  assert.deepEqual(executed, ['write_file', 'request_clarification'])
  assert.equal(modelCalls, 2)
  assert.equal(result.paused, true)
  assert.match(result.clarification.question, /grant write permission/i)
})

test('a mutation request cannot be completed by an unrelated read-only success', async () => {
  const readFile = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'read_file')
  let modelCalls = 0
  const result = await runToolsLoop({
    job: {
      id: 'job-mutation-read-only-bypass',
      userId: null,
      origin: 'chat',
      prompt: 'Create result.txt with the requested content now.',
    },
    step: { id: 'step-mutation-read-only-bypass', kind: 'chat' },
    messages: [{ role: 'user', content: 'Create result.txt with the requested content now.' }],
    toolSpecs: [readFile],
    maxIters: 4,
    enableToolHooks: false,
    runModel: async () => {
      modelCalls += 1
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [{
            id: 'read-unrelated',
            type: 'function',
            function: { name: 'read_file', arguments: JSON.stringify({ path: 'README.md' }) },
          }],
        }
      }
      return { content: 'The file is complete.', toolCalls: [] }
    },
    executeTool: async () => ({ ok: true, content: '# Existing project' }),
  })

  assert.equal(result.incomplete, true)
  assert.equal(result.reason, 'execution_evidence_missing')
  assert.equal(modelCalls, 3)
})

test('a verification-only continuation ignores injected mutation wording and completes from real reads', async () => {
  const readFile = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'read_file')
  const listDirectory = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'list_directory')
  const outputDirectory = 'D:\\verified-output'
  const outputPath = `${outputDirectory}\\filled.pdf`
  const executed = []
  let modelCalls = 0
  const userPrompt = [
    `Read back ${outputPath}, then completely list ${outputDirectory}.`,
    'Do not regenerate the PDF or write any files.',
  ].join(' ')

  const result = await runToolsLoop({
    job: {
      id: 'job-verification-only-continuation',
      userId: null,
      origin: 'chat',
      userPrompt,
      prompt: `[LOCAL PATH ACCESS GRANTED] For text changes, use write_file. Create or modify the deliverable.\n\n${userPrompt}`,
    },
    step: { id: 'step-verification-only-continuation', kind: 'chat' },
    messages: [{ role: 'user', content: userPrompt }],
    intentMode: 'execute',
    toolSpecs: [readFile, listDirectory],
    maxIters: 3,
    enableToolHooks: false,
    runModel: async () => {
      modelCalls += 1
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [
            {
              id: 'verify-read',
              type: 'function',
              function: { name: 'read_file', arguments: JSON.stringify({ path: outputPath }) },
            },
            {
              id: 'verify-list',
              type: 'function',
              function: { name: 'list_directory', arguments: JSON.stringify({ path: outputDirectory, limit: 100 }) },
            },
          ],
        }
      }
      return { content: 'Readback and complete directory verification succeeded.', toolCalls: [] }
    },
    executeTool: async ({ name }) => {
      executed.push(name)
      if (name === 'read_file') return { ok: true, path: outputPath, content: 'PDF' }
      return { ok: true, path: outputDirectory, total: 1, truncated: false, entries: [{ name: 'filled.pdf' }] }
    },
  })

  assert.deepEqual(executed.sort(), ['list_directory', 'read_file'])
  assert.equal(result.incomplete, undefined)
  assert.equal(result.text, 'Readback and complete directory verification succeeded.')
})

test('explicit execute mode cannot claim completion when no substantive tool is available', async () => {
  let modelCalls = 0
  const result = await runToolsLoop({
    job: { id: 'job-explicit-execute-no-tools', userId: null, origin: 'chat', prompt: 'Explain the current state.' },
    step: { id: 'step-explicit-execute-no-tools', kind: 'chat' },
    messages: [{ role: 'user', content: 'Explain the current state.' }],
    intentMode: 'execute',
    toolSpecs: [],
    maxIters: 1,
    enableToolHooks: false,
    runModel: async () => {
      modelCalls += 1
      return { content: 'Everything is done.', toolCalls: [] }
    },
  })

  assert.equal(modelCalls, 1)
  assert.equal(result.incomplete, true)
  assert.equal(result.reason, 'execution_evidence_missing')
  assert.doesNotMatch(result.text, /Everything is done/)
})

test('iteration limit cannot turn a failed mutation into a completed answer', async () => {
  const writeFile = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'write_file')
  let modelCalls = 0
  const result = await runToolsLoop({
    job: { id: 'job-final-round-failed-write', userId: null, origin: 'chat', prompt: 'Create result.txt now.' },
    step: { id: 'step-final-round-failed-write', kind: 'chat' },
    messages: [{ role: 'user', content: 'Create result.txt now.' }],
    toolSpecs: [writeFile],
    maxIters: 1,
    enableToolHooks: false,
    runModel: async ({ toolChoice }) => {
      modelCalls += 1
      if (toolChoice === 'none') return { content: 'The file could not be created.', toolCalls: [] }
      return {
        content: '',
        toolCalls: [{
          id: 'failed-write',
          type: 'function',
          function: { name: 'write_file', arguments: JSON.stringify({ path: 'result.txt', content: 'hello' }) },
        }],
      }
    },
    executeTool: async () => ({ ok: false, code: 'FILESYSTEM_WRITE_DENIED', error: 'denied' }),
  })

  assert.equal(modelCalls, 2)
  assert.equal(result.incomplete, true)
  assert.equal(result.reason, 'execution_evidence_missing')
})

test('iteration limit cannot bypass verification after a successful local mutation', async () => {
  const writeFile = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'write_file')
  const readFile = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'read_file')
  const result = await runToolsLoop({
    job: { id: 'job-final-round-unverified-write', userId: null, origin: 'chat', prompt: 'Create result.txt now and verify it.' },
    step: { id: 'step-final-round-unverified-write', kind: 'chat' },
    messages: [{ role: 'user', content: 'Create result.txt now and verify it.' }],
    toolSpecs: [writeFile, readFile],
    maxIters: 1,
    enableToolHooks: false,
    runModel: async ({ toolChoice }) => (
      toolChoice === 'none'
        ? { content: 'The file was written but verification is still pending.', toolCalls: [] }
        : {
            content: '',
            toolCalls: [{
              id: 'successful-write',
              type: 'function',
              function: { name: 'write_file', arguments: JSON.stringify({ path: 'result.txt', content: 'hello' }) },
            }],
          }
    ),
    executeTool: async () => ({ ok: true, path: 'result.txt', bytes: 5 }),
  })

  assert.equal(result.incomplete, true)
  assert.equal(result.reason, 'post_mutation_verification_missing')
})

test('shell writes stay pending until the matching target is read back', async () => {
  const bashExec = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'bash_exec')
  const readFile = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'read_file')
  const observedRequests = []
  const executed = []
  let modelCalls = 0
  const result = await runToolsLoop({
    job: {
      id: 'job-shell-target-verification',
      userId: null,
      origin: 'chat',
      prompt: 'Create result.txt with hello by running a command, then verify the file.',
    },
    step: { id: 'step-shell-target-verification', kind: 'chat' },
    messages: [{ role: 'user', content: 'Create result.txt with hello by running a command, then verify the file.' }],
    toolSpecs: [bashExec, readFile],
    maxIters: 8,
    enableToolHooks: false,
    runModel: async ({ messages }) => {
      modelCalls += 1
      observedRequests.push(structuredClone(messages))
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [{
            id: 'shell-write-result',
            type: 'function',
            function: { name: 'bash_exec', arguments: JSON.stringify({ command: 'echo hello > result.txt' }) },
          }],
        }
      }
      if (modelCalls === 2 || modelCalls === 4) {
        return { content: 'The file has been created.', toolCalls: [] }
      }
      if (modelCalls === 3) {
        return {
          content: '',
          toolCalls: [{
            id: 'read-wrong-target',
            type: 'function',
            function: { name: 'read_file', arguments: JSON.stringify({ path: 'README.md' }) },
          }],
        }
      }
      if (modelCalls === 5) {
        return {
          content: '',
          toolCalls: [{
            id: 'read-right-target',
            type: 'function',
            function: { name: 'read_file', arguments: JSON.stringify({ path: 'result.txt' }) },
          }],
        }
      }
      return { content: 'Created and verified result.txt.', toolCalls: [] }
    },
    executeTool: async ({ name, args }) => {
      executed.push(`${name}:${args.path || args.command}`)
      if (name === 'bash_exec') return { ok: true, exitCode: 0, stdout: '' }
      return { ok: true, content: args.path === 'result.txt' ? 'hello' : '# Gugo' }
    },
  })

  assert.equal(result.text, 'Created and verified result.txt.')
  assert.equal(result.incomplete, undefined, JSON.stringify({
    reason: result.reason,
    text: result.text,
    modelCalls,
  }))
  assert.deepEqual(executed, [
    'bash_exec:echo hello > result.txt',
    'read_file:README.md',
    'read_file:result.txt',
  ])
  const firstGuard = observedRequests[2].filter((item) => item.role === 'system').map((item) => item.content).join('\n')
  const secondGuard = observedRequests[4].filter((item) => item.role === 'system').map((item) => item.content).join('\n')
  assert.match(firstGuard, /Pending changed targets: result\.txt/)
  assert.match(secondGuard, /Pending changed targets: result\.txt/)
})

test('a compound generation and project-check command remains a pending mutation', async () => {
  const bashExec = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'bash_exec')
  const outputPath = 'generated/output.pdf'
  let modelCalls = 0
  let checkpoint = null

  const result = await runToolsLoop({
    job: {
      id: 'compound-generation-project-check-job',
      userId: null,
      origin: 'chat',
      prompt: 'Generate output.pdf by running code, then run the project tests.',
    },
    step: { id: 'compound-generation-project-check-step', kind: 'chat' },
    messages: [{
      role: 'user',
      content: 'Generate output.pdf by running code, then run the project tests.',
    }],
    intentMode: 'execute',
    toolSpecs: [bashExec],
    maxIters: 4,
    enableToolHooks: false,
    saveCheckpoint: async (state) => {
      checkpoint = structuredClone(state)
      return true
    },
    runModel: async () => {
      modelCalls += 1
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [{
            id: 'generate-and-test',
            type: 'function',
            function: {
              name: 'bash_exec',
              arguments: JSON.stringify({
                command: 'python generate.py && npm test',
                expected_outputs: [outputPath],
              }),
            },
          }],
        }
      }
      return { content: 'The PDF was generated and the tests passed.', toolCalls: [] }
    },
    executeTool: async () => ({
      ok: true,
      exitCode: 0,
      cwd: '.',
      changedPaths: [outputPath],
      stdout: 'tests passed',
    }),
  })

  assert.equal(result.incomplete, true)
  assert.equal(result.reason, 'post_mutation_verification_missing')
  assert.equal(checkpoint?.completionGuards?.mutationExecutionObserved, true)
  assert.ok(
    (checkpoint?.completionGuards?.pendingMutationTargets || []).includes(outputPath),
  )
})

test('verified directory resume rejects a repeated authorization wait claim and continues into execution', async () => {
  const bashExec = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'bash_exec')
  const readFile = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'read_file')
  const directory = 'D:\\gugo-inline-auth-e2e'
  const outputPath = `${directory}\\authorized-resume.txt`
  const checkpoint = {
    messages: [
      { role: 'user', content: `Create ${outputPath} with code execution, then read it back.` },
      {
        role: 'system',
        content: `[TURN_RESOLUTION:33] The requested local directory authorization is already persisted and verified. Continue the original task using the exact authorized path ${JSON.stringify(directory)} with read_write access.`,
      },
    ],
    iterations: 0,
    completionGuards: {},
  }
  const modelRequests = []
  let modelCalls = 0
  let executions = 0

  const result = await runToolsLoop({
    job: {
      id: 'verified-directory-resume-job',
      userId: null,
      origin: 'chat',
      prompt: `Create ${outputPath} with code execution, then read it back.`,
    },
    step: { id: 'verified-directory-resume-step', kind: 'chat' },
    messages: checkpoint.messages,
    intentMode: 'execute',
    toolSpecs: [bashExec, readFile],
    maxIters: 6,
    enableToolHooks: false,
    loadCheckpoint: async () => structuredClone(checkpoint),
    runModel: async (request) => {
      modelRequests.push(structuredClone(request.messages))
      modelCalls += 1
      if (modelCalls === 1) {
        return {
          content: '\u76ee\u5f55\u6388\u6743\u8bf7\u6c42\u5df2\u53d1\u51fa\uff0c\u8bf7\u5728\u5f39\u51fa\u7684\u9009\u62e9\u5668\u4e2d\u9009\u62e9\u5e76\u6388\u6743\u76ee\u6807\u76ee\u5f55\u3002\u6211\u5728\u7b49\u5f85\u4f60\u7684\u9009\u62e9\u3002',
          toolCalls: [],
        }
      }
      if (modelCalls === 2) {
        return {
          content: '',
          toolCalls: [{
            id: 'list-authorized-directory',
            type: 'function',
            function: {
              name: 'bash_exec',
              arguments: JSON.stringify({
                command: "Set-Content -LiteralPath 'authorized-resume.txt' -Value 'INLINE_AUTH_RESUMED'",
                cwd: directory,
                expected_outputs: ['authorized-resume.txt'],
              }),
            },
          }],
        }
      }
      if (modelCalls === 3) {
        return {
          content: '',
          toolCalls: [{
            id: 'verify-authorized-file',
            type: 'function',
            function: {
              name: 'read_file',
              arguments: JSON.stringify({ path: outputPath }),
            },
          }],
        }
      }
      return { content: 'The authorized file was created and verified successfully.', toolCalls: [] }
    },
    executeTool: async ({ name, args }) => {
      executions += 1
      if (name === 'bash_exec') {
        assert.equal(args.cwd, directory)
        return {
          ok: true,
          exitCode: 0,
          stdout: '',
          cwd: directory,
          changedPaths: ['authorized-resume.txt'],
        }
      }
      assert.equal(name, 'read_file')
      assert.equal(args.path, outputPath)
      return { ok: true, path: outputPath, content: 'INLINE_AUTH_RESUMED' }
    },
  })

  assert.equal(result.text, 'The authorized file was created and verified successfully.')
  assert.equal(result.incomplete, undefined)
  assert.equal(modelCalls, 4)
  assert.equal(executions, 2)
  assert.ok(modelRequests[1].some((message) => (
    message.role === 'system'
      && String(message.content || '').includes('[VERIFIED DIRECTORY RESUME REQUIRED]')
  )))
})

test('a PDF read with no extracted text cannot clear post-mutation verification', async () => {
  const bashExec = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'bash_exec')
  const readFile = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'read_file')
  const pdfPath = 'output.pdf'
  let modelCalls = 0
  const executed = []
  const result = await runToolsLoop({
    job: {
      id: 'job-pdf-no-text-verification',
      userId: null,
      origin: 'chat',
      prompt: 'Write the answer into output.pdf and verify it.',
    },
    step: { id: 'step-pdf-no-text-verification', kind: 'chat' },
    messages: [{ role: 'user', content: 'Write the answer into output.pdf and verify it.' }],
    toolSpecs: [bashExec, readFile],
    maxIters: 6,
    enableToolHooks: false,
    runModel: async () => {
      modelCalls += 1
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [{
            id: 'write-scanned-pdf',
            type: 'function',
            function: {
              name: 'bash_exec',
              arguments: JSON.stringify({ command: 'python create_pdf.py', expected_outputs: [pdfPath] }),
            },
          }],
        }
      }
      if (modelCalls === 2) {
        return {
          content: '',
          toolCalls: [{
            id: 'read-scanned-pdf',
            type: 'function',
            function: { name: 'read_file', arguments: JSON.stringify({ path: pdfPath }) },
          }],
        }
      }
      return { content: 'The PDF is complete and verified.', toolCalls: [] }
    },
    executeTool: async ({ name }) => {
      executed.push(name)
      if (name === 'bash_exec') return { ok: true, exitCode: 0, stdout: '' }
      return {
        ok: true,
        path: pdfPath,
        content: '[PDF file has no extractable text]',
        mimeType: 'application/pdf',
        extractionStatus: 'no_text',
        requiresVision: true,
      }
    },
  })

  assert.deepEqual(executed, ['bash_exec', 'read_file'])
  assert.equal(result.incomplete, true)
  assert.equal(result.reason, 'post_mutation_verification_missing')
})

test('local file mutations require a successful verification before completion', async () => {
  const writeFile = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'write_file')
  const readFile = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'read_file')
  const observedRequests = []
  let modelCalls = 0
  const executed = []
  const result = await runToolsLoop({
    job: {
      id: 'job-mutation-verification',
      userId: null,
      origin: 'chat',
      prompt: '创建文件 result.txt，写入 hello，然后检查结果。',
    },
    step: { id: 'step-mutation-verification', kind: 'chat' },
    messages: [{ role: 'user', content: '创建文件 result.txt，写入 hello，然后检查结果。' }],
    toolSpecs: [writeFile, readFile],
    maxIters: 6,
    enableToolHooks: false,
    runModel: async ({ messages }) => {
      modelCalls += 1
      observedRequests.push(structuredClone(messages))
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [{
            id: 'write-result',
            type: 'function',
            function: { name: 'write_file', arguments: JSON.stringify({ path: 'result.txt', content: 'hello' }) },
          }],
        }
      }
      if (modelCalls === 2) return { content: '文件已经创建完成。', toolCalls: [] }
      if (modelCalls === 3) {
        return {
          content: '',
          toolCalls: [{
            id: 'verify-result',
            type: 'function',
            function: { name: 'read_file', arguments: JSON.stringify({ path: 'result.txt' }) },
          }],
        }
      }
      return { content: '文件已创建并读回验证。', toolCalls: [] }
    },
    executeTool: async ({ name }) => {
      executed.push(name)
      return name === 'write_file'
        ? { ok: true, path: 'result.txt', bytes: 5 }
        : { ok: true, content: 'hello' }
    },
  })

  assert.deepEqual(executed, ['write_file', 'read_file'])
  assert.equal(modelCalls, 4)
  assert.equal(result.text, '文件已创建并读回验证。')
  const correction = observedRequests[2]
    .filter((item) => item.role === 'system')
    .map((item) => item.content)
    .join('\n')
  assert.match(correction, /\[POST-MUTATION VERIFICATION REQUIRED\]/)
})

async function runGitDiffVerificationScenario(diffResult) {
  const writeFile = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'write_file')
  const gitDiff = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'git_diff')
  let modelCalls = 0
  return runToolsLoop({
    job: { id: 'git-diff-verification-job', userId: null, origin: 'chat', prompt: 'Update src/result.js and verify it.' },
    step: { id: 'git-diff-verification-step', kind: 'chat' },
    messages: [{ role: 'user', content: 'Update src/result.js and verify it.' }],
    toolSpecs: [writeFile, gitDiff],
    maxIters: 3,
    enableToolHooks: false,
    runModel: async () => {
      modelCalls += 1
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [{
            id: 'write-result-js',
            type: 'function',
            function: {
              name: 'write_file',
              arguments: '{"path":"src/result.js","content":"export default true\\n"}',
            },
          }],
        }
      }
      if (modelCalls === 2) {
        return {
          content: '',
          toolCalls: [{
            id: 'inspect-result-diff',
            type: 'function',
            function: { name: 'git_diff', arguments: '{}' },
          }],
        }
      }
      return { content: 'Updated and verified src/result.js.', toolCalls: [] }
    },
    executeTool: async ({ name }) => name === 'write_file'
      ? { ok: true, path: 'src/result.js', bytes: 20 }
      : { ok: true, exitCode: 0, ...diffResult },
  })
}

test('an empty git diff cannot verify a local mutation', async () => {
  const result = await runGitDiffVerificationScenario({ path: null, diff: '', stat: '' })
  assert.equal(result.incomplete, true)
  assert.equal(result.reason, 'post_mutation_verification_missing')
})

test('a git diff for an unrelated file cannot verify a local mutation', async () => {
  const result = await runGitDiffVerificationScenario({
    path: 'README.md',
    diff: 'diff --git a/README.md b/README.md\n+++ b/README.md\n+changed',
  })
  assert.equal(result.incomplete, true)
  assert.equal(result.reason, 'post_mutation_verification_missing')
})

test('a non-empty structured git diff verifies only its matching mutation target', async () => {
  const result = await runGitDiffVerificationScenario({
    diff: 'structured diff evidence',
    changedFiles: ['src/result.js'],
  })
  assert.equal(result.incomplete, undefined)
  assert.equal(result.text, 'Updated and verified src/result.js.')
})

test('failed artifact tools cannot satisfy delivery with a dangling artifact id', async () => {
  const createDocx = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'create_docx')
  let modelCalls = 0
  await assert.rejects(
    () => runToolsLoop({
      job: {
        id: 'job-failed-artifact-id',
        userId: null,
        origin: 'chat',
        prompt: '生成一个 Word 文档介绍 Gugo。',
      },
      step: { id: 'step-failed-artifact-id', kind: 'chat' },
      messages: [{ role: 'user', content: '生成一个 Word 文档介绍 Gugo。' }],
      toolSpecs: [createDocx],
      maxIters: 2,
      enableToolHooks: false,
      runModel: async () => {
        modelCalls += 1
        if (modelCalls === 1) {
          return {
            content: '',
            toolCalls: [{
              id: 'create-broken-docx',
              type: 'function',
              function: {
                name: 'create_docx',
                arguments: JSON.stringify({ title: 'Gugo', markdown: '# Gugo' }),
              },
            }],
          }
        }
        return { content: '文档已生成。', toolCalls: [] }
      },
      executeTool: async () => ({
        ok: false,
        code: 'artifact_write_failed',
        error: 'failed to persist artifact bytes',
        artifactId: 'dangling-partial-id',
      }),
    }),
    (error) => error?.code === 'ARTIFACT_NOT_CREATED',
  )
})

test('a successful parallel read clears failures from earlier candidates', async () => {
  const readFile = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'read_file')
  let modelCalls = 0
  const result = await runToolsLoop({
    job: { id: 'job-parallel-progress', userId: null, origin: 'chat', prompt: '读取候选文件并总结' },
    step: { id: 'step-parallel-progress', kind: 'chat' },
    messages: [{ role: 'user', content: '读取候选文件并总结' }],
    toolSpecs: [readFile],
    maxIters: 3,
    enableToolHooks: false,
    runModel: async () => {
      modelCalls += 1
      if (modelCalls > 1) return { content: '已读取有效文件', toolCalls: [] }
      return {
        content: '',
        toolCalls: Array.from({ length: 5 }, (_, index) => ({
          id: `parallel-read-${index}`,
          type: 'function',
          function: {
            name: 'read_file',
            arguments: JSON.stringify({ path: `candidate-${index}.txt` }),
          },
        })),
      }
    },
    executeTool: async ({ args }) => (
      args.path === 'candidate-4.txt'
        ? { ok: true, content: '有效内容' }
        : { ok: false, code: 'ENOENT', error: 'not found' }
    ),
  })
  assert.equal(result.noProgress, undefined)
  assert.equal(result.text, '已读取有效文件')
  assert.equal(modelCalls, 2)
})

test('empty model output persists the non-empty wrap-up checkpoint', async () => {
  const checkpoints = []
  let modelCalls = 0
  const first = await runToolsLoop({
    job: { id: 'job-empty-final', userId: null, origin: 'chat', prompt: '给出结果' },
    step: { id: 'step-empty-final', kind: 'chat' },
    messages: [{ role: 'user', content: '给出结果' }],
    toolSpecs: [],
    maxIters: 1,
    enableToolHooks: false,
    saveCheckpoint: async (state) => {
      checkpoints.push(structuredClone(state))
      return true
    },
    runModel: async ({ toolChoice }) => {
      modelCalls += 1
      return toolChoice === 'none'
        ? { content: '已完成收尾', toolCalls: [] }
        : { content: '', toolCalls: [] }
    },
  })
  assert.equal(first.text, '已完成收尾')
  assert.equal(modelCalls, 2)
  assert.equal(checkpoints.at(-1)?.final?.text, '已完成收尾')

  const resumed = await runToolsLoop({
    job: { id: 'job-empty-final', userId: null, origin: 'chat', prompt: '给出结果' },
    step: { id: 'step-empty-final', kind: 'chat' },
    messages: [{ role: 'user', content: '给出结果' }],
    toolSpecs: [],
    maxIters: 1,
    enableToolHooks: false,
    loadCheckpoint: async () => checkpoints.at(-1),
    runModel: async () => { throw new Error('model must not be called while resuming') },
  })
  assert.equal(resumed.text, '已完成收尾')
  assert.equal(resumed.resumed, true)
})

test('tool loop retries transient read failures but never replays an external write', async () => {
  const readFile = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'read_file')
  let readModelCalls = 0
  let readExecutions = 0
  const outcomes = []
  const readResult = await runToolsLoop({
    job: { id: 'retry-read-job', userId: null, origin: 'chat', prompt: 'read README.md' },
    step: { id: 'retry-read-step', kind: 'chat' },
    messages: [{ role: 'user', content: 'read README.md' }],
    toolSpecs: [readFile],
    enableToolHooks: false,
    toolRetryBaseDelayMs: 0,
    runModel: async () => {
      readModelCalls += 1
      return readModelCalls === 1
        ? { content: '', toolCalls: [{ id: 'retry-read', type: 'function', function: { name: 'read_file', arguments: '{"path":"README.md"}' } }] }
        : { content: 'read completed', toolCalls: [] }
    },
    executeTool: async () => {
      readExecutions += 1
      return readExecutions === 1
        ? { ok: false, code: 'FS_BUSY', error: 'temporarily busy', status: 503, retryable: true }
        : { ok: true, content: 'README' }
    },
    onToolCompleted: async (outcome) => outcomes.push(outcome.result),
  })
  assert.equal(readResult.text, 'read completed')
  assert.equal(readExecutions, 2)
  assert.equal(outcomes[0].attempts, 2)

  const externalSpec = {
    type: 'function',
    function: { name: 'external_send', parameters: { type: 'object', properties: {}, required: [] } },
  }
  let externalModelCalls = 0
  let externalExecutions = 0
  await runToolsLoop({
    job: { id: 'retry-external-job', userId: null, origin: 'chat', prompt: 'send externally' },
    step: { id: 'retry-external-step', kind: 'chat' },
    messages: [{ role: 'user', content: 'send externally' }],
    toolSpecs: [externalSpec],
    enableToolHooks: false,
    toolRetryBaseDelayMs: 0,
    requestToolApproval: async ({ args }) => ({ proceed: true, args }),
    runModel: async () => {
      externalModelCalls += 1
      return externalModelCalls === 1
        ? { content: '', toolCalls: [{ id: 'external-write', type: 'function', function: { name: 'external_send', arguments: '{}' } }] }
        : { content: 'external send failed safely', toolCalls: [] }
    },
    executeTool: async () => {
      externalExecutions += 1
      return { ok: false, code: 'UPSTREAM_503', error: 'unknown outcome', status: 503, retryable: true }
    },
  })
  assert.equal(externalExecutions, 1)
})

test('concurrency-safe metadata cannot make an external write replay after a crash', async (t) => {
  const toolName = 'test_parallel_external_write'
  const externalSpec = {
    type: 'function',
    function: {
      name: toolName,
      parameters: {
        type: 'object',
        properties: { target: { type: 'string' } },
        required: ['target'],
      },
    },
  }
  registerDynamicTool({
    name: toolName,
    origin: 'mcp',
    spec: externalSpec,
    metadata: {
      riskClass: 'external',
      isReadOnly: false,
      isConcurrencySafe: true,
      isIdempotent: false,
      interruptBehavior: 'block',
    },
  })
  t.after(() => unregisterDynamicTool(toolName))

  let checkpoint = null
  let active = 0
  let maxActive = 0
  const executions = new Map()
  const executeExternalWrite = async ({ args }) => {
    const target = args.target
    const count = (executions.get(target) || 0) + 1
    executions.set(target, count)
    active += 1
    maxActive = Math.max(maxActive, active)
    await new Promise((resolve) => setTimeout(resolve, 10))
    active -= 1
    if (target === 'first' && count === 1) {
      const error = new Error('process stopped after the external side effect')
      error.name = 'AbortError'
      throw error
    }
    return { ok: true, externalId: `${target}-${count}` }
  }

  await assert.rejects(
    runToolsLoop({
      job: { id: 'external-crash-job', userId: null, origin: 'chat', prompt: 'send both externally' },
      step: { id: 'external-crash-step', kind: 'chat' },
      messages: [{ role: 'user', content: 'send both externally' }],
      intentMode: 'execute',
      toolSpecs: [externalSpec],
      maxIters: 3,
      enableToolHooks: false,
      saveCheckpoint: async (state) => {
        checkpoint = structuredClone(state)
        return true
      },
      requestToolApproval: async ({ args }) => ({ proceed: true, args }),
      runModel: async () => ({
        content: '',
        toolCalls: [
          { id: 'external-first', type: 'function', function: { name: toolName, arguments: '{"target":"first"}' } },
          { id: 'external-second', type: 'function', function: { name: toolName, arguments: '{"target":"second"}' } },
        ],
      }),
      executeTool: executeExternalWrite,
    }),
    (error) => error?.name === 'AbortError',
  )
  await new Promise((resolve) => setTimeout(resolve, 30))

  assert.equal(checkpoint.toolCalls[0].checkpointStatus, 'executing')
  assert.equal(checkpoint.toolCalls[1].checkpointStatus, 'pending')

  const resumed = await runToolsLoop({
    job: { id: 'external-crash-job', userId: null, origin: 'chat', prompt: 'send both externally' },
    step: { id: 'external-crash-step', kind: 'chat' },
    messages: [{ role: 'user', content: 'send both externally' }],
    intentMode: 'execute',
    toolSpecs: [externalSpec],
    maxIters: 3,
    enableToolHooks: false,
    loadCheckpoint: async () => checkpoint,
    saveCheckpoint: async (state) => {
      checkpoint = structuredClone(state)
      return true
    },
    requestToolApproval: async ({ args }) => ({ proceed: true, args }),
    runModel: async () => ({ content: 'The external writes were reconciled.', toolCalls: [] }),
    executeTool: executeExternalWrite,
  })

  assert.equal(resumed.text, 'The external writes were reconciled.')
  assert.equal(executions.get('first'), 1)
  assert.equal(executions.get('second'), 1)
  assert.equal(maxActive, 1)
})

test('approval event failures cannot turn a completed external write into a retry', async () => {
  const toolName = 'approval_callback_external_write'
  const externalSpec = {
    type: 'function',
    function: {
      name: toolName,
      parameters: {
        type: 'object',
        properties: { message: { type: 'string' } },
        required: ['message'],
      },
    },
  }
  let modelCalls = 0
  let externalWrites = 0
  const result = await runToolsLoop({
    job: { id: 'approval-event-job', userId: null, origin: 'job', prompt: 'notify the recipient' },
    step: { id: 'approval-event-step', kind: 'execute' },
    messages: [{ role: 'user', content: 'notify the recipient' }],
    toolSpecs: [externalSpec],
    maxIters: 4,
    enableToolHooks: false,
    requestToolApproval: async ({ args }) => ({
      proceed: true,
      args,
      approvalId: `approval-${externalWrites + 1}`,
    }),
    onApprovalResolved: async () => {
      throw new Error('approval event sink unavailable')
    },
    runModel: async ({ messages }) => {
      modelCalls += 1
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [{
            id: 'external-write-first',
            type: 'function',
            function: { name: toolName, arguments: '{"message":"hello"}' },
          }],
        }
      }
      const previous = messages.findLast((message) => message.role === 'tool')
      const previousResult = previous ? JSON.parse(previous.content) : null
      if (previousResult?.ok === false) {
        return {
          content: '',
          toolCalls: [{
            id: `external-write-retry-${modelCalls}`,
            type: 'function',
            function: { name: toolName, arguments: '{"message":"hello"}' },
          }],
        }
      }
      return { content: 'Notification sent once.', toolCalls: [] }
    },
    executeTool: async () => {
      externalWrites += 1
      return { ok: true, externalId: `sent-${externalWrites}` }
    },
  })

  assert.equal(result.text, 'Notification sent once.')
  assert.equal(externalWrites, 1)
  assert.equal(modelCalls, 2)
})

test('a successful MCP mutation satisfies execution evidence without repeating the external write', async (t) => {
  const toolName = 'mcp__test_jira__create_issue'
  const externalSpec = {
    type: 'function',
    function: {
      name: toolName,
      parameters: {
        type: 'object',
        properties: { title: { type: 'string' } },
        required: ['title'],
      },
    },
  }
  registerDynamicTool({
    name: toolName,
    origin: 'mcp',
    spec: externalSpec,
    metadata: {
      riskClass: 'external',
      isReadOnly: false,
      isConcurrencySafe: false,
      isIdempotent: false,
    },
  })
  t.after(() => unregisterDynamicTool(toolName))

  let modelCalls = 0
  let externalWrites = 0
  const result = await runToolsLoop({
    job: { id: 'mcp-mutation-job', userId: null, origin: 'chat', prompt: 'Create a Jira issue for the release blocker.' },
    step: { id: 'mcp-mutation-step', kind: 'chat' },
    messages: [{ role: 'user', content: 'Create a Jira issue for the release blocker.' }],
    intentMode: 'execute',
    toolSpecs: [externalSpec],
    maxIters: 5,
    enableToolHooks: false,
    requestToolApproval: async ({ args }) => ({ proceed: true, args }),
    runModel: async ({ messages }) => {
      modelCalls += 1
      if (modelCalls === 1 || messages.some((message) => (
        message.role === 'system' && String(message.content).includes('[EXECUTION EVIDENCE REQUIRED]')
      ))) {
        return {
          content: '',
          toolCalls: [{
            id: `jira-create-${modelCalls}`,
            type: 'function',
            function: { name: toolName, arguments: '{"title":"Release blocker"}' },
          }],
        }
      }
      return { content: 'Created the Jira issue.', toolCalls: [] }
    },
    executeTool: async () => {
      externalWrites += 1
      return { ok: true, issueKey: `GUGO-${externalWrites}` }
    },
  })

  assert.equal(result.text, 'Created the Jira issue.')
  assert.equal(result.incomplete, undefined)
  assert.equal(externalWrites, 1)
  assert.equal(modelCalls, 2)
})

test('two failures from the same tool inject concrete recovery context and a later success resets the streak', async () => {
  const readFile = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'read_file')
  const observedRequests = []
  let modelCalls = 0
  let executions = 0

  const result = await runToolsLoop({
    job: {
      id: 'tool-failure-recovery-job',
      userId: null,
      origin: 'chat',
      prompt: 'Read the available configuration file and summarize it.',
    },
    step: { id: 'tool-failure-recovery-step', kind: 'chat' },
    messages: [{ role: 'user', content: 'Read the available configuration file and summarize it.' }],
    toolSpecs: [readFile],
    maxIters: 6,
    enableToolHooks: false,
    runModel: async ({ messages }) => {
      modelCalls += 1
      observedRequests.push(structuredClone(messages))
      if (modelCalls <= 2) {
        return {
          content: '',
          toolCalls: [{
            id: `missing-config-${modelCalls}`,
            type: 'function',
            function: {
              name: 'read_file',
              arguments: JSON.stringify({ path: `missing-${modelCalls}.json` }),
            },
          }],
        }
      }
      if (modelCalls === 3) {
        const recovery = messages.findLast((message) => (
          message.role === 'system'
          && String(message.content).includes('[TOOL FAILURE RECOVERY REQUIRED]')
        ))
        assert.ok(recovery)
        assert.match(recovery.content, /missing-1\.json was not found/)
        assert.match(recovery.content, /missing-2\.json was not found/)
        return {
          content: '',
          toolCalls: [{
            id: 'read-known-config',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"config.json"}' },
          }],
        }
      }
      if (modelCalls === 4) {
        return {
          content: '',
          toolCalls: [{
            id: 'read-one-more-missing-config',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"missing-after-success.json"}' },
          }],
        }
      }
      return { content: 'The configuration was read and summarized.', toolCalls: [] }
    },
    executeTool: async ({ args }) => {
      executions += 1
      if (args.path === 'config.json') return { ok: true, path: args.path, content: '{"enabled":true}' }
      return {
        ok: false,
        code: 'file_not_found',
        error: `${args.path} was not found`,
        retryable: false,
      }
    },
  })

  const recoveryMarkers = observedRequests[4].filter((message) => (
    message.role === 'system'
    && String(message.content).includes('[TOOL FAILURE RECOVERY REQUIRED]')
  ))
  assert.equal(recoveryMarkers.length, 1, 'one failure after a success must not trigger a second recovery')
  assert.equal(result.text, 'The configuration was read and summarized.')
  assert.equal(modelCalls, 5)
  assert.equal(executions, 4)
})

test('complete directory evidence clears PDF and PNG while read-only Python creates no new mutations', async () => {
  const bashExec = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'bash_exec')
  const listDirectory = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'list_directory')
  const pdfPath = 'D:\\destok\\filled-answer.pdf'
  const pngPath = 'D:\\destok\\filled-answer.png'
  const normalizedPngPath = pngPath.replaceAll('\\', '/')
  const pendingSnapshots = []
  const executed = []
  let modelCalls = 0
  let correctDirectoryLists = 0

  const result = await runToolsLoop({
    job: {
      id: 'python-read-verification-job',
      userId: null,
      origin: 'chat',
      prompt: `Create ${pdfPath} and ${pngPath}, then verify both generated files.`,
    },
    step: { id: 'python-read-verification-step', kind: 'chat' },
    messages: [{
      role: 'user',
      content: `Create ${pdfPath} and ${pngPath}, then verify both generated files.`,
    }],
    intentMode: 'execute',
    toolSpecs: [bashExec, listDirectory],
    maxIters: 10,
    enableToolHooks: false,
    saveCheckpoint: async (state) => {
      pendingSnapshots.push([...(state?.completionGuards?.pendingMutationTargets || [])])
      return true
    },
    runModel: async () => {
      modelCalls += 1
      const pending = pendingSnapshots.at(-1) || []
      if (modelCalls === 2 || modelCalls === 3) assert.equal(pending.length, 2)
      if ([4, 5].includes(modelCalls)) assert.deepEqual(pending, [normalizedPngPath])
      if ([6, 7, 8, 9, 10].includes(modelCalls)) assert.deepEqual(pending, [])
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [{
            id: 'generate-pdf-and-png',
            type: 'function',
            function: {
              name: 'bash_exec',
              arguments: JSON.stringify({
                command: 'python create_outputs.py',
                expected_outputs: [pdfPath, pngPath],
              }),
            },
          }],
        }
      }
      if (modelCalls === 2) {
        return {
          content: '',
          toolCalls: [{
            id: 'list-wrong-parent',
            type: 'function',
            function: {
              name: 'list_directory',
              arguments: JSON.stringify({ path: 'D:\\other' }),
            },
          }],
        }
      }
      if (modelCalls === 3) {
        return {
          content: '',
          toolCalls: [{
            id: 'list-partial-correct-parent',
            type: 'function',
            function: {
              name: 'list_directory',
              arguments: JSON.stringify({ path: 'D:\\destok' }),
            },
          }],
        }
      }
      if (modelCalls === 4) {
        return {
          content: '',
          toolCalls: [{
            id: 'list-failed-correct-parent',
            type: 'function',
            function: {
              name: 'list_directory',
              arguments: JSON.stringify({ path: 'D:\\destok' }),
            },
          }],
        }
      }
      if (modelCalls === 5) {
        return {
          content: '',
          toolCalls: [{
            id: 'list-complete-correct-parent',
            type: 'function',
            function: {
              name: 'list_directory',
              arguments: JSON.stringify({ path: 'D:\\destok' }),
            },
          }],
        }
      }
      if (modelCalls === 6) {
        return {
          content: '',
          toolCalls: [{
            id: 'verify-pdf-with-fitz',
            type: 'function',
            function: {
              name: 'bash_exec',
              arguments: JSON.stringify({
                command: `python -c "import fitz; doc=fitz.open(r'${pdfPath}'); print(doc.page_count)"`,
              }),
            },
          }],
        }
      }
      if (modelCalls === 7) {
        return {
          content: '',
          toolCalls: [{
            id: 'verify-png-header',
            type: 'function',
            function: {
              name: 'bash_exec',
              arguments: JSON.stringify({
                command: `python -c "header=open(r'${pngPath}','rb').read(8); print(header)"`,
              }),
            },
          }],
        }
      }
      if (modelCalls === 8) {
        return { content: 'PDF and PNG were generated and verified.', toolCalls: [] }
      }
      if (modelCalls === 9) {
        return {
          content: '',
          toolCalls: [{
            id: 'verify-pdf-layout',
            type: 'function',
            function: {
              name: 'bash_exec',
              arguments: JSON.stringify({ command: 'python verify_pdf_layout.py' }),
            },
          }],
        }
      }
      return { content: 'PDF and PNG were generated and verified.', toolCalls: [] }
    },
    executeTool: async ({ name, args }) => {
      executed.push(`${name}:${args.command || args.path}`)
      if (name === 'list_directory') {
        if (args.path === 'D:\\other') {
          return {
            ok: true,
            path: args.path,
            entries: [
              { name: 'filled-answer.pdf', type: 'file' },
              { name: 'filled-answer.png', type: 'file' },
            ],
          }
        }
        correctDirectoryLists += 1
        if (correctDirectoryLists === 2) {
          return { ok: false, code: 'EIO', error: 'directory read failed', retryable: false }
        }
        if (correctDirectoryLists === 3) {
          return {
            ok: true,
            path: args.path,
            total: 2,
            truncated: false,
            entries: [
              { name: 'filled-answer.pdf', type: 'file' },
              { name: 'filled-answer.png', type: 'file' },
            ],
          }
        }
        return {
          ok: true,
          path: args.path,
          entries: [{ name: 'filled-answer.pdf', type: 'file' }],
        }
      }
      if (Array.isArray(args.expected_outputs) && args.expected_outputs.length > 0) {
        return {
          ok: true,
          exitCode: 0,
          stdout: 'created',
          changedPaths: [pdfPath, pngPath],
        }
      }
      if (args.command.includes('fitz.open')) return { ok: true, exitCode: 0, stdout: '2\n' }
      if (args.command.includes('verify_pdf_layout.py')) {
        return { ok: true, exitCode: 0, stdout: 'PDF_LAYOUT_VERIFICATION_OK\n' }
      }
      return { ok: true, exitCode: 0, stdout: "b'\\x89PNG\\r\\n\\x1a\\n'\n" }
    },
  })

  assert.equal(result.text, 'PDF and PNG were generated and verified.')
  assert.equal(result.incomplete, undefined)
  assert.equal(modelCalls, 10)
  assert.equal(executed.length, 7)
  assert.ok(pendingSnapshots.some((targets) => targets.length === 2))
  assert.ok(pendingSnapshots.some((targets) => targets.length === 1))
  assert.deepEqual(pendingSnapshots.at(-1), [])
})

test('inline Python file writes remain mutations and cannot complete without verification', async () => {
  const bashExec = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'bash_exec')
  let modelCalls = 0
  let executions = 0

  const result = await runToolsLoop({
    job: {
      id: 'python-inline-write-job',
      userId: null,
      origin: 'chat',
      prompt: 'Create created.txt with Python and verify the result.',
    },
    step: { id: 'python-inline-write-step', kind: 'chat' },
    messages: [{ role: 'user', content: 'Create created.txt with Python and verify the result.' }],
    intentMode: 'execute',
    toolSpecs: [bashExec],
    maxIters: 5,
    enableToolHooks: false,
    runModel: async () => {
      modelCalls += 1
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [{
            id: 'write-with-inline-python',
            type: 'function',
            function: {
              name: 'bash_exec',
              arguments: JSON.stringify({
                command: `python -c "open('created.txt','w').write('data')"`,
              }),
            },
          }],
        }
      }
      return { content: 'created.txt is complete.', toolCalls: [] }
    },
    executeTool: async () => {
      executions += 1
      return { ok: true, exitCode: 0, stdout: '4' }
    },
  })

  assert.equal(result.incomplete, true)
  assert.equal(result.reason, 'post_mutation_verification_missing')
  assert.equal(executions, 1)
})

test('inline Python relative writes are cleared by exact read and directory evidence inside cwd', async () => {
  const bashExec = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'bash_exec')
  const readFile = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'read_file')
  const listDirectory = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'list_directory')
  const directory = 'D:\\gugo-inline-auth-bash-final'
  const outputPath = `${directory}\\result.txt`
  let modelCalls = 0
  let executions = 0

  const result = await runToolsLoop({
    job: {
      id: 'python-inline-relative-write-verification-job',
      userId: null,
      origin: 'chat',
      prompt: `Create ${outputPath} with inline Python, then read and list it.`,
    },
    step: { id: 'python-inline-relative-write-verification-step', kind: 'chat' },
    messages: [{
      role: 'user',
      content: `Create ${outputPath} with inline Python, then read and list it.`,
    }],
    intentMode: 'execute',
    toolSpecs: [bashExec, readFile, listDirectory],
    maxIters: 6,
    enableToolHooks: false,
    runModel: async () => {
      modelCalls += 1
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [{
            id: 'python-inline-relative-write',
            type: 'function',
            function: {
              name: 'bash_exec',
              arguments: JSON.stringify({
                command: `python -c "with open('result.txt', 'w') as f: f.write('BASH_FINAL_OK')"`,
                cwd: directory,
                expected_outputs: [],
              }),
            },
          }],
        }
      }
      if (modelCalls === 2) {
        return {
          content: '',
          toolCalls: [{
            id: 'read-python-inline-relative-output',
            type: 'function',
            function: { name: 'read_file', arguments: JSON.stringify({ path: outputPath }) },
          }],
        }
      }
      if (modelCalls === 3) {
        return {
          content: '',
          toolCalls: [{
            id: 'list-python-inline-relative-output',
            type: 'function',
            function: { name: 'list_directory', arguments: JSON.stringify({ path: directory }) },
          }],
        }
      }
      return { content: 'The inline Python output was created and verified.', toolCalls: [] }
    },
    executeTool: async ({ name, args }) => {
      executions += 1
      if (name === 'bash_exec') {
        return { ok: true, exitCode: 0, stdout: '', stderr: '', cwd: directory }
      }
      if (name === 'read_file') {
        return { ok: true, path: args.path, content: 'BASH_FINAL_OK' }
      }
      return {
        ok: true,
        path: args.path,
        total: 1,
        truncated: false,
        entries: [{ name: 'result.txt', type: 'file', size: 13 }],
      }
    },
  })

  assert.equal(result.text, 'The inline Python output was created and verified.')
  assert.equal(result.incomplete, undefined)
  assert.equal(modelCalls, 4)
  assert.equal(executions, 3)
})

test('workspace-relative executor paths are not prefixed with the reported cwd twice', async () => {
  const bashExec = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'bash_exec')
  const readFile = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'read_file')
  let modelCalls = 0

  const result = await runToolsLoop({
    job: {
      id: 'workspace-relative-executor-path-job',
      userId: null,
      origin: 'chat',
      prompt: 'Create subdir/result.txt and verify it.',
    },
    step: { id: 'workspace-relative-executor-path-step', kind: 'chat' },
    messages: [{ role: 'user', content: 'Create subdir/result.txt and verify it.' }],
    intentMode: 'execute',
    toolSpecs: [bashExec, readFile],
    maxIters: 5,
    enableToolHooks: false,
    runModel: async () => {
      modelCalls += 1
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [{
            id: 'write-workspace-relative-output',
            type: 'function',
            function: {
              name: 'bash_exec',
              arguments: JSON.stringify({
                command: 'echo WORKSPACE_RELATIVE_OK > result.txt',
                cwd: 'subdir',
                expected_outputs: ['result.txt'],
              }),
            },
          }],
        }
      }
      if (modelCalls === 2) {
        return {
          content: '',
          toolCalls: [{
            id: 'read-workspace-relative-output',
            type: 'function',
            function: {
              name: 'read_file',
              arguments: JSON.stringify({ path: 'subdir/result.txt' }),
            },
          }],
        }
      }
      return { content: 'The workspace-relative output was created and verified.', toolCalls: [] }
    },
    executeTool: async ({ name, args }) => name === 'bash_exec'
      ? {
          ok: true,
          exitCode: 0,
          stdout: '',
          cwd: 'subdir',
          changedPaths: ['subdir/result.txt'],
        }
      : { ok: true, path: args.path, content: 'WORKSPACE_RELATIVE_OK' },
  })

  assert.equal(result.text, 'The workspace-relative output was created and verified.')
  assert.equal(result.incomplete, undefined)
  assert.equal(modelCalls, 3)
})

test('inline Python relative outputs use the effective relative cwd exactly once', async () => {
  const bashExec = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'bash_exec')
  const readFile = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'read_file')
  let modelCalls = 0

  const result = await runToolsLoop({
    job: {
      id: 'python-inline-effective-relative-cwd-job',
      userId: null,
      origin: 'chat',
      prompt: 'Create subdir/result.txt with inline Python and verify it.',
    },
    step: { id: 'python-inline-effective-relative-cwd-step', kind: 'chat' },
    messages: [{ role: 'user', content: 'Create subdir/result.txt with inline Python and verify it.' }],
    intentMode: 'execute',
    toolSpecs: [bashExec, readFile],
    maxIters: 5,
    enableToolHooks: false,
    runModel: async () => {
      modelCalls += 1
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [{
            id: 'write-inline-python-relative-cwd-output',
            type: 'function',
            function: {
              name: 'bash_exec',
              arguments: JSON.stringify({
                command: `python -c "open('result.txt','w').write('INLINE_RELATIVE_OK')"`,
                cwd: 'subdir/nested/..',
                expected_outputs: [],
              }),
            },
          }],
        }
      }
      if (modelCalls === 2) {
        return {
          content: '',
          toolCalls: [{
            id: 'read-inline-python-relative-cwd-output',
            type: 'function',
            function: {
              name: 'read_file',
              arguments: JSON.stringify({ path: 'subdir/result.txt' }),
            },
          }],
        }
      }
      return { content: 'The inline Python relative output was created and verified.', toolCalls: [] }
    },
    executeTool: async ({ name, args }) => name === 'bash_exec'
      ? { ok: true, exitCode: 0, stdout: '', cwd: 'subdir' }
      : { ok: true, path: args.path, content: 'INLINE_RELATIVE_OK' },
  })

  assert.equal(result.text, 'The inline Python relative output was created and verified.')
  assert.equal(result.incomplete, undefined)
  assert.equal(modelCalls, 3)
})

test('pathlib open write modes and print file targets remain mutations', async () => {
  const bashExec = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'bash_exec')
  for (const mode of ['w', 'a', 'x', 'r+']) {
    let modelCalls = 0
    let executions = 0
    const label = mode.replace('+', 'plus')
    const result = await runToolsLoop({
      job: {
        id: `python-pathlib-inline-write-${label}-job`,
        userId: null,
        origin: 'chat',
        prompt: 'Create created.txt with pathlib and verify the result.',
      },
      step: { id: `python-pathlib-inline-write-${label}-step`, kind: 'chat' },
      messages: [{ role: 'user', content: 'Create created.txt with pathlib and verify the result.' }],
      intentMode: 'execute',
      toolSpecs: [bashExec],
      maxIters: 5,
      enableToolHooks: false,
      runModel: async () => {
        modelCalls += 1
        if (modelCalls === 1) {
          return {
            content: '',
            toolCalls: [{
              id: `write-with-pathlib-inline-python-${label}`,
              type: 'function',
              function: {
                name: 'bash_exec',
                arguments: JSON.stringify({
                  command: `python -c "from pathlib import Path; f=Path('created.txt').open('${mode}'); print('data', file=f); f.close()"`,
                }),
              },
            }],
          }
        }
        return { content: 'created.txt is complete.', toolCalls: [] }
      },
      executeTool: async () => {
        executions += 1
        return { ok: true, exitCode: 0, stdout: '' }
      },
    })

    assert.equal(result.incomplete, true, mode)
    assert.equal(result.reason, 'post_mutation_verification_missing', mode)
    assert.equal(executions, 1, mode)
  }
})

test('inline Python imports with declared outputs count as production mutations', async () => {
  const bashExec = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'bash_exec')
  const outputPath = 'D:\\destok\\filled-answer.pdf'
  let modelCalls = 0

  const result = await runToolsLoop({
    job: {
      id: 'python-inline-import-output-job',
      userId: null,
      origin: 'chat',
      prompt: 'Generate filled-answer.pdf with reportlab and verify the result.',
    },
    step: { id: 'python-inline-import-output-step', kind: 'chat' },
    messages: [{ role: 'user', content: 'Generate filled-answer.pdf with reportlab and verify the result.' }],
    intentMode: 'execute',
    toolSpecs: [bashExec],
    maxIters: 5,
    enableToolHooks: false,
    runModel: async () => {
      modelCalls += 1
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [{
            id: 'generate-with-inline-reportlab',
            type: 'function',
            function: {
              name: 'bash_exec',
              arguments: JSON.stringify({
                command: `python -c "import reportlab; make_requested_pdf()"`,
                expected_outputs: [outputPath],
              }),
            },
          }],
        }
      }
      return { content: 'filled-answer.pdf is complete.', toolCalls: [] }
    },
    executeTool: async () => ({
      ok: true,
      exitCode: 0,
      stdout: '',
      changedPaths: [outputPath],
    }),
  })

  assert.equal(result.incomplete, true)
  assert.equal(result.reason, 'post_mutation_verification_missing')
})

test('pending output targets survive checkpoint restore and resume with only the remaining verification', async () => {
  const bashExec = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'bash_exec')
  const listDirectory = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'list_directory')
  const pdfPath = 'D:\\destok\\resume-answer.pdf'
  const pngPath = 'D:\\destok\\resume-answer.png'
  const normalizedPngPath = pngPath.replaceAll('\\', '/')
  const job = {
    id: 'python-verification-resume-job',
    userId: null,
    origin: 'chat',
    prompt: `Create ${pdfPath} and ${pngPath}, then verify both generated files.`,
  }
  const step = { id: 'python-verification-resume-step', kind: 'chat' }
  const messages = [{ role: 'user', content: job.prompt }]
  let checkpoint = null
  let firstModelCalls = 0

  await assert.rejects(
    () => runToolsLoop({
      job,
      step,
      messages,
      intentMode: 'execute',
      toolSpecs: [bashExec, listDirectory],
      maxIters: 7,
      enableToolHooks: false,
      saveCheckpoint: async (state) => {
        checkpoint = structuredClone(state)
        return true
      },
      runModel: async () => {
        firstModelCalls += 1
        if (firstModelCalls === 1) {
          return {
            content: '',
            toolCalls: [{
              id: 'resume-generate-outputs',
              type: 'function',
              function: {
                name: 'bash_exec',
                arguments: JSON.stringify({
                  command: 'python create_resume_outputs.py',
                  expected_outputs: [pdfPath, pngPath],
                }),
              },
            }],
          }
        }
        if (firstModelCalls === 2) {
          return {
            content: '',
            toolCalls: [{
              id: 'resume-list-pdf-only',
              type: 'function',
              function: {
                name: 'list_directory',
                arguments: JSON.stringify({ path: 'D:\\destok' }),
              },
            }],
          }
        }
        const error = new Error('simulated process interruption')
        error.name = 'AbortError'
        throw error
      },
      executeTool: async ({ name, args }) => {
        if (name === 'list_directory') {
          return {
            ok: true,
            path: args.path,
            entries: [{ name: 'resume-answer.pdf', type: 'file' }],
          }
        }
        return {
          ok: true,
          exitCode: 0,
          stdout: 'created',
          changedPaths: [pdfPath, pngPath],
        }
      },
    }),
    (error) => error?.name === 'AbortError',
  )

  assert.deepEqual(checkpoint?.completionGuards?.pendingMutationTargets, [normalizedPngPath])

  let resumedModelCalls = 0
  let resumedExecutions = 0
  const resumed = await runToolsLoop({
    job: { ...job },
    step: { ...step },
    messages,
    intentMode: 'execute',
    toolSpecs: [bashExec, listDirectory],
    maxIters: 7,
    enableToolHooks: false,
    loadCheckpoint: async () => structuredClone(checkpoint),
    saveCheckpoint: async (state) => {
      checkpoint = structuredClone(state)
      return true
    },
    runModel: async ({ messages: resumedMessages }) => {
      resumedModelCalls += 1
      if (resumedModelCalls === 1) {
        return {
          content: '',
          toolCalls: [{
            id: 'resume-list-png',
            type: 'function',
            function: {
              name: 'list_directory',
              arguments: JSON.stringify({ path: 'D:\\destok' }),
            },
          }],
        }
      }
      if (resumedModelCalls === 2) {
        return { content: 'Resumed and verified the remaining PNG.', toolCalls: [] }
      }
      if (resumedModelCalls === 3) {
        const systemText = resumedMessages
          .filter((message) => message.role === 'system')
          .map((message) => message.content)
          .join('\n')
        assert.match(systemText, /\[PDF LAYOUT VERIFICATION REQUIRED\]/)
        return {
          content: '',
          toolCalls: [{
            id: 'resume-verify-pdf-layout',
            type: 'function',
            function: {
              name: 'bash_exec',
              arguments: JSON.stringify({ command: 'python verify_pdf_layout.py' }),
            },
          }],
        }
      }
      return { content: 'Resumed and verified the remaining PNG.', toolCalls: [] }
    },
    executeTool: async ({ name, args }) => {
      resumedExecutions += 1
      if (name === 'bash_exec') {
        assert.equal(args.command, 'python verify_pdf_layout.py')
        return { ok: true, exitCode: 0, stdout: 'PDF_LAYOUT_VERIFICATION_OK\n' }
      }
      assert.equal(name, 'list_directory')
      return {
        ok: true,
        path: args.path,
        total: 1,
        truncated: false,
        entries: [{ name: 'resume-answer.png', type: 'file' }],
      }
    },
  })

  assert.equal(resumed.text, 'Resumed and verified the remaining PNG.')
  assert.equal(resumed.incomplete, undefined)
  assert.equal(resumedModelCalls, 4)
  assert.equal(resumedExecutions, 2)
  assert.deepEqual(checkpoint?.completionGuards?.pendingMutationTargets, [])
  assert.equal(checkpoint?.completionGuards?.pdfLayoutVerificationObserved, true)
})

test('exact Windows del compensates a generated temporary script while PDF and PNG stay pending until verified', async () => {
  const writeFile = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'write_file')
  const bashExec = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'bash_exec')
  const listDirectory = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'list_directory')
  const directory = 'D:\\destok'
  const scriptPath = directory + '\\_run_pdf.py'
  const pdfPath = directory + '\\filled-answer.pdf'
  const pngPath = directory + '\\filled-answer.png'
  const normalize = (value) => value.replaceAll('\\', '/')
  const snapshots = []
  const layoutSnapshots = []
  let modelCalls = 0

  const result = await runToolsLoop({
    job: {
      id: 'windows-delete-compensation-job',
      userId: null,
      origin: 'chat',
      prompt: 'Generate and verify a PDF and PNG with a temporary Python script, then remove the script.',
    },
    step: { id: 'windows-delete-compensation-step', kind: 'chat' },
    messages: [{
      role: 'user',
      content: 'Generate and verify a PDF and PNG with a temporary Python script, then remove the script.',
    }],
    intentMode: 'execute',
    toolSpecs: [writeFile, bashExec, listDirectory],
    maxIters: 8,
    enableToolHooks: false,
    saveCheckpoint: async (state) => {
      snapshots.push([...(state?.completionGuards?.pendingMutationTargets || [])])
      layoutSnapshots.push({
        observed: state?.completionGuards?.pdfLayoutVerificationObserved,
        retries: state?.completionGuards?.pdfLayoutVerificationRetries,
      })
      return true
    },
    runModel: async () => {
      modelCalls += 1
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [{
            id: 'write-temporary-script',
            type: 'function',
            function: {
              name: 'write_file',
              arguments: JSON.stringify({ path: scriptPath, content: 'print("generate")' }),
            },
          }],
        }
      }
      if (modelCalls === 2) {
        return {
          content: '',
          toolCalls: [{
            id: 'execute-temporary-script',
            type: 'function',
            function: {
              name: 'bash_exec',
              arguments: JSON.stringify({
                command: 'python "' + scriptPath + '"',
                cwd: directory,
                expected_outputs: [pdfPath, pngPath],
              }),
            },
          }],
        }
      }
      if (modelCalls === 3) {
        return {
          content: '',
          toolCalls: [{
            id: 'delete-temporary-script',
            type: 'function',
            function: {
              name: 'bash_exec',
              arguments: JSON.stringify({
                command: 'del /q "' + scriptPath + '"',
                cwd: directory,
              }),
            },
          }],
        }
      }
      if (modelCalls === 4) {
        const pending = new Set(snapshots.at(-1) || [])
        assert.deepEqual(pending, new Set([normalize(pdfPath), normalize(pngPath)]))
        return {
          content: '',
          toolCalls: [{
            id: 'verify-generated-files',
            type: 'function',
            function: {
              name: 'list_directory',
              arguments: JSON.stringify({ path: directory }),
            },
          }],
        }
      }
      if (modelCalls === 5) {
        assert.deepEqual(snapshots.at(-1), [])
        return { content: 'The PDF and PNG were generated and verified; the temporary script was removed.', toolCalls: [] }
      }
      if (modelCalls === 6) {
        return {
          content: '',
          toolCalls: [{
            id: 'verify-generated-pdf-layout',
            type: 'function',
            function: {
              name: 'bash_exec',
              arguments: JSON.stringify({
                command: 'python verify_pdf_layout.py',
                cwd: directory,
              }),
            },
          }],
        }
      }
      assert.deepEqual(snapshots.at(-1), [])
      return { content: 'The PDF and PNG were generated and verified; the temporary script was removed.', toolCalls: [] }
    },
    executeTool: async ({ name, args }) => {
      if (name === 'write_file') return { ok: true, path: scriptPath }
      if (name === 'list_directory') {
        return {
          ok: true,
          path: directory,
          total: 2,
          truncated: false,
          entries: [
            { name: 'filled-answer.pdf', type: 'file' },
            { name: 'filled-answer.png', type: 'file' },
          ],
        }
      }
      if (Array.isArray(args.expected_outputs) && args.expected_outputs.length > 0) {
        return {
          ok: true,
          exitCode: 0,
          cwd: directory,
          changedPaths: [pdfPath, pngPath],
        }
      }
      if (args.command.includes('verify_pdf_layout.py')) {
        return {
          ok: true,
          exitCode: 0,
          cwd: directory,
          stdout: 'PDF_LAYOUT_VERIFICATION_OK\n',
        }
      }
      return { ok: true, exitCode: 0, cwd: directory }
    },
  })

  assert.equal(result.incomplete, undefined, JSON.stringify({ result, layoutSnapshots }))
  assert.equal(modelCalls, 7)
  assert.deepEqual(snapshots.at(-1), [])
})

test('dynamic, wildcard, compound, unmatched, and mixed Windows deletes cannot clear a pending target', async () => {
  const writeFile = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'write_file')
  const bashExec = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'bash_exec')
  const directory = 'D:\\destok'
  const scriptPath = directory + '\\_cleanup.py'
  const normalizedScript = scriptPath.replaceAll('\\', '/')
  const cases = [
    { label: 'environment expansion', command: 'del "%TEMP%\\_cleanup.py"' },
    { label: 'wildcard', command: 'del "' + directory + '\\*.py"' },
    { label: 'compound command', command: 'del "' + scriptPath + '" && echo done' },
    { label: 'unmatched literal', command: 'erase "' + directory + '\\other.py"' },
    { label: 'mixed literal and dynamic targets', command: 'del "' + scriptPath + '" "%TEMP%\\other.py"' },
  ]

  for (const scenario of cases) {
    let modelCalls = 0
    let checkpoint = null
    const result = await runToolsLoop({
      job: {
        id: 'unsafe-delete-' + scenario.label,
        userId: null,
        origin: 'chat',
        prompt: 'Create a temporary script and remove it safely.',
      },
      step: { id: 'unsafe-delete-step-' + scenario.label, kind: 'chat' },
      messages: [{ role: 'user', content: 'Create a temporary script and remove it safely.' }],
      intentMode: 'execute',
      toolSpecs: [writeFile, bashExec],
      maxIters: 4,
      enableToolHooks: false,
      saveCheckpoint: async (state) => {
        checkpoint = structuredClone(state)
        return true
      },
      runModel: async () => {
        modelCalls += 1
        if (modelCalls === 1) {
          return {
            content: '',
            toolCalls: [{
              id: 'write-' + scenario.label,
              type: 'function',
              function: {
                name: 'write_file',
                arguments: JSON.stringify({ path: scriptPath, content: 'print("temporary")' }),
              },
            }],
          }
        }
        if (modelCalls === 2) {
          return {
            content: '',
            toolCalls: [{
              id: 'delete-' + scenario.label,
              type: 'function',
              function: {
                name: 'bash_exec',
                arguments: JSON.stringify({ command: scenario.command, cwd: directory }),
              },
            }],
          }
        }
        return { content: 'Cleanup complete.', toolCalls: [] }
      },
      executeTool: async ({ name }) => (
        name === 'write_file'
          ? { ok: true, path: scriptPath }
          : { ok: true, exitCode: 0, cwd: directory }
      ),
    })

    assert.equal(result.incomplete, true, scenario.label)
    assert.equal(result.reason, 'post_mutation_verification_missing', scenario.label)
    const pending = checkpoint?.completionGuards?.pendingMutationTargets || []
    const pendingDeletion = checkpoint?.completionGuards?.pendingDeletionTargets || []
    assert.ok(pending.includes(normalizedScript), scenario.label)
    if (scenario.label === 'unmatched literal') {
      assert.equal(pending.includes('<workspace>'), false, scenario.label)
      assert.deepEqual(pendingDeletion, [(directory + '\\other.py').replaceAll('\\', '/')])
    } else {
      assert.ok(pending.includes('<workspace>'), scenario.label)
      assert.deepEqual(pendingDeletion, [], scenario.label)
    }
  }
})

test('exact rd and rmdir require complete parent-directory evidence before completion', async () => {
  const bashExec = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'bash_exec')
  const listDirectory = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'list_directory')
  const directory = 'D:\\destok'

  for (const deleteCommand of ['rd /s /q', 'rmdir /s /q']) {
    const temporaryDirectory = directory + '\\temporary-code-runtime'
    let modelCalls = 0
    let checkpoint = null
    const result = await runToolsLoop({
      job: {
        id: 'directory-delete-' + deleteCommand,
        userId: null,
        origin: 'chat',
        prompt: 'Create and then remove a temporary execution directory.',
      },
      step: { id: 'directory-delete-step-' + deleteCommand, kind: 'chat' },
      messages: [{ role: 'user', content: 'Create and then remove a temporary execution directory.' }],
      intentMode: 'execute',
      toolSpecs: [bashExec, listDirectory],
      maxIters: 5,
      enableToolHooks: false,
      saveCheckpoint: async (state) => {
        checkpoint = structuredClone(state)
        return true
      },
      runModel: async () => {
        modelCalls += 1
        if (modelCalls === 1) {
          return {
            content: '',
            toolCalls: [{
              id: 'create-temporary-directory',
              type: 'function',
              function: {
                name: 'bash_exec',
                arguments: JSON.stringify({
                  command: 'mkdir "' + temporaryDirectory + '"',
                  cwd: directory,
                }),
              },
            }],
          }
        }
        if (modelCalls === 2) {
          return {
            content: '',
            toolCalls: [{
              id: 'remove-temporary-directory',
              type: 'function',
              function: {
                name: 'bash_exec',
                arguments: JSON.stringify({
                  command: deleteCommand + ' "' + temporaryDirectory + '"',
                  cwd: directory,
                }),
              },
            }],
          }
        }
        if (modelCalls === 3) {
          return {
            content: '',
            toolCalls: [{
              id: 'verify-temporary-directory-removed',
              type: 'function',
              function: {
                name: 'list_directory',
                arguments: JSON.stringify({ path: directory }),
              },
            }],
          }
        }
        return { content: 'The temporary directory was created and removed.', toolCalls: [] }
      },
      executeTool: async ({ name }) => (
        name === 'list_directory'
          ? { ok: true, path: directory, total: 0, truncated: false, entries: [] }
          : { ok: true, exitCode: 0, cwd: directory }
      ),
    })

    assert.equal(result.incomplete, undefined, deleteCommand)
    assert.deepEqual(checkpoint?.completionGuards?.pendingMutationTargets, [], deleteCommand)
    assert.deepEqual(checkpoint?.completionGuards?.pendingDeletionTargets, [], deleteCommand)
  }
})

test('an absolute delete in another authorized root cannot consume a relative workspace pending target', async () => {
  const writeFile = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'write_file')
  const bashExec = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'bash_exec')
  const listDirectory = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'list_directory')
  const workspaceTarget = 'nested/_run_pdf.py'
  const otherDirectory = 'D:\\other\\nested'
  const otherTarget = otherDirectory + '\\_run_pdf.py'
  let modelCalls = 0
  let checkpoint = null

  const result = await runToolsLoop({
    job: {
      id: 'cross-root-delete-target-job',
      userId: null,
      origin: 'chat',
      prompt: 'Create a workspace script, then delete and verify a different absolute target.',
    },
    step: { id: 'cross-root-delete-target-step', kind: 'chat' },
    messages: [{
      role: 'user',
      content: 'Create a workspace script, then delete and verify a different absolute target.',
    }],
    intentMode: 'execute',
    toolSpecs: [writeFile, bashExec, listDirectory],
    maxIters: 6,
    enableToolHooks: false,
    saveCheckpoint: async (state) => {
      checkpoint = structuredClone(state)
      return true
    },
    runModel: async () => {
      modelCalls += 1
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [{
            id: 'write-workspace-script',
            type: 'function',
            function: {
              name: 'write_file',
              arguments: JSON.stringify({ path: workspaceTarget, content: 'print("workspace")' }),
            },
          }],
        }
      }
      if (modelCalls === 2) {
        return {
          content: '',
          toolCalls: [{
            id: 'delete-other-root-script',
            type: 'function',
            function: {
              name: 'bash_exec',
              arguments: JSON.stringify({
                command: 'del /q "' + otherTarget + '"',
                cwd: otherDirectory,
              }),
            },
          }],
        }
      }
      if (modelCalls === 3) {
        return {
          content: '',
          toolCalls: [{
            id: 'list-other-root',
            type: 'function',
            function: {
              name: 'list_directory',
              arguments: JSON.stringify({ path: otherDirectory }),
            },
          }],
        }
      }
      return { content: 'All requested paths were handled.', toolCalls: [] }
    },
    executeTool: async ({ name }) => {
      if (name === 'write_file') return { ok: true, path: workspaceTarget }
      if (name === 'list_directory') {
        return { ok: true, path: otherDirectory, total: 0, truncated: false, entries: [] }
      }
      return { ok: true, exitCode: 0, cwd: otherDirectory }
    },
  })

  assert.equal(result.incomplete, true)
  assert.equal(result.reason, 'post_mutation_verification_missing')
  assert.ok(
    (checkpoint?.completionGuards?.pendingMutationTargets || []).includes(workspaceTarget),
  )
})

test('a project check cannot verify an absolute local output outside the workspace', async () => {
  const writeFile = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'write_file')
  const projectCheck = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'run_project_check')
  const outputPath = 'D:\\destok\\outside-output.pdf'
  const normalizedOutput = outputPath.replaceAll('\\', '/')
  let modelCalls = 0
  let checkpoint = null

  const result = await runToolsLoop({
    job: {
      id: 'external-output-project-check-job',
      userId: null,
      origin: 'chat',
      prompt: 'Write an external PDF and verify that exact output.',
    },
    step: { id: 'external-output-project-check-step', kind: 'chat' },
    messages: [{ role: 'user', content: 'Write an external PDF and verify that exact output.' }],
    intentMode: 'execute',
    toolSpecs: [writeFile, projectCheck],
    maxIters: 5,
    enableToolHooks: false,
    saveCheckpoint: async (state) => {
      checkpoint = structuredClone(state)
      return true
    },
    runModel: async () => {
      modelCalls += 1
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [{
            id: 'write-external-output',
            type: 'function',
            function: {
              name: 'write_file',
              arguments: JSON.stringify({ path: outputPath, content: '%PDF-test' }),
            },
          }],
        }
      }
      if (modelCalls === 2) {
        return {
          content: '',
          toolCalls: [{
            id: 'run-unrelated-project-check',
            type: 'function',
            function: {
              name: 'run_project_check',
              arguments: JSON.stringify({ check: 'test' }),
            },
          }],
        }
      }
      return { content: 'The external PDF was verified.', toolCalls: [] }
    },
    executeTool: async ({ name }) => (
      name === 'write_file'
        ? { ok: true, path: outputPath }
        : { ok: true, check: 'test', exitCode: 0, stdout: 'tests passed' }
    ),
  })

  assert.equal(result.incomplete, true)
  assert.equal(result.reason, 'post_mutation_verification_missing')
  assert.ok(
    (checkpoint?.completionGuards?.pendingMutationTargets || []).includes(normalizedOutput),
  )
})

test('a project check cannot verify an absolute artifact inside the workspace', async () => {
  const writeFile = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'write_file')
  const projectCheck = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'run_project_check')
  const outputPath = `${process.cwd().replaceAll('\\', '/')}/absolute-output.pdf`
  let modelCalls = 0
  let checkpoint = null

  const result = await runToolsLoop({
    job: {
      id: 'workspace-absolute-output-project-check-job',
      userId: null,
      origin: 'chat',
      prompt: 'Write an absolute PDF and verify that exact output.',
    },
    step: { id: 'workspace-absolute-output-project-check-step', kind: 'chat' },
    messages: [{ role: 'user', content: 'Write an absolute PDF and verify that exact output.' }],
    intentMode: 'execute',
    toolSpecs: [writeFile, projectCheck],
    maxIters: 5,
    enableToolHooks: false,
    saveCheckpoint: async (state) => {
      checkpoint = structuredClone(state)
      return true
    },
    runModel: async () => {
      modelCalls += 1
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [{
            id: 'write-workspace-absolute-output',
            type: 'function',
            function: {
              name: 'write_file',
              arguments: JSON.stringify({ path: outputPath, content: '%PDF-test' }),
            },
          }],
        }
      }
      if (modelCalls === 2) {
        return {
          content: '',
          toolCalls: [{
            id: 'run-unrelated-workspace-project-check',
            type: 'function',
            function: {
              name: 'run_project_check',
              arguments: JSON.stringify({ check: 'test' }),
            },
          }],
        }
      }
      return { content: 'The absolute PDF was verified.', toolCalls: [] }
    },
    executeTool: async ({ name }) => (
      name === 'write_file'
        ? { ok: true, path: outputPath }
        : { ok: true, check: 'test', exitCode: 0, stdout: 'tests passed' }
    ),
  })

  assert.equal(result.incomplete, true)
  assert.equal(result.reason, 'post_mutation_verification_missing')
  assert.ok(
    (checkpoint?.completionGuards?.pendingMutationTargets || []).includes(outputPath),
  )
})
