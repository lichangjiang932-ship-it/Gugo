import test from 'node:test'
import assert from 'node:assert/strict'
import { issueTestSession } from './helpers/testAuth.js'
import {
  SUBAGENT_TYPES,
  getSubagentRun,
  recoverInterruptedSubagentRuns,
  runSubagentBatch,
  runSubagent,
  listSubagentTypes,
  _testing,
} from '../server/services/subagentRuntime.js'
import { createJobBudget } from '../server/utils/jobBudget.js'
import { getDb } from '../server/db.js'

const { userId } = issueTestSession({ email: 'subagent-test@example.com' })

test('listSubagentTypes returns explore, plan, general', () => {
  const types = listSubagentTypes()
  const ids = types.map((t) => t.id).sort()
  assert.deepEqual(ids, ['explore', 'general', 'plan'])
})

test('SUBAGENT_TYPES have system prompts and tool specs', () => {
  for (const [id, type] of Object.entries(SUBAGENT_TYPES)) {
    assert.ok(type.label, `${id} should have a label`)
    assert.ok(type.system, `${id} should have a system prompt`)
    assert.ok(Array.isArray(type.tools), `${id} should have tools array`)
    assert.ok(type.tools.length > 0, `${id} should have at least one tool`)
  }
})

test('subagent model calls consume the shared hard budget and still return a wrap-up', async () => {
  const budget = createJobBudget({
    maxModelCalls: 1,
    maxModelTokens: 100,
    maxCostUsd: 1,
  })
  let providerCalls = 0
  const result = await _testing.subagentToolsLoop({
    messages: [
      { role: 'system', content: 'Test subagent.' },
      { role: 'user', content: 'Inspect one item.' },
    ],
    tools: [SUBAGENT_TYPES.explore.tools.find((tool) => tool.function.name === 'read_file')],
    maxIters: 3,
    userId,
    budget,
    approveTool: async ({ args }) => ({ proceed: true, args }),
    executeTool: async () => ({ ok: true, content: 'evidence' }),
    callModel: async () => {
      providerCalls += 1
      if (providerCalls === 1) {
        return {
          content: '',
          toolCalls: [{ id: 'read-1', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }],
          usage: { promptTokens: 10, completionTokens: 5 },
          costUsd: 0.01,
        }
      }
      return {
        content: 'Budget wrap-up with evidence.',
        toolCalls: [],
        usage: { promptTokens: 5, completionTokens: 5 },
        costUsd: 0.01,
      }
    },
  })
  assert.equal(result.budgetExceeded, true)
  assert.equal(result.incomplete, true)
  assert.match(result.text, /Budget wrap-up with evidence\./)
  assert.equal(providerCalls, 2, 'one normal request plus one explicit wrap-up')
  assert.equal(budget.snapshot().modelCalls, 2)
  assert.equal(budget.snapshot().modelTokens, 25)
  assert.equal(budget.snapshot().costUsd, 0.02)
})

test('explore and plan types have read-only tools', () => {
  const readonly = ['explore', 'plan']
  for (const typeId of readonly) {
    const names = SUBAGENT_TYPES[typeId].tools.map((t) => t.function.name)
    assert.ok(names.includes('web_search'), `${typeId} should have web_search`)
    assert.ok(names.includes('fetch_url'), `${typeId} should have fetch_url`)
    assert.ok(names.includes('read_file'), `${typeId} should have read_file`)
    assert.ok(!names.includes('write_file'), `${typeId} should NOT have write_file`)
  }
})

test('general type has full read-write tools', () => {
  const names = SUBAGENT_TYPES.general.tools.map((t) => t.function.name)
  assert.ok(names.includes('web_search'))
  assert.ok(names.includes('write_file'))
  assert.ok(names.includes('edit_file'))
  assert.ok(names.includes('Agent'))
})

test('runSubagent requires userId and prompt', async () => {
  await assert.rejects(runSubagent({ prompt: 'test' }), /userId is required/)
  await assert.rejects(runSubagent({ userId, prompt: '' }), /prompt is required/)
  await assert.rejects(runSubagent({ userId, prompt: 'test', type: 'invalid' }), /unknown subagent type/)
})

