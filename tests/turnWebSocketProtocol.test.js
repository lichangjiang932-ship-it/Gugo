import assert from 'node:assert/strict'
import test from 'node:test'
import { createTurnEventTransportEnvelope } from '../shared/turnEvents.js'
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

test('turn WebSocket protocol accepts only the declared runtime recovery actions', () => {
  for (const action of ['retry', 'restart_runtime']) {
    const frame = createTurnWebSocketFrame('error', {
      code: 'TURN_ENGINE_UNAVAILABLE',
      message: 'turn runtime is unavailable',
      action,
    })
    assert.deepEqual(validateTurnWebSocketServerFrame(frame), { ok: true, value: frame })
  }

  const invalid = createTurnWebSocketFrame('error', {
    code: 'TURN_ENGINE_UNAVAILABLE',
    action: 'restart_automatically',
  })
  assert.equal(validateTurnWebSocketServerFrame(invalid).ok, false)
})

test('turn WebSocket protocol validates event and activity payload fields', () => {
  const event = {
    id: 'event-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    sequence: 0,
    type: 'heartbeat',
    payload: { at: 1 },
    createdAt: 1,
  }
  const activity = {
    sessionId: 'session-1',
    turnId: 'turn-1',
    kind: 'tool_call_ready',
    toolName: 'read_file',
    createdAt: 1,
  }
  const eventFrame = createTurnWebSocketFrame('turn.event', { event })
  const activityFrame = createTurnWebSocketFrame('turn.activity', { activity })
  assert.deepEqual(validateTurnWebSocketServerFrame(eventFrame), { ok: true, value: eventFrame })
  assert.deepEqual(eventFrame, createTurnEventTransportEnvelope(event))
  assert.deepEqual(validateTurnWebSocketServerFrame(activityFrame), { ok: true, value: activityFrame })

  const removedField = createTurnWebSocketFrame('turn.event', {
    event: { ...event, sequence: undefined },
  })
  const addedField = createTurnWebSocketFrame('turn.activity', {
    activity: { ...activity, unexpected: true },
  })
  assert.equal(validateTurnWebSocketServerFrame(removedField).ok, false)
  assert.equal(validateTurnWebSocketServerFrame(addedField).ok, false)
})

test('turn WebSocket protocol validates approval result compatibility', () => {
  const approval = {
    id: 'approval-1',
    userId: 'user-1',
    origin: 'chat',
    jobId: null,
    stepId: null,
    sessionId: 'session-1',
    toolName: 'bash_exec',
    args: { command: 'git status' },
    risk: 'medium',
    metadataSource: 'declared',
    reason: null,
    status: 'approved',
    decidedArgs: null,
    effectiveArgs: { command: 'git status' },
    decidedBy: 'user-1',
    decidedAt: 2,
    expiresAt: 10,
    createdAt: 1,
    updatedAt: 2,
  }
  const result = {
    ok: true,
    alreadyDecided: false,
    approval,
    modeTransition: null,
    approvalSettings: null,
    rememberedTools: null,
    rememberedGrants: null,
  }
  const frame = createTurnWebSocketFrame('approval.resolved', {
    approvalId: approval.id,
    result,
  })
  assert.deepEqual(validateTurnWebSocketServerFrame(frame), { ok: true, value: frame })

  const removedField = createTurnWebSocketFrame('approval.resolved', {
    approvalId: approval.id,
    result: { ...result, modeTransition: undefined },
  })
  const addedField = createTurnWebSocketFrame('approval.resolved', {
    approvalId: approval.id,
    result: { ...result, approval: { ...approval, unexpected: true } },
  })
  assert.equal(validateTurnWebSocketServerFrame(removedField).ok, false)
  assert.equal(validateTurnWebSocketServerFrame(addedField).ok, false)
})
