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
    userId: row.user_id || null,
    name: row.name,
    description: row.description,
    version: row.version,
    icon: row.icon,
    permissions: parseJson(row.permissions_json, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * 导入用户技能包。`userId` 必填——P0 之后所有导入技能都强制归属,
 * 同一个用户内 id 唯一,不同用户互不可见也不冲突。
 */
export function installSkill({
  id,
  userId,
  name,
  description,
  version,
  icon,
  permissions = [],
  files = {},
  now = Date.now(),
}) {
  if (!userId) throw new Error('installSkill requires userId')
  const db = getDb()
  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO skills (id, user_id, name, description, version, icon, permissions_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, userId, name, description, version, icon, JSON.stringify(permissions), now, now)

    const stmt = db.prepare(`
      INSERT INTO skill_assets (skill_id, path, content)
      VALUES (?, ?, ?)
    `)
    Object.entries(files).forEach(([assetPath, content]) => {
      stmt.run(id, assetPath, String(content))
    })
  })
  tx()
  return getImportedSkill(id, { userId })
}

export function getImportedSkill(id, { userId } = {}) {
  const row = getDb().prepare('SELECT * FROM skills WHERE id = ?').get(id)
  const skill = mapSkill(row)
  if (!skill) return null
  if (userId && skill.userId && skill.userId !== userId) return null
  const assets = getDb()
    .prepare('SELECT path, content FROM skill_assets WHERE skill_id = ? ORDER BY path ASC')
    .all(id)
  return {
    ...skill,
    files: Object.fromEntries(assets.map((asset) => [asset.path, asset.content])),
  }
}

export function listImportedSkills({ userId } = {}) {
  if (userId) {
    return getDb()
      .prepare('SELECT * FROM skills WHERE user_id = ? ORDER BY created_at DESC')
      .all(userId)
      .map(mapSkill)
  }
  return getDb()
    .prepare('SELECT * FROM skills ORDER BY created_at DESC')
    .all()
    .map(mapSkill)
}

export function listImportedSkillIds({ userId } = {}) {
  return listImportedSkills({ userId }).map((skill) => skill.id)
}
