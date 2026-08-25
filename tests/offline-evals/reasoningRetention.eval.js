import assert from 'node:assert/strict'
import { runToolsLoop } from '../../server/services/jobTools.js'
import { defineOfflineEvalCase, defineOfflineEvalSuite } from '../helpers/offlineEvalHarness.js'

const EVAL_USER_ID = 'offline-reasoning-retention-user'

const ECHO_TOOL = Object.freeze({
  type: 'function',
  function: {
    name: 'echo_tool',
    description: 'Return the supplied text.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    },
  },
})

function toolCall(id, name, args) {
  return {
    id,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  }
}

/**
 * Task-level eval: the model's chain-of-thought must survive inside the turn's
 * durable conversation (checkpoint messages) so a later request — when
 * MODEL_REASONING_RETENTION=1 — can replay it to the same provider, while
 * blank reasoning and non-assistant surfaces stay clean.
 */
async function runScenario({ prompt, turns }) {
  const checkpoints = []
  const executions = []
  let modelCalls = 0

  const result = await runToolsLoop({
    job: {
      id: `offline-eval-reasoning-${modelCalls}`,
      userId: EVAL_USER_ID,
      origin: 'chat',
      prompt,
      userPrompt: prompt,
    },
    step: { id: 'offline-eval-reasoning-step', kind: 'chat' },
    messages: [{ role: 'user', content: prompt }],
    toolSpecs: [ECHO_TOOL],
    maxIters: 6,
    enableToolHooks: false,
    toolRetryBaseDelayMs: 0,
    saveCheckpoint: async (state) => {
      checkpoints.push(structuredClone(state))
      return true
    },
    runModel: async () => {
      const turn = turns[Math.min(modelCalls, turns.length - 1)]
      modelCalls += 1
      return turn()
    },
    executeTool: async (request) => {
      executions.push(request.name)
      return { ok: true, echoed: request.args?.text ?? null }
    },
  })

  return { result, checkpoints, executions, modelCalls }
}

function assistantMessages(checkpoints) {
  // Checkpoints are cumulative conversation snapshots, so the same assistant
  // message reappears across snapshots. Deduplicate before asserting counts.
  const unique = new Map()
  for (const state of checkpoints) {
    for (const message of (Array.isArray(state?.messages) ? state.messages : [])) {
      if (message?.role !== 'assistant') continue
      const key = message.tool_calls?.[0]?.id || `text:${message.content}`
      if (!unique.has(key)) unique.set(key, message)
    }
  }
  return [...unique.values()]
}

function task(id, title, run) {
  return defineOfflineEvalCase({ id, category: 'reasoning-retention', title, run })
}

const TASKS = [
  task(
    'reasoning-survives-tool-call-checkpoint',
    'chain-of-thought captured on a tool-call turn persists in checkpoint conversation state',
    async () => {
      const reasoningText = 'I should echo the text back before answering.'
      const { result, checkpoints, modelCalls } = await runScenario({
        prompt: 'echo hello then answer',
        turns: [
          () => ({
            content: '',
            toolCalls: [toolCall('call_reason_1', 'echo_tool', { text: 'hello' })],
            reasoning: reasoningText,
          }),
          () => ({ content: 'done', toolCalls: [] }),
        ],
      })

      assert.equal(modelCalls, 2)
      assert.equal(result?.finalText || result?.text || '', 'done')

      const withReasoning = assistantMessages(checkpoints)
        .filter((message) => typeof message.reasoning_content === 'string' && message.reasoning_content)
      assert.equal(withReasoning.length, 1)
      assert.equal(withReasoning[0].reasoning_content, reasoningText)
      assert.equal(withReasoning[0].tool_calls?.[0]?.function?.name, 'echo_tool')
    },
  ),
  task(
    'blank-reasoning-never-persists',
    'blank or missing chain-of-thought leaves no reasoning_content residue',
    async () => {
      const { checkpoints } = await runScenario({
        prompt: 'echo world without thinking markers',
        turns: [
          () => ({
            content: '',
            toolCalls: [toolCall('call_blank_1', 'echo_tool', { text: 'world' })],
            reasoning: '   ',
          }),
          () => ({ content: 'ok', toolCalls: [] }),
        ],
      })

      for (const message of assistantMessages(checkpoints)) {
        assert.equal('reasoning_content' in message, false)
      }
    },
  ),
  task(
    'reasoning-stays-out-of-tool-results',
    'retained reasoning never leaks into tool role messages',
    async () => {
      const { checkpoints } = await runScenario({
        prompt: 'echo tagged with private thoughts',
        turns: [
          () => ({
            content: '',
            toolCalls: [toolCall('call_leak_1', 'echo_tool', { text: 'tagged' })],
            reasoning: 'private chain of thought',
          }),
          () => ({ content: 'complete', toolCalls: [] }),
        ],
      })

      const toolMessages = checkpoints.flatMap((state) => (Array.isArray(state?.messages) ? state.messages : []))
        .filter((message) => message?.role === 'tool')
      assert.ok(toolMessages.length >= 1)
      for (const message of toolMessages) {
        assert.equal('reasoning_content' in message, false)
        assert.equal(String(message.content || '').includes('private chain of thought'), false)
      }
    },
  ),
]

assert.ok(TASKS.length >= 3)

export default defineOfflineEvalSuite({
  id: 'reasoning-retention',
  title: 'Chain-of-thought retention across tool-loop iterations',
  version: 1,
  cases: TASKS,
})
