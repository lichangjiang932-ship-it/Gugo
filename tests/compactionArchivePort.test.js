import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-compaction-port-'))
process.env.APP_DATA_DIR = tempDir
process.env.APP_DB_PATH = path.join(tempDir, 'app.db')

const {
  COMPACTION_ARCHIVE_PORT_VERSION,
  createCompactionArchivePort,
} = await import('../server/core/compactionArchivePort.js')
const { handleCompactionRequest } = await import('../server/routes/compactionRoutes.js')
const { compactForModel } = await import('../server/services/contextCompactionRuntime.js')
const { buildSessionsBlock, clearPromptCompilerCache } = await import('../server/services/promptCompiler.js')
const { closeDb } = await import('../server/db.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

function createAsyncMemoryArchivePort() {
  const rows = new Map()
  let sequence = 0
  const observations = []
  const key = (userId, id) => `${userId}\0${id}`
  const port = createCompactionArchivePort({
    apiVersion: COMPACTION_ARCHIVE_PORT_VERSION,
    id: 'test.memory-async',
    async create(input) {
      observations.push({ method: 'create', inputFrozen: Object.isFrozen(input) })
      sequence += 1
      const archive = {
        id: `memory-${sequence}`,
        userId: input.userId,
        sessionId: input.sessionId,
        replacedMessageCount: input.archivedMessages.length,
        archivedMessages: input.archivedMessages,
        summaryText: String(input.summaryText || ''),
        createdAt: sequence,
      }
      rows.set(key(input.userId, archive.id), structuredClone(archive))
      return archive
    },
    async get(input) {
      observations.push({ method: 'get', inputFrozen: Object.isFrozen(input) })
      return structuredClone(rows.get(key(input.userId, input.id)) || null)
    },
    async cleanup(input) {
      observations.push({ method: 'cleanup', inputFrozen: Object.isFrozen(input) })
      let removed = 0
      for (const storedKey of [...rows.keys()]) {
        if (!storedKey.startsWith(`${input.userId}\0`)) continue
        rows.delete(storedKey)
        removed += 1
      }
      return { removed }
    },
  })
  return { port, observations, rows }
}

test.after(() => {
  closeDb()
  fs.rmSync(tempDir, { recursive: true, force: true })
})

test('CompactionArchivePort v1 validates adapters and freezes boundary DTOs', async () => {
  assert.throws(
    () => createCompactionArchivePort({ apiVersion: 2, create() {}, get() {}, cleanup() {} }),
    (error) => error?.code === 'COMPACTION_ARCHIVE_PORT_VERSION_UNSUPPORTED',
  )
  assert.throws(
    () => createCompactionArchivePort({ apiVersion: 1, create() {}, get() {} }),
    (error) => error?.code === 'COMPACTION_ARCHIVE_PORT_INVALID',
  )

  const { port, observations } = createAsyncMemoryArchivePort()
  const created = await port.create({
    userId: 'owner-a',
    sessionId: 'session-a',
    archivedMessages: [{ role: 'user', content: 'private context' }],
    summaryText: 'summary-a',
  })
  assert.equal(port.apiVersion, 1)
  assert.equal(Object.isFrozen(port), true)
  assert.equal(Object.isFrozen(created), true)
  assert.equal(Object.isFrozen(created.archivedMessages), true)
  assert.equal(Object.isFrozen(created.archivedMessages[0]), true)
  assert.equal((await port.get({ userId: 'owner-b', id: created.id })), null)
  assert.deepEqual(await port.get({ userId: 'owner-a', id: created.id }), created)
  const cleanup = await port.cleanup({ userId: 'owner-a' })
  assert.deepEqual(cleanup, { removed: 1 })
  assert.equal(Object.isFrozen(cleanup), true)
  assert.ok(observations.every((entry) => entry.inputFrozen))
})

test('automatic compaction writes through an async archive port', async () => {
  const { port } = createAsyncMemoryArchivePort()
  const messages = Array.from({ length: 30 }, (_, index) => ({
    id: `message-${index}`,
    role: index % 2 ? 'assistant' : 'user',
    content: `${index}:${'x'.repeat(1200)}`,
  }))

  const result = await compactForModel({
    messages,
    contextWindow: 4_096,
    userId: 'auto-owner',
    sessionId: 'auto-session',
    compactionArchivePort: port,
  })

  assert.equal(result.compacted, true)
  assert.equal(result.archiveId, 'memory-1')
  assert.equal(result.messages.find((message) => message?.meta?.compaction)?.meta?.archiveId, 'memory-1')
  const archive = await port.get({ userId: 'auto-owner', id: result.archiveId })
  assert.equal(archive.sessionId, 'auto-session')
  assert.ok(archive.archivedMessages.length > 0)
})

test('prompt sessions block reads an archive through an async port', async () => {
  clearPromptCompilerCache()
  const { port } = createAsyncMemoryArchivePort()
  const archive = await port.create({
    userId: 'prompt-owner',
    sessionId: 'prompt-session',
    archivedMessages: [{ id: 'old-1', role: 'user', content: 'old objective' }],
    summaryText: 'ASYNC ARCHIVE SUMMARY',
  })

  const block = await buildSessionsBlock({
    userId: 'prompt-owner',
    sessionId: 'prompt-session',
    recentMessages: [{
      id: 'summary-message',
      role: 'assistant',
      content: 'summary marker',
      meta: { archiveId: archive.id },
    }],
    compactionArchivePort: port,
  })

  assert.match(block.text, /ASYNC ARCHIVE SUMMARY/u)
  assert.equal(block.sources.archiveId, archive.id)
})

test('manual compaction HTTP route creates and reads through an async port', async () => {
  const { port } = createAsyncMemoryArchivePort()
  const auth = issueTestSession()
  const server = http.createServer((req, res) => {
    void handleCompactionRequest(req, res, {
      compactionArchivePort: port,
      resolveModelContext: () => ({
        contextWindow: 8_192,
        callModel: async () => ({ content: 'unused' }),
      }),
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  try {
    const response = await fetch(`${origin}/api/compaction/compress`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${auth.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sessionId: 'manual-session',
        semantic: false,
        keepMessages: 1,
        messages: [
          { id: 'manual-1', role: 'user', content: 'old objective' },
          { id: 'manual-2', role: 'assistant', content: `old progress ${'x'.repeat(16_000)}` },
          { id: 'manual-3', role: 'user', content: 'current objective' },
        ],
      }),
    })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.ok, true)
    assert.equal(body.compacted, true)
    assert.equal(body.archiveId, 'memory-1')

    const read = await fetch(`${origin}/api/compaction/archive/${body.archiveId}`, {
      headers: { Authorization: `Bearer ${auth.token}` },
    })
    assert.equal(read.status, 200)
    const readBody = await read.json()
    assert.equal(readBody.archive.id, body.archiveId)
    assert.equal(readBody.archive.userId, auth.userId)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
