import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-skill-canonical-'))
process.env.APP_DATA_DIR = tempDir

const { closeDb } = await import('../server/db.js')
const {
  getRuntimeSkill,
  listAllRuntimeSkillIds,
  listRuntimeSkills,
} = await import('../server/services/skillRegistry.js')
const { resolveJobSkillContext } = await import('../server/services/jobPromptContext.js')

const legacyPptIds = ['htmlppt', 'axippt', 'ppt-master', 'guizang-ppt']

test.after(() => {
  closeDb()
  fs.rmSync(tempDir, { recursive: true, force: true })
})

test('runtime skill catalog exposes only canonical ppt while reserving legacy ids', () => {
  const visibleIds = listRuntimeSkills().map((skill) => skill.id)
  assert.equal(visibleIds.filter((id) => id === 'ppt').length, 1)
  for (const alias of legacyPptIds) assert.equal(visibleIds.includes(alias), false)

  const reservedIds = listAllRuntimeSkillIds()
  for (const alias of legacyPptIds) assert.equal(reservedIds.includes(alias), true)
})

test('registry and job parsing resolve legacy ppt ids to canonical ppt', () => {
  for (const alias of legacyPptIds) {
    assert.equal(getRuntimeSkill(alias)?.id, 'ppt')
    const context = resolveJobSkillContext({ prompt: `/${alias} 做一份发布会演示` })
    assert.equal(context.skillId, 'ppt')
    assert.equal(context.skill?.id, 'ppt')
    assert.equal(context.userPrompt, '做一份发布会演示')
  }
})
