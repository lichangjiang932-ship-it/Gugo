import test from 'node:test'
import assert from 'node:assert/strict'

import { buildServerToolsConfig } from '../src/pages/ChatSplit/serverTurnFlow.js'
import { createInitialState } from '../src/store/appStateBootstrap.js'
import { applyServerToolsConfig } from '../server/services/turnToolSpecs.js'
import { parseModelProviderResponse } from '../server/adapters/modelProviderResponse.js'
import { createLoopEvents } from '../server/services/loop/events.js'

const {
  runToolsLoop: runToolsLoopRuntime,
  SERVER_TOOL_SPECS,
  selectJobToolSpecs,
} = await import('../server/services/jobTools.js')
const { getDynamicTool, registerDynamicTool, unregisterDynamicTool } = await import('../server/services/toolRegistry.js')
const { createJobBudget } = await import('../server/utils/jobBudget.js')
const { createUser, getDb } = await import('../server/db.js')
const { upsertSession } = await import('../server/services/sessionStore.js')
const { appendTurnArtifact } = await import('../server/services/turnArtifactStore.js')
const {
  artifactDeliveryError,
  isLocalMutationCall,
  isSuccessfulPdfLayoutVerification,
  isVerificationCall,
} = await import('../server/services/toolLoopHeuristics.js')

const TEST_USER_ID = 'tool-loop-execution-regression-user'

function runToolsLoop(options = {}) {
  const job = options.job || {}
  return runToolsLoopRuntime({
    requestToolApproval: async ({ args }) => ({
      proceed: true,
      args,
      approvalId: 'tool-loop-regression-approved',
    }),
    ...options,
    job: {
      ...job,
      userId: job.userId || TEST_USER_ID,
    },
  })
}

test('output-truncated tool calls are paired but never executed and are regenerated', async () => {
  const readFile = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'read_file')
  let modelCalls = 0
  const executedPaths = []

  const result = await runToolsLoop({
    job: {
      id: 'job-truncated-tool-call',
      userId: null,
      origin: 'chat',
      prompt: 'Open README.md and report what it contains.',
    },
    step: { id: 'step-truncated-tool-call', kind: 'chat' },
    messages: [{ role: 'user', content: 'Open README.md and report what it contains.' }],
    intentMode: 'execute',
    toolSpecs: [readFile],
    maxIters: 4,
    enableToolHooks: false,
    runModel: async ({ messages }) => {
      modelCalls += 1
      if (modelCalls === 1) {
        return {
          content: '',
          finishReason: 'length',
          toolCalls: [{
            id: 'partial-read',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"READ' },
          }],
        }
      }
      if (modelCalls === 2) {
        const truncatedResult = messages.find((message) => (
          message.role === 'tool' && String(message.content || '').includes('tool_call_truncated')
        ))
        assert.ok(truncatedResult, 'the model must receive a paired structured truncation result')
        return {
          content: '',
          finishReason: 'tool_calls',
          toolCalls: [{
            id: 'complete-read',
            type: 'function',
            function: { name: 'read_file', arguments: JSON.stringify({ path: 'README.md' }) },
          }],
        }
      }
      return { content: 'README.md was read successfully.', toolCalls: [], finishReason: 'stop' }
    },
    executeTool: async ({ name, args }) => {
      assert.equal(name, 'read_file')
      executedPaths.push(args.path)
      return { ok: true, path: args.path, content: '# Gugo' }
    },
  })

  assert.deepEqual(executedPaths, ['README.md'])
  assert.equal(modelCalls, 3)
  assert.equal(result.text, 'README.md was read successfully.')
})

test('transport-truncated batch rejects every complete-looking tool call', async () => {
  const readFile = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'read_file')
  let executions = 0
  let started = 0
  let preHooks = 0
  let postHooks = 0
  const outcomes = []
  const loopEvents = createLoopEvents()
  loopEvents.on('pre-tool', () => { preHooks += 1 })
  loopEvents.on('post-tool', () => { postHooks += 1 })
  await runToolsLoop({
    job: { id: 'job-transport-truncated', origin: 'chat', prompt: 'Read both files.' },
    step: { id: 'step-transport-truncated', kind: 'chat' },
    messages: [{ role: 'user', content: 'Read both files.' }],
    toolSpecs: [readFile],
    maxIters: 1,
    enableToolHooks: false,
    loopEvents,
    onToolStarted: async () => { started += 1 },
    onToolCompleted: async (outcome) => outcomes.push(outcome.result),
    runModel: async () => ({
      content: '',
      finishReason: 'truncated',
      toolCalls: ['a.txt', 'b.txt'].map((path, index) => ({
        id: `transport-truncated-${index}`,
        type: 'function',
        function: { name: 'read_file', arguments: JSON.stringify({ path }) },
      })),
    }),
    executeTool: async () => {
      executions += 1
      return { ok: true }
    },
  })

  assert.equal(executions, 0)
  assert.equal(started, 0)
  assert.equal(preHooks, 0)
  assert.equal(postHooks, 0)
  assert.deepEqual(outcomes.map((outcome) => outcome.code), [
    'tool_call_truncated',
    'tool_call_truncated',
  ])
  assert.ok(outcomes.every((outcome) => outcome.recoveryAction === 'regenerate_tool_call'))
})

test('structurally incomplete arguments reject every call in the same batch', async () => {
  const readFile = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'read_file')
  let executions = 0
  const outcomes = []

  await runToolsLoop({
    job: { id: 'job-incomplete-argument-batch', origin: 'chat', prompt: 'Read both files.' },
    step: { id: 'step-incomplete-argument-batch', kind: 'chat' },
    messages: [{ role: 'user', content: 'Read both files.' }],
    toolSpecs: [readFile],
    maxIters: 1,
    enableToolHooks: false,
    onToolCompleted: async (outcome) => outcomes.push(outcome.result),
    runModel: async () => ({
      content: '',
      finishReason: 'tool_calls',
      toolCalls: [{
        id: 'complete-looking-sibling',
        type: 'function',
        function: { name: 'read_file', arguments: JSON.stringify({ path: 'safe.txt' }) },
      }, {
        id: 'structurally-incomplete-call',
        type: 'function',
        function: { name: 'read_file', arguments: '{"path":"truncated.txt"' },
      }],
    }),
    executeTool: async () => {
      executions += 1
      return { ok: true }
    },
  })

  assert.equal(executions, 0)
  assert.deepEqual(outcomes.map((outcome) => outcome.code), [
    'tool_call_truncated',
    'tool_call_truncated',
  ])
  assert.ok(outcomes.every((outcome) => (
    outcome.truncationReason === 'incomplete_tool_arguments'
      && outcome.recoveryAction === 'regenerate_tool_call'
  )))
})

test('non-stream Responses max-output truncation never executes a valid-looking write call', async () => {
  const writeFile = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'write_file')
  let executions = 0
  let completedResult = null

  const result = await runToolsLoop({
    job: {
      id: 'job-responses-json-truncated-write',
      userId: null,
      origin: 'chat',
      prompt: 'Write result.txt now.',
    },
    step: { id: 'step-responses-json-truncated-write', kind: 'execute' },
    messages: [{ role: 'user', content: 'Write result.txt now.' }],
    intentMode: 'execute',
    toolSpecs: [writeFile],
    maxIters: 1,
    enableToolHooks: false,
    onToolCompleted: async (outcome) => {
      completedResult = structuredClone(outcome.result)
    },
    runModel: async () => parseModelProviderResponse({
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: [{
        type: 'function_call',
        call_id: 'responses-partial-write',
        name: 'write_file',
        arguments: JSON.stringify({ path: 'result.txt', content: 'valid JSON must still not execute' }),
      }],
    }),
    executeTool: async () => {
      executions += 1
      return { ok: true, path: 'result.txt' }
    },
  })

  assert.equal(executions, 0)
  assert.equal(result.incomplete, true)
  assert.equal(completedResult?.code, 'tool_call_truncated')
})

test('executes tool calls returned by the model response that crosses the token budget', async () => {
  const bashExec = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'bash_exec')
  const runtimeBudget = createJobBudget({
    maxModelCalls: 5,
    maxModelTokens: 5,
  })
  let modelCalls = 0
  let executed = false
  const phases = []

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
        content: 'Completed before the command ran.',
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
    onModelPhase: async (event) => phases.push(structuredClone(event)),
  })

  assert.equal(executed, true)
  assert.equal(modelCalls, 1, 'the exhausted budget must block every later provider request')
  assert.equal(result.budgetExceeded, true)
  assert.equal(result.incomplete, true)
  const toolPhase = phases.find((event) => event.phase === 'completed' && event.toolCalls?.length > 0)
  assert.ok(toolPhase)
  assert.equal(toolPhase.content, '')
})

test('provider cost estimate remains telemetry and never blocks normal BYOK completion', async () => {
  const bashExec = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'bash_exec')
  const runtimeBudget = createJobBudget({
    maxModelCalls: 5,
    maxModelTokens: 10_000,
  })
  let modelCalls = 0
  let executed = false

  const result = await runToolsLoop({
    job: {
      id: 'job-provider-cost-telemetry',
      userId: null,
      origin: 'job',
      prompt: 'Inspect local state and summarize it.',
    },
    step: { id: 'step-provider-cost-telemetry', kind: 'execute' },
    messages: [{ role: 'user', content: 'Inspect local state and summarize it.' }],
    intentMode: 'execute',
    toolSpecs: [bashExec],
    runtimeBudget,
    maxIters: 3,
    enableToolHooks: false,
    runModel: async () => {
      modelCalls += 1
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [{
            id: 'provider-cost-telemetry-command',
            type: 'function',
            function: { name: 'bash_exec', arguments: JSON.stringify({ command: 'echo ok' }) },
          }],
          usage: { promptTokens: 4, completionTokens: 4 },
          costUsd: 0.01,
        }
      }
      return {
        content: 'Local inspection completed successfully.',
        toolCalls: [],
        usage: { promptTokens: 4, completionTokens: 4 },
        costUsd: 0.02,
      }
    },
    executeTool: async ({ name }) => {
      assert.equal(name, 'bash_exec')
      executed = true
      return { ok: true, exitCode: 0, stdout: 'ok' }
    },
  })

  assert.equal(executed, true)
  assert.equal(modelCalls, 2, 'cost telemetry must not block the normal post-tool completion')
  assert.notEqual(result.budgetExceeded, true)
  assert.notEqual(result.incomplete, true)
  assert.match(result.text, /Local inspection completed successfully/u)
  assert.equal(runtimeBudget.snapshot().costUsd, 0.03)
  assert.equal(runtimeBudget.snapshot().maxCostUsd, 0)
})

test('execution reasoning runaway stops without an automatic model retry and persists a visible final', async () => {
  const writeFile = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'write_file')
  const readFile = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'read_file')
  const outputPath = 'D:\\authorized\\reasoning-recovered.txt'
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
    saveCheckpoint: async (state) => {
      checkpoint = structuredClone(state)
      return true
    },
    runModel: async ({ messages }) => {
      modelCalls += 1
      assert.ok(Array.isArray(messages))
      const error = new Error('reasoning exceeded execution ceiling')
      error.code = 'REASONING_RUNAWAY'
      throw error
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

  assert.equal(result.text, '任务尚未完成。请重试以继续；若仍失败，请检查模型和工具调用支持。')
  assert.doesNotMatch(result.text, /reasoning exceeded execution ceiling/i)
  assert.equal(result.incomplete, true)
  assert.equal(result.code, 'REASONING_RUNAWAY')
  assert.equal(executedWrites, 0)
  assert.equal(modelCalls, 1)
  assert.equal(checkpoint?.final?.code, 'REASONING_RUNAWAY')
  assert.equal(checkpoint?.final?.text, result.text)
})

test('disabled tools remain model-visible but fail closed at the unified execution gate', async () => {
  const disabledNames = ['run_command', 'git_push', 'file_download']
  const specs = disabledNames.map((name) => (
    SERVER_TOOL_SPECS.find((item) => item?.function?.name === name)
  ))
  assert.equal(specs.every(Boolean), true)

  const completed = []
  let executions = 0
  let modelCalls = 0
  const result = await runToolsLoop({
    job: {
      id: 'job-disabled-tools-visible',
      userId: null,
      origin: 'chat',
      prompt: 'Report the current configured tool catalog.',
    },
    step: { id: 'step-disabled-tools-visible', kind: 'chat' },
    messages: [{ role: 'user', content: 'Report the current configured tool catalog.' }],
    intentMode: 'auto',
    toolSpecs: specs,
    toolsConfig: { disabled: disabledNames },
    maxIters: 3,
    enableToolHooks: false,
    onToolCompleted: async (outcome) => {
      completed.push({ name: outcome.call.name, result: structuredClone(outcome.result) })
    },
    runModel: async ({ messages, tools }) => {
      modelCalls += 1
      for (const name of disabledNames) {
        assert.ok(tools.some((item) => item?.function?.name === name), name)
      }
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [
            {
              id: 'disabled-command',
              type: 'function',
              function: { name: 'run_command', arguments: JSON.stringify({ command: 'echo blocked' }) },
            },
            {
              id: 'disabled-push',
              type: 'function',
              function: { name: 'git_push', arguments: '{}' },
            },
            {
              id: 'disabled-download',
              type: 'function',
              function: {
                name: 'file_download',
                arguments: JSON.stringify({ url: 'https://example.com/file.txt', path: 'file.txt' }),
              },
            },
          ],
        }
      }
      const disabledResults = messages.filter((message) => (
        message.role === 'tool' && String(message.content || '').includes('tool_disabled_by_config')
      ))
      assert.equal(disabledResults.length, disabledNames.length)
      return { content: 'The configured tools are visible but disabled for execution.', toolCalls: [] }
    },
    executeTool: async () => {
      executions += 1
      return { ok: true }
    },
  })

  assert.equal(executions, 0)
  assert.equal(modelCalls, 2)
  assert.deepEqual(completed.map((entry) => entry.name).sort(), [...disabledNames].sort())
  assert.equal(completed.every((entry) => entry.result?.code === 'tool_disabled_by_config'), true)
  assert.equal(result.text, 'The configured tools are visible but disabled for execution.')
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

