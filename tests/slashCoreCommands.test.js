import test from 'node:test'
import assert from 'node:assert/strict'

import { createSlashCommandRegistry } from '../src/lib/slashCommandRegistry.js'
import { CORE_SLASH_COMMANDS, registerCoreSlashCommands } from '../src/lib/slashCoreCommands.js'

function createRegistry(lang = 'en') {
  const registry = createSlashCommandRegistry({ storage: null })
  registerCoreSlashCommands(registry, { lang })
  return registry
}

test('core slash actions mirror the useful Codex action set and order', () => {
  const registry = createRegistry()
  assert.deepEqual(CORE_SLASH_COMMANDS, [
    'mcp', 'side', 'init', 'compact', 'feedback', 'continue', 'pet', 'new', 'status', 'goals', 'plan',
  ])
  assert.deepEqual(
    registry.listCommands().filter((entry) => entry.source === 'core').map((entry) => entry.name),
    CORE_SLASH_COMMANDS,
  )
  for (const name of CORE_SLASH_COMMANDS) {
    const entry = registry.getCommand(name)
    assert.equal(typeof entry.handler, 'function')
    assert.ok(entry.description)
    assert.ok(entry.meta?.displayName)
  }
})

test('Chinese labels and descriptions use the Codex-style wording', () => {
  const registry = createRegistry('zh-CN')
  assert.equal(registry.getCommand('compact').meta.displayName, '压缩')
  assert.equal(registry.getCommand('compact').description, '压缩此聊天的上下文')
  assert.equal(registry.getCommand('continue').meta.displayName, '在新聊天中继续')
  assert.equal(registry.getCommand('plan').meta.displayName, '计划模式')
})

test('MCP, side chat, status, pet, and plan actions call their real UI hooks', async () => {
  const registry = createRegistry()
  let mcp = 0
  let side = 0
  let pet = 0
  let status = 0
  let mode = null
  const context = {
    openMcp: () => { mcp += 1 },
    openSideChat: () => { side += 1 },
    togglePet: () => { pet += 1 },
    openStatus: () => { status += 1 },
    setApprovalMode: async (value) => { mode = value },
  }
  await registry.getCommand('mcp').handler('', context)
  await registry.getCommand('side').handler('', context)
  await registry.getCommand('pet').handler('', context)
  await registry.getCommand('status').handler('', context)
  await registry.getCommand('plan').handler('', context)
  assert.equal(mcp, 1)
  assert.equal(side, 1)
  assert.equal(pet, 1)
  assert.equal(status, 1)
  assert.equal(mode, 'plan')
})

test('compact only replaces chat context when enough messages exist', async () => {
  const registry = createRegistry()
  const actions = []
  const shortState = { activeSessionId: 's1', sessions: [{ id: 's1', messages: Array(8).fill({ role: 'user' }) }] }
  const longState = { activeSessionId: 's1', sessions: [{ id: 's1', messages: Array(9).fill({ role: 'user' }) }] }
  assert.equal(await registry.getCommand('compact').handler('', { getState: () => shortState }), 'This chat is still too short to compact.')
  assert.equal(await registry.getCommand('compact').handler('', {
    getState: () => longState,
    dispatch: (action) => actions.push(action),
  }), 'Chat context compacted.')
  assert.deepEqual(actions, [{ type: 'COMPRESS_CURRENT_SESSION' }])
})

test('feedback and goals first open inline panels, then save meaningful values', async () => {
  const registry = createRegistry()
  const feedback = []
  const actions = []
  let feedbackPanel = 0
  let goalsPanel = 0
  const state = { activeSessionId: 's1', sessions: [{ id: 's1', messages: [], todos: [] }] }
  assert.equal(await registry.getCommand('feedback').handler('', { openFeedback: () => { feedbackPanel += 1 } }), '')
  assert.equal(await registry.getCommand('feedback').handler('menu feels good', {
    recordFeedback: (value) => feedback.push(value),
  }), 'Feedback saved locally.')
  assert.equal(await registry.getCommand('goals').handler('', { openGoals: () => { goalsPanel += 1 } }), '')
  assert.equal(await registry.getCommand('goals').handler('ship the redesign', {
    getState: () => state,
    createId: () => 'goal-1',
    dispatch: (action) => actions.push(action),
  }), 'Goal added: ship the redesign')
  assert.deepEqual(feedback, ['menu feels good'])
  assert.equal(feedbackPanel, 1)
  assert.equal(goalsPanel, 1)
  assert.equal(actions[0].type, 'SET_TODOS')
  assert.deepEqual(actions[0].payload.todos, [{ id: 'goal-1', text: 'ship the redesign', done: false }])
})

test('goals command creates a durable planned job and opens it when job runtime is available', async () => {
  const registry = createRegistry()
  const calls = []
  const navigations = []
  const result = await registry.getCommand('goals').handler('ship the redesign', {
    createGoalJob: async (prompt, options) => {
      calls.push({ prompt, options })
      return { job: { id: 'job 1', status: 'queued' } }
    },
    navigate: (path) => navigations.push(path),
  })
  assert.equal(result, 'Goal added: ship the redesign')
  assert.deepEqual(calls, [{ prompt: 'ship the redesign', options: { requirePlanApproval: true } }])
  assert.deepEqual(navigations, ['/tasks?job=job%201'])
})

test('continue creates a new chat with a carried-context draft', async () => {
  const registry = createRegistry()
  const actions = []
  const state = {
    activeSessionId: 's1',
    sessions: [{ id: 's1', title: 'Design', messages: [{ role: 'user', content: 'Make the menu softer.' }] }],
  }
  const result = await registry.getCommand('continue').handler('', {
    getState: () => state,
    createId: () => 's2',
    dispatch: (action) => actions.push(action),
  })
  assert.equal(result, 'Created a new chat with the current context.')
  assert.equal(actions[0].type, 'NEW_SESSION')
  assert.equal(actions[0].payload.id, 's2')
  assert.equal(actions[1].type, 'SET_SESSION_DRAFT')
  assert.match(actions[1].payload.text, /Make the menu softer/)
})

test('initialize delegates AGENTS.md creation and new chat starts blank', async () => {
  const registry = createRegistry()
  const prompts = []
  const actions = []
  await registry.getCommand('init').handler('', { triggerSendFlow: (prompt) => prompts.push(prompt) })
  await registry.getCommand('new').handler('', { dispatch: (action) => actions.push(action) })
  assert.match(prompts[0], /AGENTS\.md/)
  assert.deepEqual(actions, [{ type: 'START_NEW_DRAFT' }])
})
