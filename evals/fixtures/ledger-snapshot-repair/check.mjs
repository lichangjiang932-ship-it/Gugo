import assert from 'node:assert/strict'
import { aggregate } from './src/ledger.js'
assert.deepEqual(aggregate([{userId:'u',sessionId:'s',turnId:'t',sequence:1,at:1000,type:'turn.completed',promptTokens:10}]),{turns:1,promptTokens:10})
