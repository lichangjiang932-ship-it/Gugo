import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import {
  SYSTEM_SKILLS_SEED_ROOT,
  loadSeedSkillPackage,
  seedSystemSkills,
} from '../server/services/seedSystemSkills.js'

const SKILL_DIR = path.join(SYSTEM_SKILLS_SEED_ROOT, 'connector-operator')

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

test('connector-operator seed skill manifest is complete', () => {
  const manifestPath = path.join(SKILL_DIR, 'skill.json')
  assert.equal(fs.existsSync(manifestPath), true)
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  for (const key of ['id', 'name', 'description', 'version', 'icon']) {
    assert.ok(typeof manifest[key] === 'string' && manifest[key].trim(), `skill.json missing ${key}`)
  }
  assert.equal(manifest.id, 'connector-operator')
  assert.equal(manifest.disabled, undefined, 'connector-operator must not be quarantined')
})

test('connector-operator SKILL.md has frontmatter with a trigger description', () => {
  const skillMd = fs.readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8')
  assert.match(skillMd, /^---\r?\nname: connector-operator/, 'SKILL.md must start with name frontmatter')
  assert.match(skillMd, /description: >/, 'SKILL.md frontmatter must include a description block')
})

test('connector-operator seed package passes reference-integrity loading', () => {
  const skillPackage = loadSeedSkillPackage(SKILL_DIR)
  assert.equal(skillPackage.manifest.id, 'connector-operator')
  const relPaths = skillPackage.files.map((file) => file.relPath)
  for (const required of [
    'skill.json',
    'SKILL.md',
    'prompts/system.md',
    'references/connectors.md',
    'workflows/search-and-read.md',
    'workflows/send-message.md',
  ]) {
    assert.ok(relPaths.includes(required), `seed package missing ${required}`)
  }
  // SKILL.md 引用的相对文件必须真实存在，避免重蹈 ppt-master 的隔离问题
  const skillMd = skillPackage.files.find((file) => file.relPath === 'SKILL.md').content
  for (const ref of ['references/connectors.md', 'workflows/search-and-read.md', 'workflows/send-message.md']) {
    assert.ok(skillMd.includes(ref), `SKILL.md references missing file: ${ref}`)
  }
})

test('connector-operator installs into the database as a system skill', () => {
  const db = createSeedDb()
  try {
    const results = seedSystemSkills({
      seedRoot: SYSTEM_SKILLS_SEED_ROOT,
      db,
      silent: true,
    })
    const result = results.find((item) => item.id === 'connector-operator')
    assert.ok(result, 'connector-operator should be seeded')
    assert.equal(result.status, 'installed')
    assert.equal(result.files, 6)

    const stored = db.prepare('SELECT * FROM skills WHERE id = ? AND user_id IS NULL').get('connector-operator')
    assert.ok(stored, 'system skill row exists')
    const assets = db.prepare('SELECT path FROM skill_assets WHERE skill_id = ?').all('connector-operator')
    assert.ok(assets.length >= 6, 'assets stored')
  } finally {
    db.close()
  }
})
