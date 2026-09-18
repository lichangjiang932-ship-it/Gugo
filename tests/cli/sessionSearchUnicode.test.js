import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { getDb, closeDb } from '../../server/db.js'
import { issueTestSession } from '../helpers/testAuth.js'
import { upsertSession, upsertMessage } from '../../server/services/sessionStore.js'
import { searchMessagesPage } from '../../server/services/sessionSearchService.js'
import { formatSearchMatches, matchTurnRecords, parseSearchArgs, searchTurnEvents } from '../../bin/cli/sessionSearch.js'

after(() => closeDb())
let sequence = 0

function fixture() {
  const sessionId = `unicode-search-${++sequence}`
  const { userId } = issueTestSession({ email: `${sessionId}@example.invalid` })
  upsertSession({ id: sessionId, userId, title: 'Transcript' })
  const insert = (id, content, options = {}) => upsertMessage({
    id: `${sessionId}-${id}`, userId, sessionId, role: 'assistant', content,
    createdAt: 1, modelContext: { turnId: `turn-${id}` }, ...options,
  })
  return { userId, sessionId, insert }
}

test('actual CLI search finds Chinese substrings inside continuous text', async () => {
  const scope = fixture()
  const target = scope.insert('target', '需要完善上下文工程和向量记忆系统。')
  const page = await searchTurnEvents({ ...scope, query: '上下文' })
  assert.deepEqual(page.matches.map((match) => match.messageId), [target.id])
  assert.match(page.matches[0].excerpt, /上下文/u)
  assert.equal(page.total, 1)
  assert.equal(page.totalIsExact, true)
})

test('actual CLI search matches NFKC fullwidth, ligatures and combining characters', async () => {
  for (const [content, query] of [['Ｆｏｏ', 'foo'], ['Cafe\u0301', 'CAFÉ'], ['oﬃce', 'office']]) {
    const scope = fixture()
    const target = scope.insert('target', `保存 ${content} 作为参考。`)
    const page = await searchTurnEvents({ ...scope, query })
    assert.deepEqual(page.matches.map((match) => match.messageId), [target.id])
    assert.ok(page.matches[0].excerpt.includes(content))
    assert.equal(page.totalIsExact, true)
  }
})

test('percent and underscore queries are literal, not LIKE or FTS token wildcards', async () => {
  const scope = fixture()
  const percent = scope.insert('percent', 'Keep 30% of the samples.')
  const underscore = scope.insert('underscore', 'Use foo_bar for this field.')
  scope.insert('ordinary', 'Keep 30 of the samples and use foo bar elsewhere.')
  for (const [query, expected] of [['%', percent.id], ['30%', percent.id], ['_', underscore.id], ['foo_bar', underscore.id]]) {
    const page = await searchTurnEvents({ ...scope, query })
    assert.deepEqual(page.matches.map((match) => match.messageId), [expected])
    assert.equal(page.total, 1)
  }
})

test('normalized substring fallback remains owner/session scoped beyond 2000 records', async () => {
  const scope = fixture()
  const foreign = fixture()
  const otherSession = `${scope.sessionId}-other`
  upsertSession({ id: otherSession, userId: scope.userId, title: 'Another transcript' })
  getDb().transaction(() => {
    for (let index = 0; index < 2010; index += 1) scope.insert(`ordinary-${index}`, `Ordinary ${index}`, { createdAt: index + 1 })
    scope.insert('old-match', '记录上下文工程的设计方案。', { createdAt: 0 })
  })()
  foreign.insert('foreign', '记录上下文工程的其他用户秘密。')
  scope.insert('other-session', '上下文工程的另一会话内容。', { sessionId: otherSession })
  const page = await searchTurnEvents({ ...scope, query: '上下文工程' })
  assert.equal(page.matches.length, 1)
  assert.equal(page.matches[0].sessionId, scope.sessionId)
  assert.equal(page.totalIsExact, true)
  assert.deepEqual((await searchTurnEvents({ userId: foreign.userId, sessionId: scope.sessionId, query: '上下文' })).matches, [])
})

