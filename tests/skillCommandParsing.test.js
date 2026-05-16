import assert from 'node:assert/strict'
import test from 'node:test'
import { parseSkillCommand } from '../src/lib/skillCommands.js'

test('skill commands preserve hyphenated imported skill ids', () => {
  assert.deepEqual(parseSkillCommand('/writer-2 起草周报'), {
    skillId: 'writer-2',
    userPrompt: '起草周报',
  })
})
