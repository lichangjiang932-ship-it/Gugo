import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

process.env.APP_DATA_DIR = path.join(os.tmpdir(), 'gugo-turn-recovery-state-tests', String(process.pid))

const {
  clearTurnRecoveryState,
  getTurnRecoveryState,
  listTurnRecoveryStates,
  recordTurnRecoveryFailure,
} = await import('../server/services/turnRecoveryStateStore.js')

const CONCURRENT_WRITER = fileURLToPath(new URL(
  './fixtures/turnRecoveryStateWriter.mjs',
  import.meta.url,
))

function runConcurrentWriter({ scope, candidateVersion, attempts }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      CONCURRENT_WRITER,
      JSON.stringify(scope),
      candidateVersion,
      String(attempts),
    ], {
      cwd: process.cwd(),
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => { output += chunk })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`recovery writer failed (${code ?? signal}): ${output}`))
    })
  })
}

test('recovery state persists exponential retry progress and opens at its budget', () => {
  const scope = { userId: 'state-user', sessionId: 'state-session', turnId: 'state-turn' }
  clearTurnRecoveryState(scope)
  const first = recordTurnRecoveryFailure({
    ...scope,
    candidateVersion: '1:turn.started:10',
    retryable: true,
    errorCode: 'TEMPORARY',
    errorMessage: 'temporary failure',
    now: 1_000,
    maxAttempts: 3,
    baseDelayMs: 100,
    maxDelayMs: 200,
    random: () => 0,
  })
  assert.equal(first.status, 'retrying')
  assert.equal(first.attemptCount, 1)
  assert.equal(first.nextRetryAt, 1_050)

  const second = recordTurnRecoveryFailure({
    ...scope,
    candidateVersion: '1:turn.started:10',
    retryable: true,
    errorCode: 'TEMPORARY',
    errorMessage: 'temporary failure',
    now: 1_050,
    maxAttempts: 3,
    baseDelayMs: 100,
    maxDelayMs: 200,
    random: () => 0,
  })
  assert.equal(second.attemptCount, 2)
  assert.equal(second.firstFailedAt, 1_000)
  assert.equal(second.nextRetryAt, 1_150)

  const third = recordTurnRecoveryFailure({
    ...scope,
    candidateVersion: '1:turn.started:10',
    retryable: true,
    errorCode: 'TEMPORARY',
    errorMessage: 'temporary failure',
    now: 1_150,
    maxAttempts: 3,
    baseDelayMs: 100,
    maxDelayMs: 200,
    random: () => 0,
  })
  assert.equal(third.status, 'dead_letter')
  assert.equal(third.attemptCount, 3)
  assert.equal(third.nextRetryAt, null)
  assert.deepEqual(getTurnRecoveryState(scope), third)
  assert.ok(listTurnRecoveryStates({ status: 'dead_letter' }).some((item) => item.turnId === scope.turnId))
  assert.equal(clearTurnRecoveryState(scope, { candidateVersion: 'different' }), false)
  assert.equal(clearTurnRecoveryState(scope, { candidateVersion: third.candidateVersion }), true)
  assert.equal(getTurnRecoveryState(scope), null)
})

test('non-retryable recovery errors dead-letter immediately and a new version resets the count', () => {
  const scope = { userId: 'unsafe-user', sessionId: 'unsafe-session', turnId: 'unsafe-turn' }
  clearTurnRecoveryState(scope)
  const unsafe = recordTurnRecoveryFailure({
    ...scope,
    candidateVersion: '2:turn.checkpoint:20',
    retryable: false,
    errorCode: 'MODEL_REQUEST_OUTCOME_UNKNOWN',
    errorMessage: 'outcome unknown',
    now: 2_000,
  })
  assert.equal(unsafe.status, 'dead_letter')
  assert.equal(unsafe.attemptCount, 1)
  assert.equal(unsafe.retryable, false)

  const reset = recordTurnRecoveryFailure({
    ...scope,
    candidateVersion: '3:turn.resumed:30',
    retryable: true,
    errorCode: 'TEMPORARY',
    errorMessage: 'new version failure',
    now: 3_000,
    random: () => 0,
  })
  assert.equal(reset.status, 'retrying')
  assert.equal(reset.attemptCount, 1)
  assert.equal(reset.firstFailedAt, 3_000)
  clearTurnRecoveryState(scope)
})

test('a delayed lower-sequence candidate cannot replace newer recovery state', () => {
  const scope = { userId: 'late-user', sessionId: 'late-session', turnId: 'late-turn' }
  clearTurnRecoveryState(scope)
  const current = recordTurnRecoveryFailure({
    ...scope,
    candidateVersion: '9:turn.checkpoint:900',
    retryable: true,
    errorCode: 'CURRENT_FAILURE',
    errorMessage: 'current failure',
    now: 9_000,
    random: () => 0,
  })
  const delayed = recordTurnRecoveryFailure({
    ...scope,
    candidateVersion: '8:turn.started:800',
    retryable: false,
    errorCode: 'STALE_FAILURE',
    errorMessage: 'stale failure',
    now: 10_000,
  })

  assert.deepEqual(delayed, current)
  assert.deepEqual(getTurnRecoveryState(scope), current)
  clearTurnRecoveryState(scope)
})

test('same-sequence candidates with different event identity cannot replace each other', () => {
  const scope = { userId: 'conflict-user', sessionId: 'conflict-session', turnId: 'conflict-turn' }
  clearTurnRecoveryState(scope)
  const current = recordTurnRecoveryFailure({
    ...scope,
    candidateVersion: '12:turn.checkpoint:1',
    retryable: true,
    errorCode: 'CURRENT_FAILURE',
    errorMessage: 'current failure',
    now: 12_000,
    random: () => 0,
  })
  const conflict = recordTurnRecoveryFailure({
    ...scope,
    candidateVersion: '12:turn.resumed:2',
    retryable: false,
    errorCode: 'CONFLICTING_FAILURE',
    errorMessage: 'conflicting failure',
    now: 13_000,
  })

  assert.deepEqual(conflict, current)
  assert.deepEqual(getTurnRecoveryState(scope), current)
  clearTurnRecoveryState(scope)
})

test('concurrent writers atomically increment one candidate without lost attempts', async () => {
  const scope = {
    userId: `concurrent-user-${process.pid}`,
    sessionId: 'concurrent-session',
    turnId: 'concurrent-turn',
  }
  const candidateVersion = '20:turn.checkpoint:2000'
  const writerCount = 4
  const attemptsPerWriter = 6
  clearTurnRecoveryState(scope)

  await Promise.all(Array.from({ length: writerCount }, () => runConcurrentWriter({
    scope,
    candidateVersion,
    attempts: attemptsPerWriter,
  })))

  const state = getTurnRecoveryState(scope)
  assert.equal(state.candidateVersion, candidateVersion)
  assert.equal(state.attemptCount, writerCount * attemptsPerWriter)
  assert.equal(state.status, 'retrying')
  clearTurnRecoveryState(scope)
})

test('invalid candidate identities fail closed before mutating persisted state', () => {
  const scope = { userId: 'invalid-user', sessionId: 'invalid-session', turnId: 'invalid-turn' }
  clearTurnRecoveryState(scope)

  assert.throws(() => recordTurnRecoveryFailure({
    ...scope,
    candidateVersion: 'not-an-event-identity',
  }), { code: 'TURN_RECOVERY_CANDIDATE_INVALID' })
  assert.equal(getTurnRecoveryState(scope), null)
})
