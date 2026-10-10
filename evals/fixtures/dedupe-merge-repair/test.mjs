import assert from 'node:assert/strict'
import { mergeById } from './src/records.js'
import { summarize } from './src/summary.js'

const left = [{ id: 'a', amount: 1 }, { id: 'b', amount: 2 }]
const right = [{ id: 'b', amount: 20 }, { id: 'c', amount: 3 }]

assert.deepEqual(mergeById(left, right).map((record) => record.id), ['a', 'b', 'c'])
assert.deepEqual(summarize(left, right), { count: 3, total: 24 })
