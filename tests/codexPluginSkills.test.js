import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  _resetCodexPluginSkillsForTests,
  classifyCodexSkill,
  getCodexPluginDiscovery,
  getCodexPluginSkill,
  initCodexPluginSkills,
  listCodexPluginSkills,
  parseCodexPluginRoots,
} from '../server/adapters/codexPluginSkills.js'
import { getRuntimeSkill, listRuntimeSkills } from '../server/services/skillRegistry.js'
import {
  buildSkillsBlock,
  clearPromptCompilerCache,
  prepareSkillsForPrompt,
} from '../server/services/promptCompiler.js'
import { prepareTurnPromptContext } from '../server/services/turnPromptContext.js'

function writePlugin(root, name, manifestExtra = {}, {
  skillName = name,
  runtime = false,
  skillBody = `SECRET_BODY_${name}`,
} = {}) {
  const pluginRoot = path.join(root, 'openai-plugins', 'plugins', name)
  const skillRoot = path.join(pluginRoot, 'skills', skillName)
  fs.mkdirSync(path.join(pluginRoot, '.codex-plugin'), { recursive: true })
  fs.mkdirSync(skillRoot, { recursive: true })
  fs.writeFileSync(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), JSON.stringify({
    name,
    version: '1.0.0',
    skills: './skills',
    ...manifestExtra,
  }))
  fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), [
    '---',
    `name: ${skillName}`,
    'description: >-',
    '  Metadata is discovered',
    '  without retaining the body.',
    '---',
    skillBody,
  ].join('\n'))
  if (runtime) {
    fs.mkdirSync(path.join(skillRoot, 'scripts'))
    fs.writeFileSync(path.join(skillRoot, 'scripts', 'never-run.js'), 'throw new Error("executed")')
  }
  return pluginRoot
}

test('discovers nested Codex plugins as metadata and lazily loads only ready prompts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-codex-plugins-'))
  try {
    const readyRoot = writePlugin(root, 'ready-plugin', {}, { skillName: 'Ready Reader' })
    const readySkillPath = path.join(readyRoot, 'skills', 'Ready Reader', 'SKILL.md')
    fs.mkdirSync(path.join(readyRoot, 'skills', 'Ready Reader', 'agents'))
    fs.writeFileSync(path.join(readyRoot, 'skills', 'Ready Reader', 'agents', 'openai.yaml'), 'display_name: Ready Reader')
    const appRoot = writePlugin(root, 'app-plugin', { apps: './.app.json' })
    fs.writeFileSync(path.join(appRoot, '.app.json'), '{ deliberately invalid and unread }')
    const mcpRoot = writePlugin(root, 'mcp-plugin', { mcpServers: './.mcp.json' })
    fs.writeFileSync(path.join(mcpRoot, '.mcp.json'), '{ deliberately invalid and unread }')
    writePlugin(root, 'runtime-plugin', {}, { runtime: true })
    const resourceRoot = writePlugin(root, 'resource-plugin', {}, {
      skillBody: 'Read [the required guide](references/guide.md) before answering.',
    })
    const resourceDirectory = path.join(resourceRoot, 'skills', 'resource-plugin', 'references')
    fs.mkdirSync(resourceDirectory)
    fs.writeFileSync(path.join(resourceDirectory, 'guide.md'), 'Required details')

    const discovery = initCodexPluginSkills({ roots: [root] })
    assert.equal(discovery.plugins.length, 5)
    assert.equal(discovery.skills.length, 5)
    assert.deepEqual(Object.fromEntries(discovery.skills.map((skill) => [skill.pluginId, skill.compatibility])), {
      'app-plugin': 'needs-app',
      'mcp-plugin': 'needs-mcp',
      'ready-plugin': 'ready',
      'resource-plugin': 'needs-runtime',
      'runtime-plugin': 'needs-runtime',
    })
    assert.equal(discovery.errors.length, 0)
    assert.doesNotMatch(JSON.stringify(discovery), /SECRET_BODY/)

    const listed = listCodexPluginSkills()
    const ready = listed.find((skill) => skill.pluginId === 'ready-plugin')
    assert.ok(ready)
    assert.equal(Object.hasOwn(ready, 'systemPrompt'), false)
    assert.equal(ready.source.path, 'skills/Ready Reader/SKILL.md')
    assert.equal(ready.description, 'Metadata is discovered without retaining the body.')

    const loaded = getCodexPluginSkill(ready.id, { runnableOnly: true, loadPrompt: true })
    assert.equal(loaded.systemPrompt, 'SECRET_BODY_ready-plugin')
    const app = listed.find((skill) => skill.pluginId === 'app-plugin')
    assert.equal(getCodexPluginSkill(app.id, { runnableOnly: true, loadPrompt: true }), null)
    const resource = listed.find((skill) => skill.pluginId === 'resource-plugin')
    assert.deepEqual(resource.requirements.runtime, ['resource:references'])
    assert.equal(getCodexPluginSkill(resource.id, { runnableOnly: true, loadPrompt: true }), null)

    assert.equal(listRuntimeSkills().find((skill) => skill.id === ready.id)?.systemPrompt, undefined)
    assert.equal(getRuntimeSkill(ready.id)?.systemPrompt, 'SECRET_BODY_ready-plugin')
    const prepared = prepareSkillsForPrompt({ skillIds: [ready.id] })
    assert.equal(prepared[0]?.systemPrompt, 'SECRET_BODY_ready-plugin')
    clearPromptCompilerCache('skills')
    const firstBlock = buildSkillsBlock({ skillIds: [ready.id] })
    fs.writeFileSync(readySkillPath, [
      '---',
      'name: Ready Reader',
      'description: Metadata is discovered without retaining the body.',
      '---',
      'UPDATED_SECRET_BODY_ready-plugin_with_a_new_size',
    ].join('\n'))
    const updated = prepareSkillsForPrompt({ skillIds: [ready.id] })
    const secondBlock = buildSkillsBlock({ skillIds: [ready.id] })
    assert.equal(updated[0]?.systemPrompt, 'UPDATED_SECRET_BODY_ready-plugin_with_a_new_size')
    assert.notEqual(firstBlock.fingerprint, secondBlock.fingerprint)
    const turnContext = prepareTurnPromptContext({
      userId: 'codex-plugin-user',
      skillIds: [ready.id],
      env: { AGENT_INJECT_ENABLED: '0' },
    }, {
      prepareMemoryInjectionContext: () => ({ text: '', memoryIds: [] }),
    })
    assert.deepEqual(turnContext.skillIds, [ready.id])
    assert.match(turnContext.messages.map((message) => message.content).join('\n'), /UPDATED_SECRET_BODY_ready-plugin/)
    assert.doesNotMatch(JSON.stringify(getCodexPluginDiscovery()), /SECRET_BODY/)
  } finally {
    _resetCodexPluginSkillsForTests()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('root parsing and classification do not inspect the current working directory', () => {
  assert.deepEqual(parseCodexPluginRoots('C:\\one;D:\\two', { delimiter: ';' }), ['C:\\one', 'D:\\two'])
  assert.deepEqual(parseCodexPluginRoots('["one","two"]'), ['one', 'two'])
  assert.equal(classifyCodexSkill().compatibility, 'ready')
  assert.equal(classifyCodexSkill({ manifest: { apps: './.app.json', mcpServers: './mcp.json' } }).compatibility, 'needs-app')
})
