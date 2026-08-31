import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  processExecutionBoundaryFailure,
  processExecutionNotStartedResult,
  projectVerificationFields,
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
    code: 7,
    signal: 'SIGTERM',
    processStartFailed: true,
    processStartError: 'spawn ENOENT',
    processTreeCleanupFailed: true,
  }, { cwd: 'C:\\workspace' })

  assert.equal(result.code, 'PROCESS_TREE_CLEANUP_FAILED')
  assert.equal(result.verificationVerdict, 'indeterminate')
  assert.equal(result.failureKind, 'infrastructure')
  assert.equal(result.systemFailure, true)
  assert.equal(result.processTreeCleanupFailed, true)
  assert.equal(result.processStartFailed, true)
  assert.equal(result.processStartError, 'spawn ENOENT')
  assert.equal(result.exitCode, 7)
  assert.equal(result.signal, 'SIGTERM')
  assert.equal(result.error, 'PROCESS_TREE_CLEANUP_FAILED')
  assert.equal(result.hintCode, 'PROCESS_TREE_CLEANUP_REVIEW_REQUIRED')
  assert.equal(Object.hasOwn(result, 'hint'), false)
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
  assert.equal(isolation.systemFailure, true)
  assert.match(isolation.error, /job unavailable/u)
  assert.equal(startup.code, 'PROCESS_START_FAILED')
  assert.equal(startup.systemFailure, true)
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

test('verification projection treats a missing inner runner as infrastructure', () => {
  for (const result of [
    { ok: false, exitCode: 127, stderr: '/bin/sh: 1: eslint: not found' },
    { ok: false, exitCode: 1, stderr: "'eslint' is not recognized as an internal or external command" },
    { ok: false, exitCode: 1, stderr: 'No module named pytest' },
    ...(process.platform === 'win32' ? [{
      ok: false,
      exitCode: 1,
      stdout: '\n> test\n> missing-verification-runner\n\n',
      stderr: "'missing-verification-runner' �����ڲ����ⲿ����",
    }] : []),
  ]) {
    assert.deepEqual(projectVerificationFields(result), {
      code: 'VERIFICATION_TOOLCHAIN_UNAVAILABLE',
      passed: null,
      verificationVerdict: 'indeterminate',
      failureKind: 'infrastructure',
      systemFailure: true,
    })
  }
})

test('explicit process boundary failures outrank coincident missing toolchain diagnostics', () => {
  for (const [code, flag] of [
    ['PROCESS_TREE_CLEANUP_FAILED', 'processTreeCleanupFailed'],
    ['PROCESS_ISOLATION_FAILED', 'processIsolationFailed'],
    ['PROCESS_START_FAILED', 'processStartFailed'],
  ]) {
    assert.deepEqual(projectVerificationFields({
      ok: false,
      exitCode: 127,
      code,
      [flag]: true,
      stderr: '/bin/sh: 1: npm: not found',
    }), {
      code,
      passed: null,
      verificationVerdict: 'indeterminate',
      failureKind: 'infrastructure',
      systemFailure: true,
    })
  }
})

test('explicit project failures outrank missing exit-code inference', () => {
  assert.deepEqual(projectVerificationFields({
    ok: false,
    passed: false,
    verificationVerdict: 'failed',
    failureKind: 'project',
  }), {
    passed: false,
    verificationVerdict: 'failed',
    failureKind: 'project',
    systemFailure: false,
  })
})