test('a bounded partial scan exposes coverage and a usable continuation instead of no match', () => {
  const scope = fixture()
  const target = scope.insert('old-match', '记录上下文工程的设计方案。', { createdAt: 0 })
  for (let index = 0; index < 6; index += 1) scope.insert(`ordinary-${index}`, 'Nothing relevant.', { createdAt: index + 1 })
  const options = { ...scope, query: '上下文', scanLimits: { maxScanned: 2, maxDurationMs: 1000 } }
  const first = searchMessagesPage(options)
  assert.deepEqual(first.matches, [])
  assert.equal(first.truncated, true)
  assert.equal(first.totalIsExact, false)
  assert.equal(first.diagnostics.scanned, 2)
  assert.equal(first.diagnostics.code, 'SESSION_SEARCH_SCAN_LIMIT')
  assert.ok(first.nextCursor)
  const text = formatSearchMatches(first, { query: options.query })
  assert.doesNotMatch(text, /No match|0 total/iu)
  assert.match(text, /--cursor /u)
  let page = first
  const seen = []
  for (let round = 0; page.nextCursor && round < 10; round += 1) {
    page = searchMessagesPage({ ...options, cursor: page.nextCursor })
    seen.push(...page.matches.map((match) => match.messageId))
  }
  assert.deepEqual(seen, [target.id])
  assert.equal(page.total, 1)
  assert.equal(page.totalIsExact, true)
  assert.equal(page.nextCursor, null)
})

test('bounded Unicode fallback does not hide older native FTS hits or repeat them on continuation', () => {
  const scope = fixture()
  const target = scope.insert('old-indexed', 'retainedindexedneedle is searchable', { createdAt: 0 })
  for (let index = 0; index < 6; index += 1) scope.insert(`ordinary-${index}`, 'Nothing relevant.', { createdAt: index + 1 })
  const options = { ...scope, query: 'retainedindexedneedle', limit: 2, scanLimits: { maxScanned: 2, maxDurationMs: 1000 } }
  let page = searchMessagesPage(options)
  assert.deepEqual(page.matches.map((row) => row.messageId), [target.id])
  assert.equal(page.truncated, true)
  const seen = page.matches.map((row) => row.messageId)
  for (let round = 0; page.nextCursor && round < 10; round += 1) {
    page = searchMessagesPage({ ...options, cursor: page.nextCursor })
    seen.push(...page.matches.map((row) => row.messageId))
  }
  assert.deepEqual(seen, [target.id])
  assert.equal(page.total, 1)
  assert.equal(page.totalIsExact, true)
})

test('cursor pages are deterministic for timestamp ties and bound to owner, session and query', () => {
  const scope = fixture()
  for (let index = 0; index < 5; index += 1) scope.insert(`match-${index}`, '记录上下文工程设计。')
  const options = { ...scope, query: '上下文', limit: 2 }
  const first = searchMessagesPage(options)
  const second = searchMessagesPage({ ...options, cursor: first.nextCursor })
  const third = searchMessagesPage({ ...options, cursor: second.nextCursor })
  assert.equal(new Set([...first.matches, ...second.matches, ...third.matches].map((row) => row.messageId)).size, 5)
  assert.equal(third.total, 5)
  assert.equal(third.nextCursor, null)
  for (const changed of [{ userId: 'other' }, { sessionId: 'other' }, { query: 'other' }]) {
    assert.throws(() => searchMessagesPage({ ...options, ...changed, cursor: first.nextCursor }), { code: 'SESSION_SEARCH_CURSOR_SCOPE_MISMATCH' })
  }
  for (const cursor of ['bad+base64', 'x'.repeat(3000)]) {
    assert.throws(() => searchMessagesPage({ ...options, cursor }), { code: 'SESSION_SEARCH_CURSOR_INVALID' })
  }
  assert.equal(parseSearchArgs(`上下文 --limit 2 --cursor ${first.nextCursor}`).cursor, first.nextCursor)
})

test('edits or deletions invalidate an earlier cursor with an explicit restart diagnostic', () => {
  for (const mutation of ['edit', 'delete']) {
    const scope = fixture()
    const target = scope.insert('target', '上下文工程待审查。')
    scope.insert('second', '上下文工程已验证。')
    const options = { ...scope, query: '上下文', limit: 1 }
    const first = searchMessagesPage(options)
    if (mutation === 'edit') scope.insert('target', '完全不同的内容。')
    else getDb().prepare('DELETE FROM messages WHERE id=? AND user_id=?').run(target.id, scope.userId)
    const changed = searchMessagesPage({ ...options, cursor: first.nextCursor })
    assert.deepEqual(changed.matches, [])
    assert.equal(changed.totalIsExact, false)
    assert.equal(changed.diagnostics.code, 'SESSION_SEARCH_HISTORY_CHANGED')
    assert.equal(changed.restartRequired, true)
    assert.doesNotMatch(formatSearchMatches(changed, { query: options.query }), /No match/iu)
  }
})

