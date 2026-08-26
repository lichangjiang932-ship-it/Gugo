const PROGRESS_FIELDS = ['phase', 'completed', 'total', 'iteration', 'filesChanged', 'additions', 'deletions']

/**
 * Structured turn-progress projection (P2-9). Values come exclusively from
 * `turn.progress` events dispatched into message meta by turnEventDispatch;
 * nothing here parses markdown or free text.
 */
export function hasStructuredProgress(progress) {
  if (!progress || typeof progress !== 'object') return false
  return PROGRESS_FIELDS.some((key) => progress[key] !== undefined)
}
