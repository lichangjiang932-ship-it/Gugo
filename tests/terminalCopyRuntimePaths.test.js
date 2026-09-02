import assert from 'node:assert/strict'
import test from 'node:test'

const { runToolsLoop, SERVER_TOOL_SPECS } = await import('../server/services/jobTools.js')

const EAST_ASIAN_TEXT = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/u

test('an English model-budget failure uses English wrap-up and terminal copy', async () => {
  let modelCalls = 0
  let wrapUpPrompt = ''
  const result = await runToolsLoop({
    job: {
      id: 'english-model-budget-terminal',
      userId: null,
      origin: 'chat',
      locale: 'en',
      prompt: 'Summarize the current progress.',
    },
    step: { id: 'english-model-budget-terminal', kind: 'chat' },
    messages: [{ role: 'user', content: 'Summarize the current progress.' }],
    toolSpecs: [],
    maxIters: 2,
    enableToolHooks: false,
    runModel: async ({ messages }) => {
      modelCalls += 1
      if (modelCalls === 1) {
        const error = new Error('模型预算已用尽')
        error.code = 'MODEL_BUDGET_EXCEEDED'
        throw error
      }
      wrapUpPrompt = String(messages.at(-1)?.content || '')
      return { content: 'The budget ended before the task completed.', toolCalls: [] }
    },
    executeTool: async () => ({ ok: true }),
  })

  assert.equal(modelCalls, 2)
  assert.equal(result.incomplete, true)
  assert.equal(result.budgetExceeded, true)
  assert.doesNotMatch(wrapUpPrompt, EAST_ASIAN_TEXT)
  assert.match(wrapUpPrompt, /budget is exhausted/i)
  assert.doesNotMatch(result.text, EAST_ASIAN_TEXT)
})

test('an English reasoning-runaway failure never falls back to Chinese', async () => {
  const result = await runToolsLoop({
    job: {
      id: 'english-reasoning-runaway-terminal',
      userId: null,
      origin: 'chat',
      locale: 'en',
      prompt: 'Inspect the project.',
    },
    step: { id: 'english-reasoning-runaway-terminal', kind: 'chat' },
    messages: [{ role: 'user', content: 'Inspect the project.' }],
    toolSpecs: [],
    maxIters: 2,
    enableToolHooks: false,
    runModel: async () => {
      const error = new Error('推理超过安全上限')
      error.code = 'REASONING_RUNAWAY'
      throw error
    },
    executeTool: async () => ({ ok: true }),
  })

  assert.equal(result.incomplete, true)
  assert.equal(result.code, 'REASONING_RUNAWAY')
  assert.match(result.text, /reasoning exceeded the safe limit/i)
  assert.doesNotMatch(result.text, EAST_ASIAN_TEXT)
})

test('an English source-handoff clarification is replaced with safe English copy', async () => {
  const writeFile = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'write_file')
  const requestClarification = SERVER_TOOL_SPECS.find((item) => (
    item?.function?.name === 'request_clarification'
  ))
  let modelCalls = 0
  const result = await runToolsLoop({
    job: {
      id: 'english-filtered-clarification-terminal',
      userId: 'english-filtered-clarification-user',
      origin: 'chat',
      locale: 'en',
      prompt: 'Create result.txt now.',
    },
    step: { id: 'english-filtered-clarification-terminal', kind: 'chat' },
    messages: [{ role: 'user', content: 'Create result.txt now.' }],
    intentMode: 'execute',
    toolSpecs: [writeFile, requestClarification],
    maxIters: 4,
    enableToolHooks: false,
    requestToolApproval: async ({ args }) => ({
      proceed: true,
      args,
      approvalId: 'english-filtered-clarification-approved',
    }),
    runModel: async () => {
      modelCalls += 1
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [{
            id: 'english-filtered-write',
            type: 'function',
            function: {
              name: 'write_file',
              arguments: '{"path":"result.txt","content":"done"}',
            },
          }],
        }
      }
      return {
        content: '',
        toolCalls: [{
          id: 'english-filtered-clarification',
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
      if (name === 'write_file') {
        return { ok: false, code: 'FILESYSTEM_WRITE_DENIED', error: 'access denied', status: 403 }
      }
      return {
        ok: true,
        paused: true,
        clarification: {
          question: args.question,
          blocker_kind: args.blocker_kind,
          details: '```text\n内部诊断\n```',
        },
      }
    },
  })

  assert.equal(result.paused, true, JSON.stringify({ modelCalls, result }))
  assert.equal(modelCalls, 2)
  assert.match(result.text, /More information is required/i)
  assert.match(result.clarification.question, /More information is required/i)
  assert.match(result.clarification.details, /More information is required/i)
  assert.doesNotMatch(result.text, EAST_ASIAN_TEXT)
  assert.doesNotMatch(result.clarification.question, EAST_ASIAN_TEXT)
  assert.doesNotMatch(result.clarification.question, /const result/u)
})
