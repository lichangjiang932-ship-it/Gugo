import fs from 'node:fs'
import path from 'node:path'
import { getScopedTurnProjectDirectory } from './localFileAccessService.js'

// Only explicit agent-instruction files are elevated to system context.
// README files remain ordinary project data and must be read through tools.
const INSTRUCTION_FILES = Object.freeze(['AGENTS.override.md', 'AGENTS.md', 'CLAUDE.md'])
const MAX_INSTRUCTION_BYTES = 64 * 1024
const MAX_COMBINED_INSTRUCTION_BYTES = 128 * 1024
const MAX_CACHE_ENTRIES = 256
const cache = new Map()

function workspaceRoot(env, userId) {
  return path.resolve(getScopedTurnProjectDirectory({ userId })
    || String(env.WORKSPACE_ROOT || process.cwd()))
}

function isInside(root, target) {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith(`..${path.sep}`)
    && relative !== '..' && !path.isAbsolute(relative))
}

function instructionDirectories(root, directory) {
  const requested = directory ? path.resolve(String(directory)) : root
  if (!isInside(root, requested)) return [root]
  const directories = []
  let current = requested
  while (true) {
    directories.push(current)
    if (current === root) break
    const parent = path.dirname(current)
    if (parent === current || !isInside(root, parent)) break
    current = parent
  }
  return directories.reverse()
}

function remember(scopeKey, entry) {
  cache.delete(scopeKey)
  cache.set(scopeKey, entry)
  while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value)
}

function readInstructionAt(root, directory, userId) {
  for (const name of INSTRUCTION_FILES) {
    const filepath = path.join(directory, name)
    let stat
    try {
      const linkStat = fs.lstatSync(filepath)
      if (!linkStat.isFile() || linkStat.isSymbolicLink()) continue
      const canonical = fs.realpathSync(filepath)
      if (!isInside(root, canonical)) continue
      stat = fs.statSync(canonical)
    } catch { continue }
    if (!stat.isFile()) continue
    const key = `${filepath}:${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`
    const scopeKey = JSON.stringify([userId, filepath])
    const cached = cache.get(scopeKey)
    if (cached?.key === key) {
      remember(scopeKey, cached)
      return cached.value
    }
    const source = fs.readFileSync(filepath)
    const truncated = source.byteLength > MAX_INSTRUCTION_BYTES
    const content = source.subarray(0, MAX_INSTRUCTION_BYTES).toString('utf8').trim()
    if (!content) return null
    const value = { path: filepath, name, content, truncated }
    remember(scopeKey, { key, value })
    return value
  }
  return null
}

export function readWorkspaceInstructions({ userId = null, env = process.env, directory = null } = {}) {
  if (env.PROJECT_INSTRUCTIONS_ENABLED === '0' || env.WORKSPACE_FS_ENABLED !== '1') return null
  const root = workspaceRoot(env, userId)
  const found = instructionDirectories(root, directory)
    .map((candidate) => readInstructionAt(root, candidate, userId))
    .filter(Boolean)
  if (!found.length) return null

  const sections = []
  let usedBytes = 0
  let combinedTruncated = false
  for (const entry of found) {
    const header = `Source: ${path.relative(root, entry.path).replace(/\\/g, '/') || entry.name}`
    const remaining = Math.max(0, MAX_COMBINED_INSTRUCTION_BYTES - usedBytes)
    if (remaining === 0) { combinedTruncated = true; break }
    const source = Buffer.from(`${header}\n\n${entry.content}`, 'utf8')
    const selected = source.subarray(0, remaining).toString('utf8').trim()
    if (selected) sections.push(selected)
    usedBytes += Buffer.byteLength(selected, 'utf8')
    if (source.byteLength > remaining) { combinedTruncated = true; break }
  }
  const truncated = combinedTruncated || found.some((entry) => entry.truncated)
  return {
    path: found.at(-1).path,
    paths: found.map((entry) => entry.path),
    text: [
      '# Workspace Instructions',
      ...sections,
      ...(truncated ? ['[Workspace instructions truncated by the bounded context budget]'] : []),
    ].join('\n\n'),
    truncated,
  }
}

export function clearWorkspaceInstructionsCache() {
  cache.clear()
}
