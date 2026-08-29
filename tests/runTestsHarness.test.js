import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const ISOLATED_PROBE = 'tests/unit/ManualRecoveryRouteState.test.jsx'

function childEnv(overrides = {}) {
  const env = { ...process.env, ...overrides }
  delete env.NODE_TEST_CONTEXT
  return env
}

function dataImport(source) {
  return `data:text/javascript,${encodeURIComponent(source)}`
}

function fakeSpawnPreload({ status = null, signal = null, errorCode = null } = {}) {
  const outcome = errorCode
    ? `const error = Object.assign(new Error('spawn failed'), { code: ${JSON.stringify(errorCode)} }); child.emit('error', error)`
    : `child.emit('close', ${JSON.stringify(status)}, ${JSON.stringify(signal)})`
  return `
    import childProcess from 'node:child_process'
    import { EventEmitter } from 'node:events'
    import { syncBuiltinESMExports } from 'node:module'
    childProcess.spawn = () => {
      const child = new EventEmitter()
      child.stdout = null
      child.stderr = null
      child.stdin = null
      queueMicrotask(() => { ${outcome} })
      return child
    }
    syncBuiltinESMExports()
  `
}

function fakeCoverageSpawnPreload({ thresholdFailure = false } = {}) {
  return `
    import childProcess from 'node:child_process'
    import { EventEmitter } from 'node:events'
    import { syncBuiltinESMExports } from 'node:module'
    import { PassThrough } from 'node:stream'
    childProcess.spawn = (_command, args) => {
      const child = new EventEmitter()
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.stdin = null
      const required = [
        '--experimental-test-coverage',
        '--test-coverage-lines=40',
        '--test-coverage-functions=35',
        '--test-coverage-branches=60',
      ]
      const validArgs = required.every((arg) => args.includes(arg))
      const thresholdFailure = ${JSON.stringify(thresholdFailure)}
      const status = validArgs && thresholdFailure ? 1 : (validArgs ? 0 : 91)
      const output = thresholdFailure ? [
        'TAP version 13',
        '1..1',
        '# tests 1',
        '# pass 1',
        '# fail 0',
        '# Error: 39.00% line coverage does not meet threshold of 40%.',
        '# Error: 59.00% branch coverage does not meet threshold of 60%.',
        '',
      ].join('\\n') : ''
      queueMicrotask(() => {
        child.stdout.end(output)
        child.stderr.end()
        child.emit('close', status, null)
      })
      return child
    }
    syncBuiltinESMExports()
  `
}

function runRunner(args, { preloadSource = null, env = childEnv(), timeout = 10_000 } = {}) {
  return spawnSync(process.execPath, [
    ...(preloadSource ? ['--import', dataImport(preloadSource)] : []),
    'scripts/run-tests.js',
    ...args,
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env,
    timeout,
  })
}

function combinedOutput(result) {
  return `${result.stdout || ''}\n${result.stderr || ''}`
}

function processExists(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    throw error
  }
}

function forceKillProcess(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    return
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error
  }
}

async function waitForProcessExit(pid, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!processExists(pid)) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return !processExists(pid)
}

test('test runner terminates a hung batch and its descendant process', async () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'yma-run-tests-harness-'))
  const descendantPidFile = join(fixtureRoot, 'descendant.pid')
  const env = childEnv({
    TEST_BATCH_TIMEOUT_MS: '500',
    RUN_TESTS_TIMEOUT_PROBE_PID_FILE: descendantPidFile,
  })

  let descendantPid = null
  try {
    const startedAt = Date.now()
    const result = runRunner([
      'tests/fixtures/runTestsTimeoutProbe.test.mjs',
    ], {
      env,
      timeout: 10_000,
    })

    const output = combinedOutput(result)
    descendantPid = Number(readFileSync(descendantPidFile, 'utf8'))
    assert.equal(result.status, 1)
    assert.equal(result.error, undefined)
    assert.ok(Date.now() - startedAt < 8_000, 'runner should return before the outer guard')
    assert.match(output, /batch 1\/1 \(1 files\) exceeded 500ms and was terminated/u)
    assert.match(output, /failed batch 1\/1 \(1 files\); status=timeout; exitCode=(?:none|-?\d+); signal=\w+; errorCode=ETIMEDOUT/u)
    assert.match(output, /final result: FAIL \(1 final failure\(s\)\)/u)
    assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0)
    assert.equal(
      await waitForProcessExit(descendantPid),
      true,
      `descendant process ${descendantPid} survived the runner timeout`,
    )
  } finally {
    if (descendantPid && processExists(descendantPid)) forceKillProcess(descendantPid)
    rmSync(fixtureRoot, { recursive: true, force: true })
  }
})

