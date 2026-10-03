import { normalizeVerifiedLocalFilePath } from './verifiedLocalFileIdentity.js'

/**
 * Reading a tool call: what it was asked to do, what it reported, and whether it
 * succeeded — plus the path and line-count rules every consumer of that evidence
 * has to share. Two features count the same conversation (the message rows and
 * the session change review); if they read calls differently, they disagree about
 * what the agent changed.
 *
 * Only executor-reported numbers are authoritative here: `validChangeStats` keeps
 * whatever the tool said per file, and nothing here infers a count from a path, a
 * file body, or prose.
 */
export const MUTATION_TOOL_NAMES = new Set([
  'apply_patch',
  'bash_exec',
  'edit_file',
  'multi_edit',
  'patch_file',
  'run_command',
  'write_file',
])

function parseObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function callName(call = {}) {
  return String(call?.name || call?.function?.name || '').trim()
}

export function callArguments(call = {}) {
  return parseObject(call?.args)
    || parseObject(call?.arguments)
    || parseObject(call?.function?.arguments)
    || {}
}

export function callResult(call = {}) {
  const result = parseObject(call?.result)
  if (!result) return null
  if (!result.path && !result.changes && typeof result.content === 'string') {
    return parseObject(result.content) || result
  }
  return result
}

export function callSucceeded(call, result) {
  const status = String(call?.status || '').trim().toLowerCase()
  if (['cancelled', 'error', 'failed'].includes(status)) return false
  return result?.ok !== false && !call?.error
}

export function isDryRunCall(call = {}, result = callResult(call)) {
  const args = callArguments(call)
  return args.dry_run === true || args.dryRun === true
    || result?.dry_run === true || result?.dryRun === true
}

export function absolutePath(value) {
  const path = String(value || '').trim()
  const key = normalizeVerifiedLocalFilePath(path)
  return key ? { key, path } : null
}

export function workspacePathResolver(workspacePath = '') {
  const root = String(workspacePath || '').trim().replace(/\\/g, '/').replace(/\/+$/, '')
  return (value) => {
    const raw = String(value || '').trim()
    if (!raw) return null
    const direct = absolutePath(raw)
    if (direct) return direct
    const relative = raw.replace(/\\/g, '/').replace(/^\.\//, '')
    if (!relative || relative.startsWith('..')) return null
    if (root) {
      const anchored = absolutePath(`${root}/${relative}`)
      if (anchored) return { ...anchored, relative }
    }
    return { key: `rel:${relative.toLowerCase()}`, path: relative }
  }
}


export function resultPaths(result = {}, resolve = absolutePath) {
  const values = [
    result.path,
    result.fullPath,
    result.outputPath,
    ...(Array.isArray(result.changedFiles) ? result.changedFiles : []),
    ...(Array.isArray(result.changedPaths) ? result.changedPaths : []),
    ...(Array.isArray(result.outputPaths) ? result.outputPaths : []),
    ...(Array.isArray(result.changes) ? result.changes.map((change) => change?.path) : []),
  ]
  const paths = new Map()
  for (const value of values) {
    const normalized = resolve(value)
    if (normalized) paths.set(normalized.key, normalized.path)
  }
  return paths
}

/**
 * How one conversation names a file.
 *
 * Tool results carry whatever form the tool found useful — an absolute path from
 * the executor, a workspace-relative one from a patch header. The verified-file
 * receipts deliberately accept only absolute paths; a review list cannot, or a
 * relative `src/app.js` would vanish from it. An absolute path is normalised as
 * always; a relative one is anchored to the project when the reader has one, and
 * otherwise kept as written.
 */

export function callId(call = {}) {
  return String(call?.id || call?.toolCallId || '').trim()
}

export function validChangeStats(result, resolve = absolutePath) {
  if (!Array.isArray(result?.changes)) return []
  const changes = []
  for (const change of result.changes) {
    if (!change || typeof change !== 'object' || Array.isArray(change)) continue
    const normalized = resolve(change.path)
    const additions = change.additions
    const deletions = change.deletions
    if (!normalized
      || !Number.isSafeInteger(additions)
      || additions < 0
      || !Number.isSafeInteger(deletions)
      || deletions < 0) continue
    changes.push({
      key: normalized.key,
      additions,
      deletions,
    })
  }
  return changes
}

/**
 * Executor-reported line counts for a single call, or null when the call did not
 * mutate files or the executor reported nothing.
 *
 * Shares `validChangeStats` with the per-turn aggregate below, so a step row and
 * the "N changed files" summary can never disagree: same source, same
 * validation, same refusal to infer counts the executor never reported.
 *
 * @returns {{additions: number, deletions: number}|null}
 */