test('an explicit single-file read cannot finish with a zero-tool promise', async () => {
  const readFile = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'read_file')
  const observedRequests = []
  let modelCalls = 0
  let toolCalls = 0
  const prompt = '请读取 package.json 并告诉我 test 脚本。'
  const result = await runToolsLoop({
    job: {
      id: 'job-explicit-file-read-evidence',
      userId: null,
      origin: 'chat',
      prompt,
    },
    step: { id: 'step-explicit-file-read-evidence', kind: 'chat' },
    messages: [{ role: 'user', content: prompt }],
    toolSpecs: [readFile],
    maxIters: 4,
    enableToolHooks: false,
    runModel: async ({ messages }) => {
      modelCalls += 1
      observedRequests.push(structuredClone(messages))
      if (modelCalls === 1) {
        return { content: '我会先打开 package.json，然后再告诉你结果。', toolCalls: [] }
      }
      if (modelCalls === 2) {
        return {
          content: '',
          toolCalls: [{
            id: 'read-package-json',
            type: 'function',
            function: { name: 'read_file', arguments: JSON.stringify({ path: 'package.json' }) },
          }],
        }
      }
      return { content: '已读取 package.json，test 脚本为 node scripts/run-tests.js。', toolCalls: [] }
    },
    executeTool: async ({ name }) => {
      toolCalls += 1
      assert.equal(name, 'read_file')
      return { ok: true, path: 'package.json', content: '{"scripts":{"test":"node scripts/run-tests.js"}}' }
    },
  })

  assert.equal(modelCalls, 3)
  assert.equal(toolCalls, 1)
  assert.equal(result.text, '已读取 package.json，test 脚本为 node scripts/run-tests.js。')
  const correction = observedRequests[1]
    .filter((item) => item.role === 'system')
    .map((item) => item.content)
    .join('\n')
  assert.match(correction, /\[EXECUTION EVIDENCE REQUIRED\]/)
})

test('a local mutation retry may finish when strict target checks prove the requested state already exists', async () => {
  const names = ['write_file', 'edit_file', 'read_file', 'grep_code']
  const specs = names.map((name) => SERVER_TOOL_SPECS.find((item) => item?.function?.name === name))
  assert.equal(specs.every(Boolean), true)

  const target = 'qa-context-test.html'
  const repeatedPrompt = `继续修改现有原文件 ${target}：使用蓝紫渐变，优化卡片层次。只修改这个原文件。`
  const executed = []
  let modelCalls = 0
  const result = await runToolsLoop({
    job: {
      id: 'job-existing-local-state-verified',
      userId: null,
      origin: 'chat',
      prompt: repeatedPrompt,
      userPrompt: repeatedPrompt,
    },
    step: { id: 'step-existing-local-state-verified', kind: 'chat' },
    messages: [
      { role: 'user', content: repeatedPrompt },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'prior-edit-target',
          type: 'function',
          function: {
            name: 'edit_file',
            arguments: JSON.stringify({
              path: target,
              old_string: '--accent:#6d5dfc',
              new_string: '--accent:#4f46e5;--accent2:#a855f7',
            }),
          },
        }],
      },
      {
        role: 'tool',
        tool_call_id: 'prior-edit-target',
        name: 'edit_file',
        content: JSON.stringify({
          ok: true,
          path: target,
          replacedCount: 1,
          changes: [{ path: target, additions: 1, deletions: 1 }],
        }),
      },
      { role: 'assistant', content: '任务未能正确收尾，请重试。' },
      { role: 'user', content: repeatedPrompt },
    ],
    intentMode: 'execute',
    toolSpecs: specs,
    maxIters: 6,
    enableToolHooks: false,
    runModel: async () => {
      modelCalls += 1
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [{
            id: 'read-existing-target',
            type: 'function',
            function: { name: 'read_file', arguments: JSON.stringify({ path: target, offset: 0, limit: 0 }) },
          }],
        }
      }
      if (modelCalls === 2) {
        return {
          content: '上一轮修改已经在目标文件中，无需重复写入；我会定向核对要求。',
          toolCalls: [
            {
              id: 'verify-existing-colors',
              type: 'function',
              function: {
                name: 'grep_code',
                arguments: JSON.stringify({ pattern: '#4f46e5|#a855f7', path: target }),
              },
            },
            {
              id: 'verify-existing-cards',
              type: 'function',
              function: {
                name: 'grep_code',
                arguments: JSON.stringify({ pattern: 'card::before|card:hover', path: target }),
              },
            },
          ],
        }
      }
      return {
        content: '目标文件已经包含蓝紫渐变和优化后的卡片层次；已完成完整读取与定向核验，无需重复修改。',
        toolCalls: [],
      }
    },
    executeTool: async ({ name, args }) => {
      executed.push({ name, path: args.path })
      assert.equal(args.path, target)
      if (name === 'read_file') {
        return {
          ok: true,
          path: target,
          content: '<style>:root{--accent:#4f46e5;--accent2:#a855f7}.card::before{}.card:hover{}</style>',
          size: 96,
          totalLines: 1,
          offset: 0,
          returnedLines: 1,
          truncated: false,
        }
      }
      if (name === 'grep_code') {
        return {
          ok: true,
          pattern: args.pattern,
          searched_path: target,
          total: 2,
          truncated: false,
          matches: [{ file: target, line: 1, text: args.pattern }],
        }
      }
      assert.fail(`unexpected mutation call: ${name}`)
    },
  })

  assert.deepEqual(executed.map(({ name }) => name), ['read_file', 'grep_code', 'grep_code'])
  assert.equal(modelCalls, 3)
  assert.equal(result.incomplete, undefined)
  assert.match(result.text, /无需重复修改/)
})

test('checks against an unrelated file cannot replace required local mutation evidence', async () => {
  const names = ['write_file', 'read_file', 'grep_code']
  const specs = names.map((name) => SERVER_TOOL_SPECS.find((item) => item?.function?.name === name))
  assert.equal(specs.every(Boolean), true)

  let modelCalls = 0
  const result = await runToolsLoop({
    job: {
      id: 'job-existing-local-state-unrelated',
      userId: null,
      origin: 'chat',
      prompt: '修改现有原文件 qa-context-test.html 的主视觉。',
      userPrompt: '修改现有原文件 qa-context-test.html 的主视觉。',
    },
    step: { id: 'step-existing-local-state-unrelated', kind: 'chat' },
    messages: [{ role: 'user', content: '修改现有原文件 qa-context-test.html 的主视觉。' }],
    intentMode: 'execute',
    toolSpecs: specs,
    maxIters: 4,
    enableToolHooks: false,
    runModel: async () => {
      modelCalls += 1
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [{
            id: 'read-unrelated-target',
            type: 'function',
            function: { name: 'read_file', arguments: JSON.stringify({ path: 'README.md' }) },
          }],
        }
      }
      if (modelCalls === 2) {
        return {
          content: '',
          toolCalls: [{
            id: 'grep-unrelated-target',
            type: 'function',
            function: { name: 'grep_code', arguments: JSON.stringify({ pattern: 'Gugo', path: 'README.md' }) },
          }],
        }
      }
      return { content: '已经完成修改。', toolCalls: [] }
    },
    executeTool: async ({ name, args }) => name === 'read_file'
      ? {
          ok: true,
          path: args.path,
          content: '# Gugo',
          totalLines: 1,
          offset: 0,
          returnedLines: 1,
          truncated: false,
        }
      : {
          ok: true,
          searched_path: args.path,
          total: 1,
          truncated: false,
          matches: [{ file: args.path, line: 1, text: 'Gugo' }],
        },
  })

  assert.equal(result.incomplete, true)
  assert.equal(result.reason, 'execution_evidence_missing')
  assert.doesNotMatch(result.text, /没有调用任何可用工具/)
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
      assert.deepEqual(
        tools.map((item) => item.function.name).sort(),
        [...names, 'set_deliverables'].sort(),
      )
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

test('artifact delivery rejects a fake missing-capability clarification and continues to generation', async (t) => {
  const createPptx = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'create_pptx')
  const clarification = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'request_clarification')
  const setDeliverables = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'set_deliverables')
  const userId = 'artifact-capability-user'
  const sessionId = 'artifact-capability-session'
  const artifactId = 'pptx-artifact-1'
  const artifactFilename = 'artifact-capability-q3-strategy.pptx'
  const db = getDb()
  db.prepare('DELETE FROM turn_artifacts WHERE id = ? OR filename = ?').run(artifactId, artifactFilename)
  createUser({ id: userId, email: 'artifact-capability@example.com' })
  upsertSession({ id: sessionId, userId, title: 'Artifact capability regression' })
  t.after(() => {
    db.prepare('DELETE FROM users WHERE id = ?').run(userId)
  })
  let modelCalls = 0
  let generatorCalls = 0
  const result = await runToolsLoop({
    job: {
      id: 'artifact-capability-job',
      userId,
      sessionId,
      origin: 'chat',
      prompt: '/ppt Q3 strategy',
    },
    step: { id: 'artifact-capability-step', kind: 'chat' },
    messages: [{ role: 'user', content: '/ppt Q3 strategy' }],
    skillId: 'ppt',
    toolSpecs: [createPptx, clarification, setDeliverables],
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
      if (modelCalls === 3) {
        return {
          content: '',
          toolCalls: [{
            id: 'select-real-pptx',
            type: 'function',
            function: {
              name: 'set_deliverables',
              arguments: JSON.stringify({ artifact_ids: [artifactId] }),
            },
          }],
        }
      }
      return { content: 'The presentation was created.', toolCalls: [] }
    },
    executeTool: async ({ name }) => {
      assert.equal(name, 'create_pptx')
      generatorCalls += 1
      appendTurnArtifact({
        id: artifactId,
        userId,
        sessionId,
        turnId: 'artifact-capability-job',
        type: 'pptx',
        title: 'Q3 strategy',
        url: `/api/artifacts/${artifactFilename}`,
        filename: artifactFilename,
      })
      return { ok: true, artifactId }
    },
  })

  assert.equal(modelCalls, 4)
  assert.equal(generatorCalls, 1)
  assert.equal(result.paused, undefined)
  assert.deepEqual(result.artifactIds, [artifactId])
  assert.deepEqual(result.deliveryArtifactIds, [artifactId])
})