test('test runner reports an isolated process that exits non-zero after green TAP output', () => {
  const result = runRunner([
    `--import=${dataImport('process.exitCode = 1')}`,
    ISOLATED_PROBE,
  ])
  const output = combinedOutput(result)

  assert.equal(result.status, 1)
  assert.match(output, /# pass 2/u)
  assert.match(output, /# fail 0/u)
  assert.match(
    output,
    /failed isolated test tests[\\/]unit[\\/]ManualRecoveryRouteState\.test\.jsx \(attempt 1\/3\); status=failed; exitCode=1; signal=none; errorCode=none/u,
  )
  assert.match(output, /final result: FAIL \(1 final failure\(s\)\)/u)
  assert.equal((output.match(/^\[run-tests\] - isolated test/gmu) || []).length, 1)
})

test('test runner reports signal and start-error outcomes with complete process details', () => {
  for (const { preloadSource, expected } of [
    {
      preloadSource: fakeSpawnPreload({ signal: 'SIGTERM' }),
      expected: /status=signaled; exitCode=none; signal=SIGTERM; errorCode=none/u,
    },
    {
      preloadSource: fakeSpawnPreload({ errorCode: 'ENOENT' }),
      expected: /status=start-error; exitCode=none; signal=none; errorCode=ENOENT/u,
    },
  ]) {
    const result = runRunner([ISOLATED_PROBE], { preloadSource })
    const output = combinedOutput(result)

    assert.equal(result.status, 1)
    assert.match(output, expected)
    assert.match(output, /isolated test tests[\\/]unit[\\/]ManualRecoveryRouteState\.test\.jsx \(attempt 1\/3\)/u)
    assert.match(output, /final result: FAIL \(1 final failure\(s\)\)/u)
    assert.equal((output.match(/^\[run-tests\] - isolated test/gmu) || []).length, 1)
  }
})

test('third native-transform crash is visible and only its final attempt enters the summary', () => {
  const result = runRunner([ISOLATED_PROBE], {
    preloadSource: fakeSpawnPreload({ status: 3221225477 }),
  })
  const output = combinedOutput(result)

  assert.equal(result.status, 1)
  assert.equal((output.match(/status=native-crash; exitCode=3221225477/gmu) || []).length, 4)
  assert.equal((output.match(/native transform crashed .* retrying/gmu) || []).length, 2)
  assert.match(output, /attempt 3\/3\); status=native-crash; exitCode=3221225477/u)
  assert.match(output, /final result: FAIL \(1 final failure\(s\)\)/u)
  assert.equal((output.match(/^\[run-tests\] - isolated test/gmu) || []).length, 1)
})

test('test runner prints a clear final success result', () => {
  const result = runRunner([ISOLATED_PROBE], {
    preloadSource: fakeSpawnPreload({ status: 0 }),
  })
  const output = combinedOutput(result)

  assert.equal(result.status, 0)
  assert.match(output, /final result: PASS \(1 test file\(s\)\)/u)
  assert.doesNotMatch(output, /final failure/u)
})

test('normal test mode continues to honor the configured batch size', () => {
  const result = runRunner([
    'tests/codeDebt.test.js',
    'tests/releasePipeline.test.js',
  ], {
    preloadSource: fakeSpawnPreload({ status: 0 }),
    env: childEnv({ TEST_BATCH_SIZE: '1' }),
  })
  const output = combinedOutput(result)

  assert.equal(result.status, 0)
  assert.match(output, /finished batch 1\/2 \(1 files\).*status=0/u)
  assert.match(output, /finished batch 2\/2 \(1 files\).*status=0/u)
})

test('coverage mode uses one complete batch and retains the CI thresholds', () => {
  const result = runRunner([
    '--coverage',
    'tests/codeDebt.test.js',
    'tests/releasePipeline.test.js',
  ], {
    preloadSource: fakeCoverageSpawnPreload(),
    env: childEnv({
      TEST_BATCH_SIZE: '1',
      COVERAGE_LINES: '40',
      COVERAGE_FUNCTIONS: '35',
      COVERAGE_BRANCHES: '60',
    }),
  })
  const output = combinedOutput(result)

  assert.equal(result.status, 0)
  assert.match(output, /finished batch 1\/1 \(2 files\).*status=0/u)
  assert.doesNotMatch(output, /batch 2\//u)
  assert.doesNotMatch(output, /failed batch/u)
  assert.match(output, /final result: PASS \(2 test file\(s\)\)/u)
})

test('coverage failure is reported separately from successful test processes', () => {
  const result = runRunner([
    '--coverage',
    'tests/codeDebt.test.js',
  ], {
    preloadSource: fakeCoverageSpawnPreload({ thresholdFailure: true }),
    env: childEnv({
      TEST_BATCH_SIZE: '1',
      COVERAGE_LINES: '40',
      COVERAGE_FUNCTIONS: '35',
      COVERAGE_BRANCHES: '60',
    }),
  })
  const output = combinedOutput(result)

  assert.equal(result.status, 1)
  assert.match(output, /# pass 1/u)
  assert.match(output, /# fail 0/u)
  assert.match(output, /failed coverage gate; status=failed; 39\.00% line coverage does not meet threshold of 40%/u)
  assert.doesNotMatch(output, /failed batch/u)
  assert.match(output, /final result: FAIL \(1 final failure\(s\)\)/u)
})
