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

test('chat split loads runtime skills instead of filtering only hard-coded skills', () => {
  const source = fs.readFileSync(new URL('../src/pages/ChatSplit/index.jsx', import.meta.url), 'utf8')
  assert.match(source, /listSkills/)
  assert.match(source, /runtimeSkills/)
  assert.match(source, /getSkillSystemPrompt\(skillId, state\.skillConfigs, runtimeSkills\)/)
})

test('chat composer checks runtime skills for slash menu visibility', () => {
  const source = fs.readFileSync(new URL('../src/pages/ChatSplit/ChatComposer.jsx', import.meta.url), 'utf8')
  assert.match(source, /skills/)
  assert.doesNotMatch(source, /return SKILLS\.some/)
})

