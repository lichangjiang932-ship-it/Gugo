import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const { mergeConfig } = await import(pathToFileURL(path.resolve('src/config.js')).href + `?v=${Date.now()}`)
const defaults = { theme: 'light', retries: 2 }
const supplied = JSON.parse('{"theme":"dark","__proto__":{"polluted":"yes"},"constructor":{"prototype":{"bad":true}},"prototype":{"bad":true}}')
const defaultsBefore = structuredClone(defaults)
const suppliedBefore = structuredClone(supplied)
const result = mergeConfig(defaults, supplied)
assert.deepEqual(result, { theme: 'dark', retries: 2 })
assert.equal(Object.getPrototypeOf(result), Object.prototype)
assert.equal({}.polluted, undefined)
assert.equal({}.bad, undefined)
assert.deepEqual(defaults, defaultsBefore)
assert.deepEqual(supplied, suppliedBefore)