test('legacy Unicode excerpts map normalized offsets back to the original source', () => {
  const prefix = 'ﬃ'.repeat(100)
  const text = `${prefix}NEEDLE${'後'.repeat(100)}`
  const [match] = matchTurnRecords([{ turnId: 'legacy', user: text }], 'needle')
  assert.equal(match.index, prefix.length)
  assert.match(match.excerpt, /NEEDLE/u)
  assert.ok(match.excerpt.isWellFormed())
  const cancellingLengths = 'ﬃe\u0301e\u0301'
  const [inside] = matchTurnRecords([{ turnId: 'legacy', user: cancellingLengths }], 'é')
  assert.equal(inside.index, 1, 'equal total normalized length does not imply equal prefix offsets')
})

test('mixed indexed and Unicode-only matches paginate without loss or duplication', () => {
  const scope = fixture()
  const expected = []
  for (let index = 0; index < 3; index += 1) expected.push(scope.insert(`native-${index}`, `office reference ${index}`).id)
  for (let index = 0; index < 3; index += 1) expected.push(scope.insert(`literal-${index}`, `oﬃce reference ${index}`).id)
  const options = { ...scope, query: 'office', limit: 1, scanLimits: { maxScanned: 2, maxDurationMs: 1000 } }
  let page = searchMessagesPage(options)
  const seen = page.matches.map((row) => row.messageId)
  for (let index = 0; page.nextCursor && index < 20; index += 1) {
    page = searchMessagesPage({ ...options, cursor: page.nextCursor })
    seen.push(...page.matches.map((row) => row.messageId))
  }
  assert.deepEqual([...seen].sort(), expected.sort())
  assert.equal(new Set(seen).size, 6)
  assert.equal(page.total, 6)
  assert.equal(page.totalIsExact, true)
  assert.equal(page.nextCursor, null)
})

test('cursor validation rejects malformed numeric fields, objects and duplicate CLI flags', () => {
  const scope = fixture()
  scope.insert('first', '上下文工程。')
  scope.insert('second', '上下文设计。')
  const options = { ...scope, query: '上下文', limit: 1 }
  const first = searchMessagesPage(options)
  const valid = JSON.parse(Buffer.from(first.nextCursor, 'base64url').toString('utf8'))
  for (const fields of [{ beforeRow: -1 }, { upper: 1.5 }, { ftsOffset: Number.MAX_SAFE_INTEGER },
    { binding: { toString: null, valueOf: null } }, { extraBefore: '0' }, { unrelated: true }]) {
    const cursor = Buffer.from(JSON.stringify({ ...valid, ...fields })).toString('base64url')
    assert.throws(() => searchMessagesPage({ ...options, cursor }), { code: 'SESSION_SEARCH_CURSOR_INVALID' })
  }
  assert.throws(() => parseSearchArgs(`上下文 --cursor ${first.nextCursor} --cursor ${first.nextCursor}`), { code: 'CLI_SEARCH_PAGINATION_INVALID' })
  assert.throws(() => searchMessagesPage({ ...options, query: 'x'.repeat(4097) }), { code: 'SESSION_SEARCH_QUERY_TOO_LONG' })
})

test('search cancellation and character/time limits do not masquerade as complete empty results', (t) => {
  const scope = fixture()
  scope.insert('old', '上下文工程。', { createdAt: 0 })
  for (let index = 0; index < 8; index += 1) scope.insert(`noise-${index}`, 'A'.repeat(100), { createdAt: index + 1 })
  const controller = new AbortController()
  controller.abort()
  const mock = t.mock.method(getDb(), 'prepare', () => assert.fail('cancelled search must not query the database'))
  let cancelled
  try { cancelled = searchMessagesPage({ ...scope, query: '上下文', signal: controller.signal }) } finally { mock.mock.restore() }
  assert.equal(cancelled.diagnostics.code, 'SESSION_SEARCH_ABORTED')
  assert.match(formatSearchMatches(cancelled, { query: '上下文' }), /cancelled/iu)
  const bounded = searchMessagesPage({ ...scope, query: '上下文', scanLimits: { maxTextChars: 50 } })
  assert.equal(bounded.diagnostics.code, 'SESSION_SEARCH_TEXT_LIMIT')
  assert.equal(bounded.totalIsExact, false)
  assert.doesNotMatch(formatSearchMatches(bounded, { query: '上下文' }), /No match|0 total/iu)
  let ticks = 0
  const timed = searchMessagesPage({ ...scope, query: '上下文', scanLimits: { maxDurationMs: 10 } }, {
    now: () => ++ticks < 6 ? 0 : 100,
  })
  assert.equal(timed.diagnostics.code, 'SESSION_SEARCH_TIME_LIMIT')
  assert.equal(timed.totalIsExact, false)
  assert.ok(timed.nextCursor)
})
