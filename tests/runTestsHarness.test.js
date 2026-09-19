import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import test from 'node:test'

const ISOLATED_PROBE = 'tests/unit/ManualRecoveryRouteState.test.jsx'

function walkTestFiles(directory) {
  const files = []
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) files.push(...walkTestFiles(path))
    else if (entry.endsWith('.test.js') || entry.endsWith('.test.jsx')) files.push(path)
  }
  return files
}

function findViteWrapperTests() {
  return walkTestFiles('tests')
    .filter((path) => /from ['"]vite['"]/u.test(readFileSync(path, 'utf8')))
    .map((path) => relative(process.cwd(), path).replaceAll('\\', '/'))
    .sort()
}

function childEnv(overrides = {}) {
  const env = { ...process.env }
  for (const name of ['NODE_TEST_CONTEXT', 'TEST_BATCH_TIMEOUT_MS', 'TEST_COVERAGE_TIMEOUT_MS', 'TEST_ISOLATED_TIMEOUT_MS']) {
    delete env[name]
  }
  return { ...env, ...overrides }
}

function dataImport(source) {
  return `data:text/javascript,${encodeURIComponent(source)}`
}

function fakeSpawnPreload({ status = null, signal = null, errorCode = null, output = '' } = {}) {
  const outcome = errorCode
    ? `const error = Object.assign(new Error('spawn failed'), { code: ${JSON.stringify(errorCode)} }); child.emit('error', error)`
    : `child.emit('close', ${JSON.stringify(status)}, ${JSON.stringify(signal)})`
  return `
    import childProcess from 'node:child_process'
    import { EventEmitter } from 'node:events'
    import { syncBuiltinESMExports } from 'node:module'
    import { PassThrough } from 'node:stream'
    childProcess.spawn = () => {
      const child = new EventEmitter()
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.stdin = null
      queueMicrotask(() => {
        child.stdout.end(${JSON.stringify(output)})
        child.stderr.end()
        ${outcome}
      })
      return child
    }
    syncBuiltinESMExports()
  `
}

function fakeCoverageSpawnPreload({ thresholdFailure = false, tapFailure = false, exitCode = null, waitForRelease = false } = {}) {
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
      const tapFailure = ${JSON.stringify(tapFailure)}
      const status = validArgs ? (${JSON.stringify(exitCode)} ?? (thresholdFailure || tapFailure ? 1 : 0)) : 91
      const output = thresholdFailure ? [
        'TAP version 13',
        '1..1',
        '# tests 1',
        '# pass 1',
        '# fail 0',
        '# Error: 39.00% line coverage does not meet threshold of 40%.',
        '# Error: 59.00% branch coverage does not meet threshold of 60%.',
        '',
      ].join('\\n') : (tapFailure ? [
        'TAP version 13',
        '# Subtest: flaky coverage probe',
        'not ok 1 - flaky coverage probe',
        '  ---',
        "  error: 'probe failed'",
        '  ...',
        '1..1',
        '# tests 1',
        '# pass 0',
        '# fail 1',
        '',
      ].join('\\n') : '# start of coverage report\\n# end of coverage report\\n')
      const finish = () => {
        child.stdout.end(output)
        child.stderr.end()
        child.emit('close', status, null)
      }
      queueMicrotask(() => {
        if (!${JSON.stringify(waitForRelease)}) return finish()
        process.stdin.once('data', () => {
          process.stdin.pause()
          finish()
        })
        child.stdout.write('COVERAGE_STDOUT_READY\\n')
        child.stderr.write('COVERAGE_STDERR_READY\\n')
      })
      return child
    }
    syncBuiltinESMExports()
  `
}

function fakeTimeoutClosePreload(output = '') {
  return `
    import childProcess from 'node:child_process'
    import { EventEmitter } from 'node:events'
    import { syncBuiltinESMExports } from 'node:module'
    import { PassThrough } from 'node:stream'
    let child
    const schedule = globalThis.setTimeout
    globalThis.setTimeout = (callback, delay, ...args) => schedule(() => {
      callback(...args)
      if (delay !== 20) return
      child.stdout.end(${JSON.stringify(output)})
      child.stderr.end()
      child.emit('close', 0, null)
    }, delay)
    childProcess.spawn = () => {
      child = new EventEmitter()
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.stdin = null
      return child
    }
    syncBuiltinESMExports()
  `
}

function fakeTransientV8OomPreload() {
  return `
    import childProcess from 'node:child_process'
    import { EventEmitter } from 'node:events'
    import { syncBuiltinESMExports } from 'node:module'
    import { PassThrough } from 'node:stream'
    let attempts = 0
    childProcess.spawn = () => {
      attempts += 1
      const child = new EventEmitter()
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.stdin = null
      queueMicrotask(() => {
        child.stdout.end('TAP version 13\\n')
        if (attempts === 1) {
          child.stderr.end('FATAL ERROR: RegExpCompiler Allocation failed - process out of memory\\n')
          child.emit('close', null, 'SIGABRT')
          return
        }
        child.stderr.end()
        child.emit('close', 0, null)
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

for (const coverage of [false, true]) {
  test(`test runner terminates a hung ${coverage ? 'coverage' : 'normal'} batch and its descendant process`, async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'yma-run-tests-harness-'))
    const descendantPidFile = join(fixtureRoot, 'descendant.pid')
    const env = childEnv({
      TEST_BATCH_TIMEOUT_MS: coverage ? '3000' : '1500',
      TEST_COVERAGE_TIMEOUT_MS: coverage ? '1500' : undefined,
      RUN_TESTS_TIMEOUT_PROBE_PID_FILE: descendantPidFile,
    })

    let descendantPid = null
    try {
      const startedAt = Date.now()
      const result = runRunner([
        ...(coverage ? ['--coverage'] : []),
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
      assert.match(output, /batch 1\/1 \(1 files\) exceeded 1500ms and was terminated/u)
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
}

test('test runner reports an isolated process that exits non-zero after green TAP output', () => {
  const result = runRunner([
    `--import=${dataImport('process.exitCode = 1')}`,
    ISOLATED_PROBE,
  ])
  const output = combinedOutput(result)

  assert.equal(result.status, 1)
  const total = Number(output.match(/^# tests (\d+)$/mu)?.[1])
  const passed = Number(output.match(/^# pass (\d+)$/mu)?.[1])
  assert.ok(Number.isSafeInteger(total) && total > 0, 'the isolated probe must actually run tests')
  assert.equal(passed, total, 'the TAP test cases pass even though their process exit is a failure')
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
      preloadSource: fakeSpawnPreload({ signal: 'SIGABRT' }),
      expected: /status=signaled; exitCode=none; signal=SIGABRT; errorCode=none/u,
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
    assert.doesNotMatch(output, /native transform crashed .* retrying/u)
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

test('a V8 out-of-memory SIGABRT retries an isolated native transform and can recover', () => {
  const result = runRunner([ISOLATED_PROBE], {
    preloadSource: fakeTransientV8OomPreload(),
  })
  const output = combinedOutput(result)

  assert.equal(result.status, 0)
  assert.match(
    output,
    /attempt 1\/3\); status=native-crash; exitCode=none; signal=SIGABRT; errorCode=none/u,
  )
  assert.equal((output.match(/native transform crashed .* retrying/gmu) || []).length, 1)
  assert.match(output, /starting isolated test .* \(attempt 2\/3\)/u)
  assert.match(output, /final result: PASS \(1 test file\(s\)\)/u)
  assert.doesNotMatch(output, /final result: FAIL/u)
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

test('test runner keeps lane-specific timeout defaults and explicit override precedence', () => {
  const batchProbe = 'tests/codeDebt.test.js'
  const cases = [
    { args: [batchProbe], expected: 1_200_000 },
    { args: ['--coverage', batchProbe], expected: 2_400_000 },
    { args: [ISOLATED_PROBE], expected: 180_000 },
    { args: ['--coverage', ISOLATED_PROBE], expected: 180_000 },
    { args: [batchProbe], env: { TEST_BATCH_TIMEOUT_MS: '12345' }, expected: 12_345 },
    { args: ['--coverage', batchProbe], env: { TEST_BATCH_TIMEOUT_MS: '12345' }, expected: 12_345 },
    { args: ['--coverage', batchProbe], env: { TEST_BATCH_TIMEOUT_MS: '12345', TEST_COVERAGE_TIMEOUT_MS: '23456' }, expected: 23_456 },
    { args: [batchProbe], env: { TEST_COVERAGE_TIMEOUT_MS: '23456' }, expected: 1_200_000 },
    { args: [ISOLATED_PROBE], env: { TEST_BATCH_TIMEOUT_MS: '12345', TEST_COVERAGE_TIMEOUT_MS: '23456' }, expected: 180_000 },
    { args: [ISOLATED_PROBE], env: { TEST_ISOLATED_TIMEOUT_MS: '34567' }, expected: 34_567 },
  ]
  for (const value of ['', ' ', '0', '-1', '1.5', 'invalid', 'Infinity', '9007199254740992']) {
    cases.push(
      { args: ['--coverage', batchProbe], env: { TEST_BATCH_TIMEOUT_MS: value, TEST_COVERAGE_TIMEOUT_MS: value }, expected: 2_400_000 },
      { args: ['--coverage', batchProbe], env: { TEST_BATCH_TIMEOUT_MS: '12345', TEST_COVERAGE_TIMEOUT_MS: value }, expected: 12_345 },
    )
  }
  for (const entry of cases) {
    const result = runRunner(entry.args, {
      preloadSource: fakeSpawnPreload({ status: 0 }),
      env: childEnv(entry.env),
    })
    const output = combinedOutput(result)
    assert.equal(result.status, 0, output)
    assert.match(output, new RegExp(`starting [^\\n]+; timeout=${entry.expected}ms`, 'u'), JSON.stringify(entry))
  }
})

test('watchdog errors cannot become PASS when a timed-out process closes with exit code zero', () => {
  const coverageDiagnostic = '# Error: 39.00% line coverage does not meet threshold of 40%.\n'
  for (const { args, output = '' } of [
    { args: ['tests/codeDebt.test.js'] },
    { args: ['--coverage', 'tests/codeDebt.test.js'] },
    { args: ['--coverage', 'tests/codeDebt.test.js'], output: coverageDiagnostic },
    { args: [ISOLATED_PROBE] },
  ]) {
    const result = runRunner(args, {
      preloadSource: fakeTimeoutClosePreload(output),
      env: childEnv({ TEST_BATCH_TIMEOUT_MS: '20', TEST_COVERAGE_TIMEOUT_MS: '20', TEST_ISOLATED_TIMEOUT_MS: '20' }),
    })
    const captured = combinedOutput(result)
    assert.equal(result.status, 1, captured)
    assert.match(captured, /status=timeout; exitCode=0; signal=none; errorCode=ETIMEDOUT/u)
    assert.match(captured, /final result: FAIL \(1 final failure\(s\)\)/u)
    assert.doesNotMatch(captured, /retrying|failed coverage gate|final result: PASS/u)
  }
})

test('signal termination cannot become PASS or be classified as only a coverage failure', () => {
  for (const args of [
    ['tests/codeDebt.test.js'],
    ['--coverage', 'tests/codeDebt.test.js'],
    [ISOLATED_PROBE],
  ]) {
    const result = runRunner(args, {
      preloadSource: fakeSpawnPreload({ status: 0, signal: 'SIGTERM' }),
    })
    const output = combinedOutput(result)
    assert.equal(result.status, 1, output)
    assert.match(output, /status=signaled; exitCode=0; signal=SIGTERM; errorCode=none/u)
    assert.match(output, /final result: FAIL/u)
    assert.doesNotMatch(output, /retrying|failed coverage gate/u)
  }
  const result = runRunner(['--coverage', 'tests/codeDebt.test.js'], {
    preloadSource: fakeSpawnPreload({
      signal: 'SIGTERM',
      output: '# Error: 39.00% line coverage does not meet threshold of 40%.\n',
    }),
  })
  assert.equal(result.status, 1)
  assert.match(combinedOutput(result), /status=signaled/u)
  assert.doesNotMatch(combinedOutput(result), /failed coverage gate/u)
})

test('coverage streams both channels before exit and forwards its report exactly once', async () => {
  const child = spawn(process.execPath, [
    '--import', dataImport(fakeCoverageSpawnPreload({ waitForRelease: true })),
    'scripts/run-tests.js', '--coverage', 'tests/codeDebt.test.js',
  ], {
    cwd: process.cwd(),
    env: childEnv({ COVERAGE_LINES: '40', COVERAGE_FUNCTIONS: '35', COVERAGE_BRANCHES: '60' }),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    timeout: 10_000,
  })
  let stdout = ''
  let stderr = ''
  let released = false
  const releaseAfterOutput = () => {
    if (released || !stdout.includes('COVERAGE_STDOUT_READY') || !stderr.includes('COVERAGE_STDERR_READY')) return
    released = true
    // The probe cannot close until the caller has observed both forwarded streams.
    child.stdin.end('release\n')
  }
  child.stdout.on('data', (chunk) => { stdout += chunk; releaseAfterOutput() })
  child.stderr.on('data', (chunk) => { stderr += chunk; releaseAfterOutput() })
  const [status, signal] = await once(child, 'close')
  assert.equal(status, 0, `${stdout}\n${stderr}`)
  assert.equal(signal, null)
  assert.equal(released, true, 'coverage output must reach the caller before child close')
  for (const marker of ['COVERAGE_STDOUT_READY', '# start of coverage report', '# end of coverage report']) {
    assert.equal(stdout.split(marker).length - 1, 1, `${marker} must appear exactly once`)
  }
  assert.equal(stderr.split('COVERAGE_STDERR_READY').length - 1, 1)
  assert.match(stdout, /final result: PASS/u)
})

test('failing TAP cannot be masked by a zero process exit code in either execution lane', () => {
  const output = 'TAP version 13\nnot ok 1 - masked failing assertion\n1..1\n# tests 1\n# pass 0\n# fail 1\n'
  for (const file of [ISOLATED_PROBE, 'tests/codeDebt.test.js']) {
    const result = runRunner([file], {
      preloadSource: fakeSpawnPreload({ status: 0, output }),
    })
    assert.equal(result.status, 1, file)
    assert.match(combinedOutput(result), /tapFailures=masked failing assertion/u)
    assert.match(combinedOutput(result), /final result: FAIL/u)
    assert.doesNotMatch(combinedOutput(result), /retrying/u)
  }
})

test('real failed assertions cannot be hidden by an exit callback that overwrites the code', () => {
  const mask = dataImport([
    "import test from 'node:test'",
    "import assert from 'node:assert/strict'",
    "process.on('exit', () => { process.exitCode = 0 })",
    "test('masked real assertion', () => assert.fail('expected probe failure'))",
  ].join('\n'))
  for (const args of [[ISOLATED_PROBE], ['tests/contextUsage.test.js'], ['--coverage', 'tests/contextUsage.test.js']]) {
    const result = runRunner([`--import=${mask}`, ...args], { timeout: 15_000 })
    assert.equal(result.status, 1, combinedOutput(result))
    assert.match(combinedOutput(result), /not ok \d+ - masked real assertion/u)
    assert.match(combinedOutput(result), /final result: FAIL/u)
    assert.doesNotMatch(combinedOutput(result), /retrying|failed coverage gate/u)
  }
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

test('Vite wrapper tests stay isolated and use worker-local optimizer caches', () => {
  const viteWrappers = findViteWrapperTests()
  assert.ok(viteWrappers.length > 0, 'expected at least one Vite wrapper test')

  for (const file of viteWrappers) {
    assert.match(
      readFileSync(file, 'utf8'),
      /cacheDir:\s*resolveViteTestCacheDir\(\)/u,
      `${file} must use the worker-local Vite cache`,
    )
  }

  const result = runRunner(viteWrappers, {
    preloadSource: fakeSpawnPreload({ status: 0 }),
  })
  const output = combinedOutput(result)

  assert.equal(result.status, 0)
  assert.doesNotMatch(output, /starting batch/u)
  assert.equal(
    (output.match(/starting isolated test/gmu) || []).length,
    viteWrappers.length,
  )
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

for (const exitCode of [1, 0]) {
  test(`coverage failure remains mandatory even with green TAP and exit code ${exitCode}`, () => {
    const result = runRunner([
      '--coverage',
      'tests/codeDebt.test.js',
    ], {
      preloadSource: fakeCoverageSpawnPreload({ thresholdFailure: true, exitCode }),
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
    assert.doesNotMatch(output, /retrying/u)
    assert.equal((output.match(/^# Error: 39\.00% line coverage/gmu) || []).length, 1)
  })
}

test('real Node coverage thresholds fail after passing assertions and its report is not replayed', () => {
  const result = runRunner([
    '--coverage',
    '--test-name-pattern=client token estimate charges',
    'tests/contextUsage.test.js',
  ], {
    env: childEnv({ COVERAGE_LINES: '100', COVERAGE_FUNCTIONS: '100', COVERAGE_BRANCHES: '100' }),
  })
  const output = combinedOutput(result)
  assert.equal(result.error, undefined, output)
  assert.equal(result.status, 1, output)
  assert.match(output, /# pass 1/u)
  assert.match(output, /# fail 0/u)
  assert.match(output, /failed coverage gate; status=failed;/u)
  assert.match(output, /coverage does not meet threshold of 100%/u)
  assert.match(output, /final result: FAIL \(1 final failure\(s\)\)/u)
  assert.doesNotMatch(output, /retrying|failed batch/u)
  for (const marker of ['# start of coverage report', '# end of coverage report']) {
    assert.equal(output.split(marker).length - 1, 1, `${marker} must appear exactly once`)
  }
})

test('normal batch failures retain their TAP subtest in the final summary', () => {
  const tapOutput = [
    'TAP version 13',
    '# Subtest: shared-state probe',
    'not ok 1 - shared-state probe',
    '1..1',
    '# tests 1',
    '# pass 0',
    '# fail 1',
    '',
  ].join('\n')
  const result = runRunner(['tests/codeDebt.test.js'], {
    preloadSource: fakeSpawnPreload({ status: 1, output: tapOutput }),
  })
  const output = combinedOutput(result)

  assert.equal(result.status, 1)
  assert.match(output, /not ok 1 - shared-state probe/u)
  assert.match(output, /tapFailures=shared-state probe/u)
  assert.match(output, /final result: FAIL \(1 final failure\(s\)\)/u)
})

test('coverage test failures identify their TAP subtests in the final summary', () => {
  const result = runRunner([
    '--coverage',
    'tests/codeDebt.test.js',
  ], {
    preloadSource: fakeCoverageSpawnPreload({ tapFailure: true }),
    env: childEnv({
      COVERAGE_LINES: '40',
      COVERAGE_FUNCTIONS: '35',
      COVERAGE_BRANCHES: '60',
    }),
  })
  const output = combinedOutput(result)

  assert.equal(result.status, 1)
  assert.match(
    output,
    /failed batch 1\/1 \(1 files\); status=failed; exitCode=1; signal=none; errorCode=none; tapFailures=flaky coverage probe/u,
  )
  assert.doesNotMatch(output, /failed coverage gate/u)
  assert.match(output, /final result: FAIL \(1 final failure\(s\)\)/u)
  assert.doesNotMatch(output, /retrying/u)
})
