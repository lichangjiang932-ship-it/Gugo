import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const repoDir = path.dirname(testDir)
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-turn-model-recovery-runtime-'))
const markerPath = path.join(tempDir, 'provider-record.json')
const previousDataDir = process.env.APP_DATA_DIR
process.env.APP_DATA_DIR = tempDir

const userId = 'turn-model-recovery-runtime-user'
const sessionId = 'turn-model-recovery-runtime-session'
const turnId = 'turn-model-recovery-runtime-turn'
const toolImplementations = Object.freeze({
  version: 1,
  builtinRevision: `sha256-${'a'.repeat(64)}`,
  connectorRevision: null,
  mcpTools: [],
})

const crashed = spawnSync(
  process.execPath,
  [path.join(testDir, 'fixtures', 'turnModelRecoveryCrash.mjs')],
  {
    cwd: repoDir,
    env: {
      ...process.env,
      APP_DATA_DIR: tempDir,
      TURN_MODEL_RECOVERY_MARKER: markerPath,
    },
    encoding: 'utf8',
    timeout: 30_000,
  },
)

const { closeDb } = await import('../server/db.js')
const { TurnEngine } = await import('../server/services/TurnEngine.js')
const { runToolLoop } = await import('../server/services/loop/index.js')
const { listMessages } = await import('../server/services/sessionStore.js')
const { listTurnEvents } = await import('../server/services/turnEventStore.js')
const { getTurnCheckpoint } = await import('../server/services/turnCheckpointStore.js')
const { createTurnExecutionLeaseCoordinator } = await import('../server/services/turnExecutionLeaseRuntime.js')
const {
  getPendingModelRequestRecovery,
  resolvePendingModelRequest,
} = await import('../server/services/modelRequestRecoveryService.js')

test.after(() => {
  closeDb()
  if (previousDataDir === undefined) delete process.env.APP_DATA_DIR
  else process.env.APP_DATA_DIR = previousDataDir
  fs.rmSync(tempDir, { recursive: true, force: true })
})

test('TurnEngine consumes a verified completed response after a process crash without calling the provider again', async () => {
  assert.equal(crashed.error, undefined, crashed.error?.message)
  assert.equal(crashed.status, 86, `${crashed.stdout}\n${crashed.stderr}`)
  const providerRecord = JSON.parse(fs.readFileSync(markerPath, 'utf8'))
  assert.equal(providerRecord.providerCalls, 1)

  const checkpoint = getTurnCheckpoint({ userId, sessionId, turnId })
  assert.equal(checkpoint?.state?.modelInvocation?.status, 'in_flight')
  const pending = await getPendingModelRequestRecovery({ userId, sessionId, turnId })
  assert.equal(pending.modelRequestId, checkpoint.state.modelInvocation.id)

  const resolved = await resolvePendingModelRequest({
    userId,
    sessionId,
    turnId,
    expectedCheckpointSequence: pending.checkpointSequence,
    modelRequestId: pending.modelRequestId,
    requestFingerprint: pending.requestFingerprint,
    providerId: pending.providerId,
    modelName: pending.modelName,
    configRevision: pending.configRevision,
    idempotencyKey: pending.idempotencyKey,
    verificationConfirmed: true,
    confirmModelRequestId: pending.modelRequestId,
    resolution: 'completed',
    response: providerRecord.response,
    receipt: providerRecord.receipt,
  })
  assert.equal(resolved.status, 'resolved_pending_resume')

  let recoveryProviderCalls = 0
  await new Promise((resolve) => setTimeout(resolve, 1_100))
  const engine = new TurnEngine({
    runLoop: runToolLoop,
    scheduleMemoryExtraction: () => {},
    executionLeases: createTurnExecutionLeaseCoordinator({
      ownerId: 'turn-model-recovery-resumed-worker',
      leaseMs: 1_000,
    }),
    toolSpecs: [],
    readApprovalMode: () => 'normal',
    readFileAccessStatus: () => ({ grants: [] }),
    readRuntimePlugins: () => [],
    readRuntimePluginStates: () => [],
    resolveToolSpecs: async () => [],
    resolveToolImplementationRevisions: () => toolImplementations,
    runModel: async () => {
      recoveryProviderCalls += 1
      return { content: 'duplicate provider response', toolCalls: [] }
    },
  })

  await engine.resumeTurn({ userId, sessionId, turnId })
  await engine.waitForTurn({ userId, sessionId, turnId })

  assert.equal(recoveryProviderCalls, 0)
  assert.equal(
    listTurnEvents({ userId, sessionId, turnId, limit: 100 }).at(-1)?.type,
    'turn.completed',
  )
  assert.equal(
    listMessages({ userId, sessionId, limit: 100 })
      .find((message) => message.id === `${turnId}:assistant`)?.content,
    providerRecord.response.content,
  )
})
