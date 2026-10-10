/**
 * The conversation's own file changes, published for whoever wants them.
 *
 * The review data is computed on the chat side; the diff panel lives in the
 * workbench, several components away. Threading it through every layer would
 * touch five files for one value, so the producer publishes here and the panel
 * subscribes — one small module instead of a prop relay, and just as testable.
 */
const listeners = new Set()

let state = Object.freeze({ files: [], diffs: {}, revision: 0 })

export function readSessionChanges() {
  return state
}

function sameFiles(left = [], right = []) {
  if (left.length !== right.length) return false
  return left.every((file, index) => {
    const other = right[index]
    return other && file.path === other.path
      && file.additions === other.additions
      && file.deletions === other.deletions
  })
}

/**
 * `files` use the shape the panel already understands (path + counts) and
 * `diffs` maps a path to unified-diff text, so the session view needs no git.
 * Publishing the same content twice is not a new revision — otherwise every
 * render would look like a fresh change and pop the refresh notice.
 */
export function publishSessionChanges({ files = [], diffs = {} } = {}) {
  const nextFiles = Array.isArray(files) ? files : []
  const nextDiffs = diffs && typeof diffs === 'object' ? diffs : {}
  const unchanged = sameFiles(nextFiles, state.files)
    && Object.keys(nextDiffs).length === Object.keys(state.diffs).length
  state = Object.freeze({
    files: nextFiles,
    diffs: nextDiffs,
    revision: unchanged ? state.revision : state.revision + 1,
  })
  for (const listener of listeners) listener(state)
  return state
}

export function subscribeSessionChanges(listener) {
  listeners.add(listener)
  listener(state)
  return () => listeners.delete(listener)
}

export function resetSessionChangesForTests() {
  state = Object.freeze({ files: [], diffs: {}, revision: 0 })
  listeners.clear()
}

/**
 * Unified-diff text from the recorded edits of one file, so the panel's parser
 * can render a conversation change with the same code path as a git change.
 * Line numbers are positional within the recorded edit, not file offsets.
 */
export function diffTextFromEdits(edits = []) {
  const lines = []
  let ordinal = 0
  for (const edit of Array.isArray(edits) ? edits : []) {
    const removed = Array.isArray(edit?.removed) ? edit.removed : []
    const added = Array.isArray(edit?.added) ? edit.added : []
    if (removed.length === 0 && added.length === 0) continue
    ordinal += 1
    lines.push(`@@ -${ordinal} +${ordinal} @@`)
    for (const line of removed) lines.push(`-${line}`)
    for (const line of added) lines.push(`+${line}`)
  }
  return lines.length > 0 ? `${lines.join('\n')}\n` : ''
}
