import test from 'node:test'
import assert from 'node:assert/strict'
import { issueTestSession } from './helpers/testAuth.js'
import {
  SUBAGENT_TYPES,
  getSubagentRun,
  runSubagentBatch,
  runSubagent,
  listSubagentTypes,
} from '../server/services/subagentRuntime.js'

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

test('subagent swarm exposes team members with isolated transcripts', async () => {
  const result = await runSubagentBatch({
    userId,
    request: {
      team_name: 'review swarm',
      tasks: [
        { type: 'explore', role: 'frontend', prompt: 'inspect frontend' },
        { type: 'plan', role: 'backend', prompt: 'inspect backend' },
      ],
    },
    callModel: async ({ messages }) => ({
      content: `done:${messages.find((message) => message.role === 'user')?.content}`,
      toolCalls: [],
    }),
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
})
