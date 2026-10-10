import assert from 'node:assert/strict'
import { formatMessage } from './src/template.js'

assert.equal(formatMessage('hi {name}', { name: 'A' }), 'hi A')
assert.equal(formatMessage('hi {name} {other}', { name: 'A' }), 'hi A {other}')
assert.equal(formatMessage('{{literal}}', {}), '{literal}')