test('runSubagent creates a DB record', async () => {
  // Mock the model call by overriding — for now just test DB insertion
  // This test runs without a real model call, so it will throw on model connection.
  // We verify the DB record was created before the error happens.
  try {
    await runSubagent({ userId, type: 'general', prompt: '测试任务，不需要真实执行' })
  } catch {
    // Expected — no model configured in test env
  }
  // Check that records exist for this user
  const db = (await import('../server/db.js')).getDb()
  const rows = db.prepare('SELECT * FROM subagent_runs WHERE user_id = ?').all(userId)
  assert.ok(rows.length >= 1, 'at least 1 subagent run should be recorded')
  assert.equal(rows[0].agent_type, 'general')
})

test('subagent injects optional skill and memory context and degrades when preparation fails', async () => {
  let capturedMessages = []
  let capturedModel = null
  let contextInput = null
  const run = await runSubagent({
    userId,
    type: 'explore',
    prompt: 'inspect memory pipeline',
    modelName: 'subagent-context-model',
    agentId: 'agent-context',
    skillIds: ['review'],
    preparePromptContext: (input) => {
      contextInput = input
      return {
        messages: [
          { role: 'system', content: '# Skills\nreview carefully' },
          { role: 'system', content: '# Long-term memory\nknown constraint' },
        ],
      }
    },
    callModel: async ({ messages, modelName }) => {
      capturedMessages = messages
      capturedModel = modelName
      return { content: 'done', toolCalls: [] }
    },
  })
  assert.equal(run.status, 'completed')
  assert.equal(contextInput.agentId, 'agent-context')
  assert.deepEqual(contextInput.skillIds, ['review'])
  assert.equal(capturedModel, 'subagent-context-model')
  assert.ok(capturedMessages.some((message) => message.content.includes('review carefully')))
  assert.ok(capturedMessages.some((message) => message.content.includes('known constraint')))

  const degraded = await runSubagent({
    userId,
    type: 'explore',
    prompt: 'continue without memory',
    preparePromptContext: () => { throw new Error('context unavailable') },
    callModel: async () => ({ content: 'still completed', toolCalls: [] }),
  })
  assert.equal(degraded.status, 'completed')
  assert.equal(degraded.resultText, 'still completed')
})

test('subagent compiles an inherited inline skill with the shared quality contract', async () => {
  let capturedMessages = []
  const run = await runSubagent({
    userId,
    type: 'explore',
    prompt: 'review the local workflow',
    skillIds: ['local-inline-review'],
    skillDefinitions: [{
      id: 'local-inline-review',
      name: 'Local inline review',
      description: 'A browser-local review workflow.',
      systemPrompt: 'Use this exact inherited local workflow.',
    }],
    callModel: async ({ messages }) => {
      capturedMessages = messages
      return { content: 'done', toolCalls: [] }
    },
  })

  assert.equal(run.status, 'completed')
  const skillBlock = capturedMessages.find((message) => message.content.startsWith('# Skills'))?.content || ''
  assert.match(skillBlock, /Use this exact inherited local workflow\./)
  assert.match(skillBlock, /gugo-skill-quality:v1/)
})

test('subagent swarm exposes team members with isolated transcripts', async () => {
  const modelsByPrompt = new Map()
  const result = await runSubagentBatch({
    userId,
    request: {
      team_name: 'review swarm',
      model_name: 'swarm-default-model',
      tasks: [
        { type: 'explore', role: 'frontend', prompt: 'inspect frontend' },
        { type: 'plan', role: 'backend', prompt: 'inspect backend', modelName: 'backend-model' },
      ],
    },
    callModel: async ({ messages, modelName }) => {
      const prompt = messages.find((message) => message.role === 'user')?.content
      modelsByPrompt.set(prompt, modelName)
      return { content: `done:${prompt}`, toolCalls: [] }
    },
  })
  assert.equal(result.parallel, true)
  assert.equal(result.team.mode, 'swarm')
  assert.deepEqual(result.team.members.map((member) => member.role), ['frontend', 'backend'])
  const first = getSubagentRun({ userId, id: result.runs[0].id })
  const second = getSubagentRun({ userId, id: result.runs[1].id })
  assert.equal(first.team.id, result.team.id)
  assert.equal(second.team.id, result.team.id)
  assert.ok(first.transcript.some((event) => event.eventType === 'model_response'))
  assert.match(first.resultText, /frontend/)
  assert.doesNotMatch(first.resultText, /backend/)
  assert.match(second.resultText, /backend/)
  assert.equal(modelsByPrompt.get('inspect frontend'), 'swarm-default-model')
  assert.equal(modelsByPrompt.get('inspect backend'), 'backend-model')
})