test('a real execution failure still allows a specific clarification', async () => {
  const writeFile = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'write_file')
  const clarification = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'request_clarification')
  let modelCalls = 0
  const executed = []
  const result = await runToolsLoop({
    job: {
      id: 'real-permission-blocker-job',
      userId: null,
      origin: 'chat',
      locale: 'en',
      prompt: 'Create result.txt now.',
    },
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

test('refreshed terse chat keeps the same local write catalog on every model round', async () => {
  const prompt = '你来操作'
  const selectedSpecs = selectJobToolSpecs({
    origin: 'chat',
    specs: SERVER_TOOL_SPECS,
    prompt,
    userPrompt: prompt,
    previousUserPrompt: '请说明上一轮的处理结果。',
  })
  const catalogs = []
  let modelCalls = 0

  const result = await runToolsLoop({
    job: {
      id: 'job-refreshed-terse-local-catalog',
      userId: null,
      origin: 'chat',
      prompt,
      userPrompt: prompt,
    },
    step: { id: 'step-refreshed-terse-local-catalog', kind: 'chat' },
    messages: [
      { role: 'user', content: '请说明上一轮的处理结果。' },
      { role: 'assistant', content: '上一轮回答。' },
      { role: 'user', content: prompt },
    ],
    toolSpecs: selectedSpecs,
    maxIters: 3,
    enableToolHooks: false,
    runModel: async ({ tools }) => {
      modelCalls += 1
      catalogs.push(tools.map((item) => item?.function?.name).filter(Boolean).sort())
      if (modelCalls <= 2) {
        return {
          content: '',
          toolCalls: [{
            id: `read-round-${modelCalls}`,
            type: 'function',
            function: {
              name: 'read_file',
              arguments: JSON.stringify({ path: `round-${modelCalls}.txt` }),
            },
          }],
        }
      }
      return { content: '已检查当前状态。', toolCalls: [] }
    },
    executeTool: async ({ name, args }) => ({ ok: true, path: args.path, content: name }),
  })

  assert.equal(modelCalls, 3)
  assert.deepEqual(catalogs[1], catalogs[0])
  assert.deepEqual(catalogs[2], catalogs[0])
  for (const name of ['write_file', 'edit_file', 'apply_patch', 'patch_file', 'bash_exec', 'run_command', 'run_project_check', 'run_test']) {
    assert.ok(catalogs[0].includes(name), name)
  }
  assert.equal(catalogs[0].includes('slack_send_message'), true)
  assert.equal(result.text, '已检查当前状态。')
})

test('a first-turn visual edit exposes write tools and rejects a false missing-tool answer after reads', async () => {
  const target = 'E:\\果\\gallery.html'
  const prompt = `"${target}"这个网站，是用了很多图片，但是现在我还有几个需求，1.图片之间太过拥挤2.旋转的时候似乎无法维系圆形`
  const names = ['read_file', 'write_file', 'edit_file', 'apply_patch', 'grep_code', 'find_symbol']
  const specs = names.map((name) => SERVER_TOOL_SPECS.find((item) => item?.function?.name === name))
  assert.equal(specs.every(Boolean), true)

  const executed = []
  const modelRequestMessages = []
  let modelCalls = 0
  let updated = false
  const result = await runToolsLoop({
    job: {
      id: 'job-first-turn-visual-edit-tools',
      userId: null,
      origin: 'chat',
      prompt,
      userPrompt: prompt,
    },
    step: { id: 'step-first-turn-visual-edit-tools', kind: 'chat' },
    messages: [{ role: 'user', content: prompt }],
    toolSpecs: specs,
    approvalMode: 'bypass',
    maxIters: 7,
    enableToolHooks: false,
    runModel: async ({ messages, tools }) => {
      modelRequestMessages.push(structuredClone(messages))
      modelCalls += 1
      const visibleNames = tools.map((item) => item?.function?.name).filter(Boolean)
      for (const name of ['read_file', 'write_file', 'edit_file', 'apply_patch']) {
        assert.ok(visibleNames.includes(name), `first-turn schema must include ${name}`)
      }
      if (modelCalls === 1) {
        const systemText = messages
          .filter((item) => item.role === 'system')
          .map((item) => item.content)
          .join('\n')
        assert.match(systemText, /\[RUNTIME CAPABILITIES\]/)
        assert.match(systemText, /File changes: create or edit authorized local files/)
        assert.match(systemText, /Calling only read tools is not evidence that write tools are absent/)
        assert.match(systemText, /\[AVAILABLE TOOL CAPABILITIES\]/)
        assert.match(systemText, /apply_patch\/edit_file\/write_file can create or modify authorized files/)
        return {
          content: '',
          toolCalls: [{
            id: 'inspect-gallery-first',
            type: 'function',
            function: { name: 'read_file', arguments: JSON.stringify({ path: target }) },
          }],
        }
      }
      if (modelCalls === 2) {
        return {
          content: '没有文件写入工具可用。我只能给出完整修改后的代码。',
          toolCalls: [],
        }
      }
      if (modelCalls === 3) {
        const systemText = messages
          .filter((item) => item.role === 'system')
          .map((item) => item.content)
          .join('\n')
        assert.match(systemText, /\[EXECUTION EVIDENCE REQUIRED\]/)
        return {
          content: '',
          toolCalls: [{
            id: 'write-gallery-after-denial',
            type: 'function',
            function: {
              name: 'write_file',
              arguments: JSON.stringify({ path: target, content: '<!doctype html><title>fixed</title>' }),
            },
          }],
        }
      }
      if (modelCalls === 4) {
        return {
          content: '',
          toolCalls: [{
            id: 'verify-gallery-after-write',
            type: 'function',
            function: { name: 'read_file', arguments: JSON.stringify({ path: target }) },
          }],
        }
      }
      return { content: '已原位修改并回读验证 gallery.html。', toolCalls: [] }
    },
    executeTool: async ({ name, args }) => {
      executed.push(name)
      assert.equal(args.path, target)
      if (name === 'write_file') {
        updated = true
        return { ok: true, path: target, bytes: Buffer.byteLength(args.content), changedPaths: [target] }
      }
      assert.equal(name, 'read_file')
      return {
        ok: true,
        path: target,
        content: updated
          ? '<!doctype html><title>fixed</title>'
          : '<!doctype html><title>broken</title>',
        truncated: false,
      }
    },
  })

  assert.equal(result.text, '已原位修改并回读验证 gallery.html。')
  assert.equal(result.incomplete, undefined)
  assert.deepEqual(executed, ['read_file', 'write_file', 'read_file'])
  assert.equal(modelCalls, process.platform === 'win32' ? 6 : 5)
  const reviewRequests = modelRequestMessages.filter((request) => request.some((message) => (
    message.role === 'system'
      && String(message.content).includes('[FINAL ANSWER EVIDENCE REVIEW REQUIRED]')
  )))
  assert.equal(reviewRequests.length, 1)
  assert.equal(reviewRequests[0], modelRequestMessages.at(-1))
  const reviewText = reviewRequests[0].map((message) => String(message.content || '')).join('\n')
  assert.match(reviewText, /postMutationVerificationPassed":true/)
  assert.match(reviewText, /localHtmlValidationPassed":true/)
})

test('execution completion text stays private until the current evidence review is valid', async () => {
  const target = 'D:\\evidence-review-stream-guard.txt'
  const specs = ['read_file', 'write_file']
    .map((name) => SERVER_TOOL_SPECS.find((item) => item?.function?.name === name))
  const deltas = []
  let modelCalls = 0
  let written = false
  const result = await runToolsLoop({
    job: {
      id: 'job-evidence-review-stream-guard',
      userId: null,
      origin: 'chat',
      prompt: `Modify ${target} and verify the saved content.`,
    },
    step: { id: 'step-evidence-review-stream-guard', kind: 'chat' },
    messages: [{ role: 'user', content: `Modify ${target} and verify the saved content.` }],
    intentMode: 'execute',
    toolSpecs: specs,
    approvalMode: 'bypass',
    maxIters: 7,
    enableToolHooks: false,
    onModelDelta: async ({ text }) => deltas.push(text),
    runModel: async ({ messages, onTextDelta }) => {
      modelCalls += 1
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [{
            id: 'stream-guard-initial-read',
            type: 'function',
            function: { name: 'read_file', arguments: JSON.stringify({ path: target }) },
          }],
        }
      }
      if (modelCalls === 2) {
        return {
          content: '',
          toolCalls: [{
            id: 'stream-guard-write',
            type: 'function',
            function: {
              name: 'write_file',
              arguments: JSON.stringify({ path: target, content: 'updated' }),
            },
          }],
        }
      }
      if (modelCalls === 3) {
        await onTextDelta?.('Premature completed claim.')
        return { content: 'Premature completed claim.', toolCalls: [] }
      }
      if (modelCalls === 4) {
        return {
          content: '',
          toolCalls: [{
            id: 'stream-guard-verification-read',
            type: 'function',
            function: { name: 'read_file', arguments: JSON.stringify({ path: target }) },
          }],
        }
      }
      const reviewText = messages.map((message) => String(message.content || '')).join('\n')
      assert.match(reviewText, /\[FINAL ANSWER EVIDENCE REVIEW REQUIRED\]/u)
      await onTextDelta?.('Verified completion.')
      return { content: 'Verified completion.', toolCalls: [] }
    },
    executeTool: async ({ name, args }) => {
      if (name === 'write_file') {
        written = true
        return { ok: true, path: args.path, changedPaths: [args.path] }
      }
      return {
        ok: true,
        path: args.path,
        content: written ? 'updated' : 'original',
        truncated: false,
      }
    },
  })

  assert.equal(modelCalls, 5)
  assert.equal(result.text, 'Verified completion.')
  assert.deepEqual(deltas, ['Verified completion.'])
})

test('a successful expected-path HTML patch suppresses a stray generate_image call', async () => {
  const target = 'E:\\果\\gallery.html'
  const prompt = '修改本地文件 ' + target + '，修复图片旋转时无法维持圆形的问题。'
  const specs = ['write_file', 'read_file', 'generate_image']
    .map((name) => SERVER_TOOL_SPECS.find((item) => item?.function?.name === name))
  const executed = []
  let modelCalls = 0

  const result = await runToolsLoop({
    job: {
      id: 'job-html-patch-image-fallback-guard',
      userId: null,
      origin: 'chat',
      prompt,
      userPrompt: prompt,
    },
    step: { id: 'step-html-patch-image-fallback-guard', kind: 'chat' },
    messages: [{ role: 'user', content: prompt }],
    toolSpecs: specs,
    approvalMode: 'bypass',
    maxIters: 6,
    enableToolHooks: false,
    runModel: async ({ messages, tools }) => {
      modelCalls += 1
      const names = tools.map((item) => item?.function?.name)
      assert.ok(names.includes('write_file'))
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [{
            id: 'patch-html-file',
            function: {
              name: 'write_file',
              arguments: JSON.stringify({
                path: target,
                content: '<!doctype html><html><body><div class="ring">fixed</div></body></html>',
              }),
            },
          }],
        }
      }
      if (modelCalls === 2) {
        return {
          content: '',
          toolCalls: [{
            id: 'stray-image-fallback',
            function: {
              name: 'generate_image',
              arguments: JSON.stringify({ prompt: 'unrequested replacement image' }),
            },
          }],
        }
      }
      if (modelCalls === 3) {
        const feedback = messages.findLast((message) => message.role === 'tool'
          && message.tool_call_id === 'stray-image-fallback')
        assert.ok(feedback)
        const parsed = JSON.parse(feedback.content)
        assert.equal(parsed.code, 'image_generation_not_requested_after_file_patch')
        assert.equal(parsed.retryable, false)
        assert.match(parsed.error, /已有修复写入成功/)
        return {
          content: '',
          toolCalls: [{
            id: 'verify-html-file',
            function: { name: 'read_file', arguments: JSON.stringify({ path: target }) },
          }],
        }
      }
      return { content: '已修复并验证指定 HTML 文件。', toolCalls: [] }
    },
    executeTool: async ({ name, args }) => {
      executed.push(name)
      assert.notEqual(name, 'generate_image')
      if (name === 'write_file') return { ok: true, path: target, changedPaths: [target] }
      if (name === 'read_file') {
        return {
          ok: true,
          path: args.path,
          content: '<!doctype html><html><body><div class="ring">fixed</div></body></html>',
          truncated: false,
        }
      }
      assert.fail('unexpected executor call: ' + name)
    },
  })

  assert.deepEqual(executed, ['write_file', 'read_file'])
  assert.equal(result.incomplete, undefined)
  assert.equal(result.text, '已修复并验证指定 HTML 文件。')
})

test('artifact delivery errors are advisory and non-retryable', () => {
  const error = artifactDeliveryError(['generate_image'])
  assert.equal(error.code, 'ARTIFACT_NOT_CREATED')
  assert.equal(error.retryable, false)
  assert.doesNotMatch(error.message, /must successfully call/i)
  assert.match(error.message, /Decide whether to continue/)
})

test('a behavioral revision rejects a post-read missing-tool claim and rewrites the canonical target', async () => {
  const target = 'E:\\果\\gallery.html'
  const originalRequest = `请修改 ${target} 的图片圆环旋转效果并写回原文件。`
  const previousUserPrompt = '你来修改'
  const revision = '无论我怎么旋转，图片要始终面向我'
  const names = ['read_file', 'write_file', 'edit_file', 'apply_patch']
  const specs = names.map((name) => SERVER_TOOL_SPECS.find((item) => item?.function?.name === name))
  assert.equal(specs.every(Boolean), true)

  const executed = []
  const checkpoints = []
  const modelRequestMessages = []
  let modelCalls = 0
  let updated = false
  const result = await runToolsLoop({
    job: {
      id: 'job-behavioral-file-revision',
      userId: null,
      origin: 'chat',
      prompt: revision,
      userPrompt: revision,
      previousUserPrompt,
    },
    step: { id: 'step-behavioral-file-revision', kind: 'chat' },
    messages: [
      { role: 'user', content: originalRequest },
      { role: 'assistant', content: '我可以先说明修改方案。' },
      { role: 'user', content: previousUserPrompt },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'prior-gallery-write',
          type: 'function',
          function: {
            name: 'write_file',
            arguments: JSON.stringify({ path: target, content: '<!doctype html><title>round</title>' }),
          },
        }],
      },
      {
        role: 'tool',
        tool_call_id: 'prior-gallery-write',
        name: 'write_file',
        content: JSON.stringify({ ok: true, path: target, changedPaths: [target] }),
      },
      { role: 'assistant', content: '已直接修改 gallery.html。' },
      { role: 'user', content: revision },
    ],
    toolSpecs: specs,
    approvalMode: 'bypass',
    maxIters: 5,
    enableToolHooks: false,
    saveCheckpoint: async (checkpoint) => {
      checkpoints.push(structuredClone(checkpoint))
      return true
    },
    runModel: async ({ messages, tools }) => {
      modelRequestMessages.push(structuredClone(messages))
      modelCalls += 1
      const visibleNames = tools.map((item) => item?.function?.name).filter(Boolean)
      for (const name of names) assert.ok(visibleNames.includes(name), `${name} must remain mounted`)

      if (modelCalls === 1) {
        const systemText = messages
          .filter((item) => item.role === 'system')
          .map((item) => item.content)
          .join('\n')
        assert.match(systemText, /\[CANONICAL LOCAL FILE CONTINUATION\]/)
        assert.ok(systemText.includes(target.replaceAll('\\', '/')))
        return {
          content: '',
          toolCalls: [{
            id: 'read-facing-gallery-before-change',
            type: 'function',
            function: { name: 'read_file', arguments: JSON.stringify({ path: target }) },
          }],
        }
      }
      if (modelCalls === 2) {
        return { content: '当前轮次没有文件写入工具，所以我不能直接修改。', toolCalls: [] }
      }
      if (modelCalls === 3) {
        const systemText = messages
          .filter((item) => item.role === 'system')
          .map((item) => item.content)
          .join('\n')
        assert.match(systemText, /\[EXECUTION EVIDENCE REQUIRED\]/)
        return {
          content: '',
          toolCalls: [{
            id: 'write-facing-gallery',
            type: 'function',
            function: {
              name: 'write_file',
              arguments: JSON.stringify({ path: target, content: '<!doctype html><title>always-facing</title>' }),
            },
          }],
        }
      }
      if (modelCalls === 4) {
        return {
          content: '',
          toolCalls: [{
            id: 'verify-facing-gallery',
            type: 'function',
            function: { name: 'read_file', arguments: JSON.stringify({ path: target }) },
          }],
        }
      }
      return { content: '已让所有图片在旋转时始终面向镜头，并回读验证。', toolCalls: [] }
    },
    executeTool: async ({ name, args }) => {
      executed.push(name)
      assert.equal(args.path, target)
      if (name === 'write_file') {
        updated = true
        return { ok: true, path: target, bytes: Buffer.byteLength(args.content), changedPaths: [target] }
      }
      assert.equal(name, 'read_file')
      return {
        ok: true,
        path: target,
        content: updated
          ? '<!doctype html><title>always-facing</title>'
          : '<!doctype html><title>round</title>',
        truncated: false,
      }
    },
  })

  assert.equal(result.text, '已让所有图片在旋转时始终面向镜头，并回读验证。')
  assert.equal(result.incomplete, undefined)
  assert.deepEqual(executed, ['read_file', 'write_file', 'read_file'])
  assert.equal(modelCalls, process.platform === 'win32' ? 6 : 5)
  const reviewRequests = modelRequestMessages.filter((request) => request.some((message) => (
    message.role === 'system'
      && String(message.content).includes('[FINAL ANSWER EVIDENCE REVIEW REQUIRED]')
  )))
  assert.equal(reviewRequests.length, 1)
  assert.equal(reviewRequests[0], modelRequestMessages.at(-1))
  const reviewText = reviewRequests[0].map((message) => String(message.content || '')).join('\n')
  assert.match(reviewText, /postMutationVerificationPassed":true/)
  assert.match(reviewText, /localHtmlValidationPassed":true/)
  const capabilityDecision = checkpoints.at(-1)?.capabilityDecision
  assert.deepEqual(capabilityDecision?.requiredCapabilities, [
    'execution_evidence',
    'mutation_evidence',
    'post_mutation_verification',
  ])
  assert.equal(capabilityDecision?.capabilityMode, 'execute')
  for (const name of names) assert.ok(capabilityDecision?.selectedTools.includes(name), name)
  assert.deepEqual(capabilityDecision?.unmetCapabilities, [])
})

