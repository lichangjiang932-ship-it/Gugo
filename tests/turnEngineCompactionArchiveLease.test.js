import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  createExternalToolLoopContext,
  createLoopContext,
} from '../server/services/loop/context.js'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function runFreshModule(script) {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'gugo-turn-compaction-lease-'))
  try {
    return spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        APP_DATA_DIR: path.join(tempRoot, 'data'),
      },
    })
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

test('TurnEngine holds one archive lease across prompt preparation and releases it after shutdown', () => {
  const result = runFreshModule(`
    import assert from 'node:assert/strict'
    const persistence = await import('./server/core/turnPersistenceAdapter.js')
    const compaction = await import('./server/core/compactionArchivePort.js')
    const { SQLITE_TURN_PERSISTENCE_ADAPTER } = await import(
      './server/adapters/sqliteTurnPersistenceAdapter.js'
    )
    const { closeTurnEngine, getTurnEngine } = await import(
      './server/services/turnEngineHost.js'
    )

    const persistenceController = persistence.createTurnPersistenceAdapterController(
      SQLITE_TURN_PERSISTENCE_ADAPTER,
      { source: 'test.turn-engine-compaction-lease' },
    )
    const reads = []
    const compactionController = compaction.createCompactionArchivePortController({
      apiVersion: compaction.COMPACTION_ARCHIVE_PORT_VERSION,
      id: 'test.turn-engine-compaction-lease',
      create(input) {
        return {
          id: input.id || 'archive-created',
          userId: input.userId,
          sessionId: input.sessionId,
          replacedMessageCount: input.archivedMessages.length,
          archivedMessages: input.archivedMessages,
          summaryText: input.summaryText,
          createdAt: 1,
        }
      },
      get(input) {
        reads.push(input)
        return {
          id: input.id,
          userId: input.userId,
          sessionId: 'lease-session',
          replacedMessageCount: 1,
          archivedMessages: [{ id: 'old-message', role: 'user', content: 'old context' }],
          summaryText: 'LEASED ARCHIVE SUMMARY',
          createdAt: 1,
        }
      },
      cleanup() { return { removed: 0 } },
    }, { source: 'test.turn-engine-compaction-lease' })

    persistenceController.activate()
    compactionController.activate()
    try {
      const engine = getTurnEngine()
      assert.strictEqual(getTurnEngine(), engine)
      assert.equal(compaction.getCompactionArchivePortStatus().activeLeases, 1)

      const prepared = await engine.deps.preparePromptContext({
        userId: 'lease-owner',
        sessionId: 'lease-session',
        recentMessages: [{
          id: 'archive-reference',
          role: 'assistant',
          content: 'archive marker',
          meta: { archiveId: 'archive-leased' },
        }],
        includeRecentTranscript: false,
        env: { AGENT_INJECT_ENABLED: '0' },
      })
      assert.equal(reads.length, 1)
      assert.equal(Object.isFrozen(reads[0]), true)
      assert.equal(prepared.compactionArchiveId, 'archive-leased')
      assert.match(
        prepared.messages.map((message) => message.content).join('\\n'),
        /LEASED ARCHIVE SUMMARY/u,
      )

      const originalShutdown = engine.shutdown.bind(engine)
      let shutdownCalls = 0
      engine.shutdown = async () => {
        shutdownCalls += 1
        return originalShutdown()
      }
      const firstClose = closeTurnEngine()
      const secondClose = closeTurnEngine()
      assert.strictEqual(firstClose, secondClose)
      await secondClose
      assert.equal(shutdownCalls, 1)
      assert.equal(compaction.getCompactionArchivePortStatus().activeLeases, 0)
    } finally {
      await closeTurnEngine()
      assert.equal(compactionController.release(), true)
      assert.equal(persistenceController.release(), true)
    }
  `)

  assert.equal(
    result.status,
    0,
    [result.stdout, result.stderr].filter(Boolean).join('\n'),
  )
})

test('archive port authority stays inside the built-in loop context', () => {
  const compactionArchivePort = Object.freeze({ id: 'host-only-port' })
  const internal = createLoopContext({ compactionArchivePort })
  const external = createExternalToolLoopContext(internal)

  assert.equal(internal.model.compactionArchivePort, compactionArchivePort)
  assert.equal(external.model.compactionArchivePort, undefined)
})

test('context recovery receives the loop-scoped archive port', () => {
  const source = readFileSync(
    path.join(REPO_ROOT, 'server', 'services', 'loop', 'runtime-initializeSteering.js'),
    'utf8',
  )
  assert.match(
    source,
    /callModelWithContextRecovery\(\{[\s\S]*?compactionArchivePort:\s*s\.compactionArchivePort/u,
  )
})
