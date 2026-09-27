import { logWarn } from '../utils/logger.js'
import { storeMemoryCandidates } from './autoMemoryService.js'
import { archiveExperienceEntries, readExperienceJournal } from './experienceRecorder.js'

/**
 * 经验日志 → 抽象化 → 分流（长期记忆 / 项目记忆 / 技能候选）。
 *
 * The journal (`.agent/experience.md`) is written one episode at a time by the
 * agent, and stays cheap to read. Once enough has piled up, one model call reads
 * the whole journal and returns what *generalizes* out of it; that result is what
 * is worth keeping, and each item has to name the entries it came from.
 *
 * Design decisions worth knowing:
 * - The journal is the source of truth and the evidence trail. Consumed entries
 *   move to `experience.archive.md`, never out of existence.
 * - Only consumed entries are archived, and only when the run produced something:
 *   an empty abstraction means the journal was not understood, not that it was
 *   handled.
 * - Long-term and project knowledge land in the memory store, under the guards
 *   every machine-written memory already passes (see storeMemoryCandidates).
 * - Skills are *proposed*, never installed. Installing one grants a capability,
 *   and this app already refuses to let a model grant capabilities on its own.
 */

export const EXPERIENCE_ABSTRACTION_THRESHOLDS = Object.freeze({
  entries: 20,
  bytes: 32 * 1024,
  ageDays: 7,
})

// One prompt has to stay readable for the model; the rest waits for the next run.
const MAX_ENTRIES_PER_RUN = 120
const MAX_ITEMS_PER_SECTION = Object.freeze({ longTerm: 12, project: 12, skills: 6 })
// A failing model must not be retried on every turn: the journal is unchanged, so
// a retry before the next episode would only spend another call.
const RETRY_COOLDOWN_MS = 30 * 60 * 1000
const recentAttempts = new Map()

function attemptKey({ userId, root = '' }) {
  return `${userId || ''}\u0000${root}`
}

/** Entries the agent has written and no abstraction run has consumed yet. */
export function pendingExperienceEntries(entries = []) {
  return (Array.isArray(entries) ? entries : []).filter((entry) => entry && entry.status !== 'digested')
}

/**
 * Whether the journal has earned a model call yet: enough episodes, enough
 * volume, or one episode that has waited long enough to be worth generalizing
 * even on its own.
 */
export function abstractionDue(entries = [], {
  now = Date.now(),
  thresholds = EXPERIENCE_ABSTRACTION_THRESHOLDS,
} = {}) {
  const pending = pendingExperienceEntries(entries)
  if (!pending.length) return { due: false, reason: 'empty', pending: 0, bytes: 0 }
  const bytes = pending.reduce((total, entry) => total + JSON.stringify(entry).length, 0)
  if (pending.length >= thresholds.entries) return { due: true, reason: 'entries', pending: pending.length, bytes }
  if (bytes >= thresholds.bytes) return { due: true, reason: 'bytes', pending: pending.length, bytes }
  const oldest = pending
    .map((entry) => Date.parse(entry.when))
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right)[0]
  const ageDays = Number.isFinite(oldest) ? (now - oldest) / 86_400_000 : 0
  if (ageDays >= thresholds.ageDays) return { due: true, reason: 'age', pending: pending.length, bytes }
  return { due: false, reason: 'below_threshold', pending: pending.length, bytes }
}

function entryForPrompt(entry) {
  return {
    id: entry.id,
    when: entry.when,
    topic: entry.topic,
    scope: entry.scope,
    goal: entry.goal,
    ...(entry.blocker ? { blocker: entry.blocker } : {}),
    solution: entry.solution,
    evidence: entry.evidence,
  }
}

