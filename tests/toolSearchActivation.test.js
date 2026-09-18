import assert from 'node:assert/strict'
import test from 'node:test'

import { runToolsLoop, SERVER_TOOL_SPECS } from '../server/services/jobTools.js'
import { getBuiltinSpec } from '../server/services/toolRegistry.js'
import { resolveTurnToolSpecs } from '../server/services/turnToolSpecs.js'

const SEARCH_TOOLS = getBuiltinSpec('search_tools')
const SLACK_SEND = SERVER_TOOL_SPECS.find((spec) => spec?.function?.name === 'slack_send_message')

function call(id, name, args) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } }
}

test('turn discovery keeps intent-hidden connectors in the authorized deferred catalog', async () => {
  let deferred = null
  let decision = null
  const selected = await resolveTurnToolSpecs({
    userId: null,
    baseSpecs: [SEARCH_TOOLS, SLACK_SEND],
    enabledConnectorTools: ['slack_send_message'],
    prompt: 'Explain the local project structure.',
    messages: [{ role: 'user', content: 'Explain the local project structure.' }],
    onDeferredSpecs: (specs) => { deferred = specs },
    onDecision: (value) => { decision = value },
  })
  assert.equal(selected.some((spec) => spec.function.name === 'slack_send_message'), false)
  assert.equal(deferred.some((spec) => spec.function.name === 'slack_send_message'), true)
  assert.deepEqual(decision.excludedTools.find((entry) => entry.name === 'slack_send_message'), {
    name: 'slack_send_message', stage: 'intent', reason: 'intent_not_selected',
  })
})

test('search_tools additively activates an authorized hidden tool and persists the mounted name', async () => {
  let modelCalls = 0
  let mountedCheckpoint = null
  const executed = []
  const result = await runToolsLoop({
    job: {
      id: 'tool-search-activation', userId: 'tool-search-user', origin: 'chat',
      prompt: 'Notify the team through the available connected app.',
      userPrompt: 'Notify the team through the available connected app.',
    },
    step: { id: 'tool-search-activation', kind: 'chat' },
    messages: [{ role: 'user', content: 'Notify the team through the available connected app.' }],
    toolSpecs: [SEARCH_TOOLS],
    fallbackToolSpecs: [SEARCH_TOOLS, SLACK_SEND],
    maxIters: 5,
    enableToolHooks: false,
    requestToolApproval: async ({ args }) => ({
      proceed: true, args, approvalId: 'tool-search-approved',
    }),
    saveCheckpoint: async (state) => {
      const copied = structuredClone(state)
      if (copied.completionGuards?.dynamicallyMountedToolNames?.includes('slack_send_message')) {
        mountedCheckpoint ||= copied
      }
      return true
    },
    runModel: async ({ messages, tools }) => {
      modelCalls += 1
      const names = tools.map((spec) => spec.function.name)
      if (modelCalls === 1) {
        assert.deepEqual(names, ['search_tools', 'set_deliverables'])
        return { content: '', toolCalls: [call('search-slack', 'search_tools', {
          query: 'send a Slack team message', limit: 4,
        })] }
      }
      if (modelCalls === 2) {
        assert.ok(names.includes('slack_send_message'))
        const searchResult = messages.find((message) => message.role === 'tool' && message.name === 'search_tools')
        const parsed = JSON.parse(searchResult.content)
        assert.deepEqual(parsed.activatedToolNames, ['slack_send_message'])
        return { content: '', toolCalls: [call('send-slack', 'slack_send_message', {
          channelId: 'team', text: 'Build completed.',
        })] }
      }
      return { content: 'The connected-app action completed.', toolCalls: [] }
    },
    executeTool: async ({ name, args }) => {
      executed.push(name)
      return name === 'search_tools'
        ? { ok: true, query: args.query }
        : { ok: true, messageId: 'message-1' }
    },
  })
  assert.equal(result.text, 'The connected-app action completed.')
  assert.deepEqual(executed, ['search_tools', 'slack_send_message'])
  assert.ok(mountedCheckpoint)
  assert.ok(mountedCheckpoint.capabilityDecision.dynamicallyMountedTools.includes('slack_send_message'))

  let restoredTools = null
  const restored = await runToolsLoop({
    job: {
      id: 'tool-search-restored', userId: 'tool-search-user', origin: 'chat',
      prompt: 'Continue the connected-app task.', userPrompt: 'Continue the connected-app task.',
    },
    step: { id: 'tool-search-restored', kind: 'chat' },
    messages: [{ role: 'user', content: 'Continue the connected-app task.' }],
    toolSpecs: [SEARCH_TOOLS],
    fallbackToolSpecs: [SEARCH_TOOLS, SLACK_SEND],
    maxIters: 5,
    enableToolHooks: false,
    loadCheckpoint: async () => ({ state: structuredClone(mountedCheckpoint) }),
    runModel: async ({ tools }) => {
      restoredTools = tools.map((spec) => spec.function.name)
      return { content: 'Restored.', toolCalls: [] }
    },
    executeTool: async () => assert.fail('restored final response should not execute a tool'),
  })
  assert.equal(restored.text, 'Restored.')
  assert.ok(restoredTools.includes('slack_send_message'))
})

