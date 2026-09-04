import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  auditFunctionLengths,
  auditSource,
} = require('../scripts/audit-function-length.cjs')

test('function audit uses AST boundaries instead of the next declaration', () => {
  const records = auditSource(`
export function compact() {
  return true
}

const schemaTable = {
  alpha: ${JSON.stringify('value'.repeat(1_000))},
}
`, { file: 'fixture.js' })

  assert.equal(records.length, 1)
  assert.equal(records[0].name, 'compact')
  assert.equal(records[0].bodyLines, 3)
})

test('function audit parses the server tree and excludes generated worker source templates', () => {
  const result = auditFunctionLengths()
  assert.deepEqual(result.parseErrors, [])
  assert.equal(result.totalFunctions > 7_000, true)
  assert.equal(result.violations.length > 0, true)
  assert.equal(result.violations.some((item) => /WorkerSource\.js$/u.test(item.file)), false)

  const schemaSource = fs.readFileSync(
    new URL('../server/utils/toolSchemaCatalog.js', import.meta.url),
    'utf8',
  )
  const schemaFunctions = auditSource(schemaSource, { file: 'server/utils/toolSchemaCatalog.js' })
  const specsByName = schemaFunctions.find((item) => item.name === 'specsByName')
  assert.ok(specsByName)
  assert.equal(specsByName.bodyLines < 20, true)
})
