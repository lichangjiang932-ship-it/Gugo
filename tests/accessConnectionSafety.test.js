import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

test('Access connector credentials stay disabled until their probe succeeds', () => {
  const source = fs.readFileSync(new URL('../src/components/AccessConnectModal.jsx', import.meta.url), 'utf8')
  const saveAt = source.indexOf('enabled: false')
  const testAt = source.indexOf('testIntegrationApi(saved.integration.id)')
  const enableAt = source.indexOf('toggleIntegrationEnabledApi(saved.integration.id, true)')
  assert.ok(saveAt > 0)
  assert.ok(testAt > saveAt)
  assert.ok(enableAt > testAt)
})
