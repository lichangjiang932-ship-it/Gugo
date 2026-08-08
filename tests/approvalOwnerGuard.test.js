import assert from 'node:assert/strict'
import test from 'node:test'

import { createApprovalEpochGuard, createApprovalOwnerGuard } from '../src/pages/ChatSplit/approvalOwnerGuard.js'

test('stale approval owners cannot resolve or release the current turn', () => {
  const guard = createApprovalOwnerGuard()
  const oldOwner = { sessionId: 'session-a', turnId: 'turn-old' }
  const currentOwner = { sessionId: 'session-a', turnId: 'turn-current' }

  guard.claim(oldOwner)
  guard.claim(currentOwner)

  assert.equal(guard.matches(oldOwner), false)
  assert.equal(guard.release(oldOwner), false)
  assert.equal(guard.matches(currentOwner), true)
  assert.equal(guard.release(currentOwner), true)
})

test('approval ownership includes the session as well as the turn id', () => {
  const guard = createApprovalOwnerGuard()
  guard.claim({ sessionId: 'session-a', turnId: 'shared-turn' })

  assert.equal(guard.matches({ sessionId: 'session-b', turnId: 'shared-turn' }), false)
  assert.equal(guard.matches({ sessionId: 'session-a', turnId: 'shared-turn' }), true)
})

test('a stale approval completion cannot close a newer approval', () => {
  const guard = createApprovalEpochGuard()
  guard.advance()
  const firstResolution = guard.current()

  guard.advance()

  assert.equal(guard.isCurrent(firstResolution), false)
  assert.equal(guard.isCurrent(guard.current()), true)
})
