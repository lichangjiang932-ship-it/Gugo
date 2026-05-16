import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.APP_DATA_DIR = path.join(os.tmpdir(), 'yma-skill-store-tests', String(process.pid))

const {
  getImportedSkill,
  installSkill,
  listImportedSkills,
} = await import('../server/skillStore.js')

test('skill store persists imported skill metadata and prompt asset', () => {
  installSkill({
    id: 'writer',
    name: '写作助手',
    description: '生成长文',
    version: '1.0.0',
    icon: '✍️',
    permissions: ['内容生成'],
    files: {
      'README.md': '# Writer',
      'prompts/system.md': '你是写作助手',
    },
  })

  const skill = getImportedSkill('writer')
  assert.equal(skill.name, '写作助手')
  assert.equal(skill.files['prompts/system.md'], '你是写作助手')
  assert.equal(listImportedSkills().length, 1)
})

