import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const { overlaps } = await import(pathToFileURL(path.resolve('src/interval.js')).href + `?v=${Date.now()}`)

// Ordinary overlap and containment.
assert.equal(overlaps({ start: 1, end: 5 }, { start: 3, end: 9 }), true)
assert.equal(overlaps({ start: 1, end: 9 }, { start: 3, end: 5 }), true, 'containment overlaps')
assert.equal(overlaps({ start: 3, end: 5 }, { start: 1, end: 9 }), true, 'containment overlaps (reversed)')

// Closed intervals: touching at an endpoint counts as overlap.
assert.equal(overlaps({ start: 1, end: 5 }, { start: 5, end: 9 }), true, 'touching at 5')
assert.equal(overlaps({ start: 5, end: 9 }, { start: 1, end: 5 }), true, 'touching at 5 (reversed)')
assert.equal(overlaps({ start: 2, end: 2 }, { start: 2, end: 2 }), true, 'same single point')

// Disjoint intervals do not overlap.
assert.equal(overlaps({ start: 1, end: 3 }, { start: 6, end: 9 }), false)
assert.equal(overlaps({ start: 6, end: 9 }, { start: 1, end: 3 }), false)

// Malformed intervals throw.
assert.throws(() => overlaps({ start: 5, end: 1 }, { start: 1, end: 2 }), Error)
assert.throws(() => overlaps({ start: 1, end: 2 }, { start: 5, end: 1 }), Error)
assert.throws(() => overlaps({ start: 'a', end: 2 }, { start: 1, end: 2 }), Error)
assert.throws(() => overlaps({ start: 1, end: 2 }, { start: 1, end: null }), Error)
