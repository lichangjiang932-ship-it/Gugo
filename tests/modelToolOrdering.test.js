import assert from 'node:assert/strict'
import test from 'node:test'

import { canonicalizeModelToolSet, canonicalizeModelTools } from '../server/adapters/modelRequestCache.js'
import { buildModelProviderRequest } from '../server/adapters/modelProxy.js'
import { resolveEndpointProfile } from '../server/utils/endpointProfile.js'
import { GOAL_TOOL_NAMES } from '../server/utils/goalTools.js'

function tool(name, { dynamic = false } = {}) {
  return {
    ...(dynamic ? { __gugoDynamicTool: true } : {}),
    type: 'function',
    function: {
      name,
      description: `${name} tool`,
      parameters: { type: 'object', properties: {} },
    },
  }
}

test('canonicalizeModelTools appends mid-turn tools without reordering the base set', () => {
  const base = [tool('read_file'), tool('list_directory')]
  const canonicalBase = canonicalizeModelTools(base).map((entry) => entry.function.name)
  assert.deepEqual(canonicalBase, ['list_directory', 'read_file'])

  const withDynamic = canonicalizeModelTools([
    tool('write_file', { dynamic: true }),
    tool('read_file'),
    tool('load_skill', { dynamic: true }),
    tool('list_directory'),
  ])
  assert.deepEqual(
    withDynamic.map((entry) => entry.function.name),
    ['list_directory', 'read_file', 'load_skill', 'write_file'],
  )
  // The base prefix is byte-identical whether or not a dynamic tool is present.
  assert.deepEqual(
    withDynamic.slice(0, 2).map((entry) => entry.function.name),
    canonicalBase,
  )
  // The internal ordering hint never survives canonicalization.
  assert.equal(withDynamic.some((entry) => Object.hasOwn(entry, '__gugoDynamicTool')), false)
})

test('canonicalizeModelTools stays deterministic and order-preserving off the happy path', () => {
  const duplicates = [tool('a'), tool('a', { dynamic: true })]
  const first = canonicalizeModelTools(duplicates)
  const second = canonicalizeModelTools(duplicates)
  assert.deepEqual(first, second)
  assert.deepEqual(first.map((entry) => entry.function.name), ['a', 'a'])

  const unnamed = [{ type: 'function', function: { description: 'no name' } }, tool('b')]
  assert.deepEqual(canonicalizeModelTools(unnamed).length, 2)
  assert.equal(canonicalizeModelTools(null), null)
})

test('tool-set metadata names the base boundary without leaking it into canonical tools', () => {
  const source = [tool('dynamic_a', { dynamic: true }), tool('z_base'), tool('a_base')]
  const before = JSON.stringify(source)
  const prepared = canonicalizeModelToolSet(source)
  assert.equal(prepared.lastBaseToolIndex, 1)
  assert.deepEqual(prepared.tools, canonicalizeModelTools(source))
  assert.equal(JSON.stringify(prepared.tools).includes('__gugoDynamicTool'), false)
  assert.equal(JSON.stringify(prepared.tools).includes('lastBaseToolIndex'), false)
  assert.equal(JSON.stringify(source), before)
  assert.equal(canonicalizeModelToolSet([tool('dynamic', { dynamic: true })]).lastBaseToolIndex, -1)
  assert.deepEqual(canonicalizeModelToolSet(null), { tools: null, lastBaseToolIndex: -1 })
})

test('no request body ever serializes the internal dynamic-tool marker', () => {
  const messages = [{ role: 'user', content: 'hi' }]
  const tools = [tool('alpha'), tool('beta', { dynamic: true })]

  const openai = buildModelProviderRequest({
    config: { baseUrl: 'http://127.0.0.1:1234/v1', modelName: 'm', temperature: 0 },
    profile: resolveEndpointProfile({ baseUrl: 'http://127.0.0.1:1234/v1', modelName: 'm', env: {} }),
    messages,
    tools,
  })
  const openaiBody = JSON.parse(openai.init.body)
  assert.deepEqual(openaiBody.tools.map((entry) => entry.function.name), ['alpha', 'beta'])
  assert.equal(openai.init.body.includes('__gugoDynamicTool'), false)

  const anthropic = buildModelProviderRequest({
    config: { baseUrl: 'https://api.anthropic.com', modelName: 'claude', apiKey: 'k', maxTokens: 100 },
    profile: resolveEndpointProfile({ baseUrl: 'https://api.anthropic.com', modelName: 'claude', env: {} }),
    messages,
    tools,
  })
  const anthropicBody = JSON.parse(anthropic.init.body)
  assert.deepEqual(anthropicBody.tools.map((entry) => entry.name), ['alpha', 'beta'])
  assert.equal(anthropic.init.body.includes('__gugoDynamicTool'), false)
})

test('mid-session goal tools extend the cached tool prefix instead of splitting it', async () => {
  const { initializeGoalToolVisibility } = await import(
    '../server/services/loop/runtime-initializeGoalTools.js'
  )
  const toolNameFromSpec = (spec) => String(spec?.function?.name || '').trim()
  const base = ['apply_patch', 'bash_exec', 'edit_file', 'read_file', 'write_file', 'zed_tool']
    .map((name) => ({ type: 'function', function: { name, parameters: { type: 'object' } } }))
  const goalToolContextForTurn = () => ({
    active: true,
    planId: 'plan-1',
    toolSpecs: ['goal_plan_rewrite', 'goal_plan_status', 'goal_step_update']
      .map((name) => ({ type: 'function', function: { name, parameters: { type: 'object' } } })),
    promptBlock: 'plan',
  })

  const withoutPlan = canonicalizeModelTools(base).map(toolNameFromSpec)
  const s = { d: { goalToolContextForTurn, toolNameFromSpec }, activeToolSpecs: [...base], job: {} }
  initializeGoalToolVisibility(s)
  const withPlan = canonicalizeModelTools(s.activeToolSpecs).map(toolNameFromSpec)

  // The base prefix must stay byte-identical: only new names may be appended.
  assert.deepEqual(withPlan.slice(0, withoutPlan.length), withoutPlan,
    'adding goal tools must not reorder the existing tool block')
  assert.deepEqual(withPlan.slice(withoutPlan.length).sort(), [...GOAL_TOOL_NAMES].sort())
  // And the shared module constant must not be mutated with loop-only markers.
  assert.ok(s.activeToolSpecs.every((spec) => !Object.hasOwn(spec, '__gugoDynamicTool')
    || spec.function.name.startsWith('goal_')), 'only goal specs carry the marker')
  assert.ok(
    !s.activeToolSpecs.filter((spec) => spec.function.name.startsWith('goal_'))
      .some((spec) => !Object.hasOwn(spec, '__gugoDynamicTool')),
    'goal specs must be marked dynamic',
  )
})
