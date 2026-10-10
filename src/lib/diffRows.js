/**
 * Unified diff → structured rows for the review panel.
 *
 * Pure functions only: no DOM, no fs. The panel renders what these return, the
 * tests drive them directly, and the Git workbench can reuse them.
 *
 * Line numbers are display data. A session-mode diff comes from the recorded
 * edits, which may have drifted from what is on disk, so a comment sent back to
 * the agent carries the path and the code line as well as the number.
 */

/** Split a `git diff` blob into one entry per file. */
export function splitDiffFiles(raw = '') {
  const text = String(raw || '')
  const files = []
  let current = null
  let sawHunk = false
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      if (current) files.push(current)
      const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/u)
      current = { path: match ? match[2] : '', header: [line], body: [] }
      sawHunk = false
      continue
    }
    if (!current) continue
    if (line.startsWith('@@')) {
      sawHunk = true
      current.body.push(line)
      continue
    }
    if (!sawHunk) {
      // Before the first hunk: `new file mode`, index, ---/+++ lines.
      current.header.push(line)
      const plus = line.match(/^\+\+\+ b\/(.+)$/u)
      if (plus) current.path = plus[1]
      continue
    }
    current.body.push(line)
  }
  if (current) files.push(current)
  return files
    .filter((file) => file.path && file.path !== '/dev/null' && file.body.some((line) => line.startsWith('@@')))
    .map((file) => ({ path: file.path, header: file.header, body: file.body }))
}

/** Hunks with their own line counters: `{ oldStart, newStart, lines[] }`. */
export function parseHunks(body = []) {
  const hunks = []
  let hunk = null
  for (const line of body) {
    const header = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u)
    if (header) {
      hunk = { oldStart: Number(header[1]), newStart: Number(header[2]), lines: [] }
      hunks.push(hunk)
      continue
    }
    if (!hunk) continue
    if (line.startsWith('\\')) continue // "\ No newline at end of file"
    // A blob may hold several files: the next file's header lines are not content.
    if (line.startsWith('diff --git ')) { hunk = null; continue }
    if (/^(?:---|\+\+\+) [ab]\//u.test(line)) continue
    hunk.lines.push(line)
  }
  return hunks
}

function filler() {
  return { oldNumber: null, oldText: '', newNumber: null, newText: '', kind: 'filler' }
}

/**
 * Pair a hunk into side-by-side rows: the old side keeps the line numbers the
 * removal had, the new side the numbers the addition has, and a run that is
 * longer on one side is padded so both columns stay aligned.
 */
export function toSideBySide(hunks = []) {
  const rows = []
  for (const hunk of hunks) {
    let oldNumber = hunk.oldStart
    let newNumber = hunk.newStart
    let index = 0
    while (index < hunk.lines.length) {
      const line = hunk.lines[index]
      if (line.startsWith('-')) {
        const removed = []
        while (index < hunk.lines.length && hunk.lines[index].startsWith('-')) {
          removed.push({ number: oldNumber, text: hunk.lines[index].slice(1) })
          oldNumber += 1
          index += 1
        }
        const added = []
        while (index < hunk.lines.length && hunk.lines[index].startsWith('+')) {
          added.push({ number: newNumber, text: hunk.lines[index].slice(1) })
          newNumber += 1
          index += 1
        }
        const length = Math.max(removed.length, added.length)
        for (let offset = 0; offset < length; offset += 1) {
          const left = removed[offset]
          const right = added[offset]
          rows.push({
            oldNumber: left ? left.number : null,
            oldText: left ? left.text : '',
            newNumber: right ? right.number : null,
            newText: right ? right.text : '',
            kind: left && right ? 'changed' : left ? 'removed' : 'added',
          })
        }
        continue
      }
      if (line.startsWith('+')) {
        rows.push({ oldNumber: null, oldText: '', newNumber, newText: line.slice(1), kind: 'added' })
        newNumber += 1
        index += 1
        continue
      }
      const text = line.startsWith(' ') ? line.slice(1) : line
      rows.push({ oldNumber, oldText: text, newNumber, newText: text, kind: 'context' })
      oldNumber += 1
      newNumber += 1
      index += 1
    }
    rows.push(filler())
  }
  return rows
}

export function countDiffRows(rows = []) {
  let additions = 0
  let deletions = 0
  for (const row of rows) {
    if (row.kind === 'added' || (row.kind === 'changed' && !row.oldNumber)) additions += 1
    else if (row.kind === 'changed') additions += 1
    if (row.kind === 'removed' || row.kind === 'changed') deletions += 1
  }
  return { additions, deletions }
}

const WORD_LIMIT = 300

function tokenize(text) {
  return String(text || '').split(/(\s+)/u).filter((token) => token !== '')
}

/**
 * Word-level marks for a changed row: which tokens differ between the two
 * sides. Long lines skip the comparison rather than pay a quadratic cost on a
 * minified file.
 */
export function highlightChangedWords(oldText, newText) {
  const before = tokenize(oldText)
  const after = tokenize(newText)
  if (before.length > WORD_LIMIT || after.length > WORD_LIMIT) {
    return {
      oldParts: [{ text: String(oldText || ''), changed: true }],
      newParts: [{ text: String(newText || ''), changed: true }],
    }
  }
  // Longest common subsequence over tokens, computed on a compact table.
  const lengths = Array.from({ length: before.length + 1 }, () => new Uint16Array(after.length + 1))
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      lengths[i][j] = before[i] === after[j]
        ? lengths[i + 1][j + 1] + 1
        : Math.max(lengths[i + 1][j], lengths[i][j + 1])
    }
  }
  const oldParts = []
  const newParts = []
  const push = (list, text, changed) => {
    const last = list[list.length - 1]
    if (last && last.changed === changed) last.text += text
    else list.push({ text, changed })
  }
  let i = 0
  let j = 0
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      push(oldParts, before[i], false)
      push(newParts, after[j], false)
      i += 1
      j += 1
    } else if (lengths[i + 1][j] >= lengths[i][j + 1]) {
      push(oldParts, before[i], true)
      i += 1
    } else {
      push(newParts, after[j], true)
      j += 1
    }
  }
  while (i < before.length) { push(oldParts, before[i], true); i += 1 }
  while (j < after.length) { push(newParts, after[j], true); j += 1 }
  return { oldParts, newParts }
}

/** Everything the panel needs for one file, from its diff text. */
export function buildFileDiff(diffText = '') {
  const hunks = parseHunks(String(diffText || '').split('\n'))
  const rows = toSideBySide(hunks)
  return { hunks: hunks.length, rows, ...countDiffRows(rows) }
}
