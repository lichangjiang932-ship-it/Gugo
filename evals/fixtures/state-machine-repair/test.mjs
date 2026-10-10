import assert from 'node:assert/strict'
import { nextStatus } from './src/machine.js'

assert.equal(nextStatus('placed', 'pay'), 'paid')
assert.equal(nextStatus('placed', 'ship'), null)
assert.equal(nextStatus('delivered', 'pay'), null)
