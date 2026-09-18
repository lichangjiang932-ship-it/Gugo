import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { Writable } from 'node:stream'
import { getDb, closeDb } from '../../server/db.js'
import { issueTestSession } from '../helpers/testAuth.js'
import { upsertSession, upsertMessage, archiveSession } from '../../server/services/sessionStore.js'
import { searchTurnEvents, formatSearchMatches, parseSearchArgs } from '../../bin/cli/sessionSearch.js'
import { startInteractiveSession } from '../../bin/cli/interactiveSession.js'

after(() => closeDb())

test('CLI search reads persisted messages beyond event limits and paginates within the owner/session', async () => {
  const { userId } = issueTestSession({ email: 'cli-search-owner@example.invalid' })
  const other = issueTestSession({ email: 'cli-search-other@example.invalid' }).userId
  for (const [id, owner] of [['cli-search-long', userId], ['cli-search-second', userId], ['cli-search-foreign', other]]) {
    upsertSession({ id, userId: owner, title: id })
  }
  getDb().transaction(() => {
    for (let index = 0; index < 2005; index += 1) {
      upsertMessage({ id: `cli-search-message-${index}`, userId, sessionId: 'cli-search-long', role: 'user',
        content: index >= 2000 ? `needle731 result ${index}` : `ordinary message ${index}`, createdAt: index + 1 })
    }
  })()
  upsertMessage({ id: 'cli-search-other-message', userId: other, sessionId: 'cli-search-foreign', role: 'assistant', content: 'needle731 secret' })
  upsertMessage({ id: 'cli-search-second-message', userId, sessionId: 'cli-search-second', role: 'assistant', content: 'needle731 other session' })
  archiveSession({ userId, sessionId: 'cli-search-long' })

  const first = await searchTurnEvents({ userId, sessionId: 'cli-search-long', query: 'needle731', limit: 2 })
  assert.equal(first.matches.length, 2)
  assert.equal(first.total, 5)
  assert.equal(first.nextOffset, 2)
  assert.equal(first.truncated, false, 'a result page is not an incomplete search')
  assert.ok(first.matches.every((entry) => entry.sessionId === 'cli-search-long' && entry.messageId))
  assert.match(formatSearchMatches(first, { query: 'needle731' }), /--offset 2/u)
  const second = await searchTurnEvents({ userId, sessionId: 'cli-search-long', query: 'needle731', limit: 2, offset: 2 })
  assert.equal(second.matches.length, 2)
  assert.equal(new Set([...first.matches, ...second.matches].map((entry) => entry.messageId)).size, 4)
  const foreign = await searchTurnEvents({ userId: other, sessionId: 'cli-search-long', query: 'needle731' })
  assert.deepEqual(foreign.matches, [])
  assert.equal(foreign.total, 0)
})

test('CLI search parses a stable pagination cursor and refuses duplicate or invalid offsets', () => {
  assert.deepEqual(parseSearchArgs('needle --limit 2 --offset 4'), { query: 'needle', limit: 2, offset: 4 })
  assert.deepEqual(parseSearchArgs('needle --offset 4 --limit 2'), { query: 'needle', limit: 2, offset: 4 })
  for (const args of ['needle --offset -1', 'needle --offset nope', 'needle --offset 1 --offset 2']) {
    assert.throws(() => parseSearchArgs(args), { code: 'CLI_SEARCH_PAGINATION_INVALID' })
  }
})

test('terminal search output cannot replay terminal control sequences from history or the query', () => {
  const control = String.fromCharCode(27)
  const text = formatSearchMatches([{ role: 'assistant', messageId: 'message', turnId: 'turn', excerpt: `${control}[2Jhistory` }], { query: `${control}]52;clipboard` })
  assert.equal(text.includes(control), false)
})

test('chat /search forwards the continuation cursor and refuses a mismatched query without starting a turn', async () => {
  const { userId } = issueTestSession({ email: 'cli-search-cursor-command@example.invalid' })
  const sessionId = 'cli-search-cursor-command'
  upsertSession({ id: sessionId, userId, title: 'Cursor command fixture' })
  for (const [index, content] of ['上下文工程记录：entryZero', '上下文工程记录：entryOne', '上下文工程记录：entryTwo'].entries()) {
    upsertMessage({ id: `cli-cursor-${index}`, userId, sessionId, role: 'assistant', content, createdAt: index + 1 })
  }
  const first = await searchTurnEvents({ userId, sessionId, query: '上下文', limit: 1 })
  assert.ok(first.nextCursor)
  const second = await searchTurnEvents({ userId, sessionId, query: '上下文', limit: 1, cursor: first.nextCursor })
  assert.notEqual(first.matches[0].messageId, second.matches[0].messageId)
  const chunks = []
  const out = new Writable({ write(chunk, _encoding, done) { chunks.push(String(chunk)); done() } })
  const exit = await startInteractiveSession({
    options: { sessionId }, env: {}, stdout: out, stderr: out,
    lines: [`/search 上下文 --limit 1 --cursor ${first.nextCursor}`,
      `/search other --limit 1 --cursor ${first.nextCursor}`, '/exit'],
    resolveUserId: async () => userId, readModelProviders: async () => [],
    runTurn: async () => assert.fail('history commands must not start a turn'),
  })
  assert.equal(exit, 0)
  const text = chunks.join('')
  assert.ok(text.includes(second.matches[0].excerpt))
  assert.equal(text.includes(first.matches[0].excerpt), false, 'cursor must not restart page one')
  assert.match(text, /error: .*cursor/iu)
})
