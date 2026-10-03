import assert from 'node:assert/strict'
import test, { after, before, beforeEach } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { buildSkillPackFromProposal, installSkillFromMemory } from '../server/services/skillFromMemory.js'
import { getMemory, upsertMemory } from '../server/services/memoryStore.js'
import { getImportedSkill } from '../server/services/skillStore.js'

let workspace
const savedEnv = { APP_DB_PATH: process.env.APP_DB_PATH }
const USER = 'skill-proposal-user'
const OTHER = 'skill-proposal-other-user'

before(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-skill-from-memory-'))
  process.env.APP_DB_PATH = path.join(workspace, 'skill-from-memory.db')
})

after(async () => {
  // Close the handle before removing the file: a database still open holds the
  // path (and on Windows that is an EBUSY, not a warning).
  const { closeDb } = await import('../server/db.js')
  closeDb()
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  fs.rmSync(workspace, { recursive: true, force: true })
})

beforeEach(async () => {
  const { closeDb, createUser } = await import('../server/db.js')
  closeDb()
  fs.rmSync(process.env.APP_DB_PATH, { force: true })
  createUser({ id: USER, email: 'skill-proposal@example.com' })
  createUser({ id: OTHER, email: 'skill-proposal-other@example.com' })
})

function proposal(overrides = {}) {
  return {
    userId: USER,
    type: 'reference',
    title: 'pptx-readback',
    body: '生成 pptx 后回读校验\n触发：产出 pptx 时\n步骤：1) 生成文件 2) 回读页数\n来源：exp-1, exp-2',
    frontmatter: { source: 'experience_abstraction', proposal: 'skill', experienceSources: ['exp-1', 'exp-2'] },
    ...overrides,
  }
}

test('a proposal becomes a skill pack the importer already understands', () => {
  const pack = buildSkillPackFromProposal({ title: 'PPTX Readback v2!', body: '生成后回读页数\n步骤：1) 生成' })
  assert.equal(pack.ok, true)
  assert.equal(pack.manifestId, 'pptx-readback-v2')
  const manifest = JSON.parse(pack.files['skill.json'])
  assert.equal(manifest.id, 'pptx-readback-v2')
  assert.equal(manifest.name, 'PPTX Readback v2!')
  assert.equal(manifest.description, '生成后回读页数')
  assert.equal(manifest.version, '1.0.0')
  assert.deepEqual(manifest.permissions, [])
  // The pack carries the procedure as its system prompt: what the skill does when
  // it is activated is exactly what the journal taught.
  assert.match(pack.files['prompts/system.md'], /生成后回读页数/)
  assert.match(pack.files['prompts/system.md'], /这个技能由本机经验日志抽象而来/u)
  assert.match(pack.files['prompts/system.md'], /步骤：1\) 生成/)

  const englishPack = buildSkillPackFromProposal({
    title: 'readback',
    body: 'Read back every generated file and verify its page count.',
  }, { locale: 'en' })
  assert.match(englishPack.files['prompts/system.md'], /This skill was distilled from local experience/u)
  assert.doesNotMatch(englishPack.files['prompts/system.md'], /这个技能由本机经验日志抽象而来/u)

  assert.equal(buildSkillPackFromProposal({ title: '', body: 'x' }).reason, 'PROPOSAL_TITLE_MISSING')
  assert.equal(buildSkillPackFromProposal({ title: 'ok', body: '' }).reason, 'PROPOSAL_BODY_MISSING')
  assert.equal(buildSkillPackFromProposal({ title: '!!!', body: 'x' }).reason, 'PROPOSAL_ID_INVALID')
})

test('installing a proposal creates the skill once and marks where it came from', () => {
  const memory = upsertMemory(proposal())
  const result = installSkillFromMemory({ userId: USER, memoryId: memory.id })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.alreadyInstalled, false)

  const skill = getImportedSkill(result.skillId, { userId: USER })
  assert.equal(skill.name, 'pptx-readback')
  assert.equal(skill.permissions.length, 0)

  // The memory records what it became, so the button can say "installed" instead
  // of offering the same skill again.
  const saved = getMemory(USER, memory.id)
  assert.equal(saved.frontmatter.installedSkillId, result.skillId)
  assert.equal(saved.frontmatter.proposal, 'skill')
  assert.deepEqual(saved.frontmatter.experienceSources, ['exp-1', 'exp-2'])

  const again = installSkillFromMemory({ userId: USER, memoryId: memory.id })
  assert.equal(again.ok, true)
  assert.equal(again.alreadyInstalled, true)
  assert.equal(again.skillId, result.skillId)
})

test('only a skill proposal of your own can be installed', () => {
  const memory = upsertMemory(proposal())
  // A memory the reader wrote is not a proposal, whatever it contains.
  const handwritten = upsertMemory({ userId: USER, type: 'reference', title: 'notes', body: 'just notes' })
  assert.equal(installSkillFromMemory({ userId: USER, memoryId: handwritten.id }).code, 'MEMORY_NOT_A_SKILL_PROPOSAL')

  const notProposal = upsertMemory(proposal({ title: 'other', frontmatter: { proposal: 'unknown' } }))
  assert.equal(installSkillFromMemory({ userId: USER, memoryId: notProposal.id }).code, 'MEMORY_NOT_A_SKILL_PROPOSAL')

  // Someone else's proposal is not yours to install, and looks like it is not there.
  assert.equal(installSkillFromMemory({ userId: OTHER, memoryId: memory.id }).code, 'MEMORY_NOT_FOUND')
  assert.equal(installSkillFromMemory({ userId: USER, memoryId: 'missing' }).code, 'MEMORY_NOT_FOUND')
  assert.equal(installSkillFromMemory({ memoryId: memory.id }).code, 'MEMORY_USER_REQUIRED')
})
