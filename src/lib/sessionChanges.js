import {
  MUTATION_TOOL_NAMES,
  callArguments,
  callId,
  callName,
  callResult,
  callSucceeded,
  isDryRunCall,
  resultPaths,
  validChangeStats,
  workspacePathResolver,
} from './toolCallMutationEvidence.js'

function* uniqueMutationCalls(messages, resolvePath) {
  const countedCalls = new Set()
  const rows = Array.isArray(messages) ? messages : []
  for (const [messageIndex, message] of rows.entries()) {
    const calls = Array.isArray(message?.meta?.toolCalls) ? message.meta.toolCalls : []
    const scope = String(message?.meta?.serverTurnId || message?.id || `message-${messageIndex}`)
    for (const call of calls) {
      const name = callName(call)
      const result = callResult(call)
      if (!MUTATION_TOOL_NAMES.has(name) || !result || !callSucceeded(call, result)
        || isDryRunCall(call, result)) continue
      const paths = resultPaths(result, resolvePath)
      if (!paths.size) continue
      const id = callId(call)
      // Live SSE replay is sequence-fenced and the reducer merges IDs. Keep a
      // per-turn guard for duplicate restored records without conflating a
      // provider ID reused in a later turn.
      const dedupeKey = id ? `${scope}\u0000${id}` : ''
      if (dedupeKey && countedCalls.has(dedupeKey)) continue
      if (dedupeKey) countedCalls.add(dedupeKey)
      yield { name, result, args: callArguments(call), id, paths }
    }
  }
}

function workspaceRelativePath(path, workspacePath) {
  const root = String(workspacePath || '').replace(/\\/g, '/').replace(/\/+$/, '')
  const value = String(path || '')
  if (!root) return value
  const normalized = value.replace(/\\/g, '/')
  if (normalized.toLowerCase() === root.toLowerCase()) return normalized.split('/').pop() || normalized
  if (!normalized.toLowerCase().startsWith(`${root.toLowerCase()}/`)) return value
  return normalized.slice(root.length + 1)
}

/**
 * Every file this conversation's tool calls actually changed, in the order the
 * agent first touched it.
 *
 * The header indicator and the review panel are a reading of the same evidence
 * the message rows already show, not a second opinion: only counts the executor
 * reported per file (never inferred from a path or a file body), only calls that
 * succeeded, dry runs excluded, and one call counted once even when the
 * transcript replays it.
 */
export function sessionFileChanges(messages = [], { workspacePath = '' } = {}) {
  const files = new Map()
  const resolvePath = workspacePathResolver(workspacePath)
  for (const { name, result, id, paths } of uniqueMutationCalls(messages, resolvePath)) {
    const changes = new Map(validChangeStats(result, resolvePath).map((change) => [change.key, change]))
    for (const [key, path] of paths) {
      const entry = files.get(key)
        || { key, path, reported: null, toolNames: [], toolCallIds: [] }
      const change = changes.get(key)
      if (change) {
        entry.reported = entry.reported || { additions: 0, deletions: 0 }
        entry.reported.additions += change.additions
        entry.reported.deletions += change.deletions
      }
      if (name && !entry.toolNames.includes(name)) entry.toolNames.push(name)
      if (id && !entry.toolCallIds.includes(id)) entry.toolCallIds.push(id)
      files.set(key, entry)
    }
  }
  const entries = [...files.values()].map((entry) => ({
    ...entry,
    displayPath: workspaceRelativePath(entry.path, workspacePath),
  }))
  // Totals count only what the executor reported: a number the panel derives
  // from a recorded edit afterwards must not be presented here as a receipt.
  const reported = entries.filter((entry) => entry.reported)
  return {
    files: entries,
    totals: {
      files: entries.length,
      reportedFiles: reported.length,
      additions: reported.reduce((total, entry) => total + entry.reported.additions, 0),
      deletions: reported.reduce((total, entry) => total + entry.reported.deletions, 0),
    },
  }
}

/** Lines an edit will draw, for files whose executor reported no counts. */
export function countRecordedEditLines(edits = []) {
  return (Array.isArray(edits) ? edits : []).reduce((totals, edit) => {
    const lines = interleaveEditLines(edit)
    return {
      additions: totals.additions + lines.filter((line) => line.sign === '+').length,
      deletions: totals.deletions + lines.filter((line) => line.sign === '-').length,
    }
  }, { additions: 0, deletions: 0 })
}

/** Above this many lines on either side the table would be too large; fall back. */
const MAX_DIFF_CELLS = 250_000

/**
 * One edit as a reader expects to see it: a replacement of twenty lines in which
 * one changed is one `-` and one `+` between unchanged context, not twenty of
 * each. Longest-common-subsequence over lines; a pathological size falls back
 * to "all removed, then all added", which is still correct, only less compact.
 */
