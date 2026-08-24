import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

test('test runner terminates and identifies a hung batch', () => {
  const childEnv = { ...process.env }
  delete childEnv.NODE_TEST_CONTEXT
  childEnv.TEST_BATCH_TIMEOUT_MS = '150'
  const result = spawnSync(process.execPath, [
    'scripts/run-tests.js',
    'tests/fixtures/runTestsTimeoutProbe.test.mjs',
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: childEnv,
    timeout: 5_000,
  })

  const output = `${result.stdout || ''}\n${result.stderr || ''}`
  assert.equal(result.status, 1)
  assert.match(output, /batch 1\/1 \(1 files\) exceeded 150ms and was terminated/u)
})
