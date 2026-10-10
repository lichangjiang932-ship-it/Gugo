import assert from 'node:assert/strict'
import { overlaps } from './src/interval.js'

assert.equal(overlaps({ start: 1, end: 5 }, { start: 5, end: 9 }), true)
assert.equal(overlaps({ start: 1, end: 3 }, { start: 6, end: 9 }), false)
assert.throws(() => overlaps({ start: 5, end: 1 }, { start: 1, end: 2 }))
