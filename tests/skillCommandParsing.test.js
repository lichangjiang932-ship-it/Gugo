import assert from 'node:assert/strict'
import test from 'node:test'
import { inferSkillIdFromPrompt, parseSkillCommand } from '../src/lib/skillCommands.js'

test('skill commands preserve hyphenated imported skill ids', () => {
  assert.deepEqual(parseSkillCommand('/writer-2 draft weekly report'), {
    skillId: 'writer-2',
    userPrompt: 'draft weekly report',
  })
})

test('infers built-in ppt skills from natural language prompts', () => {
  assert.equal(inferSkillIdFromPrompt('make a 5 page product intro ppt'), 'ppt')
  assert.equal(inferSkillIdFromPrompt('\u5e2e\u6211\u505a\u4e00\u4e2a5\u9875\u4ea7\u54c1\u4ecb\u7ecdPPT'), 'ppt')
  assert.equal(inferSkillIdFromPrompt('make a premium html ppt'), 'htmlppt')
  assert.equal(inferSkillIdFromPrompt('\u505a\u4e00\u4e2a\u9ad8\u7ea7\u611f html ppt'), 'htmlppt')
  assert.equal(inferSkillIdFromPrompt('just chat with me'), null)
})
