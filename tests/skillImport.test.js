import assert from 'node:assert/strict'
import test from 'node:test'
import {
  resolveImportedSkillId,
  validateSkillPack,
} from '../server/skillImport.js'

test('validator accepts a complete folder skill pack', () => {
  const result = validateSkillPack({
    'skill.json': JSON.stringify({
      id: 'writer',
      name: '写作助手',
      description: '生成长文',
      version: '1.0.0',
      icon: '✍️',
      permissions: ['内容生成'],
    }),
    'README.md': '# Writer',
    'prompts/system.md': '你是写作助手',
  })

  assert.equal(result.ok, true)
  assert.equal(result.skill.id, 'writer')
})

test('validator rejects packs without prompts/system.md', () => {
  const result = validateSkillPack({
    'skill.json': JSON.stringify({
      id: 'writer',
      name: '写作助手',
      description: '生成长文',
      version: '1.0.0',
      icon: '✍️',
      permissions: ['内容生成'],
    }),
  })

  assert.equal(result.ok, false)
  assert.match(result.reason, /prompts\/system\.md/)
})

test('collision resolver auto-suffixes imported IDs', () => {
  assert.equal(resolveImportedSkillId('writer', ['writer']), 'writer-2')
  assert.equal(resolveImportedSkillId('writer', ['writer', 'writer-2']), 'writer-3')
})

