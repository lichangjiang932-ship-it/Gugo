import assert from 'node:assert/strict'
import test from 'node:test'

import { createTurnRunRegistry } from '../src/pages/ChatSplit/turnRunRegistry.js'

test('turn registry keeps a background turn addressable after its view detaches', () => {
  const registry = createTurnRunRegistry()
  const controller = new AbortController()
  let changes = 0
  const unsubscribe = registry.subscribe(() => { changes += 1 })

  const first = registry.register({ sessionId: 'session-a', turnId: 'turn-a', controller })
  assert.equal(registry.get('session-a'), first)
  assert.equal(registry.has('session-a', 'turn-a'), true)
  assert.equal(changes, 1)

  unsubscribe()
  assert.equal(registry.get('session-a')?.controller, controller)
})

test('turn registry prevents duplicate subscriptions and stale cleanup', () => {
  const registry = createTurnRunRegistry()
  const firstController = new AbortController()
  const duplicateController = new AbortController()
  registry.register({ sessionId: 'session-a', turnId: 'turn-a', controller: firstController })

  assert.throws(() => registry.register({
    sessionId: 'session-a',
    turnId: 'turn-a',
    controller: duplicateController,
  }), { code: 'SESSION_TURN_ALREADY_RUNNING' })
  assert.throws(() => registry.register({
    sessionId: 'session-a',
    turnId: 'turn-b',
    controller: duplicateController,
  }), { code: 'SESSION_TURN_ALREADY_RUNNING' })
  assert.equal(registry.unregister({ sessionId: 'session-a', turnId: 'turn-a', controller: duplicateController }), false)
  assert.equal(registry.has('session-a', 'turn-a'), true)
  assert.equal(registry.unregister({ sessionId: 'session-a', turnId: 'turn-a', controller: firstController }), true)
  assert.equal(registry.get('session-a'), null)
})

test('only an explicit cancel aborts the registered turn', () => {
  const registry = createTurnRunRegistry()
  const controller = new AbortController()
  registry.register({ sessionId: 'session-a', turnId: 'turn-a', controller })

  assert.equal(controller.signal.aborted, false)
  assert.equal(registry.get('missing'), null)
  assert.equal(controller.signal.aborted, false, 'reading or leaving a view must not abort')
  assert.equal(registry.cancel('session-a'), true)
  assert.equal(controller.signal.aborted, true)
  assert.equal(registry.cancel('missing'), false)
})
