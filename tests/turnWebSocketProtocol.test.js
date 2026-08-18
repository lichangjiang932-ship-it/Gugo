import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createTurnWebSocketFrame,
  validateTurnWebSocketClientFrame,
  validateTurnWebSocketServerFrame,
} from '../shared/turnWebSocketProtocol.js'

test('turn WebSocket protocol accepts exact v1 client and server frames', () => {
  const subscribe = createTurnWebSocketFrame('subscribe.turn', {
    sessionId: 'session-1',
    turnId: 'turn-1',
    after: -1,
  })
  assert.deepEqual(validateTurnWebSocketClientFrame(subscribe), { ok: true, value: subscribe })

  const ready = createTurnWebSocketFrame('ready')
  assert.deepEqual(validateTurnWebSocketServerFrame(ready), { ok: true, value: ready })
})

test('turn WebSocket protocol rejects missing and incompatible versions', () => {
  const missing = validateTurnWebSocketClientFrame({
    type: 'subscribe.turn', sessionId: 'session-1', turnId: 'turn-1', after: -1,
  })
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'VERSION_MISMATCH')
  assert.equal(missing.receivedVersion, null)

  const incompatible = validateTurnWebSocketServerFrame({ v: 2, type: 'ready' })
  assert.equal(incompatible.ok, false)
  assert.equal(incompatible.code, 'VERSION_MISMATCH')
  assert.equal(incompatible.expectedVersion, 1)
  assert.equal(incompatible.receivedVersion, 2)
})

test('turn WebSocket protocol rejects unknown fields and malformed payloads', () => {
  const malformed = validateTurnWebSocketClientFrame({
    v: 1,
    type: 'subscribe.turn',
    sessionId: '',
    turnId: 'turn-1',
    after: 'latest',
    unexpected: true,
  })
  assert.equal(malformed.ok, false)
  assert.equal(malformed.code, 'INVALID_FRAME')
  assert.ok(malformed.issues.length > 0)
})
