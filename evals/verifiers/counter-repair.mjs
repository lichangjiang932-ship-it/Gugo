import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const { countCompleted } = await import(pathToFileURL(path.resolve('src/counter.js')).href + `?v=${Date.now()}`)
const input = [{ done: true }, { done: false }, { done: true }, {}, { done: 1 }]
const before = structuredClone(input)
assert.equal(countCompleted(input), 2)
assert.equal(countCompleted([]), 0)
assert.deepEqual(input, before)
