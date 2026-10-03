import assert from 'node:assert/strict'
import { countCompleted } from './src/counter.js'
assert.equal(countCompleted([{ done: true }, { done: false }, { done: true }]), 2)
assert.equal(countCompleted([]), 0)