test('a capability challenge after a false refusal rechecks tools and completes the prior mutation', async () => {
  const target = 'E:\\果\\gallery.html'
  const previousUserPrompt = `请修改 ${target} 的卡片翻转方向并写回原文件。`
  const challenge = '为什么不能你自己修改？'
  const names = ['read_file', 'write_file', 'edit_file', 'apply_patch']
  const specs = names.map((name) => SERVER_TOOL_SPECS.find((item) => item?.function?.name === name))
  assert.equal(specs.every(Boolean), true)

  const executed = []
  const modelRequestMessages = []
  let modelCalls = 0
  let updated = false
  const result = await runToolsLoop({
    job: {
      id: 'job-capability-challenge-continuation',
      userId: null,
      origin: 'chat',
      prompt: challenge,
      userPrompt: challenge,
      previousUserPrompt,
    },
    step: { id: 'step-capability-challenge-continuation', kind: 'chat' },
    messages: [
      { role: 'user', content: previousUserPrompt },
      { role: 'assistant', content: '我不能直接修改，因为当前没有文件写入工具。' },
      { role: 'user', content: challenge },
    ],
    toolSpecs: specs,
    approvalMode: 'bypass',
    maxIters: 6,
    enableToolHooks: false,
    runModel: async ({ messages, tools }) => {
      modelRequestMessages.push(structuredClone(messages))
      modelCalls += 1
      const visibleNames = tools.map((item) => item?.function?.name).filter(Boolean)
      for (const name of names) assert.ok(visibleNames.includes(name), `${name} must be rechecked`)

      if (modelCalls === 1) {
        const systemText = messages
          .filter((item) => item.role === 'system')
          .map((item) => item.content)
          .join('\n')
        assert.match(systemText, /If the user challenges a prior claim/)
        return { content: '仍然没有文件写入工具，所以我无法替你修改。', toolCalls: [] }
      }
      if (modelCalls === 2) {
        const systemText = messages
          .filter((item) => item.role === 'system')
          .map((item) => item.content)
          .join('\n')
        assert.match(systemText, /\[EXECUTION EVIDENCE REQUIRED\]/)
        return {
          content: '',
          toolCalls: [{
            id: 'write-after-capability-challenge',
            type: 'function',
            function: {
              name: 'write_file',
              arguments: JSON.stringify({ path: target, content: '<!doctype html><title>fixed</title>' }),
            },
          }],
        }
      }
      if (modelCalls === 3) {
        return {
          content: '',
          toolCalls: [{
            id: 'verify-after-capability-challenge',
            type: 'function',
            function: { name: 'read_file', arguments: JSON.stringify({ path: target }) },
          }],
        }
      }
      return { content: '已直接修改并回读验证 gallery.html。', toolCalls: [] }
    },
    executeTool: async ({ name, args }) => {
      executed.push(name)
      assert.equal(args.path, target)
      if (name === 'write_file') {
        updated = true
        return { ok: true, path: target, bytes: Buffer.byteLength(args.content), changedPaths: [target] }
      }
      assert.equal(name, 'read_file')
      return {
        ok: true,
        path: target,
        content: updated
          ? '<!doctype html><title>fixed</title>'
          : '<!doctype html><title>broken</title>',
        truncated: false,
      }
    },
  })

  assert.equal(result.text, '已直接修改并回读验证 gallery.html。')
  assert.equal(result.incomplete, undefined)
  assert.deepEqual(executed, ['write_file', 'read_file'])
  assert.equal(modelCalls, process.platform === 'win32' ? 5 : 4)
  const reviewRequests = modelRequestMessages.filter((request) => request.some((message) => (
    message.role === 'system'
      && String(message.content).includes('[FINAL ANSWER EVIDENCE REVIEW REQUIRED]')
  )))
  assert.equal(reviewRequests.length, 1)
  assert.equal(reviewRequests[0], modelRequestMessages.at(-1))
  const reviewText = reviewRequests[0].map((message) => String(message.content || '')).join('\n')
  assert.match(reviewText, /postMutationVerificationPassed":true/)
  assert.match(reviewText, /localHtmlValidationPassed":true/)
})

test('a capability challenge after an explicit read-only turn sees write tools but cannot execute them', async () => {
  const target = 'E:\\果\\gallery.html'
  const previousUserPrompt = `请只分析 ${target} 的卡片翻转问题，不要编辑、调整或写回文件。`
  const challenge = '为什么不能你自己修改？'
  const catalogNames = ['read_file', 'write_file', 'edit_file', 'apply_patch']
  const catalog = catalogNames.map((name) => SERVER_TOOL_SPECS.find((item) => item?.function?.name === name))
  assert.equal(catalog.every(Boolean), true)
  const selectedCatalog = selectJobToolSpecs({
    origin: 'chat',
    specs: catalog,
    prompt: challenge,
    userPrompt: challenge,
    previousUserPrompt,
  })
  assert.deepEqual(
    selectedCatalog.map((item) => item?.function?.name).sort(),
    [...catalogNames, 'set_deliverables'].sort(),
  )

  let modelCalls = 0
  const executed = []
  const result = await runToolsLoop({
    job: {
      id: 'job-read-only-capability-challenge',
      userId: null,
      origin: 'chat',
      prompt: challenge,
      userPrompt: challenge,
      previousUserPrompt,
    },
    step: { id: 'step-read-only-capability-challenge', kind: 'chat' },
    messages: [
      { role: 'user', content: previousUserPrompt },
      { role: 'assistant', content: '按你的要求只做分析，因此不能也无需写入文件。' },
      { role: 'user', content: challenge },
    ],
    toolSpecs: selectedCatalog,
    approvalMode: 'bypass',
    maxIters: 3,
    enableToolHooks: false,
    runModel: async ({ messages, tools }) => {
      modelCalls += 1
      const visibleNames = tools.map((item) => item?.function?.name).filter(Boolean)
      assert.ok(visibleNames.includes('read_file'))
      for (const name of ['write_file', 'edit_file', 'apply_patch']) {
        assert.equal(visibleNames.includes(name), true, `${name} must remain visible`)
      }

      const systemText = messages
        .filter((item) => item.role === 'system')
        .map((item) => item.content)
        .join('\n')
      assert.doesNotMatch(systemText, /\[EXECUTION EVIDENCE REQUIRED\]/)
      assert.match(systemText, /File changes: create or edit authorized local files/)
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [{
            id: 'forbidden-read-only-write',
            type: 'function',
            function: {
              name: 'write_file',
              arguments: JSON.stringify({ path: target, content: 'must not be written' }),
            },
          }],
        }
      }
      const toolResult = messages.find((item) => (
        item.role === 'tool' && item.tool_call_id === 'forbidden-read-only-write'
      ))
      assert.match(String(toolResult?.content || ''), /explicit_read_only_constraint/)
      assert.match(String(toolResult?.content || ''), /不是缺少写入或执行工具/)
      return { content: '上一轮要求只分析，因此没有执行文件修改。', toolCalls: [] }
    },
    executeTool: async ({ name }) => {
      executed.push(name)
      return { ok: true }
    },
  })

  assert.equal(result.text, '上一轮要求只分析，因此没有执行文件修改。')
  assert.equal(result.incomplete, undefined)
  assert.deepEqual(executed, [])
  assert.equal(modelCalls, 2)
})

test('a current-turn explicit read-only constraint blocks mutating calls before execution', async () => {
  const target = 'D:\\work\\read-only-audit.txt'
  const readFile = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'read_file')
  assert.ok(readFile)
  let modelCalls = 0
  const executed = []

  const result = await runToolsLoop({
    job: {
      id: 'job-current-turn-read-only-guard',
      userId: null,
      origin: 'chat',
      prompt: `只读检查 ${target}，不要修改或写回任何文件。`,
      userPrompt: `只读检查 ${target}，不要修改或写回任何文件。`,
    },
    step: { id: 'step-current-turn-read-only-guard', kind: 'chat' },
    messages: [{ role: 'user', content: `只读检查 ${target}，不要修改或写回任何文件。` }],
    // The write tool is intentionally absent from the model-visible catalog.
    // A custom executor would normally accept unknown calls, so this proves
    // the execution boundary is independent of visibility filtering.
    toolSpecs: [readFile],
    approvalMode: 'bypass',
    maxIters: 3,
    enableToolHooks: false,
    runModel: async ({ messages }) => {
      modelCalls += 1
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [{
            id: 'read-only-write-attempt',
            type: 'function',
            function: {
              name: 'write_file',
              arguments: JSON.stringify({ path: target, content: 'forbidden' }),
            },
          }],
        }
      }
      const denied = messages.find((message) => (
        message.role === 'tool' && message.tool_call_id === 'read-only-write-attempt'
      ))
      assert.match(String(denied?.content || ''), /explicit_read_only_constraint/)
      assert.match(String(denied?.content || ''), /不是缺少写入或执行工具/)
      return { content: '已完成只读检查，没有修改文件。', toolCalls: [] }
    },
    executeTool: async ({ name }) => {
      executed.push(name)
      return { ok: true }
    },
  })

  assert.equal(result.text, '已完成只读检查，没有修改文件。')
  assert.deepEqual(executed, [])
  assert.equal(modelCalls, 2)
})

test('an explicit read-only constraint revalidates approval-edited arguments', async () => {
  const bashExec = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'bash_exec')
  assert.ok(bashExec)
  let modelCalls = 0
  let approvalCalls = 0
  let executeCalls = 0

  const result = await runToolsLoop({
    job: {
      id: 'job-read-only-approval-edit-guard',
      userId: null,
      origin: 'chat',
      prompt: '只读检查仓库，不要修改任何文件。',
      userPrompt: '只读检查仓库，不要修改任何文件。',
    },
    step: { id: 'step-read-only-approval-edit-guard', kind: 'chat' },
    messages: [{ role: 'user', content: '只读检查仓库，不要修改任何文件。' }],
    toolSpecs: [bashExec],
    maxIters: 3,
    enableToolHooks: false,
    requestToolApproval: async ({ args }) => {
      approvalCalls += 1
      assert.equal(args.command, 'git status --short')
      return {
        proceed: true,
        args: { command: 'node -e "require(\'fs\').writeFileSync(\'forbidden.txt\',\'x\')"' },
        edited: true,
        approvalId: 'read-only-edited-approval',
      }
    },
    runModel: async ({ messages }) => {
      modelCalls += 1
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [{
            id: 'read-only-approval-edit',
            type: 'function',
            function: { name: 'bash_exec', arguments: JSON.stringify({ command: 'git status --short' }) },
          }],
        }
      }
      const denied = messages.find((message) => (
        message.role === 'tool' && message.tool_call_id === 'read-only-approval-edit'
      ))
      assert.match(String(denied?.content || ''), /explicit_read_only_constraint/)
      return { content: '只读检查结束，没有执行改写后的命令。', toolCalls: [] }
    },
    executeTool: async () => {
      executeCalls += 1
      return { ok: true }
    },
  })

  assert.equal(result.text, '只读检查结束，没有执行改写后的命令。')
  assert.equal(approvalCalls, 1)
  assert.equal(executeCalls, 0)
})

test('an executing checkpoint cannot resume with mutating args under a current read-only constraint', async () => {
  const callId = 'read-only-resumed-call'
  let checkpoint = {
    messages: [
      { role: 'user', content: '只读检查仓库，不要修改任何文件。' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: callId,
          type: 'function',
          function: { name: 'bash_exec', arguments: JSON.stringify({ command: 'git status --short' }) },
        }],
      },
    ],
    toolCalls: [{
      id: callId,
      name: 'bash_exec',
      args: { command: 'git status --short' },
      argumentsText: JSON.stringify({ command: 'git status --short' }),
      parseError: null,
      checkpointStatus: 'executing',
      checkpointApprovalId: 'persisted-read-only-approval',
      checkpointExecutionArgs: {
        command: 'node -e "require(\'fs\').writeFileSync(\'forbidden-resume.txt\',\'x\')"',
      },
    }],
    artifactIds: [],
    iterations: 0,
  }
  let executeCalls = 0

  const result = await runToolsLoop({
    job: {
      id: 'job-read-only-resume-guard',
      userId: null,
      origin: 'chat',
      prompt: '只读检查仓库，不要修改任何文件。',
      userPrompt: '只读检查仓库，不要修改任何文件。',
    },
    step: { id: 'step-read-only-resume-guard', kind: 'chat' },
    messages: [],
    toolSpecs: [],
    maxIters: 3,
    enableToolHooks: false,
    loadCheckpoint: async () => ({ state: checkpoint }),
    saveCheckpoint: async (state) => {
      checkpoint = structuredClone(state)
      return true
    },
    runModel: async ({ messages }) => {
      const denied = messages.find((message) => (
        message.role === 'tool' && message.tool_call_id === callId
      ))
      assert.match(String(denied?.content || ''), /explicit_read_only_constraint/)
      return { content: '恢复后仍保持只读，没有执行写入命令。', toolCalls: [] }
    },
    executeTool: async () => {
      executeCalls += 1
      return { ok: true }
    },
  })

  assert.equal(result.text, '恢复后仍保持只读，没有执行写入命令。')
  assert.equal(executeCalls, 0)
})

