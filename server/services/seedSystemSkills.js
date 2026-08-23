/**
 * Seed repository-owned skills into SQLite.
 * Packages are validated and decoded completely before the transaction starts,
 * so an invalid package can never replace a previously working installation.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getDb } from '../db.js'
import { logger } from '../utils/logger.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const SYSTEM_SKILLS_SEED_ROOT = path.resolve(__dirname, '../../seed/skills')

export const SYSTEM_SKILL_SEED_LIMITS = Object.freeze({
  maxFileBytes: 2 * 1024 * 1024,
  maxTotalBytes: 16 * 1024 * 1024,
  maxFiles: 2048,
})

const TEXT_EXTENSIONS = new Set([
  '.css', '.csv', '.html', '.htm', '.js', '.json', '.jsonc', '.jsx', '.md',
  '.mjs', '.cjs', '.ps1', '.py', '.sh', '.svg', '.toml', '.ts', '.tsx',
  '.txt', '.xml', '.yaml', '.yml',
])

function hasInvalidTextControls(content) {
  for (let index = 0; index < content.length; index += 1) {
    const code = content.charCodeAt(index)
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) return true
  }
  return false
}

function seedError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function normalizeLimits(overrides = {}) {
  const positive = (value, fallback) => {
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
  }
  return {
    maxFileBytes: positive(overrides.maxFileBytes, SYSTEM_SKILL_SEED_LIMITS.maxFileBytes),
    maxTotalBytes: positive(overrides.maxTotalBytes, SYSTEM_SKILL_SEED_LIMITS.maxTotalBytes),
    maxFiles: positive(overrides.maxFiles, SYSTEM_SKILL_SEED_LIMITS.maxFiles),
  }
}

function walk(dir, prefix = '') {
  const entries = []
  const children = fs.readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  for (const entry of children) {
    const fullPath = path.join(dir, entry.name)
    const relPath = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isSymbolicLink()) {
      throw seedError('SEED_SKILL_SYMLINK', `seed skill cannot contain symbolic links: ${relPath}`)
    }
    if (entry.isDirectory()) entries.push(...walk(fullPath, relPath))
    else if (entry.isFile()) entries.push({ relPath, fullPath, size: fs.statSync(fullPath).size })
  }
  return entries
}

function decodeTextFile(file) {
  const extension = path.extname(file.relPath).toLowerCase()
  if (!TEXT_EXTENSIONS.has(extension)) {
    throw seedError('SEED_SKILL_NON_TEXT_FILE', `seed skill file type is not allowed: ${file.relPath}`)
  }
  const bytes = fs.readFileSync(file.fullPath)
  let content
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw seedError('SEED_SKILL_INVALID_UTF8', `seed skill file is not valid UTF-8: ${file.relPath}`)
  }
  if (hasInvalidTextControls(content)) {
    throw seedError('SEED_SKILL_BINARY_CONTENT', `seed skill file contains binary control bytes: ${file.relPath}`)
  }
  return { ...file, content }
}

function validateManifest(manifest, manifestPath) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw seedError('SEED_SKILL_INVALID_MANIFEST', `invalid skill.json: ${manifestPath}`)
  }
  for (const key of ['id', 'name', 'description', 'version', 'icon']) {
    if (typeof manifest[key] !== 'string' || !manifest[key].trim()) {
      throw seedError('SEED_SKILL_INVALID_MANIFEST', `skill.json missing field ${key}: ${manifestPath}`)
    }
  }
}

function hashField(hash, value) {
  const bytes = Buffer.from(String(value), 'utf8')
  hash.update(String(bytes.length)).update(':').update(bytes)
}

function metadataForHash(manifest) {
  return JSON.stringify({
    id: manifest.id,
    name: manifest.name,
    description: manifest.description,
    version: manifest.version,
    icon: manifest.icon,
    permissions: Array.isArray(manifest.permissions) ? manifest.permissions : [],
  })
}

export function computeSystemSkillContentHash(manifest, files) {
  const hash = crypto.createHash('sha256')
  hashField(hash, 'yma-system-skill-package-v1')
  hashField(hash, metadataForHash(manifest))
  for (const file of [...files].sort((a, b) => String(a.relPath).localeCompare(String(b.relPath)))) {
    hashField(hash, file.relPath)
    hashField(hash, file.content)
  }
  return hash.digest('hex')
}

export function loadSeedSkillPackage(skillDir, limitOverrides = {}) {
  const limits = normalizeLimits(limitOverrides)
  const discovered = walk(skillDir)
  if (discovered.length > limits.maxFiles) {
    throw seedError('SEED_SKILL_TOO_MANY_FILES', `seed skill has ${discovered.length} files; limit is ${limits.maxFiles}`)
  }
  let totalBytes = 0
  for (const file of discovered) {
    if (file.size > limits.maxFileBytes) {
      throw seedError('SEED_SKILL_FILE_TOO_LARGE', `seed skill file exceeds ${limits.maxFileBytes} bytes: ${file.relPath}`)
    }
    totalBytes += file.size
    if (totalBytes > limits.maxTotalBytes) {
      throw seedError('SEED_SKILL_PACKAGE_TOO_LARGE', `seed skill package exceeds ${limits.maxTotalBytes} bytes`)
    }
  }

  const files = discovered.map(decodeTextFile)
  const manifestFile = files.find((file) => file.relPath === 'skill.json')
  if (!manifestFile) throw seedError('SEED_SKILL_MISSING_MANIFEST', `seed skill missing skill.json: ${skillDir}`)
  let manifest
  try {
    manifest = JSON.parse(manifestFile.content)
  } catch {
    throw seedError('SEED_SKILL_INVALID_MANIFEST', `invalid skill.json JSON: ${manifestFile.fullPath}`)
  }
  validateManifest(manifest, manifestFile.fullPath)
  return {
    manifest,
    files,
    totalBytes,
    contentHash: computeSystemSkillContentHash(manifest, files),
  }
}

function parsePermissions(value) {
  try {
    const parsed = JSON.parse(value || '[]')
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function storedContentHash(db, row) {
  if (!row) return null
  const files = db.prepare(
    'SELECT path, content FROM skill_assets WHERE skill_id = ? ORDER BY path ASC'
  ).all(row.id).map((asset) => ({ relPath: asset.path, content: asset.content }))
  return computeSystemSkillContentHash({
    id: row.id,
    name: row.name,
    description: row.description,
    version: row.version,
    icon: row.icon,
    permissions: parsePermissions(row.permissions_json),
  }, files)
}

function upsertSystemSkill(db, skillPackage) {
  const { manifest, files, contentHash } = skillPackage
  const now = Date.now()
  const existing = db.prepare(
    'SELECT id, name, description, version, icon, permissions_json FROM skills WHERE id = ? AND user_id IS NULL'
  ).get(manifest.id)
  const previousHash = storedContentHash(db, existing)

  if (existing && previousHash === contentHash) {
    return { id: manifest.id, status: 'unchanged', version: manifest.version, contentHash }
  }

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
        manifest.id,
      )
    } else {
      // PRIMARY KEY 是全局唯一 id：用户可能已经导入了同名技能（user_id 非 NULL）。
      // 此时直接 INSERT 会抛 UNIQUE 冲突导致整个 seed 报 error；改为优雅跳过，
      // 用户删除自己的同名技能后，下次启动再安装系统版本。
      const owned = db.prepare('SELECT id FROM skills WHERE id = ? AND user_id IS NOT NULL').get(manifest.id)
      if (owned) {
        return {
          id: manifest.id,
          status: 'conflict',
          version: manifest.version,
          reason: `id 已被用户导入占用，跳过系统种子安装: ${manifest.id}`,
        }
      }
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
        now,
      )
    }

    const insertAsset = db.prepare(
      'INSERT INTO skill_assets (skill_id, path, content) VALUES (?, ?, ?)'
    )
    for (const file of files) insertAsset.run(manifest.id, file.relPath, file.content)
  })
  const earlyExit = tx()
  // 事务内 conflict 分支提前返回了结果（用户占用了该 id），不再落到 installed
  if (earlyExit) return earlyExit

  return {
    id: manifest.id,
    status: existing ? 'updated' : 'installed',
    version: manifest.version,
    contentHash,
    previousHash,
    files: files.length,
  }
}

function disableSystemSkill(db, manifest) {
  const existing = db.prepare(
    'SELECT id FROM skills WHERE id = ? AND user_id IS NULL'
  ).get(manifest.id)
  if (existing) {
    db.transaction(() => {
      db.prepare('DELETE FROM skill_assets WHERE skill_id = ?').run(manifest.id)
      db.prepare('DELETE FROM skills WHERE id = ? AND user_id IS NULL').run(manifest.id)
    })()
  }
  return {
    id: manifest.id,
    status: 'disabled',
    version: manifest.version,
    removed: Boolean(existing),
    reason: typeof manifest.disabledReason === 'string' ? manifest.disabledReason : '',
  }
}

export function seedSystemSkills({
  silent = false,
  seedRoot = SYSTEM_SKILLS_SEED_ROOT,
  db,
  limits,
} = {}) {
  if (!fs.existsSync(seedRoot)) {
    if (!silent) logger.info('[seed] no seed/skills directory, skip')
    return []
  }
  const targetDb = db || getDb()
  const skillDirs = fs.readdirSync(seedRoot)
    .map((name) => path.join(seedRoot, name))
    .filter((candidate) => fs.statSync(candidate).isDirectory())

  const results = []
  for (const dir of skillDirs) {
    try {
      const skillPackage = loadSeedSkillPackage(dir, limits)
      const result = skillPackage.manifest.disabled === true
        ? disableSystemSkill(targetDb, skillPackage.manifest)
        : upsertSystemSkill(targetDb, skillPackage)
      results.push(result)
      if (!silent) {
        logger.info(`[seed] ${result.id} v${result.version}: ${result.status}${result.files ? ` (${result.files} files)` : ''}`)
      }
    } catch (error) {
      if (!silent) logger.error(`[seed] failed for ${dir}:`, error.message)
      results.push({ dir, status: 'error', code: error.code || 'SEED_SKILL_ERROR', error: error.message })
    }
  }

  // Sweep repository-owned skills that no longer exist in the current seed.
  // Without this, an old install keeps stale rows forever and the web app and
  // desktop app report different skill counts for the same seed set.
  const expectedIds = new Set()
  for (const dir of skillDirs) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'skill.json'), 'utf8'))
      if (manifest?.id) expectedIds.add(manifest.id)
    } catch {
      // The directory already failed above; nothing to track here.
    }
  }
  for (const row of targetDb.prepare('SELECT id FROM skills WHERE user_id IS NULL').all()) {
    if (expectedIds.has(row.id)) continue
    targetDb.transaction(() => {
      targetDb.prepare('DELETE FROM skill_assets WHERE skill_id = ?').run(row.id)
      targetDb.prepare('DELETE FROM skills WHERE id = ? AND user_id IS NULL').run(row.id)
    })()
    results.push({ id: row.id, status: 'swept', version: null, reason: 'no longer in repository seed' })
    if (!silent) logger.info(`[seed] ${row.id}: swept (not in current seed)`)
  }
  return results
}
