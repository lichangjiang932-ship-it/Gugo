import assert from 'node:assert/strict'
import { mergeConfig } from './src/config.js'
const supplied = JSON.parse('{"theme":"dark","__proto__":{"polluted":true}}')
assert.deepEqual(mergeConfig({ theme: 'light', retries: 2 }, supplied), { theme: 'dark', retries: 2 })
assert.equal({}.polluted, undefined)