export function interleaveEditLines(edit) {
  if (Array.isArray(edit?.lines) && edit.lines.length > 0) return edit.lines
  const removed = Array.isArray(edit?.removed) ? edit.removed : []
  const added = Array.isArray(edit?.added) ? edit.added : []
  if (removed.length === 0 || added.length === 0
    || (removed.length + 1) * (added.length + 1) > MAX_DIFF_CELLS) {
    return [
      ...removed.map((line) => ({ sign: '-', line })),
      ...added.map((line) => ({ sign: '+', line })),
    ]
  }
  const rows = removed.length + 1
  const cols = added.length + 1
  const table = new Uint32Array(rows * cols)
  for (let i = removed.length - 1; i >= 0; i -= 1) {
    for (let j = added.length - 1; j >= 0; j -= 1) {
      table[i * cols + j] = removed[i] === added[j]
        ? table[(i + 1) * cols + j + 1] + 1
        : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1])
    }
  }
  const lines = []
  let i = 0
  let j = 0
  while (i < removed.length && j < added.length) {
    if (removed[i] === added[j]) { lines.push({ sign: ' ', line: removed[i] }); i += 1; j += 1 }
    else if (table[(i + 1) * cols + j] >= table[i * cols + j + 1]) { lines.push({ sign: '-', line: removed[i] }); i += 1 }
    else { lines.push({ sign: '+', line: added[j] }); j += 1 }
  }
  while (i < removed.length) { lines.push({ sign: '-', line: removed[i] }); i += 1 }
  while (j < added.length) { lines.push({ sign: '+', line: added[j] }); j += 1 }
  return lines
}

const MAX_RECORDED_LINES = 400

function textLines(value) {
  const text = String(value ?? '')
  if (!text) return []
  return text.replace(/\r\n/g, '\n').split('\n').slice(0, MAX_RECORDED_LINES)
}

/** Each file's section of a patch, as the diff the agent asked for. */
function patchSections(patch) {
  const lines = textLines(patch)
  const sections = []
  let current = null
  for (const line of lines) {
    const header = line.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/)
    if (header) {
      current = { path: header[1].trim(), lines: [] }
      sections.push(current)
      continue
    }
    if (current && !line.startsWith('*** ')) current.lines.push(line)
  }
  return sections.map((section) => ({
    path: section.path,
    removed: section.lines.filter((line) => line.startsWith('-')).map((line) => line.slice(1)),
    added: section.lines.filter((line) => line.startsWith('+')).map((line) => line.slice(1)),
    // The patch's own order, with its context lines: already the diff a reader
    // wants, so it is drawn as written rather than recomputed.
    lines: section.lines
      .filter((line) => /^[ +-]/.test(line))
      .map((line) => ({ sign: line[0], line: line.slice(1) })),
  }))
}

/**
 * What the agent actually did to one file in this conversation, from the calls
 * that did it. This is the review's evidence: prose is never read, and a file
 * touched only by a script shows its counts without inventing an edit.
 */
export function sessionFileEditIndex(messages = [], { workspacePath = '' } = {}) {
  const index = new Map()
  const resolvePath = workspacePathResolver(workspacePath)
  const push = (pathKey, edit) => {
    const edits = index.get(pathKey) || []
    edits.push(edit)
    index.set(pathKey, edits)
  }
  for (const { name, args, paths } of uniqueMutationCalls(messages, resolvePath)) {
    const record = (edit) => { for (const pathKey of paths.keys()) push(pathKey, edit) }
    if (['edit_file', 'patch_file'].includes(name) && typeof args.old_string === 'string') {
      record({ toolName: name, kind: 'replace', removed: textLines(args.old_string), added: textLines(args.new_string) })
      continue
    }
    if (name === 'multi_edit' && Array.isArray(args.edits)) {
      for (const edit of args.edits) {
        record({
          toolName: name,
          kind: 'replace',
          removed: textLines(edit?.old_string),
          added: textLines(edit?.new_string),
        })
      }
      continue
    }
    if (['apply_patch', 'patch_file'].includes(name) && typeof args.patch === 'string') {
      // A patch names its own files, so each section is filed under the path it
      // edits rather than under every path the call reported.
      const sections = patchSections(args.patch)
      for (const section of sections) {
        const pathKey = resolvePath(section.path)?.key
        if (pathKey) push(pathKey, { toolName: name, kind: 'patch', removed: section.removed, added: section.added, lines: section.lines })
      }
      continue
    }
    if (name === 'write_file' && typeof args.content === 'string') {
      record({ toolName: name, kind: 'write', removed: [], added: textLines(args.content) })
    }
  }
  return index
}

