import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveClientId,
  recordPasswordFailure,
  isAccountLocked,
  clearPasswordFailures,
  _resetLoginGuard,
} from '../server/utils/loginGuard.js'

test.beforeEach(() => _resetLoginGuard())

test('resolveClientId ignores x-forwarded-for unless proxy is trusted', () => {
  const req = {
    headers: { 'x-forwarded-for': '1.2.3.4' },
    socket: { remoteAddress: '10.0.0.9' },
  }
  // default: do not trust XFF
  assert.equal(resolveClientId(req, {}), '10.0.0.9')
  // trusted proxy: take leftmost XFF
  assert.equal(resolveClientId(req, { TRUST_PROXY: '1' }), '1.2.3.4')
})

test('resolveClientId takes leftmost hop from XFF chain when trusted', () => {
  const req = {
    headers: { 'x-forwarded-for': '5.6.7.8, 9.9.9.9' },
    socket: { remoteAddress: '10.0.0.1' },
  }
  assert.equal(resolveClientId(req, { TRUST_PROXY: '1' }), '5.6.7.8')
})

test('account lockout: locks after MAX failures, separate from any code window', () => {
  const email = 'lock@example.com'
  let now = 1000
  const clock = () => now
  for (let i = 0; i < 5; i += 1) {
    assert.equal(isAccountLocked(email, { now: clock }), false, `not locked before ${i + 1} failures`)
    recordPasswordFailure(email, { now: clock })
  }
  assert.equal(isAccountLocked(email, { now: clock }), true, 'locked after 5 failures')
})

test('account lockout expires after window', () => {
  const email = 'expire@example.com'
  let now = 1000
  const clock = () => now
  for (let i = 0; i < 5; i += 1) recordPasswordFailure(email, { now: clock })
  assert.equal(isAccountLocked(email, { now: clock }), true)
  now += 15 * 60 * 1000 + 1
  assert.equal(isAccountLocked(email, { now: clock }), false, 'unlocks after window')
})

test('clearPasswordFailures resets the counter on success', () => {
  const email = 'clear@example.com'
  let now = 1000
  const clock = () => now
  for (let i = 0; i < 4; i += 1) recordPasswordFailure(email, { now: clock })
  clearPasswordFailures(email)
  recordPasswordFailure(email, { now: clock })
  assert.equal(isAccountLocked(email, { now: clock }), false, 'counter reset, single failure does not lock')
})
