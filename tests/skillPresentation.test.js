import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import {
  describeSkillRequirements,
  getPresentedSkill,
  getSkillDetailCopy,
  presentSkillCollection,
} from '../src/lib/skillPresentation.js'

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

test('skill library, slash menu, and command palette share presented metadata', () => {
  const chat = fs.readFileSync(new URL('../src/pages/ChatSplit/index.jsx', import.meta.url), 'utf8')
  const commands = fs.readFileSync(new URL('../src/components/SkillCommandsSync.jsx', import.meta.url), 'utf8')

  assert.match(chat, /presentSkillCollection\(runtimeSkills, lang\)/)
  assert.match(chat, /for \(const skill of presentedRuntimeSkills\)/)
  assert.match(commands, /syncSkillsToCommands\(presentSkillCollection\(skills, lang\)\)/)
})

test('skill details explain invocation and runtime requirements in every UI language', () => {
  for (const lang of ['zh', 'en', 'ja', 'ko', 'zh-TW']) {
    const copy = getSkillDetailCopy(lang)
    assert.ok(copy.overview)
    assert.ok(copy.command)
    assert.ok(copy.requirements)
  }
  assert.deepEqual(describeSkillRequirements({ requirements: {} }, 'zh'), ['当前环境已满足运行要求'])
  assert.deepEqual(describeSkillRequirements({ requirements: { app: true, mcp: true, runtime: ['references'] } }, 'zh'), [
    '需要对应应用连接',
    '需要 MCP 服务',
    '需要额外运行资源：references',
  ])
})
