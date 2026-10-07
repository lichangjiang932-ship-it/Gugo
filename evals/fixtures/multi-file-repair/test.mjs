import assert from 'node:assert/strict'
import { sumAmounts } from './src/totals.js'
import { labelCount } from './src/labels.js'
assert.equal(sumAmounts([{ amount: 10 }, { amount: -4 }]), 6)
assert.equal(labelCount(2), '2 items')