test('bypass recovery never remounts a tool excluded from the current turn enabled catalog', async () => {
  const target = 'D:\\work\\disabled-tool-guard.txt'
  const readFile = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'read_file')
  assert.ok(readFile)

  const visibleToolNames = []
  const result = await runToolsLoop({
    job: {
      id: 'job-disabled-dynamic-tool-guard',
      userId: null,
      origin: 'chat',
      prompt: `修改 ${target}。`,
      userPrompt: `修改 ${target}。`,
    },
    step: { id: 'step-disabled-dynamic-tool-guard', kind: 'chat' },
    messages: [{ role: 'user', content: `修改 ${target}。` }],
    // This is the catalog after the user's tool configuration was applied.
    // write_file/apply_patch/command tools are deliberately disabled.
    toolSpecs: [readFile],
    approvalMode: 'bypass',
    maxIters: 1,
    enableToolHooks: false,
    loadCheckpoint: async () => ({
      state: {
        completionGuards: {
          // A stale checkpoint must not be able to resurrect a now-disabled tool.
          dynamicallyMountedToolNames: ['write_file', 'apply_patch'],
        },
      },
    }),
    runModel: async ({ tools }) => {
      const names = tools.map((item) => item?.function?.name).filter(Boolean)
      visibleToolNames.push(names)
      assert.ok(names.includes('read_file'))
      for (const disabledName of [
        'write_file',
        'edit_file',
        'multi_edit',
        'apply_patch',
        'patch_file',
        'bash_exec',
        'run_command',
      ]) {
        assert.equal(names.includes(disabledName), false, `${disabledName} must remain disabled`)
      }
      return { content: '无法在当前已启用工具范围内完成修改。', toolCalls: [] }
    },
  })

  assert.equal(visibleToolNames.length, 1)
  assert.equal(result.incomplete, true)
})

test('a continuation turn remounts execution tools, preserves the canonical file, and switches tools after failure', async () => {
  const target = 'D:\\work\\gallery.js'
  const priorPrompt = `修改 ${target} 的卡片翻转逻辑。`
  const continuation = '继续刚才未完成的修改。'
  const readFile = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'read_file')
  assert.ok(readFile)
  const enabledExecutionNames = new Set([
    'read_file',
    'write_file',
    'edit_file',
    'apply_patch',
    'patch_file',
    'bash_exec',
    'run_command',
  ])
  const enabledTurnCatalog = SERVER_TOOL_SPECS.filter((item) => (
    enabledExecutionNames.has(item?.function?.name)
  ))
  assert.equal(enabledTurnCatalog.length, enabledExecutionNames.size)

  const modelRequests = []
  const approvalRequests = []
  const executed = []
  let modelCalls = 0
  let patched = false
  const result = await runToolsLoop({
    job: {
      id: 'job-dynamic-execution-continuation',
      userId: null,
      origin: 'chat',
      prompt: continuation,
      userPrompt: continuation,
      previousUserPrompt: priorPrompt,
    },
    step: { id: 'step-dynamic-execution-continuation', kind: 'chat' },
    messages: [
      { role: 'user', content: priorPrompt },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'prior-gallery-edit',
          type: 'function',
          function: {
            name: 'edit_file',
            arguments: JSON.stringify({
              path: target,
              old_string: 'const card = oldCard',
              new_string: 'const card = fixedCard',
            }),
          },
        }],
      },
      {
        role: 'tool',
        tool_call_id: 'prior-gallery-edit',
        name: 'edit_file',
        content: JSON.stringify({ ok: true, path: target, replacedCount: 1, changedPaths: [target] }),
      },
      { role: 'assistant', content: '上一轮未能完成最终验证。' },
      { role: 'user', content: continuation },
    ],
    toolSpecs: [readFile],
    // Simulate the wider catalog already resolved after user configuration.
    // Recovery may remount from this list, never from the global registry.
    fallbackToolSpecs: enabledTurnCatalog,
    approvalMode: 'bypass',
    maxIters: 8,
    toolRetryMaxAttempts: 1,
    enableToolHooks: false,
    onApprovalPending: async () => assert.fail('bypass mode must not enter approval pending'),
    requestToolApproval: async (request) => {
      approvalRequests.push(request)
      assert.equal(request.mode, 'bypass')
      return {
        proceed: true,
        args: request.args,
        approvalId: 'continuation-bypass-approval',
      }
    },
    runModel: async ({ tools, messages }) => {
      modelCalls += 1
      modelRequests.push(structuredClone(messages))
      const names = tools.map((item) => item?.function?.name).filter(Boolean)
      for (const required of ['read_file', 'write_file', 'edit_file', 'apply_patch', 'patch_file', 'bash_exec', 'run_command']) {
        assert.ok(names.includes(required), `${required} must be dynamically mounted`)
      }

      if (modelCalls === 1) {
        const systemText = messages.filter((item) => item.role === 'system').map((item) => item.content).join('\n')
        assert.match(systemText, /\[CANONICAL LOCAL FILE CONTINUATION\]/)
        assert.ok(systemText.includes(target.replaceAll('\\', '/')))
        return {
          content: '',
          toolCalls: [{
            id: 'read-canonical-before-edit',
            type: 'function',
            function: { name: 'read_file', arguments: JSON.stringify({ path: target }) },
          }],
        }
      }
      if (modelCalls === 2) {
        return {
          content: '',
          toolCalls: [{
            id: 'edit-canonical-fails',
            type: 'function',
            function: {
              name: 'edit_file',
              arguments: JSON.stringify({
                path: target,
                old_string: 'const card = staleCard',
                new_string: 'const card = finalCard',
              }),
            },
          }],
        }
      }
      if (modelCalls === 3) {
        const systemText = messages.filter((item) => item.role === 'system').map((item) => item.content).join('\n')
        assert.match(systemText, /\[DYNAMIC EXECUTION TOOL RECOVERY\]/)
        assert.match(systemText, /switch to an equivalent available mutation tool/i)
        return {
          content: '',
          toolCalls: [{
            id: 'patch-canonical-after-edit-failure',
            type: 'function',
            function: {
              name: 'apply_patch',
              arguments: JSON.stringify({
                patch: `*** Begin Patch\n*** Update File: ${target}\n@@\n-const card = fixedCard\n+const card = finalCard\n*** End Patch`,
              }),
            },
          }],
        }
      }
      if (modelCalls === 4) {
        return {
          content: '',
          toolCalls: [{
            id: 'read-canonical-after-patch',
            type: 'function',
            function: { name: 'read_file', arguments: JSON.stringify({ path: target }) },
          }],
        }
      }
      return { content: '正式文件已原位修改并完成回读验证。', toolCalls: [] }
    },
    executeTool: async ({ name, args }) => {
      executed.push({ name, args })
      if (name === 'read_file') {
        assert.equal(args.path, target)
        return {
          ok: true,
          path: target,
          content: patched ? 'const card = finalCard' : 'const card = fixedCard',
          truncated: false,
        }
      }
      if (name === 'edit_file') {
        assert.equal(args.path, target)
        return { ok: false, code: 'EDIT_STRING_NOT_FOUND', error: 'old_string was not found' }
      }
      assert.equal(name, 'apply_patch')
      assert.ok(args.patch.includes(target))
      patched = true
      return { ok: true, changes: [{ path: target, additions: 1, deletions: 1 }] }
    },
  })

  assert.equal(result.text, '正式文件已原位修改并完成回读验证。')
  assert.equal(result.incomplete, undefined)
  assert.deepEqual(executed.map((entry) => entry.name), [
    'read_file',
    'edit_file',
    'apply_patch',
    'read_file',
  ])
  assert.ok(approvalRequests.length >= 4)
  assert.equal(modelRequests.some((messages) => messages.some((message) => (
    message.role === 'system'
      && String(message.content || '').includes('[DYNAMIC EXECUTION TOOL RECOVERY]')
  ))), true)
})

test('a status inquiry keeps the immediately preceding failure after read-only inspection', async () => {
  const readFile = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'read_file')
  let modelCalls = 0
  const messages = [
    { role: 'user', content: '生成并验证 result.txt' },
    {
      role: 'system',
      content: '[PRIOR TURN OUTCOME]\n{"state":"failed","error":{"message":"最终验证没有通过"}}\nThe prior turn did not complete.',
    },
    { role: 'assistant', content: '任务尚未完成。' },
    { role: 'user', content: '完成了吗？' },
  ]

  const result = await runToolsLoop({
    job: { id: 'job-prior-failure-read-only', userId: null, origin: 'chat', prompt: '完成了吗？' },
    step: { id: 'step-prior-failure-read-only', kind: 'chat' },
    messages,
    toolSpecs: [readFile],
    maxIters: 3,
    enableToolHooks: false,
    runModel: async () => {
      modelCalls += 1
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [{
            id: 'inspect-prior-output',
            type: 'function',
            function: { name: 'read_file', arguments: JSON.stringify({ path: 'result.txt' }) },
          }],
        }
      }
      return { content: '已经完成，没有任何问题。', toolCalls: [] }
    },
    executeTool: async () => ({ ok: true, path: 'result.txt', content: 'partial output' }),
  })

  assert.equal(modelCalls, 2)
  assert.match(result.text, /上一轮仍未完成：最终验证没有通过/)
  assert.doesNotMatch(result.text, /没有任何问题/)
})

test('an English status inquiry never exposes a Chinese prior-failure message', async () => {
  const readFile = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'read_file')
  let modelCalls = 0
  const messages = [
    { role: 'user', content: 'Generate and verify result.txt.' },
    {
      role: 'system',
      content: '[PRIOR TURN OUTCOME]\n{"state":"failed","error":{"message":"最终验证没有通过"}}\nThe prior turn did not complete.',
    },
    { role: 'assistant', content: 'The task is incomplete.' },
    { role: 'user', content: 'Is it complete?' },
  ]

  const result = await runToolsLoop({
    job: {
      id: 'job-prior-failure-read-only-en',
      userId: null,
      origin: 'chat',
      locale: 'en',
      prompt: 'Is it complete?',
    },
    step: { id: 'step-prior-failure-read-only-en', kind: 'chat' },
    messages,
    toolSpecs: [readFile],
    maxIters: 3,
    enableToolHooks: false,
    runModel: async () => {
      modelCalls += 1
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [{
            id: 'inspect-prior-output-en',
            type: 'function',
            function: { name: 'read_file', arguments: JSON.stringify({ path: 'result.txt' }) },
          }],
        }
      }
      return { content: 'Everything is complete.', toolCalls: [] }
    },
    executeTool: async () => ({ ok: true, path: 'result.txt', content: 'partial output' }),
  })

  assert.ok(modelCalls >= 2)
  assert.match(result.text, /prior turn is still incomplete/i)
  assert.doesNotMatch(result.text, /Everything is complete/)
  assert.doesNotMatch(result.text, /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/u)
})

test('an older failure cannot leak through a newer successful turn into a status inquiry', async () => {
  const messages = [
    { role: 'user', content: '第一次生成 result.txt' },
    {
      role: 'system',
      content: '[PRIOR TURN OUTCOME]\n{"state":"failed","error":{"message":"第一次生成失败"}}\nThe prior turn did not complete.',
    },
    { role: 'assistant', content: '任务尚未完成。' },
    { role: 'user', content: '重新生成并验证' },
    { role: 'assistant', content: '已重新生成并验证。' },
    { role: 'user', content: '完成了吗？' },
  ]

  const result = await runToolsLoop({
    job: { id: 'job-stale-prior-failure', userId: null, origin: 'chat', prompt: '完成了吗？' },
    step: { id: 'step-stale-prior-failure', kind: 'chat' },
    messages,
    toolSpecs: [],
    maxIters: 2,
    enableToolHooks: false,
    runModel: async () => ({ content: '已经完成，没有任何问题。', toolCalls: [] }),
    executeTool: async () => ({ ok: true }),
  })

  assert.equal(result.text, '已经完成，没有任何问题。')
})

test('a status inquiry may report success after a new mutation and matching verification', async () => {
  const writeFile = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'write_file')
  const readFile = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'read_file')
  let modelCalls = 0
  const messages = [
    { role: 'user', content: '生成并验证 result.txt' },
    {
      role: 'system',
      content: '[PRIOR TURN OUTCOME]\n{"state":"failed","error":{"message":"最终验证没有通过"}}\nThe prior turn did not complete.',
    },
    { role: 'assistant', content: '任务尚未完成。' },
    { role: 'user', content: '完成了吗？' },
  ]

  const result = await runToolsLoop({
    job: { id: 'job-prior-failure-recovered', userId: null, origin: 'chat', prompt: '完成了吗？' },
    step: { id: 'step-prior-failure-recovered', kind: 'chat' },
    messages,
    toolSpecs: [writeFile, readFile],
    maxIters: 5,
    enableToolHooks: false,
    runModel: async () => {
      modelCalls += 1
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [{
            id: 'repair-prior-output',
            type: 'function',
            function: { name: 'write_file', arguments: JSON.stringify({ path: 'result.txt', content: 'fixed' }) },
          }],
        }
      }
      if (modelCalls === 2) {
        return {
          content: '',
          toolCalls: [{
            id: 'verify-prior-output',
            type: 'function',
            function: { name: 'read_file', arguments: JSON.stringify({ path: 'result.txt' }) },
          }],
        }
      }
      return { content: '已经完成，没有任何问题。', toolCalls: [] }
    },
    executeTool: async ({ name }) => name === 'write_file'
      ? { ok: true, path: 'result.txt', bytes: 5 }
      : { ok: true, path: 'result.txt', content: 'fixed' },
  })

  assert.equal(modelCalls, 3)
  assert.equal(result.text, '已经完成，没有任何问题。')
  assert.equal(result.incomplete, undefined)
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

