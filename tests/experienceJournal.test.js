import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  countExperienceEntries,
  experienceArchivePath,
  experienceJournalPath,
  formatExperienceEntryId,
  normalizeExperienceEntry,
  parseExperienceJournal,
  readJournalFile,
  renderExperienceJournal,
  serializeExperienceEntry,
  writeJournalFile,
} from '../server/services/experienceJournal.js'

const WHEN = Date.UTC(2026, 8, 24, 9, 12, 4)

function entry(overrides = {}) {
  const result = normalizeExperienceEntry({
    topic: 'sidebar-browser',
    scope: 'project',
    evidence: 'turn-abc;src/components/EmbeddedBrowser.jsx',
    goal: '让侧栏浏览器能打开禁止嵌入的站点',
    blocker: 'iframe 被 X-Frame-Options 拒绝且不触发事件',
    solution: '桌面端改用 WebContentsView，web 端保留 iframe 并明说限制',
    ...overrides,
  }, { when: WHEN, sequence: 1 })
  return result
}

test('an episode round-trips through the journal exactly', () => {
  const normalized = entry()
  assert.equal(normalized.ok, true)
  const written = serializeExperienceEntry(normalized.entry)
  const { entries, problems } = parseExperienceJournal(written)

  assert.deepEqual(problems, [])
  assert.equal(entries.length, 1)
  // The fields a reader cares about must survive the write/read pair — a journal
  // that cannot be read back looks like it works while learning from nothing.
  assert.deepEqual(entries[0], normalized.entry)
})

test('a journal entry always carries a verdict and a source', () => {
  // Every field here exists because abstraction downstream may only keep a lesson
  // that points at something real. Accepting an entry without evidence would move
  // that rejection downstream, where the context to judge it is already gone.
  assert.equal(entry({ goal: '' }).ok, false)
  assert.match(entry({ goal: '' }).error, /goal 必填/u)
  assert.equal(entry({ solution: '' }).ok, false)
  assert.match(entry({ solution: '' }).error, /solution 必填/u)
  assert.equal(entry({ evidence: '' }).ok, false)
  assert.match(entry({ evidence: '' }).error, /evidence 必填/u)
  assert.equal(entry({ scope: 'global' }).ok, false)
  assert.match(entry({ scope: 'global' }).error, /scope 必须是/u)
})

test('a clean episode has no blocker field rather than a blank one', () => {
  const normalized = entry({ blocker: '' })
  assert.equal(normalized.ok, true)
  assert.equal('blocker' in normalized.entry, false)
  assert.doesNotMatch(serializeExperienceEntry(normalized.entry), /^blocker:/mu)
})

test('the entry id is derived from the episode date, not the machine clock', () => {
  assert.equal(formatExperienceEntryId(WHEN, 1), 'exp-20260924-001')
  assert.equal(formatExperienceEntryId(WHEN, 42), 'exp-20260924-042')
  // A caller may pass an explicit id; a bad date must not throw or produce NaN.
  assert.equal(formatExperienceEntryId('not-a-date', 3), 'exp-00000000-003')
  assert.equal(entry({ id: 'exp-custom-1' }).entry.id, 'exp-custom-1')
})

test('a topic becomes a stable slug that keeps non-latin text', () => {
  assert.equal(entry({ topic: 'Sidebar Browser!' }).entry.topic, 'sidebar-browser')
  assert.equal(entry({ topic: '   ' }).entry.topic, 'general')
  assert.equal(entry({}).entry.topic, 'sidebar-browser')
  // Chinese topics must survive: stripping them to nothing would collapse every
  // entry to the same slug.
  assert.equal(entry({ topic: '侧栏浏览器' }).entry.topic, '侧栏浏览器')
})

