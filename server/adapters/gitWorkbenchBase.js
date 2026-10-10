import { httpError as badReq } from './gitCommandRunner.js'

/**
 * Comparison-base handling for the Git workbench, in its own module so the
 * workbench file itself stays inside the runtime size budget.
 */

const GIT_BASE_RE = /^[A-Za-z0-9][A-Za-z0-9._/~^-]{0,119}$/u

/** A comparison base is a revision name, never an option or an arbitrary path. */
export function normalizeGitBase(rawBase) {
  const value = String(rawBase ?? '').trim()
  if (!value) return ''
  if (!GIT_BASE_RE.test(value)) throw badReq('invalid git comparison base')
  return value
}

/** `git diff --numstat` + `--name-status` → the same file shape status returns. */
export function parseNumstat(numstatText = '', nameStatusText = '') {
  const statusByPath = new Map()
  for (const line of String(nameStatusText).split('\n')) {
    const match = line.match(/^([A-Z])\s+(.+)$/u)
    if (match) statusByPath.set(match[2].trim(), match[1])
  }
  const files = []
  for (const line of String(numstatText).split('\n')) {
    const [added, removed, ...rest] = line.split('\t')
    const path = rest.join('\t').trim()
    if (!path) continue
    const additions = Number(added)
    const deletions = Number(removed)
    files.push({
      path,
      status: statusByPath.get(path) || 'M',
      additions: Number.isFinite(additions) ? additions : 0,
      deletions: Number.isFinite(deletions) ? deletions : 0,
    })
  }
  return files
}
