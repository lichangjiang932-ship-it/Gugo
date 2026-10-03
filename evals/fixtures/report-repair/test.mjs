import assert from 'node:assert/strict'
import { buildReport } from './src/report.js'
const records = [{ id: 'a', value: 4 }, { id: 'b', value: 10 }, { id: 'c', value: 1 }]
const before = structuredClone(records)
assert.deepEqual(buildReport(records), { total: 15, average: 5, highest: records[1] })
assert.deepEqual(records, before)