test('an unreadable entry is reported, never silently skipped', () => {
  // A silently-dropped entry makes a corrupted journal look like a short one, and
  // the abstraction step would then learn from a history that never happened.
  const text = [
    '---', 'id: exp-1', 'when: 2026-09-24', 'topic: a', 'scope: project', 'status: pending', 'evidence: turn-1', '---',
    'goal: worked', 'solution: fixed', '',
    '---', 'topic: b', '---', 'goal: no id here', '',
  ].join('\n')
  const { entries, problems } = parseExperienceJournal(text)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].id, 'exp-1')
  assert.equal(problems.length, 1)
  assert.match(problems[0], /unreadable/u)
})

test('a hand-wrapped lesson keeps its whole text', () => {
  // Entry text is written one line by the tool, but the file is meant to be
  // editable by hand; a hard-wrapped line must not silently lose its tail.
  const text = [
    '---', 'id: exp-2', 'when: 2026-09-24', 'topic: a', 'scope: project', 'status: pending', 'evidence: turn-2', '---',
    'goal: keep everything', 'solution: 第一行说明做法',
    '第二行继续说明，仍然属于同一条 solution', '',
  ].join('\n')
  const { entries } = parseExperienceJournal(text)
  assert.match(entries[0].solution, /第一行说明做法/u)
  assert.match(entries[0].solution, /第二行继续说明/u)
})

test('unknown metadata falls back to safe defaults instead of corrupting the read', () => {
  const text = [
    '---', 'id: exp-3', 'when: 2026-09-24', 'topic: a', 'scope: nonsense', 'status: nonsense', 'evidence: turn-3', '---',
    'goal: g', 'solution: s', '',
  ].join('\n')
  const { entries } = parseExperienceJournal(text)
  assert.equal(entries[0].scope, 'project')
  assert.equal(entries[0].status, 'pending')
})

test('the journal file is written once, appended to, and archived beside it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-experience-'))
  try {
    const journalPath = experienceJournalPath(root)
    assert.equal(path.basename(journalPath), 'experience.md')
    assert.match(journalPath, /\.agent[\\/]experience\.md$/u)
    assert.match(experienceArchivePath(root), /\.agent[\\/]experience\.archive\.md$/u)

    // A journal that does not exist yet reads as empty, not as an error.
    assert.equal(readJournalFile(journalPath), '')
    assert.equal(countExperienceEntries(readJournalFile(journalPath)), 0)

    const first = entry().entry
    writeJournalFile(journalPath, renderExperienceJournal([first]))
    const text = readJournalFile(journalPath)
    // The header explains the file to a human who finds it; it is written once,
    // not per entry, so the file stays a journal rather than a pile of banners.
    assert.match(text, /^# 经验日志（append-only）/u)
    assert.equal((text.match(/# 经验日志/gu) || []).length, 1)
    assert.equal(countExperienceEntries(text), 1)

    const second = normalizeExperienceEntry({
      topic: 'sidebar-browser', scope: 'project', evidence: 'turn-def',
      goal: '第二个任务', solution: '第二种解法',
    }, { when: WHEN, sequence: 2 }).entry
    const { entries } = parseExperienceJournal(text)
    writeJournalFile(journalPath, renderExperienceJournal([...entries, second]))
    const reread = parseExperienceJournal(readJournalFile(journalPath))
    assert.deepEqual(reread.entries.map((item) => item.id), ['exp-20260924-001', 'exp-20260924-002'])
    assert.equal((readJournalFile(journalPath).match(/# 经验日志/gu) || []).length, 1)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a journal is rewritten atomically so a crash cannot truncate it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-experience-atomic-'))
  try {
    const journalPath = experienceJournalPath(root)
    writeJournalFile(journalPath, renderExperienceJournal([entry().entry]))
    // No temporary file may be left behind: a stranded `.tmp` next to the journal
    // would be picked up by nothing and eventually confuse a human reader.
    const leftovers = fs.readdirSync(path.dirname(journalPath)).filter((name) => name.endsWith('.tmp'))
    assert.deepEqual(leftovers, [])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
