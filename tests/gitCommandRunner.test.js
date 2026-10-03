import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import { httpError, runFile, workspaceRoot } from '../server/adapters/gitCommandRunner.js'

function eb  (code) {
  const error = new Error(`spawn failed: ${code}`)
  error.code = code
  return error
}

/** Counts calls and fails with `failures` before succeeding. */
function createExec({ failures = [], stdout = 'ok\n', stderr = '', killed = false } = {}) {
  const calls = []
  const impl = (_file, _args, _options, callback) => {
    calls.push(true)
    const next = failures[calls.length - 1]
    setImmediate(() => {
      if (next) callback(Object.assign(next, killed ? { killed: true } : {}), '', stderr)
      else callback(null, stdout, stderr)
    })
  }
  return { calls, impl }
}

test('a transient EBUSY spawn is retried instead of failing the command', async () => {
  // Windows reports EBUSY for a moment after a process tree was force-killed;
  // the next `git` spawn would otherwise fail for no real reason.
  const first = createExec({ failures: [eb('EBUSY')] })
  const result = await runFile('git', ['status'], { execFileImpl: first.impl, platform: 'win32' })
  assert.equal(result.ok, true)
  assert.equal(result.stdout, 'ok\n')
  assert.equal(first.calls.length, 2, 'the command is retried once')

  // Every retry budget spent: the failure is reported, not hidden.
  const always = createExec({ failures: [eb('EBUSY'), eb('EBUSY'), eb('EBUSY')] })
  const exhausted = await runFile('git', ['status'], { execFileImpl: always.impl, platform: 'win32', rejectOnError: false })
  assert.equal(exhausted.ok, false)
  assert.equal(always.calls.length, 3, 'one try plus the two bounded retries')

  // Off Windows there is no such state to retry.
  const other = createExec({ failures: [eb('EBUSY')] })
  const unsupported = await runFile('git', ['status'], { execFileImpl: other.impl, platform: 'linux', rejectOnError: false })
  assert.equal(unsupported.ok, false)
  assert.equal(other.calls.length, 1)
})

test('only EBUSY is treated as transient', async () => {
  const missing = createExec({ failures: [eb('ENOENT')] })
  await assert.rejects(
    () => runFile('git', ['status'], { execFileImpl: missing.impl, platform: 'win32' }),
    (error) => {
      assert.equal(missing.calls.length, 1, 'a missing binary is not retried')
      assert.equal(error.statusCode, 500)
      assert.equal(error.result.ok, false)
      assert.equal(error.result.exitCode, -1)
      return true
    },
  )
})

test('a timeout is reported as 408 with the timed-out result attached', async () => {
  const timedOut = createExec({ failures: [eb('ETIMEDOUT')], killed: true })
  await assert.rejects(
    () => runFile('git', ['status'], { execFileImpl: timedOut.impl, platform: 'win32' }),
    (error) => {
      assert.equal(error.statusCode, 408)
      assert.equal(error.result.timedOut, true)
      assert.match(error.message, /spawn failed/)
      return true
    },
  )
})

test('the runner runs in the workspace root by default and reports plain errors on request', async () => {
  const previous = process.env.WORKSPACE_ROOT
  process.env.WORKSPACE_ROOT = 'C:/workspace-under-test'
  try {
    // Compared against path.resolve rather than a literal, so the test says what it
    // means on every platform.
    assert.equal(workspaceRoot(), path.resolve('C:/workspace-under-test'))
  } finally {
    if (previous === undefined) delete process.env.WORKSPACE_ROOT
    else process.env.WORKSPACE_ROOT = previous
  }

  const failing = createExec({ failures: [eb('ENOENT')] })
  const result = await runFile('git', ['status'], { execFileImpl: failing.impl, platform: 'win32', rejectOnError: false })
  assert.deepEqual(result, { ok: false, exitCode: -1, stdout: '', stderr: '', timedOut: false })
  assert.equal(httpError('nope', 403).statusCode, 403)
})
