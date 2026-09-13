import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.APP_DATA_DIR = path.join(os.tmpdir(), 'gugo-dynamic-skill-tests', String(process.pid))

const { runToolsLoop } = await import('../server/services/jobTools.js')
const { getBuiltinSpec } = await import('../server/services/toolRegistry.js')
const {
  DYNAMIC_SKILL_SYSTEM_MARKER,
  hasRuntimeSkillActivationBlock,
  prepareRuntimeSkillActivation,
} = await import('../server/services/runtimeSkillActivation.js')

const LOAD_SKILL = getBuiltinSpec('load_skill')

function call(id, skillId) {
  return {
    id,
    type: 'function',
    function: { name: 'load_skill', arguments: JSON.stringify({ skill_id: skillId }) },
  }
}

test('runtime skill activation resolves exact host-owned instructions without exposing them as tool data', () => {
  const activation = prepareRuntimeSkillActivation({ userId: null, skillId: 'review' })
  assert.equal(activation.ok, true)
  assert.equal(activation.skillId, 'review')
  assert.match(activation.promptBlock, /^\[HOST-VERIFIED SKILL ACTIVATION\]\n\nskill_id="review"/)
  assert.match(activation.promptBlock, /# Skills/)
  assert.equal(hasRuntimeSkillActivationBlock([
    { role: 'tool', content: activation.promptBlock },
  ], 'review'), false)
  assert.equal(hasRuntimeSkillActivationBlock([
    { role: 'system', content: activation.promptBlock },
  ], 'review'), true)

  assert.deepEqual(prepareRuntimeSkillActivation({ userId: null, skillId: 'missing-private-skill' }), {
    ok: false,
    code: 'skill_not_available',
    error: 'The requested skill is not available to the current user.',
  })
})

test('load_skill injects a separately trusted prompt, checkpoints it, and restores it once', async () => {
  let modelCalls = 0
  let activatedCheckpoint = null
  const executed = []
  const result = await runToolsLoop({
    job: {
      id: 'dynamic-skill-activation', userId: 'dynamic-skill-user', origin: 'chat',
      prompt: 'Review this code for correctness.', userPrompt: 'Review this code for correctness.',
    },
    step: { id: 'dynamic-skill-activation', kind: 'chat' },
    messages: [{ role: 'user', content: 'Review this code for correctness.' }],
    toolSpecs: [LOAD_SKILL],
    fallbackToolSpecs: [LOAD_SKILL],
    maxIters: 4,
    enableToolHooks: false,
    saveCheckpoint: async (state) => {
      const copied = structuredClone(state)
      const loaded = copied.completionGuards?.dynamicallyLoadedSkillIds || []
      if (!activatedCheckpoint
        && loaded.includes('review')
        && hasRuntimeSkillActivationBlock(copied.messages, 'review')
        && copied.final !== true) activatedCheckpoint = copied
      return true
    },
    runModel: async ({ messages, tools }) => {
      modelCalls += 1
      assert.ok(tools.some((spec) => spec.function.name === 'load_skill'))
      if (modelCalls === 1) return { content: '', toolCalls: [call('load-review', 'review')] }

      const trusted = messages.filter((message) => message.role === 'system'
        && String(message.content || '').includes(DYNAMIC_SKILL_SYSTEM_MARKER))
      assert.equal(trusted.length, 1)
      assert.match(trusted[0].content, /skill_id="review"/)
      const toolMessage = messages.find((message) => message.role === 'tool'
        && message.name === 'load_skill')
      const toolResult = JSON.parse(toolMessage.content)
      assert.deepEqual(toolResult, {
        ok: true,
        skillId: 'review',
        name: '代码审查',
        activated: true,
      })
      assert.doesNotMatch(toolMessage.content, /HOST-VERIFIED|Loaded skill instructions|# Skills/)
      return { content: 'Review completed with the loaded checklist.', toolCalls: [] }
    },
    executeTool: async ({ name }) => {
      executed.push(name)
      return { ok: true }
    },
  })

  assert.equal(result.text, 'Review completed with the loaded checklist.')
  assert.deepEqual(executed, ['load_skill'])
  assert.ok(activatedCheckpoint)
  assert.deepEqual(
    activatedCheckpoint.capabilityDecision.dynamicallyLoadedSkills,
    ['review'],
  )

  let restoredMessages = null
  const restored = await runToolsLoop({
    job: {
      id: 'dynamic-skill-restored', userId: 'dynamic-skill-user', origin: 'chat',
      prompt: 'Continue the review.', userPrompt: 'Continue the review.',
    },
    step: { id: 'dynamic-skill-restored', kind: 'chat' },
    messages: [{ role: 'user', content: 'Continue the review.' }],
    toolSpecs: [LOAD_SKILL],
    fallbackToolSpecs: [LOAD_SKILL],
    maxIters: 4,
    enableToolHooks: false,
    loadCheckpoint: async () => ({ state: structuredClone(activatedCheckpoint) }),
    runModel: async ({ messages }) => {
      restoredMessages = messages
      return { content: 'Restored review.', toolCalls: [] }
    },
    executeTool: async () => assert.fail('restored activation must not execute again'),
  })
  assert.equal(restored.text, 'Restored review.')
  assert.equal(restoredMessages.filter((message) => message.role === 'system'
    && String(message.content || '').includes(DYNAMIC_SKILL_SYSTEM_MARKER)).length, 1)
})

test('load_skill fails closed for a skill outside the visible catalog', async () => {
  let calls = 0
  const result = await runToolsLoop({
    job: {
      id: 'dynamic-skill-denied', userId: 'dynamic-skill-user', origin: 'chat',
      prompt: 'Use a missing skill.', userPrompt: 'Use a missing skill.',
    },
    step: { id: 'dynamic-skill-denied', kind: 'chat' },
    messages: [{ role: 'user', content: 'Use a missing skill.' }],
    toolSpecs: [LOAD_SKILL],
    fallbackToolSpecs: [LOAD_SKILL],
    maxIters: 3,
    enableToolHooks: false,
    runModel: async ({ messages }) => {
      calls += 1
      if (calls === 1) return { content: '', toolCalls: [call('load-missing', 'missing-private-skill')] }
      const toolResult = JSON.parse(messages.find((message) => message.role === 'tool').content)
      assert.equal(toolResult.ok, false)
      assert.equal(toolResult.code, 'skill_not_available')
      assert.equal(messages.some((message) => message.role === 'system'
        && String(message.content || '').includes(DYNAMIC_SKILL_SYSTEM_MARKER)), false)
      return { content: 'The requested skill is unavailable.', toolCalls: [] }
    },
    executeTool: async () => ({ ok: true }),
  })
  assert.equal(result.text, 'The requested skill is unavailable.')
})
