import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, normalize, relative, resolve } from 'node:path'

export class TestSelectorUsageError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'TestSelectorUsageError'
    this.code = code
    this.exitCode = 2
  }
}

function selectionError(code, message, file = '') {
  return new TestSelectorUsageError(code, `${message}${file ? `: ${JSON.stringify(String(file).slice(0, 1000))}` : ''}`)
}

/** Resolve every input before running any of them. Node must receive files, never globs. */
export function validateSelectedTestFiles(files, { cwd = process.cwd(), platform = process.platform } = {}) {
  if (!Array.isArray(files) || files.length === 0) {
    throw selectionError('TEST_SELECTOR_EMPTY', 'No test files were selected; refusing to report PASS for an empty selection')
  }
  const selected = []
  const identities = new Set()
  const canonicalCwd = realpathSync.native(cwd)
  for (const raw of files) {
    const file = typeof raw === 'string' ? raw.replaceAll('\\', '/') : ''
    if (!file || /\p{Cc}/u.test(file)) throw selectionError('TEST_SELECTOR_INVALID', 'Test selectors must be non-empty file paths', file)
    if (/[*?[\]{}]|[!+@]\(/u.test(file)) {
      throw selectionError('TEST_SELECTOR_PATTERN_UNSUPPORTED', 'Glob selectors are unsupported; pass explicit test files (or omit selectors for the full suite)', file)
    }
    const absolute = resolve(cwd, file)
    let stats
    let canonical
    try {
      stats = statSync(absolute, { bigint: true })
      canonical = realpathSync.native(absolute)
    } catch {
      throw selectionError('TEST_SELECTOR_NOT_FOUND', 'Selected test file does not exist or is unreadable', file)
    }
    if (!stats.isFile()) {
      throw selectionError('TEST_SELECTOR_NOT_FILE', 'Directory selectors are unsupported; pass explicit test files', file)
    }
    const canonicalPath = normalize(canonical)
    const identity = stats.ino !== 0n ? `${stats.dev}:${stats.ino}`
      : (platform === 'win32' ? canonicalPath.toLowerCase() : canonicalPath)
    if (identities.has(identity)) continue
    identities.add(identity)
    const local = relative(canonicalCwd, canonicalPath)
    // Preserve repository-relative paths for the native-transform lane allowlist.
    selected.push(!isAbsolute(local) && local !== '..' && !local.startsWith(`..${platform === 'win32' ? '\\' : '/'}`)
      ? normalize(local) : canonicalPath)
  }
  if (selected.length === 0) throw selectionError('TEST_SELECTOR_EMPTY', 'No executable test files remain after resolving selectors')
  return selected
}
