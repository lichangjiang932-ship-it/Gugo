import { getDb } from './db.js'

function parseJson(value, fallback) {
  try {
    return value == null ? fallback : JSON.parse(value)
  } catch {
    return fallback
  }
}

function mapSkill(row) {
  if (!row) return null
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    version: row.version,
    icon: row.icon,
    permissions: parseJson(row.permissions_json, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function installSkill({
  id,
  name,
  description,
  version,
  icon,
  permissions = [],
  files = {},
  now = Date.now(),
}) {
  const db = getDb()
  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO skills (id, name, description, version, icon, permissions_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, name, description, version, icon, JSON.stringify(permissions), now, now)

    const stmt = db.prepare(`
      INSERT INTO skill_assets (skill_id, path, content)
      VALUES (?, ?, ?)
    `)
    Object.entries(files).forEach(([assetPath, content]) => {
      stmt.run(id, assetPath, String(content))
    })
  })
  tx()
  return getImportedSkill(id)
}

export function getImportedSkill(id) {
  const row = getDb().prepare('SELECT * FROM skills WHERE id = ?').get(id)
  const skill = mapSkill(row)
  if (!skill) return null
  const assets = getDb()
    .prepare('SELECT path, content FROM skill_assets WHERE skill_id = ? ORDER BY path ASC')
    .all(id)
  return {
    ...skill,
    files: Object.fromEntries(assets.map((asset) => [asset.path, asset.content])),
  }
}

export function listImportedSkills() {
  return getDb()
    .prepare('SELECT * FROM skills ORDER BY created_at DESC')
    .all()
    .map(mapSkill)
}

export function listImportedSkillIds() {
  return listImportedSkills().map((skill) => skill.id)
}

