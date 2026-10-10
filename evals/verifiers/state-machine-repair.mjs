import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const { nextStatus } = await import(pathToFileURL(path.resolve('src/machine.js')).href + `?v=${Date.now()}`)

// Valid transitions.
assert.equal(nextStatus('placed', 'pay'), 'paid')
assert.equal(nextStatus('placed', 'cancel'), 'cancelled')
assert.equal(nextStatus('paid', 'ship'), 'shipped')
assert.equal(nextStatus('paid', 'refund'), 'refunded')
assert.equal(nextStatus('shipped', 'deliver'), 'delivered')
assert.equal(nextStatus('shipped', 'refund'), 'refunded')

// Invalid event for a live status is rejected (null), not a silent no-op.
assert.equal(nextStatus('placed', 'ship'), null)
assert.equal(nextStatus('placed', 'deliver'), null)
assert.equal(nextStatus('paid', 'pay'), null)
assert.equal(nextStatus('paid', 'deliver'), null)
assert.equal(nextStatus('shipped', 'pay'), null)

// Terminal statuses have no outgoing moves.
assert.equal(nextStatus('delivered', 'pay'), null)
assert.equal(nextStatus('delivered', 'ship'), null)
assert.equal(nextStatus('cancelled', 'pay'), null)
assert.equal(nextStatus('refunded', 'refund'), null)

// Unknown / empty status is rejected.
assert.equal(nextStatus('bogus', 'pay'), null)
assert.equal(nextStatus('', 'pay'), null)
assert.equal(nextStatus('placed', 'bogus'), null)
