import assert from 'node:assert/strict'
import test from 'node:test'
import {
  SKILL_PACK_LIMITS,
  resolveImportedSkillId,
  validateSkillPack,
} from '../server/services/skillImport.js'

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

function validPack(patch = {}) {
  return {
    'skill.json': JSON.stringify({
      id: 'safe-skill',
      name: 'Safe skill',
      description: 'Safe skill',
      version: '1.0.0',
      icon: '🧩',
      permissions: [],
    }),
    'prompts/system.md': 'Use safe instructions.',
    ...patch,
  }
}

test('validator rejects traversal, non-string files, and too many files', () => {
  assert.match(validateSkillPack(validPack({ '../escape.md': 'x' })).reason, /不安全/)
  assert.match(validateSkillPack(validPack({ 'assets/value.json': { unsafe: true } })).reason, /必须是文本/)
  const files = validPack()
  for (let index = 0; index < SKILL_PACK_LIMITS.maxFiles; index += 1) files[`assets/${index}.txt`] = 'x'
  assert.match(validateSkillPack(files).reason, /文件数/)
})

test('validator rejects oversized prompt and total package payloads', () => {
  const prompt = 'x'.repeat(SKILL_PACK_LIMITS.maxSystemPromptBytes + 1)
  assert.match(validateSkillPack(validPack({ 'prompts/system.md': prompt })).reason, /system\.md/)

  const files = validPack()
  const chunk = 'x'.repeat(SKILL_PACK_LIMITS.maxFileBytes)
  for (let index = 0; index < 9; index += 1) files[`assets/chunk-${index}.txt`] = chunk
  assert.match(validateSkillPack(files).reason, /总大小/)
})

