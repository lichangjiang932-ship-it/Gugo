import {
  experienceArchivePath,
  experienceJournalPath,
  nextExperienceSequence,
  normalizeExperienceEntry,
  parseExperienceJournal,
  readJournalFile,
  renderExperienceJournal,
  writeJournalFile,
} from './experienceJournal.js'
import { getProjectDirectory } from './localFileAccessService.js'
import { resolveForFileTool } from '../adapters/fsShellSupport.js'

/**
 * Read-modify-write access to a workspace's experience journal.
 *
 * The journal is a single file that a whole session appends to, so two turns
 * finishing at once would otherwise interleave: both read the same text, both
 * write, and one episode disappears. A per-file promise chain serializes the
 * append inside this process — the server runs as one process, so this is the
 * whole concurrency model, and a lock file would only add a stale-lock failure
 * mode for a guarantee this already provides.
 */
const appendChains = new Map()

export function withJournalLock(key, operation) {
  const previous = appendChains.get(key) || Promise.resolve()
  const next = previous.then(operation, operation)
  // Keep the chain alive even when this append fails, so one bad write does not
  // stall every later append to the same journal.
  appendChains.set(key, next.then(() => {}, () => {}))
  return next
}

/**
 * Resolve the journal path through the same authorization the file tools use, so
 * the journal can never be written somewhere the agent could not otherwise write.
 * Returns `{ path }` or `{ refused }` — never throws, because a refused journal
 * must not turn a completed task into a failed one.
 */
export function resolveJournalPath({ userId, workspaceRoot = '', file = 'journal' } = {}) {
  const root = String(workspaceRoot || '').trim() || getProjectDirectory({ userId })
  if (!root) return { refused: '当前没有可用的项目目录，无法记录经验' }
  const target = file === 'archive' ? experienceArchivePath(root) : experienceJournalPath(root)
  try {
    const resolved = resolveForFileTool(target, { userId, write: true, allowMissing: true })
    return { path: resolved.fullPath, root }
  } catch (error) {
    return {
      refused: `${error?.message || String(error)}${workspaceWriteDisabledHint()}`,
      code: error?.code || 'EXPERIENCE_PATH_REJECTED',
    }
  }
}

/**
 * The authorization layer reports a refused workspace write as "this path is not
 * authorized", which reads as advice to grant the directory — but while the
 * workspace feature is switched off, no grant can make it succeed. Naming the
 * flag is the difference between a user fixing it in one step and hunting for a
 * permission dialog that would not have helped.
 */
function workspaceWriteDisabledHint() {
  if (process.env.WORKSPACE_FS_ENABLED === '1') return ''
  return '（工作区文件写入当前未启用：需要设置 WORKSPACE_FS_ENABLED=1 并信任该工作区后才会记录经验）'
}

/**
 * Append one episode. Returns a result object rather than throwing: this runs at
 * the end of a task, where a bookkeeping failure must never look like the task
 * failed.
 */
export async function recordExperience({ userId = null, workspaceRoot = '', episode = {}, now = Date.now() } = {}) {
  if (!userId) return { ok: false, code: 'EXPERIENCE_NO_USER', error: '未登录，无法记录经验' }
  const resolved = resolveJournalPath({ userId, workspaceRoot })
  if (resolved.refused) return { ok: false, code: resolved.code, error: resolved.refused }

  return withJournalLock(resolved.path, () => {
    const existing = parseExperienceJournal(readJournalFile(resolved.path))
    const normalized = normalizeExperienceEntry(episode, {
      now,
      sequence: nextExperienceSequence(existing.entries, now),
    })
    if (!normalized.ok) return { ok: false, code: 'EXPERIENCE_INVALID', error: normalized.error }

    const entries = [...existing.entries, normalized.entry]
    writeJournalFile(resolved.path, renderExperienceJournal(entries))
    return {
      ok: true,
      entry: normalized.entry,
      journalPath: resolved.path,
      pendingCount: entries.filter((entry) => entry.status === 'pending').length,
      // Surface unreadable earlier lines instead of pretending the journal is
      // short: the caller can then tell a human rather than silently learn from
      // a truncated history.
      ...(existing.problems.length > 0 ? { problems: existing.problems } : {}),
    }
  })
}

export function readExperienceJournal({ userId = null, workspaceRoot = '' } = {}) {
  if (!userId) return { ok: false, code: 'EXPERIENCE_NO_USER', error: '未登录', entries: [], problems: [] }
  const resolved = resolveJournalPath({ userId, workspaceRoot })
  if (resolved.refused) return { ok: false, code: resolved.code, error: resolved.refused, entries: [], problems: [] }
  const parsed = parseExperienceJournal(readJournalFile(resolved.path))
  return { ok: true, ...parsed, journalPath: resolved.path, root: resolved.root }
}

/**
 * Move the given entries out of the journal and into the archive beside it. The
 * journal is meant to stay small enough to read in one model call; the archive is
 * where the evidence trail lives on, so nothing is ever deleted.
 */
export async function archiveExperienceEntries({ userId = null, workspaceRoot = '', entryIds = [] } = {}) {
  if (!userId) return { ok: false, code: 'EXPERIENCE_NO_USER', error: '未登录' }
  const ids = new Set((Array.isArray(entryIds) ? entryIds : []).map((id) => String(id)))
  if (ids.size === 0) return { ok: false, code: 'EXPERIENCE_NOTHING_TO_ARCHIVE', error: '没有要归档的条目' }
  const resolved = resolveJournalPath({ userId, workspaceRoot })
  if (resolved.refused) return { ok: false, code: resolved.code, error: resolved.refused }

  return withJournalLock(resolved.path, () => {
    const journal = parseExperienceJournal(readJournalFile(resolved.path))
    const archived = journal.entries.filter((entry) => ids.has(entry.id))
    if (archived.length === 0) return { ok: false, code: 'EXPERIENCE_NOTHING_TO_ARCHIVE', error: '这些条目不在日志里' }

    // Resolve the archive target BEFORE removing anything from the journal:
    // "nothing is ever deleted" only holds if a refused archive path cannot
    // leave an entry that is neither in the journal nor in the archive.
    const archive = resolveJournalPath({ userId, workspaceRoot, file: 'archive' })
    if (archive.refused) {
      return { ok: false, code: 'EXPERIENCE_ARCHIVE_REFUSED', error: archive.refused, archived: [], remaining: journal.entries.length }
    }

    const remaining = journal.entries.filter((entry) => !ids.has(entry.id))
    const digested = archived.map((entry) => ({ ...entry, status: 'digested' }))
    writeJournalFile(resolved.path, renderExperienceJournal(remaining))

    const existingArchive = parseExperienceJournal(readJournalFile(archive.path))
    writeJournalFile(archive.path, renderExperienceJournal([...existingArchive.entries, ...digested]))

    return { ok: true, archived: digested.map((entry) => entry.id), remaining: remaining.length, archivePath: archive.path }
  })
}
