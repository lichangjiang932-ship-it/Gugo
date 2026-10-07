import assert from 'node:assert/strict'
import { projectOutcome } from './src/recovery.js'
assert.equal(projectOutcome({ status: 'cancelled' }), 'cancelled')
assert.equal(projectOutcome({ status: 'completed', verificationPassed: false }), 'unknown')
