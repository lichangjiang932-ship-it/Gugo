/**
 * The episodic journal: what was attempted, what blocked it, what fixed it.
 *
 * This is the raw layer of the experience pipeline. It is deliberately dumb and
 * append-only — one entry per episode, never edited by the agent — because the
 * value of a journal is that it is a record, not a summary. Abstraction reads it
 * and writes the distilled results elsewhere; the journal itself only grows and
 * is later archived.
 *
 * The file is the source of truth and lives in the workspace (`.agent/`), so it
 * is human-readable, hand-editable, git-versionable, and survives a crash. No
 * derived index is authoritative for it, which is why nothing here is cached:
 * re-reading a small markdown file is cheaper than invalidating a cache wrongly.
 *
 * Format (front-matter for the machine, three labelled fields for the reader):
 *
 *   ---
 *   id: exp-20260924-001
 *   when: 2026-09-24T09:12:04.000Z
 *   topic: sidebar-browser
 *   scope: project
 *   status: pending
 *   evidence: turn-abc;src/components/EmbeddedBrowser.jsx
 *   ---
 *   goal: 让侧栏浏览器能打开禁止嵌入的站点
 *   blocker: iframe 被 X-Frame-Options 拒绝且不触发任何事件，看上去像产品坏了
 *   solution: 桌面端改用 WebContentsView 宿主视图，web 端保留 iframe 并明说限制
 */
import fs from 'node:fs'
import path from 'node:path'

export const EXPERIENCE_DIR = '.agent'
export const EXPERIENCE_FILE = 'experience.md'
export const EXPERIENCE_ARCHIVE_FILE = 'experience.archive.md'

export const EXPERIENCE_SCOPES = Object.freeze(['user', 'project'])
export const EXPERIENCE_STATUSES = Object.freeze(['pending', 'digested'])

const MAX_TOPIC = 64
const MAX_FIELD = 2000
const MAX_EVIDENCE = 400
const HEADER = '# 经验日志（append-only）'
const HEADER_NOTE = [
  '',
  '> 由 agent 在任务结束/踩坑解决后追加，只增不改；抽象化后条目转入 `experience.archive.md`。',
  '> 每条必须能被追溯：`evidence` 指向真实的 turn 或文件。没有证据的条目不要写进来。',
  '',
].join('\n')

/**
 * The one accepted field order. Serializing and parsing share it so a written
 * entry round-trips exactly — a journal whose entries cannot be read back is
 * worse than no journal, because it looks like it works.
 */
const FRONT_MATTER_KEYS = Object.freeze(['id', 'when', 'topic', 'scope', 'status', 'evidence'])
const BODY_FIELDS = Object.freeze(['goal', 'blocker', 'solution'])

function oneLine(value, limit) {
  return String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, limit)
}

function slugifyTopic(topic) {
  const ascii = String(topic ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9一-龥]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
  return ascii.slice(0, MAX_TOPIC) || 'general'
}

export function experienceIdPrefix(when) {
  const date = new Date(Number(when))
  const stamp = Number.isFinite(date.getTime())
    ? `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}`
    : '00000000'
  return `exp-${stamp}-`
}

export function formatExperienceEntryId(when, sequence) {
  return `${experienceIdPrefix(when)}${String(sequence).padStart(3, '0')}`
}

/**
 * The next free sequence number for one day. Derived from the ids already in the
 * journal rather than from a counter that would be lost on restart, so two
 * processes appending the same day cannot both write `-001`.
 */
export function nextExperienceSequence(entries, when) {
  const prefix = experienceIdPrefix(when)
  const used = (Array.isArray(entries) ? entries : [])
    .filter((entry) => String(entry?.id || '').startsWith(prefix))
    .map((entry) => Number.parseInt(String(entry.id).slice(prefix.length), 10) || 0)
  return (used.length > 0 ? Math.max(...used) : 0) + 1
}

/**
 * Validate and normalize one episode. Returns `{ ok, entry }` or `{ ok:false, error }`.
 * `evidence` is required on purpose: an abstraction step downstream is only
 * allowed to keep a lesson that points at something that really happened, so an
 * entry without evidence could never survive, and accepting it would just move
 * the rejection later with less context.
 */
