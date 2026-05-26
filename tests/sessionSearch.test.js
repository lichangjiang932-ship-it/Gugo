import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.APP_DATA_DIR = path.join(os.tmpdir(), 'yma-session-search-tests', String(process.pid))

const { createAppServer } = await import('../server/appServer.js')
const { getDb } = await import('../server/db.js')
const {
  archiveSession,
  unarchiveSession,
  upsertMessage,
  upsertSession,
} = await import('../server/services/sessionStore.js')
const { searchMessages } = await import('../server/services/sessionSearchService.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

function cleanDb() {
  const db = getDb()
  db.prepare('DELETE FROM messages').run()
  db.prepare('DELETE FROM ledger').run()
  db.prepare('DELETE FROM sessions').run()
  db.prepare('DELETE FROM login_codes').run()
  db.prepare('DELETE FROM users').run()
  db.prepare('DELETE FROM rate_limits').run()
}

function seedSearchData() {
  const { token, userId } = issueTestSession()
  upsertSession({ id: 'search-s1', userId, title: 'Alpha project', createdAt: 1000, updatedAt: 3000 })
  upsertSession({ id: 'search-s2', userId, title: 'Beta project', createdAt: 2000, updatedAt: 4000 })
  upsertMessage({
    id: 'search-m1',
    userId,
    sessionId: 'search-s1',
    role: 'user',
    content: 'The orchard contains alpha roadmap notes.',
    createdAt: 1100,
  })
  upsertMessage({
    id: 'search-m2',
    userId,
    sessionId: 'search-s1',
    role: 'assistant',
    content: 'Budget forecast includes alpha beta delivery details.',
    createdAt: 1200,
  })
  upsertMessage({
    id: 'search-m3',
    userId,
    sessionId: 'search-s2',
    role: 'user',
    content: 'The beta launch checklist is ready.',
    createdAt: 2100,
  })
  return { token, userId }
}

async function withServer(fn) {
  const server = createAppServer({ getEnv: () => ({}) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    await fn(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

test.beforeEach(() => {
  cleanDb()
})

test.after(() => {
  cleanDb()
})

test('v9 creates messages_fts and indexes existing inserted messages', () => {
  const { userId } = seedSearchData()
  const db = getDb()
  const fts = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'messages_fts'").get()
  assert.equal(fts.name, 'messages_fts')
  const sessionsColumns = db.prepare('PRAGMA table_info(sessions)').all().map((row) => row.name)
  assert.ok(sessionsColumns.includes('archived_at'))

  const rows = searchMessages({ userId, query: 'roadmap' })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].messageId, 'search-m1')
})

test('searchMessages returns single-word matches', () => {
  const { userId } = seedSearchData()
  const rows = searchMessages({ userId, query: 'roadmap' })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].sessionId, 'search-s1')
})

test('searchMessages returns multi-word matches', () => {
  const { userId } = seedSearchData()
  const rows = searchMessages({ userId, query: 'alpha beta' })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].messageId, 'search-m2')
})

test('searchMessages snippets include mark highlights', () => {
  const { userId } = seedSearchData()
  const rows = searchMessages({ userId, query: 'alpha' })
  assert.ok(rows.some((row) => row.snippet.includes('<mark>alpha</mark>')))
})

test('searchMessages returns matches across sessions', () => {
  const { userId } = seedSearchData()
  const rows = searchMessages({ userId, query: 'beta' })
  assert.deepEqual(new Set(rows.map((row) => row.sessionId)), new Set(['search-s1', 'search-s2']))
})

test('archiveSession and unarchiveSession flip archived state', () => {
  const { userId } = seedSearchData()
  const archived = archiveSession({ userId, sessionId: 'search-s1', now: 5000 })
  assert.equal(archived.archivedAt, 5000)
  const restored = unarchiveSession({ userId, sessionId: 'search-s1', now: 6000 })
  assert.equal(restored.archivedAt, null)
})

test('session routes search, archive, and list filters return 200', async () => {
  const { token } = seedSearchData()
  await withServer(async (baseUrl) => {
    const headers = { Authorization: `Bearer ${token}` }
    const search = await fetch(`${baseUrl}/api/sessions/search?q=alpha&limit=20&offset=0`, { headers })
    assert.equal(search.status, 200)
    const searchBody = await search.json()
    assert.ok(searchBody.results.length >= 1)

    const archive = await fetch(`${baseUrl}/api/sessions/search-s1/archive`, {
      method: 'POST',
      headers,
    })
    assert.equal(archive.status, 200)

    const active = await fetch(`${baseUrl}/api/sessions?archived=false`, { headers })
    assert.equal(active.status, 200)
    const activeBody = await active.json()
    assert.ok(activeBody.sessions.every((session) => session.id !== 'search-s1'))

    const archived = await fetch(`${baseUrl}/api/sessions?archived=true`, { headers })
    assert.equal(archived.status, 200)
    const archivedBody = await archived.json()
    assert.ok(archivedBody.sessions.some((session) => session.id === 'search-s1'))
  })
})

test('session routes reject unauthenticated requests with 401', async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/sessions/search?q=alpha`)
    assert.equal(res.status, 401)
  })
})
