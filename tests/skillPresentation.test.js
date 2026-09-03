import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { readSourceTree } from './sourceTree.js'
import {
  describeSkillRequirements,
  getPresentedSkill,
  getSkillDetailCopy,
  organizeSkillCatalog,
  presentSkillCollection,
  selectDefaultSkillCatalog,
} from '../src/lib/skillPresentation.js'
import { SKILLS } from '../src/data/skillCatalog.js'

const present = (name, desc = 'Use this skill for professional work.') => getPresentedSkill({
  id: `codex-superpowers-${name}`,
  name,
  desc,
  pluginName: 'Superpowers',
}, 'zh')

test('plugin skills keep distinct Chinese names and concrete descriptions', () => {
  const receiving = present('receiving-code-review', 'Use when receiving code review feedback.')
  const requesting = present('requesting-code-review', 'Use before merging to verify work.')
  const verification = present('verification-before-completion', 'Use before claiming work is complete.')

  assert.deepEqual([receiving.name, requesting.name, verification.name], [
    '处理审查意见',
    '发起代码审查',
    '完成前验证',
  ])
  assert.equal(new Set([receiving.name, requesting.name, verification.name]).size, 3)
  assert.match(receiving.desc, /验证技术合理性/)
  assert.match(requesting.desc, /合并前发起代码审查/)
  assert.match(verification.desc, /实际输出/)
})

test('unknown plugin skills retain a unique translated identity instead of a shared category name', () => {
  const android = present('zoom-meeting-sdk-android', 'Zoom Meeting SDK for Android.')
  const windows = present('zoom-meeting-sdk-windows', 'Zoom Meeting SDK for Windows.')

  assert.notEqual(android.name, windows.name)
  assert.match(android.name, /Android/)
  assert.match(windows.name, /Windows/)
  assert.match(android.desc, /环境准备|认证|核心接口/)
  assert.equal(android.originalName, 'zoom-meeting-sdk-android')
})

test('existing Chinese built-in skill copy remains unchanged', () => {
  const skill = { id: 'research', name: '深度研究', desc: '检索并核验多来源资料。' }
  assert.equal(getPresentedSkill(skill, 'zh'), skill)
})

test('every built-in skill exposes English catalog metadata without changing runtime identity', () => {
  const english = presentSkillCollection(SKILLS, 'en')

  assert.equal(english.length, 12)
  assert.deepEqual(english.map((skill) => skill.id), SKILLS.map((skill) => skill.id))
  assert.deepEqual(english.map((skill) => skill.name), [
    'Presentation Design',
    'Premium Webpage',
    'Document Editing',
    'Spreadsheet Analysis',
    'Email Drafting',
    'Financial Analysis',
    'Code Generation',
    'Code Review',
    'Test Generation',
    'Translation & Editing',
    'Research & Analysis',
    'Project Planning',
  ])
  for (const skill of english) {
    assert.doesNotMatch(skill.name, /[\u3400-\u9fff]/u, `${skill.id} name must be English`)
    assert.doesNotMatch(skill.desc, /[\u3400-\u9fff]/u, `${skill.id} description must be English`)
    assert.doesNotMatch(skill.perms.join(' '), /[\u3400-\u9fff]/u, `${skill.id} permissions must be English`)
    assert.equal(skill.systemPrompt, SKILLS.find((source) => source.id === skill.id)?.systemPrompt)
  }
})

test('legacy UI languages use English built-in copy while user-managed skills keep their own metadata', () => {
  const englishPpt = getPresentedSkill(SKILLS[0], 'en')
  for (const legacyLang of ['ja', 'ko', 'zh-TW', 'en-US']) {
    assert.deepEqual(getPresentedSkill(SKILLS[0], legacyLang), englishPpt)
  }

  const custom = {
    id: 'ppt',
    name: '我的演示技能',
    desc: '保留用户自己的名称与说明。',
    perms: ['自定义权限'],
    custom: true,
  }
  assert.equal(getPresentedSkill(custom, 'en'), custom)
})

test('skill collection merges identical plugin copies and disambiguates real title collisions', () => {
  const skills = [
    { id: 'one-react', name: 'react-best-practices', desc: 'Same guidance.', pluginName: 'Build Web Apps', codexPlugin: true, runnable: true },
    { id: 'two-react', name: 'react-best-practices', desc: 'Same guidance.', pluginName: 'Vercel', codexPlugin: true, runnable: true },
    { id: 'security-validation', name: 'validation', desc: 'Validate security policy.', pluginName: 'Codex Security', codexPlugin: true, runnable: true },
    { id: 'release-verification', name: 'verification', desc: 'Verify release output.', pluginName: 'Vercel', codexPlugin: true, runnable: true },
  ]
  const presented = presentSkillCollection(skills, 'zh')

  assert.equal(presented.length, 3)
  assert.equal(new Set(presented.map((skill) => skill.name)).size, 3)
  assert.ok(presented.some((skill) => skill.name.includes('Codex Security')))
  assert.ok(presented.some((skill) => skill.name.includes('Vercel')))
})