export function normalizeExperienceEntry(input = {}, { when = Date.now(), sequence = 1 } = {}) {
  const goal = oneLine(input.goal, MAX_FIELD)
  const blocker = oneLine(input.blocker, MAX_FIELD)
  const solution = oneLine(input.solution, MAX_FIELD)
  const evidence = oneLine(input.evidence, MAX_EVIDENCE)
  const scope = String(input.scope || 'project').trim()
  const topic = slugifyTopic(input.topic)

  if (!goal) return { ok: false, error: 'goal 必填：这次到底想做什么' }
  if (!solution) return { ok: false, error: 'solution 必填：最后是怎么解决的' }
  if (!evidence) return { ok: false, error: 'evidence 必填：指向真实的 turn 或文件，没有证据的经验不可追溯' }
  if (!EXPERIENCE_SCOPES.includes(scope)) {
    return { ok: false, error: `scope 必须是 ${EXPERIENCE_SCOPES.join(' / ')} 之一` }
  }
  return {
    ok: true,
    entry: {
      id: oneLine(input.id, 64) || formatExperienceEntryId(when, sequence),
      when: new Date(Number(when)).toISOString(),
      topic,
      scope,
      status: 'pending',
      evidence,
      goal,
      // A clean episode has no blocker; the field is then absent rather than blank.
      ...(blocker ? { blocker } : {}),
      solution,
    },
  }
}

export function serializeExperienceEntry(entry) {
  const lines = ['---']
  for (const key of FRONT_MATTER_KEYS) lines.push(`${key}: ${entry[key] ?? ''}`)
  lines.push('---')
  for (const field of BODY_FIELDS) {
    if (entry[field]) lines.push(`${field}: ${entry[field]}`)
  }
  return `${lines.join('\n')}\n`
}

/**
 * Parse the journal written by `serializeExperienceEntry`. Anything that does not
 * match the format is reported as a problem rather than skipped: silently
 * dropping an unreadable entry would make a corrupted journal look like a short
 * one, and the abstraction step would then "learn" from a truncated history.
 */
/**
 * Read `field: value` lines, folding a wrapped continuation line into the field
 * above it. A hand-editor who hard-wraps a long lesson must not silently lose
 * everything after the first line of it.
 */
function readLabeledFields(text) {
  const fields = {}
  let current = ''
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const match = /^([a-z_]+):\s?(.*)$/u.exec(line)
    if (match) {
      current = match[1]
      fields[current] = match[2].trim()
      continue
    }
    if (current && fields[current]) fields[current] = `${fields[current]} ${line}`
  }
  return fields
}

export function parseExperienceJournal(text) {
  const entries = []
  const problems = []
  const source = String(text ?? '')
  const blocks = source.split(/^---\s*$/mu)
  // blocks[0] is the prose header; entries are front-matter/body pairs thereafter.
  for (let index = 1; index < blocks.length; index += 2) {
    const frontMatter = blocks[index]
    const body = blocks[index + 1] ?? ''
    const meta = {}
    for (const line of frontMatter.split('\n')) {
      const match = /^([a-z_]+):\s?(.*)$/u.exec(line.trim())
      if (!match) continue
      meta[match[1]] = match[2].trim()
    }
    const fields = readLabeledFields(body)
    if (!meta.id || !fields.goal) {
      problems.push(`entry ${entries.length + 1} is unreadable (missing id or goal)`)
      continue
    }
    entries.push({
      id: meta.id,
      when: meta.when || '',
      topic: meta.topic || 'general',
      scope: EXPERIENCE_SCOPES.includes(meta.scope) ? meta.scope : 'project',
      status: EXPERIENCE_STATUSES.includes(meta.status) ? meta.status : 'pending',
      evidence: meta.evidence || '',
      goal: fields.goal || '',
      ...(fields.blocker ? { blocker: fields.blocker } : {}),
      solution: fields.solution || '',
    })
  }
  return { entries, problems }
}

export function countExperienceEntries(text) {
  return parseExperienceJournal(text).entries.length
}

/**
 * Serialize the journal back out, entries first, header last-written-once.
 * `readJournal`/`writeJournal` are the only things that touch the disk, so the
 * append path and the archive path cannot drift in format.
 */
export function renderExperienceJournal(entries) {
  return `${HEADER}\n${HEADER_NOTE}${entries.map(serializeExperienceEntry).join('\n')}`
}

export function experienceJournalPath(workspaceRoot) {
  return path.join(String(workspaceRoot), EXPERIENCE_DIR, EXPERIENCE_FILE)
}

export function experienceArchivePath(workspaceRoot) {
  return path.join(String(workspaceRoot), EXPERIENCE_DIR, EXPERIENCE_ARCHIVE_FILE)
}

export function readJournalFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return ''
    throw error
  }
}

/**
 * Write atomically: a journal half-written when the process dies would lose every
 * episode after the interruption point, and this file is the only copy.
 */
export function writeJournalFile(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.${process.pid}.tmp`
  fs.writeFileSync(temporary, text, { encoding: 'utf8', mode: 0o644 })
  fs.renameSync(temporary, filePath)
}
