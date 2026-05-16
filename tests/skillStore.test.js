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
const { issueTestSession } = await import('./helpers/testAuth.js')

test('skill store persists imported skill metadata and prompt asset', () => {
  const { userId } = issueTestSession()
  installSkill({
    id: 'writer',
    userId,
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

  const skill = getImportedSkill('writer', { userId })
  assert.equal(skill.name, '写作助手')
  assert.equal(skill.files['prompts/system.md'], '你是写作助手')
  assert.equal(listImportedSkills({ userId }).length, 1)

  // 另一个用户看不到
  const other = issueTestSession()
  assert.equal(getImportedSkill('writer', { userId: other.userId }), null)
  assert.equal(listImportedSkills({ userId: other.userId }).length, 0)
})