test('skill library keeps one canonical presentation capability and preserves user-installed skills', () => {
  const presented = organizeSkillCatalog([
    { id: 'openai-presentations', name: 'Presentations', desc: 'Create slide decks.', codexPlugin: true, runnable: true },
    { id: 'ppt', name: '制作 PPT', desc: '生成可编辑演示文稿。', runnable: true, recommended: true },
    { id: 'slides', name: 'Slides', desc: 'Another built-in slide generator.', codexPlugin: true, runnable: true },
    { id: 'my-presentation', name: '我的路演模板', desc: '用户安装的演示技能。', custom: true, imported: true, runnable: true },
  ], 'zh')

  assert.deepEqual(presented.map((skill) => skill.id).sort(), ['my-presentation', 'ppt'])
  assert.equal(presented.find((skill) => skill.id === 'ppt')?.capabilityKey, 'presentation')
  assert.equal(presented.find((skill) => skill.id === 'ppt')?.categoryLabel, '办公创作')
  assert.equal(presented.find((skill) => skill.id === 'my-presentation')?.categoryLabel, '我的技能')
})

test('skill library merges duplicate official names and sorts categories deterministically', () => {
  const input = [
    { id: 'plugin-b-review', name: 'code-review', desc: 'Second review copy.', codexPlugin: true, runnable: true },
    { id: 'mail', name: '邮件起草', desc: '起草专业邮件。', runnable: true },
    { id: 'review', name: '代码审查', desc: '检查代码变更。', runnable: true },
    { id: 'plugin-a-review', name: 'code-review', desc: 'First review copy.', codexPlugin: true, runnable: true },
  ]
  const first = organizeSkillCatalog(input, 'zh')
  const second = organizeSkillCatalog([...input].reverse(), 'zh')

  assert.deepEqual(first.map((skill) => skill.id), ['review', 'mail'])
  assert.deepEqual(second.map((skill) => skill.id), ['review', 'mail'])
  assert.deepEqual(first.map((skill) => skill.categoryLabel), ['开发与测试', '沟通协作'])
})

test('default skill library stays compact while retaining user skills and common plugin capabilities', () => {
  const catalog = organizeSkillCatalog([
    { id: 'ppt', name: '制作 PPT', desc: '制作演示文稿。', runnable: true },
    { id: 'codex-superpowers-systematic-debugging', name: 'systematic-debugging', desc: 'Debug with evidence.', codexPlugin: true, runnable: true, recommended: true },
    { id: 'codex-obscure-runtime', name: 'obscure-runtime', desc: 'A specialized plugin skill.', codexPlugin: true, runnable: true, recommended: true },
    { id: 'my-imported-skill', name: '我的导入技能', desc: '用户自己的技能。', custom: true, imported: true, runnable: true },
  ], 'zh')
  const defaults = selectDefaultSkillCatalog(catalog)

  assert.deepEqual(defaults.map((skill) => skill.id), [
    'ppt',
    'codex-superpowers-systematic-debugging',
    'my-imported-skill',
  ])
  assert.ok(catalog.some((skill) => skill.id === 'codex-obscure-runtime'), 'full catalog must keep non-default skills searchable')
})

test('large catalogs keep a compact featured set and deterministic complete ordering', () => {
  const featured = Array.from({ length: 25 }, (_, index) => ({
    id: `core-skill-${String(index).padStart(2, '0')}`,
    name: `Core skill ${String(index).padStart(2, '0')}`,
    desc: `Built-in capability ${index}`,
    runnable: true,
    recommended: true,
  }))
  const longTail = Array.from({ length: 586 }, (_, index) => ({
    id: `codex-specialized-${String(index).padStart(3, '0')}`,
    name: `Specialized plugin ${String(index).padStart(3, '0')}`,
    desc: `Specialized capability ${index}`,
    runnable: true,
    codexPlugin: true,
    external: true,
  }))

  const catalog = organizeSkillCatalog([...longTail, ...featured], 'en')
  const reversed = organizeSkillCatalog([...featured, ...longTail].reverse(), 'en')

  assert.equal(catalog.length, 611)
  assert.equal(selectDefaultSkillCatalog(catalog).length, 25)
  assert.deepEqual(catalog.map((skill) => skill.id), reversed.map((skill) => skill.id))
})

test('skill library, slash menu, and command palette share presented metadata', () => {
  const chat = readSourceTree('../src/pages/ChatSplit/')
  const commands = fs.readFileSync(new URL('../src/components/SkillCommandsSync.jsx', import.meta.url), 'utf8')

  assert.match(chat, /presentSkillCollection\(runtimeSkills, lang\)/)
  assert.match(chat, /for \(const skill of presentedRuntimeSkills\)/)
  assert.match(commands, /syncSkillsToCommands\(presentSkillCollection\(skills, lang\)\)/)
})

test('skill details explain invocation and runtime requirements in every supported UI language', () => {
  for (const lang of ['zh', 'en']) {
    const copy = getSkillDetailCopy(lang)
    assert.ok(copy.overview)
    assert.ok(copy.command)
    assert.ok(copy.requirements)
  }
  const englishCopy = getSkillDetailCopy('en')
  for (const legacyLang of ['ja', 'ko', 'zh-TW']) {
    assert.deepEqual(getSkillDetailCopy(legacyLang), englishCopy)
  }
  assert.deepEqual(describeSkillRequirements({ requirements: {} }, 'zh'), ['当前环境已满足运行要求'])
  assert.deepEqual(describeSkillRequirements({ requirements: { app: true, mcp: true, runtime: ['references'] } }, 'zh'), [
    '需要对应应用连接',
    '需要 MCP 服务',
    '需要额外运行资源：references',
  ])
  assert.deepEqual(describeSkillRequirements({ compatibility: 'needs-runtime' }, 'zh'), ['需要额外运行资源'])
})
