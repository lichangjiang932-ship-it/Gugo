/**
 * Pure helpers for the diff review panel: comparison labels and the defensive
 * reading of git status payloads. Kept out of the components so the panel files
 * only export components (the repo's fast-refresh rule) and so these are
 * directly unit-testable.
 */

/** The three comparison targets, in the order the reference lists them. */
export const COMPARE_MODES = Object.freeze(['all', 'uncommitted', 'branch'])

export function compareLabel(target = {}, t) {
  if (target.mode === 'all') return t('diffReview.allChanges')
  if (target.mode === 'branch') return `${t('diffReview.compareAgainst')} ${target.branch || ''}`.trim()
  return `${target.branch || 'main'} ▸ ${t('diffReview.workingTree')}`
}

/** Git status entries arrive in a few shapes; take what is there. */
export function normalizeChangedFile(entry = {}) {
  const path = String(entry.path || entry.file || entry.name || '').trim()
  const stat = entry.stats || entry
  return {
    path,
    status: String(entry.status || entry.state || 'M').trim().slice(0, 2) || 'M',
    additions: Number(stat.additions ?? stat.added ?? 0) || 0,
    deletions: Number(stat.deletions ?? stat.removed ?? 0) || 0,
  }
}

export function filesFromStatusPayload(payload) {
  const list = Array.isArray(payload) ? payload
    : Array.isArray(payload?.files) ? payload.files
      : Array.isArray(payload?.changes) ? payload.changes
        : []
  return list.map(normalizeChangedFile).filter((file) => file.path && !file.path.endsWith('/'))
}

/** Diff payloads arrive as `{diff}`, `{patch}`, `{text}` or a bare string. */
export function diffTextFromPayload(payload) {
  if (typeof payload === 'string') return payload
  for (const key of ['diff', 'patch', 'text', 'content']) {
    if (typeof payload?.[key] === 'string') return payload[key]
  }
  return ''
}

const SPECIAL_SEGMENTS = new Set(['test', 'tests', '__tests__', 'dist', 'build', 'generated', 'snapshots'])

/** Test/build/generated files, which the menu can list separately. */
export function isSpecialFile(path = '') {
  const value = String(path)
  const segments = value.split('/')
  if (segments.some((segment) => SPECIAL_SEGMENTS.has(segment))) return true
  // A spec/test suffix is a test file even when it sits beside the source.
  if (/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(value)) return true
  return /\.(?:min|bundle|chunk)\.[cm]?js$/u.test(value)
}

/** Long names keep both ends, so `interval-overlap-repair` stays recognisable. */
export function truncateMiddle(text, max = 26) {
  const value = String(text ?? '')
  if (value.length <= max || max < 5) return value
  const head = Math.ceil((max - 1) * 0.6)
  const tail = Math.floor((max - 1) * 0.4)
  return `${value.slice(0, head)}…${value.slice(value.length - tail)}`
}

/**
 * Files grouped the way the reference groups them: folders first, then names,
 * with the option to pull test/build/generated files into their own list.
 */
export function buildFileTree(files = [], { groupByFolder = true, separateSpecial = false } = {}) {
  const all = Array.isArray(files) ? files.filter((file) => file?.path) : []
  const special = separateSpecial ? all.filter((file) => isSpecialFile(file.path)) : []
  const specialPaths = new Set(special.map((file) => file.path))
  const rest = all.filter((file) => !specialPaths.has(file.path))
  if (!groupByFolder) {
    const nodes = [...rest]
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((file) => ({ type: 'file', name: file.path.split('/').pop() || file.path, path: file.path, file }))
    return { nodes, special }
  }
  const root = { children: new Map() }
  for (const file of rest) {
    const segments = file.path.split('/')
    let node = root
    segments.forEach((segment, index) => {
      const last = index === segments.length - 1
      if (!node.children.has(segment)) {
        node.children.set(segment, last
          ? { type: 'file', name: segment, path: file.path, file }
          : { type: 'dir', name: segment, path: segments.slice(0, index + 1).join('/'), children: new Map() })
      }
      node = node.children.get(segment)
    })
  }
  const toNodes = (node) => [...node.children.values()]
    .map((child) => (child.type === 'dir' ? { ...child, children: toNodes(child) } : child))
    .sort((left, right) => (left.type === right.type
      ? left.name.localeCompare(right.name)
      : left.type === 'dir' ? -1 : 1))
  return { nodes: toNodes(root), special }
}
