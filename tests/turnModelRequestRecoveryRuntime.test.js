import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
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

// Load the recovery process before crashing its predecessor. Import latency
// must not accidentally stand in for waiting for the crashed worker's lease.
const { closeDb } = await import('../server/db.js')
const { TurnEngine } = await import('../server/services/TurnEngine.js')
const { runToolLoop } = await import('../server/services/loop/index.js')
const { listMessages } = await import('../server/services/sessionStore.js')
const { listTurnEvents } = await import('../server/services/turnEventStore.js')
const { getTurnCheckpoint } = await import('../server/services/turnCheckpointStore.js')
const { createTurnExecutionLeaseCoordinator } = await import('../server/services/turnExecutionLeaseRuntime.js')
const { getTurnExecutionLease, isTurnExecutionLeaseActive } = await import('../server/services/turnExecutionLeaseStore.js')
const {
  getPendingModelRequestRecovery,
  readModelRequestRecoveryResolution,
  resolvePendingModelRequest,
} = await import('../server/services/modelRequestRecoveryService.js')

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
  const resolutionInput = {
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
  }

  // process.exit(86) cannot execute the old worker's release finally block.
  // Manual reconciliation is safe only after its durable lease really expires.
  const scope = { userId, sessionId, turnId }
  const crashedLease = getTurnExecutionLease(scope)
  assert.equal(crashedLease?.ownerId, 'turn-model-recovery-crashed-worker')
  const observedAt = Date.now()
  if (isTurnExecutionLeaseActive(scope, observedAt)) {
    // Pin this rejection assertion to the real observed time so a host pause
    // at expiry cannot turn it into a successful resolution. Success below
    // uses the live clock after the durable lease has actually expired.
    await assert.rejects(() => resolvePendingModelRequest({ ...resolutionInput, now: () => observedAt }),
      (error) => error.code === 'MODEL_REQUEST_RECOVERY_EXECUTION_ACTIVE')
    assert.deepEqual(getTurnCheckpoint(scope), checkpoint, 'active-lease rejection must preserve the checkpoint')
    assert.equal(readModelRequestRecoveryResolution({ ...scope, invocation: checkpoint.state.modelInvocation }), null)
  }
  const leaseWaitDeadline = performance.now() + 5_000
  while (isTurnExecutionLeaseActive(scope)) {
    assert.ok(performance.now() < leaseWaitDeadline, 'the crashed worker lease must expire before manual recovery')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.deepEqual(getTurnExecutionLease(scope), crashedLease, 'waiting must not delete, rewrite or steal the old lease')
  assert.deepEqual(getTurnCheckpoint(scope), checkpoint, 'waiting must preserve the unknown model request')

  const resolved = await resolvePendingModelRequest(resolutionInput)
  assert.equal(resolved.status, 'resolved_pending_resume')

  let recoveryProviderCalls = 0
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
  assert.equal(getTurnExecutionLease(scope), null, 'normal completion must release the resumed worker lease')
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
