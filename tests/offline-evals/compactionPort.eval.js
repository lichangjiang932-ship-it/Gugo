import assert from 'node:assert/strict'

import {
  COMPACTION_ARCHIVE_PORT_VERSION,
  createCompactionArchivePort,
} from '../../server/core/compactionArchivePort.js'
import { compactForModel } from '../../server/services/contextCompactionRuntime.js'
import {
  buildSessionsBlock,
  clearPromptCompilerCache,
} from '../../server/services/promptCompiler.js'
import { defineOfflineEvalCase, defineOfflineEvalSuite } from '../helpers/offlineEvalHarness.js'

function createAsyncMemoryArchivePort() {
  const rows = new Map()
  let sequence = 0
  const observations = []
  const key = (userId, id) => `${userId}\0${id}`
  const port = createCompactionArchivePort({
    apiVersion: COMPACTION_ARCHIVE_PORT_VERSION,
    id: 'offline-eval.memory-async',
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
  return { port, observations }
}

export default defineOfflineEvalSuite({
  id: 'compaction-port',
  title: 'Compaction archive port',
  version: 1,
  cases: [
    defineOfflineEvalCase({
      id: 'CMP-01',
      category: 'boundary',
      title: 'port validates adapters and freezes boundary data',
      async run() {
        assert.throws(
          () => createCompactionArchivePort({
            apiVersion: 2,
            create() {},
            get() {},
            cleanup() {},
          }),
          (error) => error?.code === 'COMPACTION_ARCHIVE_PORT_VERSION_UNSUPPORTED',
        )
        const { port, observations } = createAsyncMemoryArchivePort()
        const created = await port.create({
          userId: 'owner-a',
          sessionId: 'session-a',
          archivedMessages: [{ role: 'user', content: 'private context' }],
          summaryText: 'summary-a',
        })

        assert.equal(Object.isFrozen(port), true)
        assert.equal(Object.isFrozen(created), true)
        assert.equal(Object.isFrozen(created.archivedMessages[0]), true)
        assert.equal(await port.get({ userId: 'owner-b', id: created.id }), null)
        assert.deepEqual(await port.get({ userId: 'owner-a', id: created.id }), created)
        assert.deepEqual(await port.cleanup({ userId: 'owner-a' }), { removed: 1 })
        assert.ok(observations.every((entry) => entry.inputFrozen))
      },
    }),
    defineOfflineEvalCase({
      id: 'CMP-02',
      category: 'runtime',
      title: 'automatic compaction writes through the injected async port',
      async run() {
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
        assert.equal(
          result.messages.find((message) => message?.meta?.compaction)?.meta?.archiveId,
          'memory-1',
        )
        const archive = await port.get({ userId: 'auto-owner', id: result.archiveId })
        assert.equal(archive.sessionId, 'auto-session')
        assert.ok(archive.archivedMessages.length > 0)
      },
    }),
    defineOfflineEvalCase({
      id: 'CMP-03',
      category: 'prompt',
      title: 'prompt compilation reads the archive through the injected port',
      async run(ctx) {
        clearPromptCompilerCache()
        ctx.defer(clearPromptCompilerCache)
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
      },
    }),
  ],
})
