import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  processExecutionBoundaryFailure,
  processExecutionNotStartedResult,
} from '../server/utils/processExecutionFailure.js'

test('not-started process results preserve the optional control-pipe contract', () => {
  const plain = processExecutionNotStartedResult({ aborted: true })
  const controlled = processExecutionNotStartedResult({
    controlPipe: true,
    aborted: true,
  })

  assert.equal(plain.aborted, true)
  assert.equal(plain.processStartFailed, false)
  assert.equal(plain.processIsolationFailed, false)
  assert.equal(plain.processTreeCleanupFailed, false)
  assert.equal('control' in plain, false)
  assert.deepEqual(controlled.control, Buffer.alloc(0))
  assert.equal(controlled.controlError, null)
  assert.equal(controlled.controlTruncated, false)
  assert.equal(controlled.controlTotalBytes, 0)
})

test('process failure projection keeps cleanup uncertainty above startup diagnostics', () => {
  const result = processExecutionBoundaryFailure({
    stdout: '',
    stderr: 'spawn ENOENT',
    processStartFailed: true,
    processStartError: 'spawn ENOENT',
    processTreeCleanupFailed: true,
  }, { cwd: 'C:\\workspace' })

  assert.equal(result.code, 'PROCESS_TREE_CLEANUP_FAILED')
  assert.equal(result.processTreeCleanupFailed, true)
  assert.equal(result.processStartFailed, true)
  assert.equal(result.processStartError, 'spawn ENOENT')
  assert.match(result.error, /无法确认所有子进程都已退出/u)
  assert.match(result.hint, /不要重试/u)
})

test('process failure projection distinguishes isolation and startup failures', () => {
  const isolation = processExecutionBoundaryFailure({
    processIsolationFailed: true,
    processIsolationError: 'job unavailable',
  })
  const startup = processExecutionBoundaryFailure({
    processStartFailed: true,
    processStartError: 'spawn ENOENT',
  })

  assert.equal(isolation.code, 'PROCESS_ISOLATION_FAILED')
  assert.match(isolation.error, /job unavailable/u)
  assert.equal(startup.code, 'PROCESS_START_FAILED')
  assert.match(startup.error, /spawn ENOENT/u)
})

test('process failure projection preserves abort and timeout over late startup diagnostics', () => {
  for (const terminal of [{ aborted: true }, { timedOut: true }]) {
    assert.equal(processExecutionBoundaryFailure({
      ...terminal,
      processIsolationFailed: true,
      processIsolationError: 'late isolation failure',
      processStartFailed: true,
      processStartError: 'late start failure',
    }), null)
  }
})
