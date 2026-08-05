import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  SYSTEM_SKILLS_SEED_ROOT,
  loadSeedSkillPackage,
  seedSystemSkills,
} from '../server/services/seedSystemSkills.js'

function createSeedDb() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE skills (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      version TEXT NOT NULL,
      icon TEXT NOT NULL,
      permissions_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE skill_assets (
      skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      content TEXT NOT NULL,
      PRIMARY KEY (skill_id, path)
    );
  `)
  return db
}

function writeSeedSkill(root, manifest = {}, content = '# Skill\n\nFirst version.') {
  const dir = path.join(root, manifest.id || 'demo-skill')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'skill.json'), JSON.stringify({
    id: 'demo-skill',
    name: 'Demo skill',
    description: 'A deterministic seed fixture.',
    version: '1.0.0',
    icon: 'sparkles',
    permissions: [],
    ...manifest,
  }))
  fs.writeFileSync(path.join(dir, 'SKILL.md'), content)
  return dir
}

test('system skill seeding resolves the repository seed/skills directory', () => {
  assert.equal(path.basename(SYSTEM_SKILLS_SEED_ROOT), 'skills')
  assert.equal(path.basename(path.dirname(SYSTEM_SKILLS_SEED_ROOT)), 'seed')
  assert.equal(fs.existsSync(path.join(SYSTEM_SKILLS_SEED_ROOT, 'ppt-master', 'SKILL.md')), true)
})

test('system skill seeding detects content changes without a version bump', () => {
  const seedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-seed-hash-'))
  const db = createSeedDb()
  try {
    const skillDir = writeSeedSkill(seedRoot)
    const first = seedSystemSkills({ seedRoot, db, silent: true })
    assert.equal(first[0].status, 'installed')

    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# Skill\n\nChanged without a version bump.')
    const second = seedSystemSkills({ seedRoot, db, silent: true })
    assert.equal(second[0].status, 'updated')
    assert.notEqual(second[0].previousHash, second[0].contentHash)
    assert.match(db.prepare("SELECT content FROM skill_assets WHERE skill_id = ? AND path = 'SKILL.md'").get('demo-skill').content, /Changed/)

    const third = seedSystemSkills({ seedRoot, db, silent: true })
    assert.equal(third[0].status, 'unchanged')
  } finally {
    db.close()
    fs.rmSync(seedRoot, { recursive: true, force: true })
  }
})

test('disabled seed manifests remove only the repository-owned system skill', () => {
  const seedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-seed-disabled-'))
  const db = createSeedDb()
  try {
    writeSeedSkill(seedRoot)
    seedSystemSkills({ seedRoot, db, silent: true })
    db.prepare(`INSERT INTO skills
      (id, user_id, name, description, version, icon, permissions_json, created_at, updated_at)
      VALUES ('user-skill', 'user-1', 'User skill', 'Keep me', '1', 'user', '[]', 1, 1)`).run()

    writeSeedSkill(seedRoot, {
      disabled: true,
      disabledReason: 'Incomplete package references.',
    })
    const [result] = seedSystemSkills({ seedRoot, db, silent: true })
    assert.equal(result.status, 'disabled')
    assert.equal(result.removed, true)
    assert.equal(db.prepare('SELECT COUNT(*) count FROM skills WHERE id = ?').get('demo-skill').count, 0)
    assert.equal(db.prepare('SELECT COUNT(*) count FROM skill_assets WHERE skill_id = ?').get('demo-skill').count, 0)
    assert.equal(db.prepare('SELECT user_id FROM skills WHERE id = ?').get('user-skill').user_id, 'user-1')
  } finally {
    db.close()
    fs.rmSync(seedRoot, { recursive: true, force: true })
  }
})

test('seed package validation rejects unsupported binary files and package overflow', () => {
  const seedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-seed-limits-'))
  try {
    const skillDir = writeSeedSkill(seedRoot)
    fs.writeFileSync(path.join(skillDir, 'payload.bin'), Buffer.from([0, 1, 2]))
    assert.throws(() => loadSeedSkillPackage(skillDir), { code: 'SEED_SKILL_NON_TEXT_FILE' })
    fs.rmSync(path.join(skillDir, 'payload.bin'))
    assert.throws(
      () => loadSeedSkillPackage(skillDir, { maxTotalBytes: 8 }),
      { code: 'SEED_SKILL_PACKAGE_TOO_LARGE' },
    )
  } finally {
    fs.rmSync(seedRoot, { recursive: true, force: true })
  }
})

test('S4: user-owned skill id shadows system seed without UNIQUE conflict', () => {
  const seedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-seed-conflict-'))
  const db = createSeedDb()
  try {
    // 用户先导入了同名技能（user_id 非 NULL）
    db.prepare(`INSERT INTO skills
      (id, user_id, name, description, version, icon, permissions_json, created_at, updated_at)
      VALUES ('demo-skill', 'user-1', 'User owned', 'Mine', '1', 'user', '[]', 1, 1)`).run()
    db.prepare(`INSERT INTO skill_assets (skill_id, path, content)
      VALUES ('demo-skill', 'prompts/system.md', 'user copy')`).run()

    writeSeedSkill(seedRoot)
    const [result] = seedSystemSkills({ seedRoot, db, silent: true })

    // 优雅跳过，不抛 error、不覆盖用户技能
    assert.equal(result.status, 'conflict')
    assert.match(result.reason, /已被用户导入占用/)
    const row = db.prepare('SELECT user_id, name FROM skills WHERE id = ?').get('demo-skill')
    assert.equal(row.user_id, 'user-1')
    assert.equal(row.name, 'User owned')
    assert.equal(
      db.prepare("SELECT content FROM skill_assets WHERE skill_id = ? AND path = 'prompts/system.md'").get('demo-skill').content,
      'user copy',
    )
  } finally {
    db.close()
    fs.rmSync(seedRoot, { recursive: true, force: true })
  }
})