test('first-round completion deltas stay private when the same response writes an unverified file', async () => {
  const writeFile = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'write_file')
  const published = []
  const phases = []
  const result = await runToolsLoop({
    job: {
      id: 'job-first-round-write-stream-guard',
      userId: null,
      origin: 'chat',
      prompt: 'Create result.txt now and verify it.',
    },
    step: { id: 'step-first-round-write-stream-guard', kind: 'chat' },
    messages: [{ role: 'user', content: 'Create result.txt now and verify it.' }],
    toolSpecs: [writeFile],
    maxIters: 1,
    enableToolHooks: false,
    onModelDelta: async ({ text }) => published.push(text),
    onModelPhase: async (event) => phases.push(structuredClone(event)),
    runModel: async ({ onTextDelta, toolChoice }) => {
      if (toolChoice === 'none') {
        return { content: 'The file was written but verification is still pending.', toolCalls: [] }
      }
      await onTextDelta?.('Completed: result.txt is ready.')
      return {
        content: 'Completed: result.txt is ready.',
        toolCalls: [{
          id: 'first-round-streamed-write',
          type: 'function',
          function: {
            name: 'write_file',
            arguments: JSON.stringify({ path: 'result.txt', content: 'hello' }),
          },
        }],
      }
    },
    executeTool: async () => ({ ok: true, path: 'result.txt', bytes: 5 }),
  })

  assert.equal(result.incomplete, true)
  assert.equal(result.reason, 'post_mutation_verification_missing')
  assert.equal(published.some((text) => /Completed: result\.txt is ready\./u.test(text)), false)
  const toolPhase = phases.find((event) => event.phase === 'completed' && event.toolCalls?.length > 0)
  assert.ok(toolPhase)
  assert.equal(toolPhase.content, '')
})

test('a spontaneous first-round write cannot leak completion text from an answer-mode chat', async () => {
  const writeFile = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'write_file')
  const published = []
  const result = await runToolsLoop({
    job: {
      id: 'job-answer-mode-spontaneous-write-stream-guard',
      userId: null,
      origin: 'chat',
      prompt: 'Tell me whether result.txt is ready.',
    },
    step: { id: 'step-answer-mode-spontaneous-write-stream-guard', kind: 'chat' },
    messages: [{ role: 'user', content: 'Tell me whether result.txt is ready.' }],
    intentMode: 'answer',
    toolSpecs: [writeFile],
    maxIters: 1,
    enableToolHooks: false,
    onModelDelta: async ({ text }) => published.push(text),
    runModel: async ({ onTextDelta, toolChoice }) => {
      if (toolChoice === 'none') {
        return { content: 'The write ran, but the task did not finish.', toolCalls: [] }
      }
      await onTextDelta?.('任务已经完成。')
      return {
        content: '任务已经完成。',
        toolCalls: [{
          id: 'answer-mode-spontaneous-write',
          type: 'function',
          function: {
            name: 'write_file',
            arguments: JSON.stringify({ path: 'result.txt', content: 'hello' }),
          },
        }],
      }
    },
    executeTool: async () => ({ ok: true, path: 'result.txt', bytes: 5 }),
  })

  assert.equal(result.incomplete, true)
  assert.equal(published.includes('任务已经完成。'), false)
})

test('pure chat deltas remain live without execution evidence requirements', async () => {
  const published = []
  let publishedBeforeModelReturn = false
  const result = await runToolsLoop({
    job: {
      id: 'job-pure-chat-live-stream',
      userId: null,
      origin: 'chat',
      prompt: 'Say hello.',
    },
    step: { id: 'step-pure-chat-live-stream', kind: 'chat' },
    messages: [{ role: 'user', content: 'Say hello.' }],
    intentMode: 'answer',
    toolSpecs: [],
    maxIters: 1,
    enableToolHooks: false,
    onModelDelta: async ({ text }) => published.push(text),
    runModel: async ({ onTextDelta }) => {
      await onTextDelta?.('Hello from the live stream.')
      publishedBeforeModelReturn = published.includes('Hello from the live stream.')
      return { content: 'Hello from the live stream.', toolCalls: [] }
    },
    executeTool: async () => {
      throw new Error('pure chat must not execute tools')
    },
  })

  assert.equal(result.text, 'Hello from the live stream.')
  assert.equal(publishedBeforeModelReturn, true)
  assert.deepEqual(published, ['Hello from the live stream.'])
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

for (const scenario of [
  {
    name: 'patch_file',
    args: { path: 'generated/patched.txt', start_line: 1, end_line: 1, replacement: 'updated' },
    path: 'generated/patched.txt',
  },
  {
    name: 'file_download',
    args: { url: 'https://example.com/generated.bin', path: 'generated/downloaded.bin' },
    path: 'generated/downloaded.bin',
  },
]) {
  test(`${scenario.name} remains pending until its exact output is verified`, async () => {
    const spec = SERVER_TOOL_SPECS.find((item) => item?.function?.name === scenario.name)
    let modelCalls = 0
    let checkpoint = null

    const result = await runToolsLoop({
      job: {
        id: `post-write-verification-${scenario.name}`,
        userId: null,
        origin: 'chat',
        prompt: `Create ${scenario.path} and verify it.`,
      },
      step: { id: `post-write-verification-${scenario.name}-step`, kind: 'chat' },
      messages: [{ role: 'user', content: `Create ${scenario.path} and verify it.` }],
      intentMode: 'execute',
      toolSpecs: [spec],
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
              id: `pending-${scenario.name}`,
              type: 'function',
              function: { name: scenario.name, arguments: JSON.stringify(scenario.args) },
            }],
          }
        }
        return { content: 'Created successfully.', toolCalls: [] }
      },
      executeTool: async () => ({
        ok: true,
        path: scenario.path,
        changedPaths: [scenario.path],
      }),
    })

    assert.equal(result.incomplete, true)
    assert.equal(result.reason, 'post_mutation_verification_missing')
    assert.equal(checkpoint?.completionGuards?.mutationExecutionObserved, true)
    assert.ok(
      (checkpoint?.completionGuards?.pendingMutationTargets || []).includes(scenario.path),
    )
  })
}

test('Windows cmd directory discovery redirected to nul is verification, not a mutation', () => {
  const commands = [
    'cmd.exe /c "cd /d D:\\destok && dir /s /b qa-context-test*.html 2>nul"',
    'dir "D:\\destok\\artifact-output"',
  ]

  for (const name of ['bash_exec', 'run_command']) {
    for (const command of commands) {
      const call = { name, args: { command } }
      assert.equal(isVerificationCall(call), true, `${name}: ${command}`)
      assert.equal(isLocalMutationCall(call), false, `${name}: ${command}`)
    }
  }
})

test('LSP navigation is classified as read-only verification, not a mutation', () => {
  const call = {
    name: 'lsp',
    args: {
      operation: 'goToDefinition',
      file: 'D:\\workspace\\source.js',
      line: 1,
      character: 1,
    },
  }

  assert.equal(isVerificationCall(call), true)
  assert.equal(isLocalMutationCall(call), false)
})

test('workspace-changing Git and rewind tools are local mutations', () => {
  assert.equal(isLocalMutationCall({ name: 'git_write', args: { action: 'checkout' } }), true)
  assert.equal(isLocalMutationCall({ name: 'git_write', args: { action: 'pull' } }), true)
  assert.equal(isLocalMutationCall({ name: 'git_rollback', args: {} }), true)
  assert.equal(isLocalMutationCall({ name: 'rewind_files', args: {} }), true)
  for (const action of ['branch', 'create_branch', 'commit', 'push']) {
    assert.equal(isLocalMutationCall({ name: 'git_write', args: { action } }), false, action)
  }
})

test('Windows cmd verification classification stays conservative for dynamic or mutating syntax', () => {
  const commands = [
    'cmd.exe /c "dir /b && del victim.txt"',
    'cmd.exe /c "dir /b > results.txt"',
    'cmd.exe /c "dir /b & erase victim.txt"',
    'cmd.exe /c "dir /b $(whoami)"',
    'cmd.exe /c "dir /b `whoami`"',
    'cmd.exe /c "dir /b %TARGET%"',
    'cmd.exe /v:on /c "dir /b !TARGET!"',
    'dir > results.txt',
    'dir; del victim.txt',
    'dir $(New-Item victim.txt)',
  ]

  for (const name of ['bash_exec', 'run_command']) {
    for (const command of commands) {
      const call = { name, args: { command } }
      assert.equal(isVerificationCall(call), false, `${name}: ${command}`)
      assert.equal(isLocalMutationCall(call), true, `${name}: ${command}`)
    }
  }
})

test('PDF layout completion accepts only controlled validator commands and result lines', () => {
  const comprehensive = {
    name: 'bash_exec',
    args: { command: 'python verify_comprehensive.py' },
  }
  const successful = {
    ok: true,
    exitCode: 0,
    stdout: 'all structural checks passed\nRESULT: PDF_LAYOUT_VERIFICATION_OK\n',
  }

  assert.equal(isVerificationCall(comprehensive), true)
  assert.equal(isLocalMutationCall(comprehensive), false)
  assert.equal(isSuccessfulPdfLayoutVerification(comprehensive, successful), true)
  assert.equal(isSuccessfulPdfLayoutVerification({
    name: 'bash_exec',
    args: { command: 'python verify_final.py' },
  }, successful), false)
  assert.equal(isSuccessfulPdfLayoutVerification(comprehensive, {
    ...successful,
    stdout: 'prefix PDF_LAYOUT_VERIFICATION_OK suffix\n',
  }), false)
  assert.equal(isSuccessfulPdfLayoutVerification({
    name: 'bash_exec',
    args: { command: 'python verify_comprehensive.py PDF_LAYOUT_VERIFICATION_OK' },
  }, successful), false)
  assert.equal(isSuccessfulPdfLayoutVerification({
    name: 'bash_exec',
    args: { command: 'python verify_comprehensive.py', expected_outputs: ['result.pdf'] },
  }, successful), false)
})

test('comprehensive PDF verification followed by bare dir remains complete', async () => {
  const bashExec = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'bash_exec')
  const runCommand = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'run_command')
  const writeFile = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'write_file')
  const directory = 'D:\\destok\\pdf-layout-regression'
  const pdfPath = `${directory}\\filled-answer.pdf`
  const pngPath = `${directory}\\filled-answer.png`
  const validatorPath = `${directory}\\verify_comprehensive.py`
  let modelCalls = 0
  let checkpoint = null
  const executed = []

  const result = await runToolsLoop({
    job: {
      id: 'comprehensive-pdf-verification-bare-dir-job',
      userId: null,
      origin: 'chat',
      prompt: `Fill the supplied PDF, save ${pdfPath} and ${pngPath}, and verify the layout.`,
    },
    step: { id: 'comprehensive-pdf-verification-bare-dir-step', kind: 'chat' },
    messages: [{
      role: 'user',
      content: `Fill the supplied PDF, save ${pdfPath} and ${pngPath}, and verify the layout.`,
    }],
    intentMode: 'execute',
    toolSpecs: [bashExec, runCommand, writeFile],
    maxIters: 8,
    enableToolHooks: false,
    saveCheckpoint: async (state) => {
      checkpoint = structuredClone(state)
      return true
    },
    runModel: async () => {
      modelCalls += 1
      if (modelCalls === 1) return {
        content: '',
        toolCalls: [{
          id: 'generate-pdf-layout-artifacts',
          type: 'function',
          function: {
            name: 'bash_exec',
            arguments: JSON.stringify({
              command: 'python fill_pdf.py',
              cwd: directory,
              expected_outputs: [pdfPath, pngPath],
            }),
          },
        }],
      }
      if (modelCalls === 2) return {
        content: '',
        toolCalls: [{
          id: 'first-pdf-layout-validator',
          type: 'function',
          function: {
            name: 'bash_exec',
            arguments: JSON.stringify({ command: 'python verify_pdf_layout.py', cwd: directory }),
          },
        }],
      }
      if (modelCalls === 3) return {
        content: '',
        toolCalls: [{
          id: 'write-comprehensive-validator',
          type: 'function',
          function: {
            name: 'write_file',
            arguments: JSON.stringify({
              path: validatorPath,
              content: 'print("RESULT: PDF_LAYOUT_VERIFICATION_OK")',
            }),
          },
        }],
      }
      if (modelCalls === 4) return {
        content: '',
        toolCalls: [{
          id: 'run-comprehensive-validator',
          type: 'function',
          function: {
            name: 'bash_exec',
            arguments: JSON.stringify({ command: 'python verify_comprehensive.py', cwd: directory }),
          },
        }],
      }
      if (modelCalls === 5) return {
        content: '',
        toolCalls: [{
          id: 'list-generated-files-with-bare-dir',
          type: 'function',
          function: {
            name: 'run_command',
            arguments: JSON.stringify({ command: `dir "${directory}"`, cwd: directory }),
          },
        }],
      }
      return {
        content: 'The PDF and PNG passed comprehensive layout verification.',
        toolCalls: [],
      }
    },
    executeTool: async ({ name, args }) => {
      executed.push(args.command ? args.command : `${name}:${args.path}`)
      if (name === 'write_file') {
        return { ok: true, path: args.path, changedPaths: [args.path] }
      }
      if (Array.isArray(args.expected_outputs) && args.expected_outputs.length > 0) {
        return {
          ok: true,
          exitCode: 0,
          cwd: directory,
          stdout: 'generated\n',
          changedPaths: [pdfPath, pngPath],
        }
      }
      if (args.command.includes('verify_pdf_layout.py')) {
        return { ok: true, exitCode: 0, cwd: directory, stdout: 'PDF_LAYOUT_VERIFICATION_OK\n' }
      }
      if (args.command.includes('verify_comprehensive.py')) {
        return {
          ok: true,
          exitCode: 0,
          cwd: directory,
          stdout: 'all structural checks passed\nRESULT: PDF_LAYOUT_VERIFICATION_OK\n',
        }
      }
      return { ok: true, exitCode: 0, cwd: directory, stdout: 'filled-answer.pdf\nfilled-answer.png\n' }
    },
  })

  assert.equal(result.incomplete, undefined, JSON.stringify(result))
  assert.equal(result.text, 'The PDF and PNG passed comprehensive layout verification.')
  assert.equal(modelCalls, 6)
  assert.deepEqual(executed, [
    'python fill_pdf.py',
    'python verify_pdf_layout.py',
    `write_file:${validatorPath}`,
    'python verify_comprehensive.py',
    `dir "${directory}"`,
  ])
  assert.equal(checkpoint?.completionGuards?.pdfLayoutVerificationObserved, true)
  assert.deepEqual(checkpoint?.completionGuards?.pendingMutationTargets, [])
})

