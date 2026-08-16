import test from 'node:test'
import assert from 'node:assert/strict'

import { createModelPhaseHeartbeat } from '../server/services/modelPhaseHeartbeat.js'

test('model phase heartbeat exposes cold start, stream idle, and resumed output', async () => {
  const phases = []
  let pendingTimer = null
  const setTimer = (callback) => {
    const handle = { callback, unref() {} }
    pendingTimer = handle
    return handle
  }
  const clearTimer = (handle) => {
    if (pendingTimer === handle) pendingTimer = null
  }
  const fireTimer = async () => {
    const handle = pendingTimer
    pendingTimer = null
    handle?.callback()
    await Promise.resolve()
    await Promise.resolve()
  }
  const heartbeat = createModelPhaseHeartbeat({
    onPhase: (event) => phases.push(event.phase),
    iteration: 4,
    intervalMs: 10,
    setTimer,
    clearTimer,
  })

  await heartbeat.beginRequest()
  await fireTimer()
  await heartbeat.recordDelta()
  await fireTimer()
  await heartbeat.recordDelta()

  assert.deepEqual(phases, [
    'waiting_first_token',
    'waiting_first_token',
    'streaming',
    'idle',
    'streaming',
  ])

  await heartbeat.stop()
  assert.equal(pendingTimer, null)
  await fireTimer()
  assert.equal(phases.length, 5)
})

test('model phase heartbeat resets to waiting for each context-recovery request', async () => {
  const phases = []
  const heartbeat = createModelPhaseHeartbeat({
    onPhase: ({ phase }) => phases.push(phase),
    intervalMs: 0,
  })

  await heartbeat.beginRequest()
  await heartbeat.recordDelta()
  await heartbeat.beginRequest()
  await heartbeat.stop()

  assert.deepEqual(phases, ['waiting_first_token', 'streaming', 'waiting_first_token'])
})
