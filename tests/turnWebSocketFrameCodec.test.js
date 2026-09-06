import assert from 'node:assert/strict'
import test from 'node:test'
import {
  decodeTurnWebSocketClientFrame,
  encodeTurnWebSocketEvent,
  encodeTurnWebSocketServerFrame,
} from '../server/core/turnWebSocketFrameCodec.js'
import {
  createTurnEvent,
  createTurnEventTransportEnvelope,
  parseTurnEventTransportPayload,
} from '../shared/turnEvents.js'
import { createTurnWebSocketFrame, validateTurnWebSocketServerFrame } from '../shared/turnWebSocketProtocol.js'

test('checked codec preserves v1 JSON and the existing invalid-JSON and version rejections', () => {
  const frame = createTurnWebSocketFrame('subscribe.turn', { sessionId: 'session', turnId: 'turn', after: -1 })
  assert.deepEqual(decodeTurnWebSocketClientFrame(JSON.stringify(frame)), { ok: true, value: frame })
  assert.deepEqual(decodeTurnWebSocketClientFrame('{invalid'), { ok: false, code: 'INVALID_JSON' })
  const version = decodeTurnWebSocketClientFrame(JSON.stringify({ ...frame, v: 2 }))
  assert.equal(version.ok, false)
  assert.equal(version.code, 'VERSION_MISMATCH')
  assert.equal(version.expectedVersion, 1)
  assert.equal(version.receivedVersion, 2)
  const fields = decodeTurnWebSocketClientFrame(JSON.stringify({ ...frame, after: 'latest' }))
  assert.equal(fields.ok, false)
  assert.equal(fields.code, 'INVALID_FRAME')
})

test('checked server encoding retains the durable-event envelope and separate activity frames', () => {
  const event = createTurnEvent({
    id: 'event', sessionId: 'session', turnId: 'turn', type: 'heartbeat',
    sequence: 0, payload: { at: 1 }, createdAt: 1,
  })
  const serialized = encodeTurnWebSocketEvent(event)
  const frame = JSON.parse(serialized)
  assert.deepEqual(frame, createTurnEventTransportEnvelope(event))
  assert.deepEqual(parseTurnEventTransportPayload(frame), event)
  assert.deepEqual(parseTurnEventTransportPayload(event), event)
  assert.throws(() => parseTurnEventTransportPayload({ ...frame, v: 2 }), /invalid|Invalid/u)
  assert.throws(() => encodeTurnWebSocketEvent({ ...event, payload: { at: 'wrong' } }))
  const activity = createTurnWebSocketFrame('turn.activity', {
    activity: { sessionId: 'session', turnId: 'turn', kind: 'tool_call_ready', toolName: 'read_file', createdAt: 1 },
  })
  assert.deepEqual(JSON.parse(encodeTurnWebSocketServerFrame(activity)), activity)
  assert.equal(validateTurnWebSocketServerFrame(activity).ok, true)
})
