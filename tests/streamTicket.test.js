import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStreamTicket, consumeStreamTicket, _clearStreamTickets } from '../server/utils/streamTicket.js'

test.beforeEach(() => _clearStreamTickets())

test('createStreamTicket returns an opaque ticket string bound to userId', () => {
  const ticket = createStreamTicket('user_a')
  assert.equal(typeof ticket, 'string')
  assert.ok(ticket.length >= 16)
})

test('consumeStreamTicket returns userId once, then invalidates (one-time)', () => {
  const ticket = createStreamTicket('user_a')
  assert.equal(consumeStreamTicket(ticket), 'user_a')
  // second use must fail
  assert.equal(consumeStreamTicket(ticket), null)
})

test('consumeStreamTicket rejects unknown ticket', () => {
  assert.equal(consumeStreamTicket('nope'), null)
})

test('consumeStreamTicket rejects expired ticket (>60s)', () => {
  let t = 1_000_000
  const clock = () => t
  const ticket = createStreamTicket('user_a', { now: clock })
  t += 61_000
  assert.equal(consumeStreamTicket(ticket, { now: clock }), null)
})

test('consumeStreamTicket accepts within TTL', () => {
  let t = 1_000_000
  const clock = () => t
  const ticket = createStreamTicket('user_b', { now: clock })
  t += 59_000
  assert.equal(consumeStreamTicket(ticket, { now: clock }), 'user_b')
})
