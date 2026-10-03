import test from 'node:test'
import assert from 'node:assert/strict'

import { normalizeModelPhaseProgress } from '../shared/modelPhaseProgress.js'
import { createTurnEvent, parseTurnEvent } from '../shared/turnEvents.js'
import { createToolArgumentProgressTracker } from '../server/adapters/modelStreamProgress.js'

test('model progress exposes only bounded metadata and round-trips through the durable protocol', () => {
  const metadata = normalizeModelPhaseProgress({
    toolName: 'write_file', toolCallId: 'call-progress', toolArgumentsChars: 42,
    elapsedMs: 5000, idleMs: 50, arguments: '{"secret":"not-visible"', reasoning: 'not-visible',
    phase: 'forged', index: 8,
  })
  assert.deepEqual(metadata, {
    toolName: 'write_file', toolCallId: 'call-progress', toolArgumentsChars: 42, elapsedMs: 5000, idleMs: 50,
  })
  const event = createTurnEvent({
    id: 'progress-1', sessionId: 'session-1', turnId: 'turn-1', sequence: 1,
    createdAt: 10_000, type: 'model.phase', payload: { phase: 'tool_arguments', iteration: 0, ...metadata },
  })
  assert.deepEqual(parseTurnEvent(JSON.parse(JSON.stringify(event))), event)
  assert.throws(() => parseTurnEvent({ ...event, payload: { ...event.payload, arguments: '{}' } }))
  assert.throws(() => parseTurnEvent({ ...event, payload: { ...event.payload, toolName: 'bad\nname' } }))
})

test('model progress rejects invalid counts and unsafe identities without leaking other values', () => {
  for (const invalid of [NaN, Infinity, -Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '10', null]) {
    assert.deepEqual(normalizeModelPhaseProgress({ toolArgumentsChars: invalid, elapsedMs: invalid, idleMs: invalid }), {})
  }
  for (const invalid of ['', ' spaced', 'spaced ', 'line\nbreak', 'null\0byte', 'delete\x7f', {}, 42]) {
    assert.deepEqual(normalizeModelPhaseProgress({ toolName: invalid, toolCallId: invalid }), {})
  }
  assert.deepEqual(normalizeModelPhaseProgress({ toolName: 'x'.repeat(161), toolCallId: 'x'.repeat(501) }), {})
  for (const invalid of [null, [], false, 3, 'metadata']) assert.deepEqual(normalizeModelPhaseProgress(invalid), {})
  assert.deepEqual(normalizeModelPhaseProgress({ toolArgumentsChars: 0, elapsedMs: Number.MAX_SAFE_INTEGER, idleMs: 0 }),
    { toolArgumentsChars: 0, elapsedMs: Number.MAX_SAFE_INTEGER, idleMs: 0 })
})

test('tool argument progress counts meaningful growth and replacement without exposing partial JSON', () => {
  const track = createToolArgumentProgressTracker()
  const call = { id: 'call-a', name: 'write_file', arguments: '' }
  assert.equal(track(call), null)
  call.arguments = '  '
  assert.equal(track(call), null)
  call.arguments += '{"content":"私'
  assert.deepEqual(track(call), { type: 'tool_call_progress', index: 0,
    toolName: 'write_file', toolCallId: 'call-a', toolArgumentsChars: call.arguments.length })
  assert.equal(track(call), null, 'repeated snapshots are not output progress')
  call.arguments += '  '
  assert.equal(track(call), null, 'whitespace-only growth is not output progress')
  call.arguments += '密"}'
  assert.equal(track(call).toolArgumentsChars, call.arguments.length)
  call.arguments = '{"content":"replaced"}'
  assert.equal(track(call).toolArgumentsChars, call.arguments.length)
  assert.equal(track(call), null)
  assert.deepEqual(track({ id: 'call-b', function: { name: 'read_file', arguments: '{' } }, 1),
    { type: 'tool_call_progress', index: 1, toolName: 'read_file', toolCallId: 'call-b', toolArgumentsChars: 1 })
})
