/**
 * Name/path matching helpers shared by the code-search tools and `find_files`.
 *
 * Pure (or near-pure) so they can live apart from the ripgrep invocation and
 * the workspace path-safety logic in codeSearch.js: glob→regex conversion,
 * filename/file-type filtering, and the no-ripgrep directory walker. Keeping
 * these here means `grep_code`'s fallback and `find_files` match names with
 * identical semantics whether or not ripgrep is available.
 */
import fs from 'node:fs'
import path from 'node:path'

export const EXCLUDED_DIRS = new Set(['.git', 'node_modules', 'dist', '.next', 'build', 'server-data'])

export const TYPE_EXTENSIONS = {
  js: ['.js', '.jsx', '.mjs', '.cjs'],
  jsx: ['.jsx'],
  ts: ['.ts', '.tsx'],
  tsx: ['.tsx'],
  py: ['.py'],
  rs: ['.rs'],
  md: ['.md', '.mdx'],
  json: ['.json'],
  css: ['.css'],
  html: ['.html', '.htm'],
}

export function walkFiles(root, out = []) {
  let entries
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry.name)) walkFiles(path.join(root, entry.name), out)
    } else if (entry.isFile()) {
      out.push(path.join(root, entry.name))
    }
  }
  return out
}

export function globToRegex(glob) {
  const escaped = String(glob)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    // `**/` matches zero or more whole directories (so `src/**\/*.py` covers
    // `src/pay.py` as well as `src/a/b/pay.py`); a bare `**` still spans any run
    // of characters. Handled before single `*` so the two never cross.
    .replace(/\*\*\//g, '\u0001')
    .replace(/\*\*/g, '\u0002')
    .replace(/\*/g, '[^/\\\\]*')
    .replace(/\?/g, '[^/\\\\]')
    .split('\u0001').join('(?:.*/)?')
    .split('\u0002').join('.*')
  return new RegExp(`^${escaped}$`)
}

export function matchesGlob(rel, glob) {
  if (!glob) return true
  const normalized = rel.replace(/\\/g, '/')
  const base = path.basename(rel)
  const re = globToRegex(String(glob).replace(/\\/g, '/'))
  return re.test(normalized) || re.test(base)
}

export function matchesFileType(file, fileType) {
  if (!fileType) return true
  const ext = path.extname(file).toLowerCase()
  const allowed = TYPE_EXTENSIONS[String(fileType).toLowerCase()]
  return allowed ? allowed.includes(ext) : ext === `.${String(fileType).toLowerCase()}`
}

export function buildSearchRegex(pattern, { caseSensitive = false, word = false } = {}) {
  const source = word ? `\\b(?:${pattern})\\b` : pattern
  return new RegExp(source, caseSensitive ? '' : 'i')
}
