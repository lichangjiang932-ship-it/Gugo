/**
 * 系统级技能播种：把 seed/skills/<id>/ 目录树灌进 SQLite。
 *
 * 设计：
 * - user_id = NULL ⇒ 全站共享（"内置"语义）
 * - 二进制安全：所有文件按文本读，SVG / MD / JSON 都是文本，符合现有 skill_assets.content TEXT 约束
 * - 幂等：每次启动重新比对版本号；版本不变就跳过
 * - 调用方式：server 启动时自动跑；也可 `node server/seedSystemSkills.js` 手动跑
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getDb } from '../db.js'
import { logger } from '../utils/logger.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const SYSTEM_SKILLS_SEED_ROOT = path.resolve(__dirname, '../../seed/skills')

// 容易超 SQLite row 大小的极端 SVG 文件做一下 sanity 限制（实际我们的素材最大 ~40KB，没问题）
const MAX_ASSET_BYTES = 2 * 1024 * 1024 // 2MB / file

function walk(dir, prefix = '') {
  const entries = []
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name)
    const rel = prefix ? `${prefix}/${name}` : name
    const stat = fs.statSync(full)
    if (stat.isDirectory()) {
      entries.push(...walk(full, rel))
    } else {
      entries.push({ relPath: rel, fullPath: full, size: stat.size })
    }
  }
  return entries
}

function loadManifest(skillDir) {
  const manifestPath = path.join(skillDir, 'skill.json')
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`seed skill 缺少 skill.json: ${skillDir}`)
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  for (const k of ['id', 'name', 'description', 'version', 'icon']) {
    if (!manifest[k]) throw new Error(`skill.json 缺少字段 ${k}: ${manifestPath}`)
  }
  return manifest
}

function upsertSystemSkill(db, skillDir, manifest) {
  const now = Date.now()
  const existing = db.prepare(
    'SELECT version FROM skills WHERE id = ? AND user_id IS NULL'
  ).get(manifest.id)

  if (existing && existing.version === manifest.version) {
    return { id: manifest.id, status: 'unchanged', version: manifest.version }
  }

  const files = walk(skillDir).filter((f) => {
    if (f.size > MAX_ASSET_BYTES) {
      console.warn(`[seed] 跳过超大文件 ${f.relPath} (${f.size} bytes)`)
      return false
    }
    return true
  })

  const tx = db.transaction(() => {
    if (existing) {
      db.prepare('DELETE FROM skill_assets WHERE skill_id = ?').run(manifest.id)
      db.prepare(
        'UPDATE skills SET name=?, description=?, version=?, icon=?, permissions_json=?, updated_at=? WHERE id=? AND user_id IS NULL'
      ).run(
        manifest.name,
        manifest.description,
        manifest.version,
        manifest.icon,
        JSON.stringify(manifest.permissions || []),
        now,
        manifest.id
      )
    } else {
      db.prepare(
        'INSERT INTO skills (id, user_id, name, description, version, icon, permissions_json, created_at, updated_at) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?)'
      ).run(
        manifest.id,
        manifest.name,
        manifest.description,
        manifest.version,
        manifest.icon,
        JSON.stringify(manifest.permissions || []),
        now,
        now
      )
    }

    const ins = db.prepare(
      'INSERT INTO skill_assets (skill_id, path, content) VALUES (?, ?, ?)'
    )
    for (const f of files) {
      // 文本读取；非 UTF8 文件遇到时再考虑 base64 包装
      const content = fs.readFileSync(f.fullPath, 'utf8')
      ins.run(manifest.id, f.relPath, content)
    }
  })
  tx()

  return {
    id: manifest.id,
    status: existing ? 'updated' : 'installed',
    version: manifest.version,
    files: files.length,
  }
}

export function seedSystemSkills({ silent = false } = {}) {
  if (!fs.existsSync(SYSTEM_SKILLS_SEED_ROOT)) {
    if (!silent) logger.info('[seed] no seed/skills directory, skip')
    return []
  }
  const db = getDb()
  const skillDirs = fs.readdirSync(SYSTEM_SKILLS_SEED_ROOT)
    .map((name) => path.join(SYSTEM_SKILLS_SEED_ROOT, name))
    .filter((p) => fs.statSync(p).isDirectory())

  const results = []
  for (const dir of skillDirs) {
    try {
      const manifest = loadManifest(dir)
      const result = upsertSystemSkill(db, dir, manifest)
      results.push(result)
      if (!silent) {
        logger.info(`[seed] ${result.id} v${result.version}: ${result.status}${result.files ? ` (${result.files} files)` : ''}`)
      }
    } catch (err) {
      console.error(`[seed] failed for ${dir}:`, err.message)
      results.push({ dir, status: 'error', error: err.message })
    }
  }
  return results
}

// 允许 CLI 直接执行：node server/seedSystemSkills.js
if (import.meta.url === `file://${process.argv[1]}`) {
  const results = seedSystemSkills()
  logger.info('\n[seed] done:', JSON.stringify(results, null, 2))
  process.exit(0)
}