export function buildExperienceAbstractionMessages(entries = []) {
  const consumed = pendingExperienceEntries(entries).slice(0, MAX_ENTRIES_PER_RUN)
  return {
    consumedEntryIds: consumed.map((entry) => entry.id),
    messages: [
      {
        role: 'system',
        content: [
          'You are consolidating an agent\'s own experience journal into durable knowledge.',
          'Each entry is one episode: what was attempted, what blocked it, how it was solved, and the evidence.',
          'Return JSON only, with this shape:',
          '{"longTerm":[{"type":"user|feedback|project|reference","title":"short stable key","body":"one or two factual sentences","confidence":0.0,"sources":["entry-id"]}],',
          '"project":[{"title":"short stable key","body":"one or two factual sentences","confidence":0.0,"sources":["entry-id"]}],',
          '"skills":[{"name":"kebab-case-name","description":"what it does","trigger":"when to use it","steps":["step"],"confidence":0.0,"sources":["entry-id"]}]}',
          'Every item MUST list the entry ids it was derived from in "sources"; an item without real sources is discarded, so never invent an id.',
          'Abstract, do not copy: merge episodes that teach the same lesson into one item and say what is generally true.',
          'longTerm is knowledge that holds beyond this project (how this reader works, corrections they gave, references they rely on).',
          'project is knowledge about this workspace only (paths, conventions, constraints, decisions).',
          'skills are repeatable procedures worth reusing as a skill; propose one only when the episodes show a procedure, not a one-off fix.',
          'When two episodes disagree, keep the newer lesson and say so in the body.',
          'Never include passwords, API keys, tokens, private keys, or other credentials.',
          `Emit at most ${MAX_ITEMS_PER_SECTION.longTerm} longTerm, ${MAX_ITEMS_PER_SECTION.project} project, and ${MAX_ITEMS_PER_SECTION.skills} skills items.`,
          'Return empty arrays when nothing generalizes.',
        ].join(' '),
      },
      {
        role: 'user',
        content: JSON.stringify({ entries: consumed.map(entryForPrompt) }),
      },
    ],
  }
}

/** Model output, tolerating a fenced block or surrounding prose. */
function parseJsonObject(value) {
  const source = String(value?.content ?? value ?? '').trim()
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim()
  for (const candidate of [fenced, source]) {
    if (!candidate) continue
    try {
      const parsed = JSON.parse(candidate)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch {
      const start = candidate.indexOf('{')
      const end = candidate.lastIndexOf('}')
      if (start < 0 || end <= start) continue
      try {
        const parsed = JSON.parse(candidate.slice(start, end + 1))
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
      } catch {
        // Unparseable output is a safe no-op: nothing is archived on a failed run.
      }
    }
  }
  return null
}

function text(value, limit) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit)
}

function sourcesOf(item, knownEntryIds) {
  const ids = [...new Set((Array.isArray(item?.sources) ? item.sources : [])
    .map((id) => text(id, 64))
    .filter((id) => id && knownEntryIds.has(id)))]
  return ids
}

function memoryItem(item, knownEntryIds, { type = '' } = {}) {
  const title = text(item?.title, 120)
  const body = text(item?.body, 2000)
  if (!title || !body) return null
  const sources = sourcesOf(item, knownEntryIds)
  // The evidence rule this app applies everywhere: a claim without a source is
  // not knowledge, it is a guess.
  if (!sources.length) return null
  return {
    type: type || text(item?.type, 24),
    title,
    body,
    confidence: Number(item?.confidence),
    provenance: { experienceSources: sources },
  }
}

function skillItem(item, knownEntryIds) {
  const name = text(item?.name, 64)
  const description = text(item?.description, 400)
  const trigger = text(item?.trigger, 300)
  const steps = (Array.isArray(item?.steps) ? item.steps : [])
    .map((step) => text(step, 300))
    .filter(Boolean)
    .slice(0, 12)
  if (!name || !description || !trigger || !steps.length) return null
  const sources = sourcesOf(item, knownEntryIds)
  if (!sources.length) return null
  return {
    type: 'reference',
    title: name,
    // Readable as a memory: what it is, when it applies, and the procedure.
    body: [
      description,
      `触发：${trigger}`,
      `步骤：${steps.map((step, index) => `${index + 1}) ${step}`).join(' ')}`,
      `来源：${sources.join(', ')}`,
    ].join('\n'),
    confidence: Number(item?.confidence),
    provenance: { experienceSources: sources, proposal: 'skill' },
  }
}

export function parseExperienceAbstraction(raw, { knownEntryIds = new Set() } = {}) {
  const parsed = parseJsonObject(raw)
  if (!parsed) return { longTerm: [], project: [], skills: [], rejected: 0 }
  const known = knownEntryIds instanceof Set ? knownEntryIds : new Set(knownEntryIds)
  let rejected = 0
  const section = (items, mapper, limit) => (Array.isArray(items) ? items : [])
    .slice(0, limit)
    .map((item) => {
      const mapped = mapper(item)
      if (!mapped) rejected += 1
      return mapped
    })
    .filter(Boolean)
  const longTerm = section(parsed.longTerm, (item) => memoryItem(item, known), MAX_ITEMS_PER_SECTION.longTerm)
  const project = section(parsed.project, (item) => memoryItem(item, known, { type: 'project' }), MAX_ITEMS_PER_SECTION.project)
  const skills = section(parsed.skills, (item) => skillItem(item, known), MAX_ITEMS_PER_SECTION.skills)
  return { longTerm, project, skills, rejected }
}

