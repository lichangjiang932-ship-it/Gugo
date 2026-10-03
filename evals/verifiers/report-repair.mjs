import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const { buildReport } = await import(pathToFileURL(path.resolve('src/report.js')).href + `?v=${Date.now()}`)
const records = [{ id: 'a', value: 4 }, { id: 'b', value: 10 }, { id: 'c', value: 1 }]
const before = structuredClone(records)
assert.deepEqual(buildReport(records), { total: 15, average: 5, highest: records[1] })
assert.deepEqual(records, before)
assert.deepEqual(buildReport([]), { total: 0, average: 0, highest: null })
