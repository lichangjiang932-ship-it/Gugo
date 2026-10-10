import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const { mergeById } = await import(pathToFileURL(path.resolve('src/records.js')).href + `?v=${Date.now()}`)
const { summarize } = await import(pathToFileURL(path.resolve('src/summary.js')).href + `?v=${Date.now()}`)

const left = [{ id: 'a', amount: 1 }, { id: 'b', amount: 2 }]
const right = [{ id: 'b', amount: 20 }, { id: 'c', amount: 3 }]

// Merge yields unique ids in first-appearance order (left, then new right ids).
const merged = mergeById(left, right)
assert.deepEqual(merged.map((record) => record.id), ['a', 'b', 'c'])
// A shared id is won by the right-hand record.
assert.equal(merged.find((record) => record.id === 'b').amount, 20)

// summarize runs over the de-duplicated merge (b counted once, at its right value).
assert.deepEqual(summarize(left, right), { count: 3, total: 24 })
assert.deepEqual(summarize([], []), { count: 0, total: 0 })
assert.deepEqual(summarize([{ id: 'x' }, { id: 'x', amount: 5 }], []), { count: 1, total: 5 })
assert.deepEqual(summarize([{ id: 'x', amount: 'bad' }], []), { count: 1, total: 0 })

// Neither input array nor its records are mutated.
const leftBefore = structuredClone(left)
const rightBefore = structuredClone(right)
mergeById(left, right)
summarize(left, right)
assert.deepEqual(left, leftBefore)
assert.deepEqual(right, rightBefore)
