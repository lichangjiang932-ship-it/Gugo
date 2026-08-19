import fs from 'node:fs'
import path from 'node:path'

// Explicit agent instructions always win. README is a conservative fallback
// for repositories that have not adopted an agent-specific instruction file.
const INSTRUCTION_FILES = Object.freeze(['AGENTS.md', 'CLAUDE.md', 'README.md'])
const MAX_INSTRUCTION_BYTES = 64 * 1024
const cache = new Map()

function workspaceRoot(env) {
  return path.resolve(String(env.WORKSPACE_ROOT || process.cwd()))
}

export function readWorkspaceInstructions({ env = process.env } = {}) {
  if (env.PROJECT_INSTRUCTIONS_ENABLED === '0' || env.WORKSPACE_FS_ENABLED !== '1') return null
  const root = workspaceRoot(env)
  for (const name of INSTRUCTION_FILES) {
    const filepath = path.join(root, name)
    let stat
    try { stat = fs.statSync(filepath) } catch { continue }
    if (!stat.isFile()) continue
    const key = `${filepath}:${stat.mtimeMs}:${stat.size}`
    const cached = cache.get(filepath)
    if (cached?.key === key) return cached.value
    const source = fs.readFileSync(filepath)
    const truncated = source.byteLength > MAX_INSTRUCTION_BYTES
    const content = source.subarray(0, MAX_INSTRUCTION_BYTES).toString('utf8').trim()
    if (!content) return null
    const value = {
      path: filepath,
      text: [
        '# Workspace Instructions',
        `Source: ${name}`,
        content,
        ...(truncated ? ['[Workspace instructions truncated at 64 KB]'] : []),
      ].join('\n\n'),
      truncated,
    }
    cache.set(filepath, { key, value })
    return value
  }
  return null
}

export function clearWorkspaceInstructionsCache() {
  cache.clear()
}
