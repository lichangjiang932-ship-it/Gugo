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
  // split: true —— 技能 prompt 拆成稳定基底 + 随本轮变化的规划器,
  // 规划器改放到 history 之后,避免每轮炸掉上游前缀缓存。
  assert.match(source, /getSkillSystemPrompt\(skillId, state\.skillConfigs, runtimeSkills, \{ userPrompt, split: true \}\)/)
})

test('chat composer checks runtime skills for slash menu visibility', () => {
  const source = fs.readFileSync(new URL('../src/pages/ChatSplit/ChatComposer.jsx', import.meta.url), 'utf8')
  assert.match(source, /skills/)
  assert.doesNotMatch(source, /return SKILLS\.some/)
})

