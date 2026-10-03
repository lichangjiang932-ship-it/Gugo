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

test('tool argument heartbeat throttles durable writes and retains truthful elapsed and idle metadata', async () => {
  let timestamp = 10_000
  let pending = null
  const events = []
  const heartbeat = createModelPhaseHeartbeat({
    iteration: 2, intervalMs: 5000, now: () => timestamp,
    onPhase: (event) => events.push(event),
    setTimer(callback) { pending = { callback }; return pending },
    clearTimer(handle) { if (pending === handle) pending = null },
  })
  const progress = async (at, chars, id = 'call-a') => {
    timestamp = 10_000 + at
    await heartbeat.recordToolProgress({ toolName: 'write_file', toolCallId: id,
      toolArgumentsChars: chars, arguments: 'never-visible', reasoning: 'never-visible' })
  }
  await heartbeat.beginRequest()
  assert.deepEqual(events[0], { phase: 'waiting_first_token', iteration: 2, elapsedMs: 0, idleMs: 0 })
  await progress(10, 3)
  for (let step = 1; step < 10; step += 1) await progress(10 + step * 100, 3 + step)
  assert.equal(events.length, 2, 'one active tool emits at most once within the first second')
  await progress(1010, 20)
  assert.deepEqual(events[2], { phase: 'tool_arguments', iteration: 2, elapsedMs: 1010, idleMs: 0,
    toolName: 'write_file', toolCallId: 'call-a', toolArgumentsChars: 20 })
  await progress(1011, 2, 'call-b')
  assert.equal(events.length, 4, 'switching tools is visible immediately')
  await progress(1511, 5, 'call-b')
  timestamp = 16_511
  pending.callback()
  await Promise.resolve()
  await Promise.resolve()
  assert.deepEqual(events.at(-1), { phase: 'idle', iteration: 2, elapsedMs: 6511, idleMs: 5000,
    toolName: 'write_file', toolCallId: 'call-b', toolArgumentsChars: 5 })
  await progress(6512, 8, 'call-b')
  assert.equal(events.at(-1).phase, 'tool_arguments', 'resumed output is visible without waiting for the throttle')
  timestamp += 10
  await heartbeat.recordDelta()
  assert.deepEqual(events.at(-1), { phase: 'streaming', iteration: 2, elapsedMs: 6522, idleMs: 0 })
  await heartbeat.beginRequest()
  assert.deepEqual(events.at(-1), { phase: 'waiting_first_token', iteration: 2, elapsedMs: 0, idleMs: 0 })
  const staleTimer = pending
  await heartbeat.stop()
  const count = events.length
  staleTimer.callback()
  await heartbeat.beginRequest()
  await heartbeat.recordDelta()
  await progress(20_000, 100)
  assert.equal(events.length, count, 'stopped requests never append new phase events')
  assert.equal(pending, null)
  assert.equal(JSON.stringify(events).includes('never-visible'), false)
})

test('fresh progress uses one clock sample even when the clock advances on every read', async () => {
  let timestamp = 10_000
  const events = []
  const heartbeat = createModelPhaseHeartbeat({
    now: () => timestamp++, intervalMs: 0, onPhase: (event) => events.push(event),
  })
  await heartbeat.beginRequest()
  await heartbeat.recordToolProgress({ toolName: 'read_file', toolCallId: 'clock-test', toolArgumentsChars: 1 })
  await heartbeat.recordDelta()
  await heartbeat.stop()
  assert.deepEqual(events.map(({ phase, elapsedMs, idleMs }) => ({ phase, elapsedMs, idleMs })), [
    { phase: 'waiting_first_token', elapsedMs: 0, idleMs: 0 },
    { phase: 'tool_arguments', elapsedMs: 1, idleMs: 0 },
    { phase: 'streaming', elapsedMs: 2, idleMs: 0 },
  ])
})

test('invalid tool progress cannot turn an otherwise silent request into activity', async () => {
  const events = []
  const heartbeat = createModelPhaseHeartbeat({ onPhase: (event) => events.push(event), intervalMs: 0 })
  await heartbeat.beginRequest()
  await heartbeat.recordToolProgress({ toolArgumentsChars: -1 })
  await heartbeat.recordToolProgress({ arguments: '{"path":"partial' })
  assert.deepEqual(events.map((event) => event.phase), ['waiting_first_token'])
  await heartbeat.stop()
})
