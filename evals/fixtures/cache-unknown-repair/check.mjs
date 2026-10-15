import assert from 'node:assert/strict'
import { classify } from './src/cache.js'
assert.equal(classify({promptTokens:100,cacheHitTokens:20}).hitRate,20)
