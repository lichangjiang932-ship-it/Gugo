import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-skill-store-tests-'))
process.env.APP_DATA_DIR = TMP_DIR

const {
  getImportedSkill,
  installSkill,
  listImportedSkills,
} = await import('../server/services/skillStore.js')
const { closeDb } = await import('../server/db.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

test.after(() => {
  try { closeDb() } catch { /* already closed */ }
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }) } catch { /* best effort */ }
})

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

  // Anonymous callers may read only repository-owned system skills.
  assert.equal(getImportedSkill('writer'), null)
  assert.equal(listImportedSkills().some((skill) => skill.id === 'writer'), false)
})
