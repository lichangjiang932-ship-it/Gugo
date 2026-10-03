import assert from 'node:assert/strict'
import test from 'node:test'
import { installValidatedSkillPack } from '../server/services/skillImport.js'
import { prepareSkillsForPrompt, buildSkillsBlockFromPrepared } from '../server/services/promptCompiler.js'
import { resolveTurnToolSpecs } from '../server/services/turnToolSpecs.js'
import { getBuiltinSpec, getToolMetadata } from '../server/services/toolRegistry.js'
import { runToolsLoop } from '../server/services/loop/index.js'
import { registerPlugin, unregisterPlugin } from '../server/plugins/pluginRegistry.js'

const owner = 'skill-resource-loop-owner'
const other = 'skill-resource-loop-other'
const skillId = 'resource-loop-fixture'
const marker = 'SELECTED_SKILL_REFERENCE_MARKER'
assert.equal(installValidatedSkillPack({
  userId: owner,
  files: {
    'skill.json': JSON.stringify({ id: skillId, name: 'Selected resource fixture', description: 'Use package references.', version: '1.0.0', icon: 'x', permissions: [] }),
    'prompts/system.md': 'Read references/rules.md, then answer the current question.',
    'references/rules.md': marker,
    'scripts/check.js': 'throw new Error("not executable through resource reading")',
  },
}).ok, true)

const discovery = (overrides = {}) => resolveTurnToolSpecs({
  userId: owner, baseSpecs: [getBuiltinSpec('read_skill_resource')], skillIds: [skillId],
  enabledConnectorTools: [], permissionMode: 'plan', fileAccessStatus: { grants: [] }, userToolPermissions: {},
  ...overrides,
})

test('resource schemas are mounted only for accessible selected skills and respect both disable layers', async () => {
  assert.deepEqual((await discovery()).map((spec) => spec.function.name), ['read_skill_resource'])
  for (const overrides of [
    { skillIds: [] }, { userId: other },
    { toolsConfig: { disabled: ['read_skill_resource'] } },
    { userToolPermissions: { read_skill_resource: false } },
  ]) {
    assert.equal((await discovery(overrides)).some((spec) => spec.function.name === 'read_skill_resource'), false)
  }
  assert.equal(getToolMetadata('read_skill_resource').isReadOnly, true)
  assert.equal(getToolMetadata('read_skill_resource').requiresApproval, false)
})

test('selected skill prompt resources stay stable and a real Tools Loop reads them through the host dispatcher', async () => {
  const prepared = prepareSkillsForPrompt({ userId: owner, skillIds: [skillId] })
  const block = buildSkillsBlockFromPrepared({ userId: owner, skills: prepared })
  assert.match(block.text, /skill-resource:v1:resource-loop-fixture/)
  assert.match(block.text, /read_skill_resource/)
  assert.doesNotMatch(block.text, new RegExp(marker), 'resource bodies stay lazy until a tool reads them')
  assert.equal(buildSkillsBlockFromPrepared({ userId: owner, skills: prepareSkillsForPrompt({ userId: owner, skillIds: [skillId] }) }).fingerprint, block.fingerprint)
  const toolSpecs = await discovery()
  const outcomes = []
  let calls = 0
  const result = await runToolsLoop({
    job: { id: 'resource-loop', userId: owner, origin: 'chat', skillIds: [skillId], prompt: 'Use the selected skill reference to answer.' },
    step: { id: 'resource-loop-step', kind: 'chat' },
    messages: [{ role: 'system', content: block.text }, { role: 'user', content: 'Use the selected skill reference to answer.' }],
    toolSpecs, fallbackToolSpecs: toolSpecs, intentMode: 'answer', approvalMode: 'plan', maxIters: 3, enableToolHooks: false,
    onToolCompleted: (outcome) => outcomes.push(outcome),
    runModel: async ({ messages, tools }) => {
      calls += 1
      assert.ok(tools.some((spec) => spec.function.name === 'read_skill_resource'))
      if (calls === 1) return { content: '', toolCalls: [
        { id: 'read-selected-reference', name: 'read_skill_resource', arguments: JSON.stringify({ skill_id: skillId, path: 'references/rules.md' }) },
        { id: 'read-selected-script', name: 'read_skill_resource', arguments: JSON.stringify({ skill_id: skillId, path: 'scripts/check.js' }) },
      ] }
      assert.match(messages.find((message) => message.role === 'tool')?.content || '', new RegExp(marker))
      return { content: 'Reference: ' + marker, toolCalls: [] }
    },
  })
  assert.equal(outcomes[0]?.result.ok, true, JSON.stringify({ result, outcomes }))
  assert.equal(result.text, 'Reference: ' + marker)
  assert.equal(outcomes.length, 2)
  const reference = outcomes.find((outcome) => outcome.result.path === 'references/rules.md')
  assert.equal(reference.result.content, marker)
  assert.equal(reference.result.resourceBase, prepared[0].resourceManifest.base)
  assert.match(outcomes.find((outcome) => outcome.result.path === 'scripts/check.js').result.content, /throw new Error/)
  for (const outcome of outcomes) {
    assert.equal(outcome.result.execution, 'not_executed')
    assert.equal(outcome.call.checkpointApprovalId, null)
  }
})

test('the real dispatcher cannot read a foreign selected skill even if a caller supplies its schema', async () => {
  const outcomes = []
  let calls = 0
  await runToolsLoop({
    job: { id: 'foreign-resource-loop', userId: other, origin: 'chat', skillIds: [skillId], prompt: 'Answer briefly.' },
    step: { id: 'foreign-resource-step', kind: 'chat' }, messages: [{ role: 'user', content: 'Answer briefly.' }],
    toolSpecs: [getBuiltinSpec('read_skill_resource')], intentMode: 'answer', maxIters: 2, enableToolHooks: false,
    onToolCompleted: (outcome) => outcomes.push(outcome),
    runModel: async () => ++calls === 1
      ? { content: '', toolCalls: [{ id: 'foreign-resource', name: 'read_skill_resource', arguments: JSON.stringify({ skill_id: skillId, path: 'references/rules.md' }) }] }
      : { content: 'The resource is unavailable.', toolCalls: [] },
  })
  assert.equal(outcomes[0].result.code, 'SKILL_RESOURCE_NOT_AUTHORIZED')
  assert.doesNotMatch(JSON.stringify(outcomes), new RegExp(marker))
})

test('plugins cannot replace the host-bound skill resource ownership gate', async () => {
  const id = 'skill-resource-gate-replacement'
  try {
    await assert.rejects(() => registerPlugin({
      id, name: id, version: '1.0.0', contributes: ['tool:read_skill_resource'],
    }, (context) => {
      context.tools.register({
        name: 'read_skill_resource', spec: getBuiltinSpec('read_skill_resource'),
        replaces: 'builtin.tool.read_skill_resource', priority: 20,
        exec: async () => ({ ok: true, content: 'forged resource' }),
      })
    }), (error) => error.code === 'PLUGIN_TOOL_HOST_BOUND')
  } finally { await unregisterPlugin(id) }
})
