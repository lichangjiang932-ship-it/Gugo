/**
 * The workbench terminal's scrollback, bounded.
 *
 * A command console in a long session appends forever: every run prefixed its
 * output onto one string, so the transcript grew without limit and React had to
 * re-render all of it on every keystroke-length update. It was also lossy in the
 * other direction — stdout and stderr were concatenated into the same blob, so a
 * failure read as one more paragraph of output.
 *
 * So the transcript is a list of typed entries, trimmed to a budget that keeps
 * what a reader actually needs after a long session: the command at the top (what
 * was asked) and the most recent output (what happened). What is dropped is the
 * middle, and the count is reported rather than hidden — a silently shortened
 * transcript would look like a complete one.
 */
export const TERMINAL_STREAM = Object.freeze({
  COMMAND: 'command',
  STDOUT: 'stdout',
  STDERR: 'stderr',
  ERROR: 'error',
  NOTICE: 'notice',
})

export const TERMINAL_LIMITS = Object.freeze({ maxEntries: 200, maxChars: 40_000 })

/** Entries that must survive trimming: the first is the reader's own request. */
const KEEP_HEAD_ENTRIES = 1
const KEEP_TAIL_ENTRIES = 40

function textLength(entry) {
  return String(entry?.text || '').length
}

function totalChars(entries) {
  return entries.reduce((sum, entry) => sum + textLength(entry), 0)
}

/**
 * Drop entries from the middle until the transcript fits: the head (the command
 * that started this stretch of work) and the tail (the newest output).
 *
 * Trimming by characters alone is not enough — a single enormous command output
 * would still be one entry — so the newest entry is clipped as a last resort,
 * keeping its tail, which is where an error message is.
 */
export function trimTerminalEntries(entries, limits = TERMINAL_LIMITS) {
  const { maxEntries, maxChars } = limits
  let list = Array.isArray(entries) ? [...entries] : []
  let dropped = 0

  while (list.length > maxEntries) {
    const removable = list.length - KEEP_HEAD_ENTRIES - KEEP_TAIL_ENTRIES
    if (removable <= 0) break
    list.splice(KEEP_HEAD_ENTRIES, 1)
    dropped += 1
  }

  while (totalChars(list) > maxChars && list.length > KEEP_HEAD_ENTRIES + 1) {
    list.splice(KEEP_HEAD_ENTRIES, 1)
    dropped += 1
  }

  const overflow = totalChars(list) - maxChars
  if (overflow > 0 && list.length > 0) {
    const lastIndex = list.length - 1
    const last = list[lastIndex]
    const text = String(last.text || '')
    if (text.length > overflow) {
      list[lastIndex] = { ...last, text: text.slice(overflow), clipped: true }
    }
  }
  return { dropped, entries: list }
}

export function createTerminalTranscript() {
  return { entries: [], dropped: 0, nextId: 1 }
}

/**
 * Append one entry and trim. Pure: the caller owns the returned transcript, so
 * the same append can be replayed in a test without a DOM.
 */
export function appendTerminalEntry(transcript, entry, limits = TERMINAL_LIMITS) {
  const current = transcript && typeof transcript === 'object' ? transcript : createTerminalTranscript()
  const entries = Array.isArray(current.entries) ? current.entries : []
  const nextId = Number(current.nextId) || entries.length + 1
  const appended = {
    id: nextId,
    stream: entry?.stream || TERMINAL_STREAM.STDOUT,
    text: String(entry?.text ?? ''),
  }
  const trimmed = trimTerminalEntries([...entries, appended], limits)
  return {
    entries: trimmed.entries,
    // Accumulated across appends: the reader is told how much of the session is no
    // longer on screen, not just how much this one append removed.
    dropped: (Number(current.dropped) || 0) + trimmed.dropped,
    nextId: nextId + 1,
  }
}