test('directory discovery through cmd can precede a write and read-back without leaving a phantom nul target', async () => {
  const bashExec = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'bash_exec')
  const writeFile = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'write_file')
  const readFile = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'read_file')
  const outputPath = 'D:\\destok\\qa-context-test.html'
  const html = '<!doctype html><title>Second revision complete</title>'
  let modelCalls = 0
  let checkpoint = null
  const executed = []
  const modelRequestMessages = []

  const result = await runToolsLoop({
    job: {
      id: 'windows-cmd-discovery-before-second-revision-job',
      userId: null,
      origin: 'chat',
      prompt: 'Find the existing HTML, apply the second revision, and verify the saved file.',
    },
    step: { id: 'windows-cmd-discovery-before-second-revision-step', kind: 'chat' },
    messages: [{
      role: 'user',
      content: 'Find the existing HTML, apply the second revision, and verify the saved file.',
    }],
    intentMode: 'execute',
    toolSpecs: [bashExec, writeFile, readFile],
    maxIters: 6,
    enableToolHooks: false,
    saveCheckpoint: async (state) => {
      checkpoint = structuredClone(state)
      return true
    },
    runModel: async ({ messages: requestMessages }) => {
      modelRequestMessages.push(structuredClone(requestMessages))
      modelCalls += 1
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [{
            id: 'find-existing-html-with-cmd',
            type: 'function',
            function: {
              name: 'bash_exec',
              arguments: JSON.stringify({
                command: 'cmd.exe /c "cd /d D:\\destok && dir /s /b qa-context-test*.html 2>nul"',
              }),
            },
          }],
        }
      }
      if (modelCalls === 2) {
        return {
          content: '',
          toolCalls: [{
            id: 'write-second-revision',
            type: 'function',
            function: {
              name: 'write_file',
              arguments: JSON.stringify({ path: outputPath, content: html }),
            },
          }],
        }
      }
      if (modelCalls === 3) {
        return {
          content: '',
          toolCalls: [{
            id: 'read-second-revision',
            type: 'function',
            function: {
              name: 'read_file',
              arguments: JSON.stringify({ path: outputPath }),
            },
          }],
        }
      }
      return { content: 'The second revision was saved and verified.', toolCalls: [] }
    },
    executeTool: async ({ name, args }) => {
      executed.push(name)
      if (name === 'bash_exec') {
        return { ok: true, exitCode: 0, stdout: `${outputPath}\r\n` }
      }
      if (name === 'write_file') {
        return {
          ok: true,
          path: args.path,
          bytes: args.content.length,
          changedPaths: [args.path],
        }
      }
      assert.equal(name, 'read_file')
      return { ok: true, path: args.path, content: html }
    },
  })

  assert.deepEqual(executed, ['bash_exec', 'write_file', 'read_file'])
  assert.equal(modelCalls, process.platform === 'win32' ? 5 : 4)
  const reviewRequests = modelRequestMessages.filter((request) => request.some((message) => (
    message.role === 'system'
      && String(message.content).includes('[FINAL ANSWER EVIDENCE REVIEW REQUIRED]')
  )))
  assert.equal(reviewRequests.length, 1)
  assert.equal(reviewRequests[0], modelRequestMessages.at(-1))
  const reviewText = reviewRequests[0].map((message) => String(message.content || '')).join('\n')
  assert.match(reviewText, /postMutationVerificationPassed":true/)
  assert.match(reviewText, /localHtmlValidationPassed":true/)
  assert.equal(result.incomplete, undefined)
  assert.notEqual(result.reason, 'post_mutation_verification_missing')
  assert.equal(result.text, 'The second revision was saved and verified.')
  assert.deepEqual(checkpoint?.completionGuards?.pendingMutationTargets, [])
  if (process.platform !== 'win32') {
    assert.equal(
      modelRequestMessages.flat().some((message) => (
        String(message?.content || '').includes('[LOCAL HTML DELIVERY VALIDATION REQUIRED]')
      )),
      false,
      'a foreign Windows path must not start host-local HTML delivery validation',
    )
  }
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
    directoryAuthorizationResolution: [{
      type: 'directory_authorization',
      approved: true,
      path: directory,
      access_mode: 'read_write',
      authorization_scope: 'session',
      grant_id: 'verified-directory-resume-grant',
      resource_type: 'directory',
      paused_sequence: 33,
    }],
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

test('already-authorized read-write directory refreshes the active tool schema without pausing', async () => {
  const initialNames = ['request_directory', 'list_directory', 'read_file']
  const authorizedNames = [
    ...initialNames,
    'write_file',
    'edit_file',
    'bash_exec',
    'run_command',
  ]
  const initialSpecs = initialNames.map((name) => (
    SERVER_TOOL_SPECS.find((item) => item?.function?.name === name)
  ))
  assert.equal(initialSpecs.every(Boolean), true)
  const authorizedTurnCatalog = authorizedNames.map((name) => (
    SERVER_TOOL_SPECS.find((item) => item?.function?.name === name)
  ))
  assert.equal(authorizedTurnCatalog.every(Boolean), true)

  const directory = 'D:\\already-authorized-output'
  const outputPath = `${directory}\\authorized-resume.txt`
  const modelToolNames = []
  const executed = []
  let modelCalls = 0

  const result = await runToolsLoop({
    job: {
      id: 'already-authorized-refresh-job',
      userId: 'already-authorized-refresh-user',
      origin: 'chat',
      prompt: `Create ${outputPath}, then read it back to verify the result.`,
    },
    step: { id: 'already-authorized-refresh-step', kind: 'chat' },
    messages: [{
      role: 'user',
      content: `Create ${outputPath}, then read it back to verify the result.`,
    }],
    intentMode: 'execute',
    toolSpecs: initialSpecs,
    fallbackToolSpecs: authorizedTurnCatalog,
    maxIters: 6,
    enableToolHooks: false,
    requestToolApproval: async ({ args }) => ({
      proceed: true,
      args,
      approvalId: 'authorized-directory-approval',
    }),
    runModel: async ({ tools, messages }) => {
      modelCalls += 1
      const names = tools.map((item) => item?.function?.name).filter(Boolean).sort()
      modelToolNames.push(names)

      if (modelCalls === 1) {
        assert.deepEqual(names, [...initialNames, 'set_deliverables'].sort())
        for (const unavailable of ['write_file', 'edit_file', 'bash_exec', 'run_command']) {
          assert.equal(names.includes(unavailable), false, unavailable)
        }
        return {
          content: '',
          toolCalls: [{
            id: 'request-existing-directory',
            type: 'function',
            function: {
              name: 'request_directory',
              arguments: JSON.stringify({
                purpose: 'Create and verify the requested output file.',
                access_mode: 'read_write',
                suggested_path: directory,
              }),
            },
          }],
        }
      }

      if (modelCalls === 2) {
        assert.deepEqual(names, [
          'bash_exec',
          'edit_file',
          'list_directory',
          'read_file',
          'request_directory',
          'run_command',
          'set_deliverables',
          'write_file',
        ])
        const authorizationResult = JSON.parse(messages.findLast((item) => item.role === 'tool').content)
        assert.equal(authorizationResult.already_authorized, true)
        assert.equal(authorizationResult.paused, false)
        return {
          content: '',
          toolCalls: [{
            id: 'write-after-existing-authorization',
            type: 'function',
            function: {
              name: 'write_file',
              arguments: JSON.stringify({ path: outputPath, content: 'ALREADY_AUTHORIZED_RESUMED' }),
            },
          }],
        }
      }

      if (modelCalls === 3) {
        return {
          content: '',
          toolCalls: [{
            id: 'read-after-existing-authorization',
            type: 'function',
            function: {
              name: 'read_file',
              arguments: JSON.stringify({ path: outputPath }),
            },
          }],
        }
      }

      return { content: 'The already-authorized output was created and verified.', toolCalls: [] }
    },
    executeTool: async ({ name, args }) => {
      executed.push({ name, args })
      if (name === 'request_directory') {
        return {
          ok: true,
          paused: false,
          already_authorized: true,
          authorization: {
            path: directory,
            resource_type: 'directory',
            access_mode: 'read_write',
          },
          message: `Directory access is already authorized for ${directory}.`,
        }
      }
      if (name === 'write_file') {
        return { ok: true, path: args.path, bytes: args.content.length, changedPaths: [args.path] }
      }
      if (name === 'read_file') {
        return { ok: true, path: args.path, content: 'ALREADY_AUTHORIZED_RESUMED' }
      }
      throw new Error(`unexpected tool: ${name}`)
    },
  })

  assert.equal(result.paused, undefined)
  assert.equal(result.incomplete, undefined)
  assert.equal(result.text, 'The already-authorized output was created and verified.')
  assert.deepEqual(executed.map(({ name }) => name), ['request_directory', 'write_file', 'read_file'])
  assert.equal(modelCalls, 4)
  assert.equal(modelToolNames.length, 4)
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
  const finalReview = observedRequests[3]
    .filter((item) => item.role === 'system')
    .map((item) => item.content)
    .join('\n')
  assert.match(finalReview, /\[FINAL ANSWER EVIDENCE REVIEW REQUIRED\]/)
  assert.match(finalReview, /evidence_digest=[a-f0-9]{64}/)
  assert.match(finalReview, /postMutationVerificationPassed":true/)
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
  const result = await runToolsLoop({
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
    })
  assert.equal(result.incomplete, true)
  assert.equal(result.reason, 'artifact_delivery_not_converged')
  assert.deepEqual(result.deliveryArtifactIds, [])
  assert.doesNotMatch(result.text, /The requested file was not created|ARTIFACT_NOT_CREATED/)
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

test('parallel screenshot batches reuse both images for context retry without persisting either', async (t) => {
  const screenshot = {
    type: 'function',
    function: {
      name: 'browser_screenshot',
      description: 'Capture the current page as PNG.',
      parameters: {
        type: 'object',
        properties: { fullPage: { type: 'boolean' } },
      },
    },
  }
  registerDynamicTool({
    name: 'browser_screenshot',
    origin: 'browser-test',
    spec: screenshot,
    metadata: {
      riskClass: 'read',
      isReadOnly: true,
      isConcurrencySafe: true,
      isIdempotent: true,
      interruptBehavior: 'cancellable',
    },
  })
  t.after(() => unregisterDynamicTool('browser_screenshot'))
  const readFile = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'read_file')
  assert.ok(readFile)
  let modelCalls = 0
  const checkpoints = []

  const result = await runToolsLoop({
    job: {
      id: 'job-parallel-screenshot-protocol',
      userId: null,
      origin: 'chat',
      prompt: 'Inspect the browser screenshot and read notes.txt, then summarize both.',
    },
    step: { id: 'step-parallel-screenshot-protocol', kind: 'chat' },
    messages: [{
      role: 'user',
      content: 'Inspect the browser screenshot and read notes.txt, then summarize both.',
    }],
    intentMode: 'execute',
    toolSpecs: [screenshot, readFile],
    maxIters: 3,
    enableToolHooks: false,
    saveCheckpoint: async (state) => {
      checkpoints.push(structuredClone(state))
      return true
    },
    runModel: async ({ messages }) => {
      modelCalls += 1
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [
            {
              id: 'parallel-shot-one',
              type: 'function',
              function: { name: 'browser_screenshot', arguments: '{}' },
            },
            {
              id: 'parallel-shot-two',
              type: 'function',
              function: { name: 'browser_screenshot', arguments: '{}' },
            },
            {
              id: 'parallel-read',
              type: 'function',
              function: { name: 'read_file', arguments: '{"path":"notes.txt"}' },
            },
          ],
        }
      }

      const imageIndexes = messages.map((message, index) => ({ message, index })).filter(({ message }) => (
        message.role === 'user'
        && Array.isArray(message.content)
        && message.content.some((part) => part?.type === 'image_url')
      )).map(({ index }) => index)
      if (modelCalls === 2 || modelCalls === 3) {
        assert.equal(imageIndexes.length, 2)
        const requestText = JSON.stringify(messages)
        assert.match(requestText, /data:image\/png;base64,FIRST_SCREENSHOT_BYTES/u)
        assert.match(requestText, /data:image\/png;base64,SECOND_SCREENSHOT_BYTES/u)
        if (modelCalls === 2) {
          const firstShotIndex = messages.findIndex((message) => message.tool_call_id === 'parallel-shot-one')
          const secondShotIndex = messages.findIndex((message) => message.tool_call_id === 'parallel-shot-two')
          const readIndex = messages.findIndex((message) => message.tool_call_id === 'parallel-read')
          assert.ok(firstShotIndex >= 0)
          assert.ok(secondShotIndex > firstShotIndex)
          assert.ok(readIndex > secondShotIndex)
          assert.ok(imageIndexes[0] > readIndex)
          assert.ok(imageIndexes[1] > imageIndexes[0])
          assert.equal(JSON.parse(messages[firstShotIndex].content).image.data, undefined)
          assert.equal(JSON.parse(messages[secondShotIndex].content).image.data, undefined)
          throw Object.assign(new Error('maximum context length exceeded'), { status: 400 })
        }
        return {
          content: '',
          toolCalls: [{
            id: 'post-shot-read',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"after-shot.txt"}' },
          }],
        }
      }
      assert.deepEqual(imageIndexes, [], 'the image must not be replayed after its next logical model call')
      return { content: 'Screenshot and notes inspected.', toolCalls: [] }
    },
    executeTool: async ({ name, toolCallId }) => {
      if (name === 'browser_screenshot') {
        return {
          ok: true,
          image: {
            mimeType: 'image/png',
            data: toolCallId === 'parallel-shot-one'
              ? 'FIRST_SCREENSHOT_BYTES'
              : 'SECOND_SCREENSHOT_BYTES',
            bytes: 8,
          },
        }
      }
      assert.equal(name, 'read_file')
      return { ok: true, path: 'notes.txt', content: 'release notes' }
    },
  })

  assert.equal(result.text, 'Screenshot and notes inspected.')
  assert.equal(modelCalls, 4)
  assert.ok(checkpoints.length > 0)
  for (const checkpoint of checkpoints) {
    assert.doesNotMatch(
      JSON.stringify(checkpoint),
      /data:image|base64|FIRST_SCREENSHOT_BYTES|SECOND_SCREENSHOT_BYTES/u,
    )
  }
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
    requestToolApproval: async ({ args }) => ({
      proceed: true,
      args,
      approvalId: 'external-retry-approval',
    }),
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
  const disposeExternalTool = registerDynamicTool({
    name: toolName,
    origin: 'mcp',
    userId: TEST_USER_ID,
    spec: externalSpec,
    metadata: {
      riskClass: 'external',
      isReadOnly: false,
      isConcurrencySafe: true,
      isIdempotent: false,
      interruptBehavior: 'block',
    },
  })
  t.after(disposeExternalTool)
  const boundExternalSpec = getDynamicTool(toolName, { userId: TEST_USER_ID }).spec

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
      toolSpecs: [boundExternalSpec],
      maxIters: 3,
      enableToolHooks: false,
      saveCheckpoint: async (state) => {
        checkpoint = structuredClone(state)
        return true
      },
      requestToolApproval: async ({ args }) => ({
        proceed: true,
        args,
        approvalId: 'external-crash-approval',
      }),
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
    toolSpecs: [boundExternalSpec],
    maxIters: 3,
    enableToolHooks: false,
    loadCheckpoint: async () => checkpoint,
    saveCheckpoint: async (state) => {
      checkpoint = structuredClone(state)
      return true
    },
    requestToolApproval: async ({ args }) => ({
      proceed: true,
      args,
      approvalId: 'external-crash-resume-approval',
    }),
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
  const disposeMcpTool = registerDynamicTool({
    name: toolName,
    origin: 'mcp',
    userId: TEST_USER_ID,
    spec: externalSpec,
    metadata: {
      riskClass: 'external',
      isReadOnly: false,
      isConcurrencySafe: false,
      isIdempotent: false,
    },
  })
  t.after(disposeMcpTool)
  const boundExternalSpec = getDynamicTool(toolName, { userId: TEST_USER_ID }).spec

  let modelCalls = 0
  let externalWrites = 0
  const result = await runToolsLoop({
    job: { id: 'mcp-mutation-job', userId: null, origin: 'chat', prompt: 'Create a Jira issue for the release blocker.' },
    step: { id: 'mcp-mutation-step', kind: 'chat' },
    messages: [{ role: 'user', content: 'Create a Jira issue for the release blocker.' }],
    intentMode: 'execute',
    toolSpecs: [boundExternalSpec],
    maxIters: 5,
    enableToolHooks: false,
    requestToolApproval: async ({ args }) => ({
      proceed: true,
      args,
      approvalId: 'mcp-mutation-approval',
    }),
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
                command: 'cmd.exe /d /c del /q "' + scriptPath + '" 2>nul',
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

test('failed auxiliary-script cleanup cannot overturn a verified primary delivery', async () => {
  const writeFile = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'write_file')
  const bashExec = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'bash_exec')
  const readFile = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'read_file')
  const directory = 'D:\\destok'
  const scriptPath = directory + '\\_run_report.py'
  const sourcePath = directory + '\\source\\_run_report.py'
  const outputPath = directory + '\\final-report.txt'
  let modelCalls = 0
  let checkpoint = null

  const result = await runToolsLoop({
    job: {
      id: 'failed-auxiliary-cleanup-job',
      userId: null,
      origin: 'chat',
      prompt: 'Create and verify final-report.txt using a temporary helper, then clean up the helper.',
    },
    step: { id: 'failed-auxiliary-cleanup-step', kind: 'chat' },
    messages: [{ role: 'user', content: 'Create and verify final-report.txt using a temporary helper, then clean up the helper.' }],
    intentMode: 'execute',
    toolSpecs: [writeFile, bashExec, readFile],
    maxIters: 8,
    enableToolHooks: false,
    saveCheckpoint: async (state) => {
      checkpoint = structuredClone(state)
      return true
    },
    runModel: async () => {
      modelCalls += 1
      if (modelCalls === 1) return {
        content: '',
        toolCalls: [{
          id: 'write-report-helper', type: 'function', function: {
            name: 'write_file',
            arguments: JSON.stringify({ path: scriptPath, content: 'print("report")' }),
          },
        }],
      }
      if (modelCalls === 2) return {
        content: '',
        toolCalls: [{
          id: 'write-same-name-source', type: 'function', function: {
            name: 'write_file',
            arguments: JSON.stringify({ path: sourcePath, content: 'export const report = true' }),
          },
        }],
      }
      if (modelCalls === 3) return {
        content: '',
        toolCalls: [{
          id: 'generate-final-report', type: 'function', function: {
            name: 'bash_exec',
            arguments: JSON.stringify({
              command: 'python "' + scriptPath + '"',
              cwd: directory,
              expected_outputs: [outputPath],
            }),
          },
        }],
      }
      if (modelCalls === 4) return {
        content: '',
        toolCalls: [{
          id: 'verify-final-report', type: 'function', function: {
            name: 'read_file', arguments: JSON.stringify({ path: outputPath }),
          },
        }],
      }
      if (modelCalls === 5) return {
        content: '',
        toolCalls: [{
          id: 'verify-same-name-source', type: 'function', function: {
            name: 'read_file', arguments: JSON.stringify({ path: sourcePath }),
          },
        }],
      }
      if (modelCalls === 6) return {
        content: '',
        toolCalls: [{
          id: 'cleanup-report-helper', type: 'function', function: {
            name: 'bash_exec',
            arguments: JSON.stringify({ command: 'del /q "' + scriptPath + '"', cwd: directory }),
          },
        }],
      }
      return {
        content: 'Final report was generated and verified; temporary helper cleanup failed.',
        toolCalls: [],
      }
    },
    executeTool: async ({ name, args }) => {
      if (name === 'write_file') return { ok: true, path: args.path }
      if (name === 'read_file') return { ok: true, path: args.path, content: 'verified content' }
      if (Array.isArray(args.expected_outputs) && args.expected_outputs.length > 0) {
        return { ok: true, exitCode: 0, cwd: directory, changedPaths: [outputPath] }
      }
      return { ok: false, code: 'cleanup_failed', error: 'temporary helper is locked', retryable: false }
    },
  })

  assert.equal(result.incomplete, undefined)
  assert.match(result.text, /generated and verified/)
  assert.deepEqual(checkpoint?.completionGuards?.pendingMutationTargets, [])
  assert.deepEqual(checkpoint?.completionGuards?.auxiliaryMutationTargets, [scriptPath.replaceAll('\\', '/')])
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
    { label: 'wrapped compound command', command: 'cmd /c del "' + scriptPath + '" && echo done' },
    { label: 'wrapped redirected output', command: 'cmd /c del "' + scriptPath + '" 2>delete.log' },
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

const specializedVerificationScenarios = [
  {
    label: 'media_transform is closed by media_probe for the exact output',
    mutation: 'media_transform',
    mutationArgs: { operation: 'transcode', input_path: 'input.mov', output_path: 'output.mp4' },
    mutationResult: { ok: true, output_path: 'output.mp4' },
    verification: 'media_probe',
    verificationArgs: { input_path: 'output.mp4' },
    verificationResult: { ok: true, path: 'output.mp4', probe: { streams: [] } },
  },
  {
    label: 'image_transform is closed by image_info for the exact output',
    mutation: 'image_transform',
    mutationArgs: { input_path: 'input.png', output_path: 'output.webp' },
    mutationResult: { ok: true, path: 'output.webp' },
    verification: 'image_info',
    verificationArgs: { path: 'output.webp' },
    verificationResult: { ok: true, path: 'output.webp', width: 100, height: 100 },
  },
  {
    label: 'pdf_transform is closed by pdf_info for the exact output',
    mutation: 'pdf_transform',
    mutationArgs: { operation: 'rotate', input: 'input.pdf', output: 'output.pdf', degrees: 90 },
    mutationResult: { ok: true, outputs: [{ path: 'output.pdf' }] },
    verification: 'pdf_info',
    verificationArgs: { path: 'output.pdf' },
    verificationResult: { ok: true, path: 'output.pdf', pageCount: 1 },
  },
  {
    label: 'pdf_transform is closed by pdf_text for the exact output',
    mutation: 'pdf_transform',
    mutationArgs: { operation: 'overlay_text', input: 'input.pdf', output: 'patched.pdf', overlays: [] },
    mutationResult: { ok: true, outputs: [{ path: 'patched.pdf' }] },
    verification: 'pdf_text',
    verificationArgs: { path: 'patched.pdf' },
    verificationResult: { ok: true, path: 'patched.pdf', pages: [{ page: 1, text: 'verified' }] },
  },
  {
    label: 'archive_create is tracked and closed by archive_list',
    mutation: 'archive_create',
    mutationArgs: { inputs: ['source.txt'], output: 'bundle.zip' },
    mutationResult: { ok: true, output: 'bundle.zip' },
    verification: 'archive_list',
    verificationArgs: { input: 'bundle.zip' },
    verificationResult: { ok: true, input: 'bundle.zip', entries: [{ path: 'source.txt' }] },
  },
  {
    label: 'archive_extract is tracked and closed by an output directory listing',
    mutation: 'archive_extract',
    mutationArgs: { input: 'bundle.zip', outputDir: 'unpacked' },
    mutationResult: {
      ok: true,
      outputDir: 'unpacked',
      entries: [{ path: 'source.txt', outputPath: 'unpacked/source.txt' }],
    },
    verification: 'list_directory',
    verificationArgs: { path: 'unpacked' },
    verificationResult: {
      ok: true,
      path: 'unpacked',
      truncated: false,
      entries: [{ name: 'source.txt', path: 'source.txt', type: 'file' }],
    },
  },
  {
    label: 'batch_rename is tracked and closed by a destination directory listing',
    mutation: 'batch_rename',
    mutationArgs: { operations: [{ from: 'old.txt', to: 'renamed.txt' }] },
    mutationResult: {
      ok: true,
      renamed: [{ from: 'old.txt', to: 'renamed.txt', unchanged: false }],
    },
    verification: 'list_directory',
    verificationArgs: { path: '.' },
    verificationResult: {
      ok: true,
      path: '.',
      truncated: false,
      entries: [{ name: 'renamed.txt', path: 'renamed.txt', type: 'file' }],
    },
  },
]

for (const scenario of specializedVerificationScenarios) {
  test(scenario.label, async () => {
    const mutationSpec = SERVER_TOOL_SPECS.find((item) => item?.function?.name === scenario.mutation)
    const verificationSpec = SERVER_TOOL_SPECS.find((item) => item?.function?.name === scenario.verification)
    assert.ok(mutationSpec, `missing ${scenario.mutation} spec`)
    assert.ok(verificationSpec, `missing ${scenario.verification} spec`)

    let modelCalls = 0
    let checkpoint = null
    const requests = []
    const executed = []
    const result = await runToolsLoop({
      job: {
        id: `specialized-verification-${scenario.mutation}-${scenario.verification}`,
        userId: null,
        origin: 'chat',
        prompt: `Run ${scenario.mutation}, then verify the exact output with ${scenario.verification}.`,
      },
      step: { id: `step-${scenario.mutation}-${scenario.verification}`, kind: 'chat' },
      messages: [{
        role: 'user',
        content: `Run ${scenario.mutation}, then verify the exact output with ${scenario.verification}.`,
      }],
      intentMode: 'execute',
      toolSpecs: [mutationSpec, verificationSpec],
      maxIters: 6,
      enableToolHooks: false,
      saveCheckpoint: async (state) => {
        checkpoint = structuredClone(state)
        return true
      },
      runModel: async ({ messages }) => {
        modelCalls += 1
        requests.push(structuredClone(messages))
        if (modelCalls === 1) {
          return {
            content: '',
            toolCalls: [{
              id: `mutate-${scenario.mutation}`,
              type: 'function',
              function: {
                name: scenario.mutation,
                arguments: JSON.stringify(scenario.mutationArgs),
              },
            }],
          }
        }
        if (modelCalls === 2) return { content: 'Mutation complete.', toolCalls: [] }
        if (modelCalls === 3) {
          return {
            content: '',
            toolCalls: [{
              id: `verify-${scenario.verification}`,
              type: 'function',
              function: {
                name: scenario.verification,
                arguments: JSON.stringify(scenario.verificationArgs),
              },
            }],
          }
        }
        return { content: 'Mutation and exact-path verification complete.', toolCalls: [] }
      },
      executeTool: async ({ name }) => {
        executed.push(name)
        if (name === scenario.mutation) return structuredClone(scenario.mutationResult)
        assert.equal(name, scenario.verification)
        return structuredClone(scenario.verificationResult)
      },
    })

    assert.deepEqual(executed, [scenario.mutation, scenario.verification])
    assert.equal(modelCalls, 4)
    assert.equal(result.incomplete, undefined)
    assert.equal(result.text, 'Mutation and exact-path verification complete.')
    assert.ok(requests[2].some((message) => (
      message?.role === 'system'
      && String(message.content || '').includes('[POST-MUTATION VERIFICATION REQUIRED]')
    )), 'the runtime must block premature completion until specialized verification runs')
    assert.deepEqual(checkpoint?.completionGuards?.pendingMutationTargets, [])
  })

  test('a pure text deliverable completes without demanding tool execution evidence', async () => {
    const result = await runToolsLoop({
      job: {
        id: 'job-text-deliverable',
        userId: null,
        origin: 'chat',
        prompt: '帮我生成一份本周项目周报',
      },
      step: { id: 'step-text-deliverable', kind: 'chat' },
      messages: [{ role: 'user', content: '帮我生成一份本周项目周报' }],
      toolSpecs: [],
      maxIters: 2,
      enableToolHooks: false,
      runModel: async () => ({ content: '本周周报：完成 A，推进 B，下周计划 C。', toolCalls: [] }),
    })

    assert.equal(result.incomplete, undefined)
    assert.match(result.text, /本周周报/)
  })
}
