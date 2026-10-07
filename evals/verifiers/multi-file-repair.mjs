import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const { sumAmounts } = await import(pathToFileURL(path.resolve('src/totals.js')).href)
const { labelCount } = await import(pathToFileURL(path.resolve('src/labels.js')).href)
const input = [{ amount: 7 }, { amount: -3 }, {}, { amount: NaN }, { amount: Infinity }]
assert.equal(sumAmounts(input), 4)
assert.equal(sumAmounts([]), 0)
for (const [count, expected] of [[0, '0 items'], [1, '1 item'], [3, '3 items']]) {
  assert.equal(labelCount(count), expected)
}
assert.match(fs.readFileSync('README.md', 'utf8'), /negative amounts are included/iu)
