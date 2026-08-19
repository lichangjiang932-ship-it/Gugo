import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createStreamTicket,
  consumeStreamTicket,
  _clearStreamTickets,
  _getStreamTicketCount,
  _MAX_PENDING_TICKETS,
} from '../server/utils/streamTicket.js'

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

test('a ticket expires exactly at its TTL boundary', () => {
  let t = 1_000_000
  const clock = () => t
  const ticket = createStreamTicket('user_boundary', { now: clock })
  t += 60_000
  assert.equal(consumeStreamTicket(ticket, { now: clock }), null)
})

test('creating a ticket prunes expired unconsumed tickets', () => {
  let t = 1_000_000
  const clock = () => t
  createStreamTicket('user_expired', { now: clock })
  assert.equal(_getStreamTicketCount(), 1)

  t += 60_000
  const activeTicket = createStreamTicket('user_active', { now: clock })
  assert.equal(_getStreamTicketCount(), 1)
  assert.equal(consumeStreamTicket(activeTicket, { now: clock }), 'user_active')
})

test('pending tickets stay within the hard cap and evict the oldest first', () => {
  const issued = []
  for (let index = 0; index <= _MAX_PENDING_TICKETS; index += 1) {
    issued.push(createStreamTicket(`user_${index}`))
  }

  assert.equal(_getStreamTicketCount(), _MAX_PENDING_TICKETS)
  assert.equal(consumeStreamTicket(issued[0]), null)
  assert.equal(
    consumeStreamTicket(issued.at(-1)),
    `user_${_MAX_PENDING_TICKETS}`,
  )
})

test('consumeStreamTicket accepts within TTL', () => {
  let t = 1_000_000
  const clock = () => t
  const ticket = createStreamTicket('user_b', { now: clock })
  t += 59_000
  assert.equal(consumeStreamTicket(ticket, { now: clock }), 'user_b')
})

test('scoped tickets are accepted only by their exact stream scope', () => {
  const notificationTicket = createStreamTicket('user_scope', { scope: 'notifications' })
  assert.equal(
    consumeStreamTicket(notificationTicket, { scope: 'notifications' }),
    'user_scope',
  )

  const wrongScopeTicket = createStreamTicket('user_scope', { scope: 'channel:alpha' })
  assert.equal(consumeStreamTicket(wrongScopeTicket, { scope: 'channel:beta' }), null)
  assert.equal(
    consumeStreamTicket(wrongScopeTicket, { scope: 'channel:alpha' }),
    null,
    'a scope mismatch still burns the one-time ticket',
  )
})

test('scoped and legacy unscoped tickets cannot be exchanged across boundaries', () => {
  const scoped = createStreamTicket('user_scope', { scope: 'notifications' })
  assert.equal(consumeStreamTicket(scoped), null)

  const unscoped = createStreamTicket('user_legacy')
  assert.equal(consumeStreamTicket(unscoped, { scope: 'notifications' }), null)
})