test('runSubagent persists paused and interrupted loop terminals without claiming completion', async () => {
  for (const terminal of [
    { paused: true, expected: 'paused' },
    { interrupted: true, expected: 'interrupted' },
    { incomplete: true, expected: 'interrupted' },
    { budgetExceeded: true, expected: 'interrupted' },
    { noProgress: true, expected: 'interrupted' },
    { text: 'done', expected: 'completed' },
  ]) {
    assert.equal(_testing.subagentStatusForLoopResult(terminal), terminal.expected)
  }

  const paused = await runSubagent({
    id: `subagent-paused-${Date.now()}`,
    userId,
    type: 'explore',
    prompt: 'inspect the relevant area',
    callModel: async () => ({
      content: '',
      toolCalls: [{
        id: 'clarify-1',
        function: {
          name: 'request_clarification',
          arguments: JSON.stringify({ question: 'Which area should be inspected?' }),
        },
      }],
    }),
  })
  assert.equal(paused.status, 'paused')
  assert.match(paused.resultText, /需要澄清/)

  let modelCalls = 0
  const interrupted = await runSubagent({
    id: `subagent-interrupted-${Date.now()}`,
    userId,
    type: 'explore',
    prompt: 'inspect one file',
    callModel: async () => {
      modelCalls += 1
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [{
            id: 'read-1',
            function: { name: 'read_file', arguments: JSON.stringify({ path: 'README.md' }) },
          }],
        }
      }
      throw Object.assign(new Error('provider interrupted'), { status: 503 })
    },
    executeTool: async () => ({ ok: true, content: 'evidence' }),
  })
  assert.equal(interrupted.status, 'interrupted')
  assert.match(interrupted.resultText, /探索中断/)
})

test('stale running subagent is marked interrupted and resumes completed tool outcomes from its checkpoint', async () => {
  let checkpoint = null
  let modelCalls = 0
  let toolCalls = 0
  const prompt = 'resume checkpoint evidence'
  const initial = await _testing.subagentToolsLoop({
    messages: [{ role: 'user', content: prompt }],
    tools: [SUBAGENT_TYPES.explore.tools.find((tool) => tool.function.name === 'read_file')],
    userId,
    callModel: async () => {
      modelCalls += 1
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [{
            id: 'checkpoint-read-1',
            function: { name: 'read_file', arguments: JSON.stringify({ path: 'README.md' }) },
          }],
        }
      }
      throw Object.assign(new Error('simulated restart'), { status: 503 })
    },
    executeTool: async () => {
      toolCalls += 1
      return { ok: true, content: 'durable evidence' }
    },
    saveCheckpoint: async (state) => {
      checkpoint = structuredClone(state)
      return { state }
    },
  })
  assert.equal(initial.interrupted, true)
  assert.ok(checkpoint)
  assert.equal(toolCalls, 1)

  const id = `subagent-resume-${Date.now()}`
  const at = Date.now()
  getDb().prepare(`
    INSERT INTO subagent_runs
      (id, user_id, agent_type, prompt, status, trace_json, created_at)
    VALUES (?, ?, 'explore', ?, 'running', ?, ?)
  `).run(id, userId, prompt, JSON.stringify([
    { type: 'start', at },
    { type: 'runtime_checkpoint', state: checkpoint, at },
  ]), at)

  assert.equal(recoverInterruptedSubagentRuns({ at: at + 1 }), 1)
  const recovered = getSubagentRun({ userId, id })
  assert.equal(recovered.status, 'interrupted')
  assert.equal(recovered.trace.some((event) => event.type === 'runtime_checkpoint'), false)
  assert.equal(recovered.trace.at(-1).resumable, true)

  let resumedModelCalls = 0
  const resumed = await runSubagent({
    id,
    userId,
    type: 'explore',
    prompt,
    callModel: async ({ messages }) => {
      resumedModelCalls += 1
      assert.ok(messages.some((message) => (
        message.role === 'tool' && String(message.content).includes('durable evidence')
      )))
      return { content: 'resumed and completed', toolCalls: [] }
    },
    executeTool: async () => {
      toolCalls += 1
      return { ok: true }
    },
  })
  assert.equal(resumed.status, 'completed')
  assert.equal(resumed.resultText, 'resumed and completed')
  assert.equal(resumedModelCalls, 1)
  assert.equal(toolCalls, 1, 'a completed checkpointed tool must not be replayed')
})
