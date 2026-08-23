import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'

import { createCheckpointBarrier } from '../server/services/loop/checkpoint.js'

function boundedInteger(value, fallback, { min, max }) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

function boundedNumber(value, fallback, { min, max }) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)]
}

function opsPerSecond(iterations, durationMs) {
  return iterations / (durationMs / 1_000)
}

const iterations = boundedInteger(
  process.env.CHECKPOINT_BENCH_ITERATIONS,
  800,
  { min: 100, max: 20_000 },
)
const rounds = boundedInteger(
  process.env.CHECKPOINT_BENCH_ROUNDS,
  7,
  { min: 3, max: 15 },
)
const maxSlowdownRatio = boundedNumber(
  process.env.CHECKPOINT_BENCH_MAX_RATIO,
  3,
  { min: 1, max: 10 },
)
const warmupIterations = Math.min(200, iterations)
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-checkpoint-benchmark-'))
const previousAppDataDir = process.env.APP_DATA_DIR
process.env.APP_DATA_DIR = tempDir

let closeDb

try {
  const dbModule = await import('../server/db.js')
  const { upsertSession } = await import('../server/services/sessionStore.js')
  const { appendTurnEvent } = await import('../server/services/turnEventStore.js')
  const { createTurnEvent } = await import('../shared/turnEvents.js')
  const { createUser, getDb } = dbModule
  closeDb = dbModule.closeDb

  const userId = 'checkpoint-benchmark-user'
  const sessionId = 'checkpoint-benchmark-session'
  const benchmarkStartedAt = Date.now()
  createUser({
    id: userId,
    email: 'checkpoint-benchmark@example.invalid',
    now: benchmarkStartedAt,
  })
  upsertSession({
    id: sessionId,
    userId,
    title: 'Checkpoint benchmark',
    createdAt: benchmarkStartedAt,
  })

  const checkpointState = (sequence) => ({
    messages: [
      { role: 'user', content: 'Persist this state before the side effect.' },
      { role: 'assistant', content: 'Checkpoint acknowledged.' },
    ],
    iterations: sequence,
    toolCalls: [{ id: `call-${sequence}`, name: 'benchmark_tool' }],
    budget: { used: sequence, maxTotalCalls: 10_000 },
  })
  const startedEvent = ({ mode, round, turnId }) => createTurnEvent({
    id: `benchmark-${mode}-${round}-started`,
    sessionId,
    turnId,
    sequence: 0,
    type: 'turn.started',
    createdAt: benchmarkStartedAt,
  })
  const checkpointEvent = ({ mode, round, turnId, sequence }) => createTurnEvent({
    id: `benchmark-${mode}-${round}-${sequence}`,
    sessionId,
    turnId,
    sequence,
    type: 'turn.checkpoint',
    payload: {
      storage: 'turn_checkpoints',
      checkpointVersion: 1,
      iterations: sequence,
      toolCallCount: 1,
    },
    createdAt: benchmarkStartedAt + sequence,
  })

  const runAtomic = async (count, round) => {
    const turnId = `benchmark-atomic-${round}`
    appendTurnEvent({
      userId,
      event: startedEvent({ mode: 'atomic', round, turnId }),
    })
    const barrier = createCheckpointBarrier({
      stateFactory: ({ sequence }) => checkpointState(sequence),
      saveCheckpoint: (state, meta) => appendTurnEvent({
        userId,
        event: checkpointEvent({ mode: 'atomic', round, turnId, sequence: meta.sequence }),
        checkpointState: state,
      }),
    })
    const startedAt = performance.now()
    for (let sequence = 1; sequence <= count; sequence += 1) {
      await barrier.flush({ meta: { sequence } })
    }
    return performance.now() - startedAt
  }

  const runDirect = async (count, round) => {
    const turnId = `benchmark-direct-${round}`
    appendTurnEvent({
      userId,
      event: startedEvent({ mode: 'direct', round, turnId }),
    })
    const startedAt = performance.now()
    for (let sequence = 1; sequence <= count; sequence += 1) {
      const event = checkpointEvent({ mode: 'direct', round, turnId, sequence })
      appendTurnEvent({
        userId,
        event,
        checkpointState: checkpointState(sequence),
      })
    }
    return performance.now() - startedAt
  }

  await runDirect(warmupIterations, 'warmup')
  await runAtomic(warmupIterations, 'warmup')

  const atomicDurations = []
  const directDurations = []
  for (let round = 0; round < rounds; round += 1) {
    if (round % 2 === 0) {
      directDurations.push(await runDirect(iterations, round))
      atomicDurations.push(await runAtomic(iterations, round))
    } else {
      atomicDurations.push(await runAtomic(iterations, round))
      directDurations.push(await runDirect(iterations, round))
    }
  }

  const atomicMedianMs = median(atomicDurations)
  const directMedianMs = median(directDurations)
  const slowdownRatio = atomicMedianMs / directMedianMs
  const latestAtomic = getDb().prepare(`
    SELECT event_sequence AS sequence FROM turn_checkpoints
     WHERE user_id = ? AND session_id = ? AND turn_id = ?
  `).get(userId, sessionId, `benchmark-atomic-${rounds - 1}`)
  const latestDirect = getDb().prepare(`
    SELECT event_sequence AS sequence FROM turn_checkpoints
     WHERE user_id = ? AND session_id = ? AND turn_id = ?
  `).get(userId, sessionId, `benchmark-direct-${rounds - 1}`)
  assert.equal(latestAtomic?.sequence, iterations)
  assert.equal(latestDirect?.sequence, iterations)

  assert.ok(
    slowdownRatio <= maxSlowdownRatio,
    `Atomic checkpoint path regressed to ${slowdownRatio.toFixed(2)}x `
      + `(limit ${maxSlowdownRatio.toFixed(2)}x)`,
  )
  process.stdout.write([
    'Loop checkpoint benchmark (median)',
    `  workload: ${iterations} checkpoints x ${rounds} rounds`,
    `  direct atomic transaction: ${directMedianMs.toFixed(2)} ms, `
      + `${opsPerSecond(iterations, directMedianMs).toFixed(0)} ops/s`,
    `  atomic barrier + transaction: ${atomicMedianMs.toFixed(2)} ms, `
      + `${opsPerSecond(iterations, atomicMedianMs).toFixed(0)} ops/s`,
    `  atomic/direct ratio: ${slowdownRatio.toFixed(2)}x `
      + `(non-flaky ceiling: ${maxSlowdownRatio.toFixed(2)}x)`,
    '  result: PASS',
    '',
  ].join('\n'))
} finally {
  closeDb?.()
  fs.rmSync(tempDir, { recursive: true, force: true })
  if (previousAppDataDir === undefined) delete process.env.APP_DATA_DIR
  else process.env.APP_DATA_DIR = previousAppDataDir
}
