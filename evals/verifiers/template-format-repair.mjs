import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const { formatMessage } = await import(pathToFileURL(path.resolve('src/template.js')).href + `?v=${Date.now()}`)

// Present keys substitute.
assert.equal(formatMessage('hi {name}', { name: 'A' }), 'hi A')
assert.equal(formatMessage('{a}-{b}', { a: 'x', b: 'y' }), 'x-y')

// Missing keys stay literal and never throw.
assert.equal(formatMessage('hi {name} {other}', { name: 'A' }), 'hi A {other}')
assert.equal(formatMessage('{gone}', {}), '{gone}')
assert.equal(formatMessage('{gone}', { name: 'A' }), '{gone}')

// Braces escape to literals; an escaped brace is not a substitution.
assert.equal(formatMessage('{{literal}}', {}), '{literal}')
assert.equal(formatMessage('{{name}}', { name: 'A' }), '{name}')
assert.equal(formatMessage('a {{x}} b', { x: 1 }), 'a {x} b')
assert.equal(formatMessage('{{{n}}}', { n: 7 }), '{7}')

// Substituted values are inserted literally, not re-scanned.
assert.equal(formatMessage('{a}', { a: '{b}', b: 'X' }), '{b}')
assert.equal(formatMessage('{a}', { a: '{{c}}' }), '{{c}}')

// Falsy and non-string values render via String().
assert.equal(formatMessage('{n}', { n: 0 }), '0')
assert.equal(formatMessage('{n}', { n: false }), 'false')
assert.equal(formatMessage('{n}', { n: '' }), '')

// Plain text and empty input round-trip.
assert.equal(formatMessage('plain', {}), 'plain')
assert.equal(formatMessage('', {}), '')

// Neither argument is mutated.
const values = { name: 'A', other: '{name}' }
const template = 'hi {name}'
const valuesBefore = structuredClone(values)
formatMessage(template, values)
assert.deepEqual(values, valuesBefore)