test('search_tools restores a deferred static verification tool by exact name', async () => {
  const runTest = getBuiltinSpec('run_test')
  let modelCalls = 0
  let activatedResult = null
  await runToolsLoop({
    job: {
      id: 'tool-search-static', userId: 'tool-search-static-user', origin: 'chat',
      prompt: 'Run a specialized test after the repair.',
      userPrompt: 'Run a specialized test after the repair.',
    },
    step: { id: 'tool-search-static', kind: 'chat' },
    messages: [{ role: 'user', content: 'Run a specialized test after the repair.' }],
    toolSpecs: [SEARCH_TOOLS],
    fallbackToolSpecs: [SEARCH_TOOLS, runTest],
    maxIters: 3,
    enableToolHooks: false,
    runModel: async ({ messages, tools }) => {
      modelCalls += 1
      const names = tools.map((item) => item.function.name)
      if (modelCalls === 1) {
        assert.equal(names.includes('run_test'), false)
        return { content: '', toolCalls: [call('search-run-test', 'search_tools', {
          query: 'run_test', limit: 1,
        })] }
      }
      assert.ok(names.includes('run_test'))
      activatedResult = JSON.parse(messages.find((message) => (
        message.role === 'tool' && message.name === 'search_tools'
      )).content)
      return { content: 'The verification tool is available.', toolCalls: [] }
    },
    executeTool: async ({ name }) => {
      assert.equal(name, 'search_tools')
      return { ok: true }
    },
  })
  assert.deepEqual(activatedResult.activatedToolNames, ['run_test'])
})

test('tool search never mounts an unrequested artifact generator from the deferred catalog', async () => {
  const createPdf = getBuiltinSpec('create_pdf')
  let secondTools = null
  let calls = 0
  const executed = []
  await runToolsLoop({
    job: { id: 'tool-search-artifact', userId: 'tool-search-artifact-user', origin: 'chat', prompt: 'Find a PDF tool.', userPrompt: 'Find a PDF tool.' },
    step: { id: 'tool-search-artifact', kind: 'chat' },
    messages: [{ role: 'user', content: 'Find a PDF tool.' }],
    toolSpecs: [SEARCH_TOOLS],
    fallbackToolSpecs: [SEARCH_TOOLS, createPdf],
    maxIters: 3,
    enableToolHooks: false,
    requestToolApproval: async ({ args }) => ({ proceed: true, args, approvalId: 'artifact-search-only' }),
    runModel: async ({ tools }) => {
      calls += 1
      if (calls === 1) return { content: '', toolCalls: [call('search-pdf', 'search_tools', { query: 'create PDF' })] }
      secondTools = tools.map((spec) => spec.function.name)
      return { content: 'No authorized generator was mounted.', toolCalls: [] }
    },
    executeTool: async ({ name }) => { executed.push(name); return { ok: true } },
  })
  assert.deepEqual(executed, ['search_tools'])
  assert.equal(calls, 2)
  assert.equal(secondTools.includes('create_pdf'), false)
})
