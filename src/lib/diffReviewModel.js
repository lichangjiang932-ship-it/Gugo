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
