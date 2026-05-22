import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import {
  getSkillEffectiveConfig,
  getSkillSystemPrompt,
} from '../src/data.js'

test('skill helpers resolve imported skills supplied at runtime', () => {
  const importedSkills = [{
    id: 'writer',
    name: '写作助手',
    systemPrompt: '你是写作助手',
  }]

  assert.equal(getSkillSystemPrompt('writer', {}, importedSkills), '你是写作助手')
  assert.equal(getSkillEffectiveConfig('writer', {}, importedSkills).enabled, true)
})

test('ppt skill prompt appends a topic-specific presentation blueprint', () => {
  const prompt = getSkillSystemPrompt('ppt', {}, [], {
    userPrompt: '帮我做一个关于 DeepSeek V4 Pro 的 ppt5页，要求高级感，内容充实',
  })

  assert.match(prompt, /Template library planner/)
  assert.match(prompt, /Selected template: technology/)
  assert.match(prompt, /Strict slide count: 5/)
})

test('chat split loads runtime skills instead of filtering only hard-coded skills', () => {
  const source = fs.readFileSync(new URL('../src/pages/ChatSplit/index.jsx', import.meta.url), 'utf8')
  assert.match(source, /listSkills/)
  assert.match(source, /runtimeSkills/)
  assert.match(source, /getSkillSystemPrompt\(skillId, state\.skillConfigs, runtimeSkills, \{ userPrompt \}\)/)
})

test('chat composer checks runtime skills for slash menu visibility', () => {
  const source = fs.readFileSync(new URL('../src/pages/ChatSplit/ChatComposer.jsx', import.meta.url), 'utf8')
  assert.match(source, /skills/)
  assert.doesNotMatch(source, /return SKILLS\.some/)
})