/**
 * Run one abstraction pass: read the journal, ask the model what generalizes,
 * write the durable parts, and archive exactly what was consumed.
 *
 * Returns a report rather than throwing: this runs after a finished task, where a
 * bookkeeping failure must never look like the task failed.
 */
export async function abstractExperienceJournal({
  userId = null,
  workspaceRoot = '',
  callModel,
  now = Date.now(),
  signal = null,
  thresholds = EXPERIENCE_ABSTRACTION_THRESHOLDS,
} = {}) {
  if (!userId) return { ok: false, skipped: true, reason: 'no_user' }
  if (typeof callModel !== 'function') return { ok: false, skipped: true, reason: 'no_model' }
  if (signal?.aborted) return { ok: false, skipped: true, reason: 'aborted' }

  const journal = readExperienceJournal({ userId, workspaceRoot })
  if (!journal.ok) return { ok: false, skipped: true, reason: journal.code || 'journal_unavailable', error: journal.error }
  const due = abstractionDue(journal.entries, { now, thresholds })
  if (!due.due) return { ok: true, skipped: true, reason: due.reason, pending: due.pending, bytes: due.bytes }

  const key = attemptKey({ userId, root: journal.root || workspaceRoot })
  const lastAttemptAt = recentAttempts.get(key) || 0
  if (now - lastAttemptAt < RETRY_COOLDOWN_MS) {
    return { ok: true, skipped: true, reason: 'cooldown', pending: due.pending, bytes: due.bytes }
  }
  recentAttempts.set(key, now)

  const { messages, consumedEntryIds } = buildExperienceAbstractionMessages(journal.entries)
  const response = await callModel({ ...(signal ? { signal } : {}), messages })
  if (signal?.aborted) return { ok: false, skipped: true, reason: 'aborted' }

  const abstained = parseExperienceAbstraction(response, { knownEntryIds: new Set(consumedEntryIds) })
  const knowledge = [...abstained.longTerm, ...abstained.project]
  const produced = knowledge.length + abstained.skills.length
  if (!produced) {
    // Nothing was understood, so nothing is consumed: the entries stay pending
    // for a run that does read them.
    return { ok: true, skipped: true, reason: 'nothing_generalized', pending: due.pending, rejected: abstained.rejected }
  }

  const stored = storeMemoryCandidates({
    userId,
    source: 'experience_abstraction',
    candidates: knowledge,
    signal,
  })
  // A skill proposal is a memory too, but marked as a proposal: it points at a
  // procedure worth installing instead of granting it.
  const proposals = storeMemoryCandidates({
    userId,
    source: 'experience_abstraction',
    candidates: abstained.skills,
    signal,
  })
  if (signal?.aborted) return { ok: false, skipped: true, reason: 'aborted' }

  const archived = await archiveExperienceEntries({ userId, workspaceRoot, entryIds: consumedEntryIds })
  return {
    ok: archived.ok !== false,
    skipped: false,
    consumed: consumedEntryIds.length,
    archived: archived.archived || [],
    stored: {
      longTerm: abstained.longTerm.length,
      project: abstained.project.length,
      skills: abstained.skills.length,
    },
    refused: [...stored.refused, ...proposals.refused],
    rejected: abstained.rejected,
    reason: due.reason,
  }
}

/**
 * The after-turn hook: cheap checks here, and the model call only when the
 * journal has actually earned one.
 */
export function scheduleExperienceAbstraction(options = {}) {
  const { signal, userId, workspaceRoot = '', callModel, now = Date.now(), thresholds } = options
  if (signal?.aborted || !userId || typeof callModel !== 'function') return
  let journal
  let due
  try {
    journal = readExperienceJournal({ userId, workspaceRoot })
    if (!journal.ok) return
    due = abstractionDue(journal.entries, { now, thresholds })
  } catch {
    return
  }
  if (!due.due) return

  const run = () => {
    if (signal?.aborted) return
    // The project directory was resolved while the turn's scope was still on the
    // stack; the run itself must not depend on that scope still being there.
    abstractExperienceJournal({ ...options, workspaceRoot: journal.root || workspaceRoot, thresholds }).catch((error) => {
      if (signal?.aborted) return
      logWarn('experience.abstraction', error?.message || error, {
        userId,
        reason: due.reason,
        pending: due.pending,
        code: error?.code || null,
      })
    })
  }
  const task = setImmediate(run)
  const cancelQueuedRun = () => {
    clearImmediate(task)
    signal?.removeEventListener('abort', cancelQueuedRun)
  }
  signal?.addEventListener('abort', cancelQueuedRun, { once: true })
}

/** Test seam: the cooldown is process-wide, and a test must not inherit it. */
export function resetExperienceAbstractionCooldown() {
  recentAttempts.clear()
}
