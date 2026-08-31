import assert from 'node:assert/strict'
import test from 'node:test'

import {
  commandCheckDescriptors,
  taskVerificationScopes,
} from '../server/services/loop/taskVerificationCheckScope.js'
import {
  clearVerifiedMutationTargets,
  isVerificationCall,
} from '../server/services/toolLoopHeuristics.js'
import {
  buildTaskVerificationRepairPrompt,
  hasPendingTaskVerificationRepair,
  observeTaskVerificationMutation,
  observeTaskVerificationRepair,
  restoreTaskVerificationRepair,
  serializeTaskVerificationRepair,
  taskVerificationRepairBlockerText,
  taskVerificationRepairDetails,
} from '../server/services/loop/taskVerificationRepair.js'
import {
  processExecutionBoundaryFailure,
  projectVerificationFields,
} from '../server/utils/processExecutionFailure.js'

test('verification command parser recognizes supported project checks conservatively', () => {
  const cases = new Map([
    ['python -m pytest -q', 'test'],
    ['npx --no-install eslint src', 'lint'],
    ['ruff check .', 'lint'],
    ['python -m mypy src', 'typecheck'],
    ['tsc --noEmit', 'typecheck'],
    ['mvn test', 'test'],
    ['./gradlew check', 'check'],
    ['make build', 'build'],
    ['npm test -- --watch=false', 'test'],
  ])
  for (const [command, kind] of cases) {
    assert.deepEqual(
      [...new Set(commandCheckDescriptors(command).map((entry) => entry.kind))],
      [kind],
      command,
    )
    assert.equal(
      isVerificationCall({ name: 'bash_exec', args: { command } }),
      true,
      command,
    )
  }

  const direct = taskVerificationScopes({
    name: 'bash_exec',
    args: { cwd: 'packages/api', command: 'npm test' },
  })
  const prefixed = taskVerificationScopes({
    name: 'bash_exec',
    args: { cwd: '.', command: 'cd packages/api && npm test' },
  })
  assert.deepEqual(prefixed, direct)

  const environmentScoped = taskVerificationScopes({
    name: 'bash_exec',
    args: { command: 'env NODE_ENV=test python -m pytest -q' },
  })
  const plain = taskVerificationScopes({
    name: 'bash_exec',
    args: { command: 'python -m pytest -q' },
  })
  assert.notEqual(environmentScoped[0].scope, plain[0].scope)

  for (const command of [
    'npm test --workspace packages/a',
    'python -m pytest tests/unit/test_one.py',
    'npx --no-install eslint packages/a',
  ]) {
    assert.equal(commandCheckDescriptors(command)[0]?.coverage, 'targeted', command)
  }
  for (const command of [
    'pytest -v',
    'go test -v ./...',
    'cargo test -v',
    'dotnet test -v normal',
    'npm test -- --maxWorkers 2',
    'pytest --maxfail 1 --tb short -n 2',
    'jest --maxWorkers 2',
    'vitest --maxConcurrency 2',
    'node --test --test-concurrency 2',
    'go test -p 2 -count 1 -timeout 30s ./...',
    'cargo test --jobs 2 --features default',
    'cargo test --manifest-path Cargo.toml',
    'dotnet test --verbosity normal --configuration Release',
    'eslint . --max-warnings 0 --format stylish',
    'mypy . --python-version 3.12',
    'tsc --noEmit --pretty false --target es2022',
    'mvn -f pom.xml test',
    'gradle --max-workers 2 check',
    'make -j 4 -f Makefile test',
  ]) {
    assert.equal(commandCheckDescriptors(command)[0]?.coverage, 'cwd', command)
  }
  for (const command of [
    'pytest -k=test_one',
    'pytest -m=unit',
    'jest --runTestsByPath=tests/a.test.js',
    'node --test --test-name-pattern=unit',
    'go test -run=TestOne ./...',
    'cargo test --package=core',
    'mvn -Dtest=Foo test',
    'mypy --package=foo',
    'npm test -- --testPathPattern=foo',
    'pytest -ktest_one',
    'pytest -munit',
    'cargo test -pcore',
    'mypy -pfoo',
    'dotnet test -fnet8.0',
    'mvn -Dgroups=unit test',
    'mvn -Dincludes=**/FooTest.java test',
    'mvn -f modules/a/pom.xml test',
    'cargo test --manifest-path modules/a/Cargo.toml',
    'jest --bail tests/unit',
    'node --test --test-only',
    'cargo test -- --ignored',
    'tsc --noEmit -p packages/a/tsconfig.json',
    'gradle test --tests com.example.UnitTest',
    'make -C packages/a test',
    'pytest --unregistered-option=value',
    'jest --config packages/a/jest.config.js',
    'make -f packages/a/Makefile test',
    'pytest -c subset.ini',
    'vitest --config subset.config.js',
    'npm test -- --config subset.config.js',
    'eslint --config relaxed.config.js',
    'mypy --config-file relaxed.ini .',
    'dotnet test --settings subset.runsettings',
    'ruff check --config relaxed.toml .',
  ]) {
    assert.equal(commandCheckDescriptors(command)[0]?.coverage, 'targeted', command)
  }
})

test('verification environment assignments and boolean flags fail closed unless exact and safe', () => {
  for (const command of [
    'CI=1 npm test',
    'CI=true npm test',
    'NODE_ENV=test npm test',
    'env CI=1 npm test',
    'export CI=1 && npm test',
    'set "CI=true" && npm test',
  ]) {
    assert.equal(commandCheckDescriptors(command)[0]?.coverage, 'cwd', command)
  }

  const rejected = [
    'CI=false npm test',
    'env CI=0 npm test',
    'cross-env NODE_ENV=production npm test',
    'export CI=false && npm test',
    'set NODE_ENV=production && npm test',
    'export CI=1 PATH=/tmp/controlled && npm test',
    'export NODE_ENV=test NODE_OPTIONS=--require=/tmp/x.js && npm test',
    'export CI=1 BASH_ENV=/tmp/x.sh && npm test',
  ]
  for (const command of rejected) {
    assert.deepEqual(commandCheckDescriptors(command), [], command)
  }

  const narrowed = [
    'npm test -- --ci=false',
    'npm test -- --run=false',
    'vitest --run=false',
    'jest --ci=false',
    'mypy --strict=false .',
    'cargo test --offline=false',
  ]
  for (const command of narrowed) {
    assert.notEqual(commandCheckDescriptors(command)[0]?.coverage, 'cwd', command)
  }

  for (const command of [...rejected, ...narrowed]) {
    const state = restoreTaskVerificationRepair()
    observeTaskVerificationRepair(state, {
      name: 'bash_exec',
      args: { command: 'npm test' },
    }, { ok: false, exitCode: 1, stderr: 'assertion failed' }, {
      mutationObserved: true,
    })
    assert.equal(state.pending.size, 1, command)
    observeTaskVerificationRepair(state, {
      name: 'bash_exec',
      args: { command },
    }, { ok: true, exitCode: 0 })
    assert.equal(state.pending.size, 1, command)
  }
})

test('external configuration checks are targeted and cannot clear a full failure', () => {
  const commands = [
    'pytest -c subset.ini',
    'vitest --config subset.config.js',
    'npm test -- --config subset.config.js',
    'eslint --config relaxed.config.js',
    'mypy --config-file relaxed.ini .',
    'dotnet test --settings subset.runsettings',
    'ruff check --config relaxed.toml .',
  ]
  for (const command of commands) {
    assert.equal(commandCheckDescriptors(command)[0]?.coverage, 'targeted', command)
    const kind = commandCheckDescriptors(command)[0]?.kind
    const baseline = kind === 'lint'
      ? 'npm run lint'
      : kind === 'typecheck' ? 'tsc --noEmit' : 'npm test'
    const state = restoreTaskVerificationRepair()
    observeTaskVerificationRepair(state, {
      name: 'bash_exec', args: { command: baseline },
    }, { ok: false, exitCode: 1, stderr: 'project failure' }, { mutationObserved: true })
    observeTaskVerificationRepair(state, {
      name: 'bash_exec', args: { command },
    }, { ok: true, exitCode: 0 })
    assert.equal(state.pending.size, 1, command)
  }
})

test('a passing check only clears debt from the same verifier family', () => {
  for (const [failureCommand, successCommand] of [
    ['npm test', 'pytest'],
    ['npm run lint', 'ruff check .'],
    ['npm run build', 'cargo build'],
    ['tsc --noEmit', 'mypy .'],
  ]) {
    const state = restoreTaskVerificationRepair()
    observeTaskVerificationRepair(state, {
      name: 'bash_exec', args: { command: failureCommand },
    }, { ok: false, exitCode: 1, stderr: 'project failure' }, { mutationObserved: true })
    observeTaskVerificationRepair(state, {
      name: 'bash_exec', args: { command: successCommand },
    }, { ok: true, exitCode: 0 })
    assert.equal(state.pending.size, 1, `${failureCommand} -> ${successCommand}`)
  }
})

test('multiple inconclusive verifier families remain independently blocking', () => {
  const state = restoreTaskVerificationRepair()
  for (const command of ['npm test', 'npm run lint']) {
    observeTaskVerificationRepair(state, {
      name: 'bash_exec', args: { command },
    }, { ok: false, timedOut: true }, { mutationObserved: true })
  }
  assert.equal(state.indeterminate.size, 2)
  assert.equal(hasPendingTaskVerificationRepair(state), true)

  const restored = restoreTaskVerificationRepair(serializeTaskVerificationRepair(state))
  assert.equal(restored.indeterminate.size, 2)
  observeTaskVerificationRepair(restored, {
    name: 'bash_exec', args: { command: 'npm run lint' },
  }, { ok: true, exitCode: 0 })
  assert.deepEqual([...restored.indeterminate.values()].map(({ kind }) => kind), ['test'])
  assert.equal(hasPendingTaskVerificationRepair(restored), true)
  assert.deepEqual(
    taskVerificationRepairDetails(restored)?.checks.map(({ status, kind }) => [status, kind]),
    [['indeterminate', 'test']],
  )
})

test('bounded verification state leaves a durable overflow blocker', () => {
  const state = restoreTaskVerificationRepair()
  for (let index = 0; index < 65; index += 1) {
    observeTaskVerificationRepair(state, {
      name: 'bash_exec',
      args: { command: 'npm test', cwd: `packages/p${index}` },
    }, { ok: false, exitCode: 1, stderr: `failure ${index}` }, {
      mutationObserved: true,
      workspaceRoot: 'D:/workspace',
    })
  }
  assert.equal(state.pending.size, 64)
  assert.equal(state.verificationOverflowed, true)
  for (let index = 0; index < 64; index += 1) {
    observeTaskVerificationRepair(state, {
      name: 'bash_exec',
      args: { command: 'npm test', cwd: `packages/p${index}` },
    }, { ok: true, exitCode: 0 }, { workspaceRoot: 'D:/workspace' })
  }
  assert.equal(state.pending.size, 0)
  assert.equal(hasPendingTaskVerificationRepair(state), true)
  assert.equal(
    taskVerificationRepairDetails(state)?.checks[0]?.code,
    'TASK_VERIFICATION_STATE_OVERFLOW',
  )

  const candidateOverflow = restoreTaskVerificationRepair()
  const indeterminateOverflow = restoreTaskVerificationRepair()
  for (let index = 0; index < 65; index += 1) {
    const call = {
      name: 'bash_exec', args: { command: 'npm test', cwd: `packages/c${index}` },
    }
    observeTaskVerificationRepair(candidateOverflow, call, {
      ok: false, exitCode: 1, stderr: `candidate ${index}`,
    })
    observeTaskVerificationRepair(indeterminateOverflow, call, {
      ok: false, timedOut: true,
    }, { mutationObserved: true, workspaceRoot: 'D:/workspace' })
  }
  assert.equal(candidateOverflow.verificationOverflowed, true)
  assert.equal(indeterminateOverflow.verificationOverflowed, true)
  assert.equal(hasPendingTaskVerificationRepair(candidateOverflow), true)
  assert.equal(hasPendingTaskVerificationRepair(indeterminateOverflow), true)
})

test('verification command parser rejects compound, mutating, and output-producing variants', () => {
  const commands = [
    'npm test && npm lint',
    'cd packages/api && npm test && del victim.txt',
    'npm test || del victim.txt',
    'npm test; del victim.txt',
    'npm test | tee report.txt',
    'npm test > report.txt',
    'npm test 2>&1',
    'npm test & del victim.txt',
    'echo npm test',
    'sh -c "npm test"',
    'env TARGET=$(whoami) npm test',
    'env PATH=fixtures/bin npm test',
    'env NODE_OPTIONS=--require=fixtures/pass.js npm test',
    'BASH_ENV=fixtures/pass.sh npm test',
    'LD_PRELOAD=fixtures/pass.so npm test',
    'export PATH=fixtures/bin && npm test',
    'set NODE_OPTIONS=--require=fixtures/pass.js && npm test',
    'npx eslint src',
    'eslint --fix src',
    'ruff check --fix .',
    'npx --yes eslint src',
    'tsc',
    'mvn clean test',
    'mvn antrun:run test',
    'gradle clean build',
    'gradle destroyEverything test',
    'make clean test',
    'make destroy test',
    'npm run test --if-present',
    'npm test --help',
    'pytest --collect-only',
    'jest --updateSnapshot',
    'vitest -u',
    'eslint --cache src',
    'ruff check --add-noqa .',
    'cargo test --no-run',
    'dotnet test --list-tests',
    'tsc --noEmit --showConfig',
    'mvn test -DskipTests',
    'gradle check -x test',
    'go test -list .',
    'cargo test -- --list',
    'pytest --setup-only',
    'pytest --fixtures',
    'make -n test',
    'make -q test',
    'make -t test',
    'vitest -w tests/unit',
    'go build -n',
    'go vet -n ./...',
    'node --test --test-reporter-destination=src/result.tap',
    'pytest --basetemp src .',
    'mvn -l src/result.log test',
    'dotnet test --results-directory src',
    'dotnet test --logger trx',
    'go test -coverprofile reports/coverage.out ./...',
    'go test -cpuprofile reports/cpu.out ./...',
    'go test -memprofile reports/memory.out ./...',
    'go test -trace reports/trace.out ./...',
    'mypy . --cache-dir .mypy-cache',
    'tsc --noEmit --incremental',
    'tsc --noEmit --tsBuildInfoFile .cache/project.tsbuildinfo',
    'cargo test --target-dir .cache/cargo-target',
    'CARGO_TARGET_DIR=.cache/cargo-target cargo test',
    'gradle --gradle-user-home .cache/gradle check',
    'gradle --project-cache-dir .cache/gradle-project check',
    'mvn -Dsurefire.reportsDirectory=reports test',
  ]
  for (const command of commands) {
    assert.deepEqual(commandCheckDescriptors(command), [], command)
  }
  for (const command of commands.filter((value) => value !== 'echo npm test')) {
    assert.equal(
      isVerificationCall({ name: 'bash_exec', args: { command } }),
      false,
      command,
    )
  }
})

test('unsafe verification-shaped commands cannot clear pending mutation targets', () => {
  for (const command of [
    'echo npm test',
    'npm test && del victim.txt',
    'npm test > report.txt',
  ]) {
    const pending = new Set(['<workspace>', 'src/result.js'])
    assert.equal(clearVerifiedMutationTargets(
      pending,
      { name: 'bash_exec', args: { command } },
      { ok: true, exitCode: 0, stdout: 'not a project verdict' },
    ), false, command)
    assert.deepEqual([...pending], ['<workspace>', 'src/result.js'], command)
  }

  const pending = new Set(['<workspace>', 'src/result.js'])
  assert.equal(clearVerifiedMutationTargets(
    pending,
    { name: 'bash_exec', args: { command: 'npm test' } },
    { ok: true, exitCode: 0 },
  ), true)
  assert.deepEqual([...pending], [])

  for (const command of [
    'npm test --workspace packages/a',
    'python -m pytest packages/a/test_one.py',
    'npx --no-install eslint packages/a',
  ]) {
    const targeted = new Set(['<workspace>', 'packages/a/a.js', 'packages/b/b.js'])
    assert.equal(clearVerifiedMutationTargets(
      targeted,
      { name: 'bash_exec', args: { command } },
      { ok: true, exitCode: 0 },
    ), false, command)
    assert.deepEqual(
      [...targeted],
      ['<workspace>', 'packages/a/a.js', 'packages/b/b.js'],
      command,
    )
  }

  const cwdScoped = new Set(['<workspace>', 'packages/a/a.js', 'packages/b/b.js'])
  assert.equal(clearVerifiedMutationTargets(
    cwdScoped,
    { name: 'bash_exec', args: { command: 'cd packages/a && npm test' } },
    { ok: true, exitCode: 0, cwd: '.' },
  ), true)
  assert.deepEqual([...cwdScoped], ['<workspace>', 'packages/b/b.js'])

  const persistentScope = taskVerificationScopes(
    { name: 'bash_exec', args: { command: 'cd packages/a && npm test' } },
    { ok: true, exitCode: 0, cwd: 'packages/a', session: 'reuse' },
  )
  assert.equal(persistentScope[0]?.cwd, 'packages/a')

  const indeterminate = new Set(['<workspace>', 'src/result.js'])
  assert.equal(clearVerifiedMutationTargets(
    indeterminate,
    { name: 'run_project_check', args: { check: 'test', cwd: '.' } },
    { ok: true, passed: null, verificationVerdict: 'indeterminate' },
  ), false)
  assert.deepEqual([...indeterminate], ['<workspace>', 'src/result.js'])

  const external = new Set([
    '<workspace>',
    'D:/repo/src/a.js',
    'D:/repo/report.pdf',
    'D:/repo/image.png',
    'D:/repo/report.html',
    'D:/repo/report.md',
    'D:/repo/report.txt',
    'D:/repo/report.json',
    'D:/repo/report.csv',
    'D:/other/src/b.js',
  ])
  assert.equal(clearVerifiedMutationTargets(
    external,
    { name: 'run_project_check', args: { check: 'test', cwd: 'D:/repo' } },
    { ok: true, passed: true, verificationVerdict: 'passed', cwd: 'D:/repo' },
    { projectDirectory: 'D:/repo' },
  ), true)
  assert.deepEqual([...external], [
    'D:/repo/report.pdf',
    'D:/repo/image.png',
    'D:/repo/report.html',
    'D:/repo/report.md',
    'D:/repo/report.txt',
    'D:/repo/report.json',
    'D:/repo/report.csv',
    'D:/other/src/b.js',
  ])

  const authorized = new Set([
    '<workspace>',
    'D:/repo/src/original.js',
    'D:/authorized/src/generated.js',
    'D:/authorized/report.html',
  ])
  assert.equal(clearVerifiedMutationTargets(
    authorized,
    { name: 'run_project_check', args: { check: 'test', cwd: 'D:/authorized' } },
    { ok: true, passed: true, verificationVerdict: 'passed', cwd: 'D:/authorized' },
    {
      projectDirectory: 'D:/repo',
      projectDirectories: ['D:/repo', 'D:/authorized'],
    },
  ), true)
  assert.deepEqual([...authorized], [
    '<workspace>',
    'D:/repo/src/original.js',
    'D:/authorized/report.html',
  ])
})

test('project verification result distinguishes project failures from infrastructure failures', () => {
  assert.deepEqual(projectVerificationFields({ ok: true, exitCode: 0 }), {
    passed: true,
    verificationVerdict: 'passed',
    failureKind: null,
    systemFailure: false,
  })
  assert.deepEqual(projectVerificationFields({ ok: false, exitCode: 2 }), {
    passed: false,
    verificationVerdict: 'failed',
    failureKind: 'project',
    systemFailure: false,
  })
  assert.deepEqual(projectVerificationFields({
    ok: false,
    exitCode: 1,
    processTreeCleanupFailed: true,
  }), {
    passed: null,
    verificationVerdict: 'indeterminate',
    failureKind: 'infrastructure',
    systemFailure: true,
  })

  const boundary = processExecutionBoundaryFailure({
    code: 1,
    processStartFailed: true,
    processStartError: 'spawn ENOENT',
  })
  assert.equal(boundary.systemFailure, true)
  assert.equal(boundary.failureKind, 'infrastructure')
  assert.equal(boundary.verificationVerdict, 'indeterminate')

  assert.deepEqual(projectVerificationFields({
    ok: false,
    exitCode: 127,
    stderr: '/bin/sh: 1: eslint: not found',
  }), {
    code: 'VERIFICATION_TOOLCHAIN_UNAVAILABLE',
    passed: null,
    verificationVerdict: 'indeterminate',
    failureKind: 'infrastructure',
    systemFailure: true,
  })
})

test('indeterminate verification never consumes task repair budget', () => {
  const infrastructureResults = [
    { ok: false, exitCode: 1, passed: null, verificationVerdict: 'indeterminate' },
    { ok: false, exitCode: 1, passed: false, systemFailure: true },
    { ok: false, exitCode: 1, passed: false, failureKind: 'infrastructure' },
    { ok: false, exitCode: 1, passed: null, processTreeCleanupFailed: true },
    { ok: false, timedOut: true, passed: null },
    { ok: false, cancelled: true, passed: null },
    {
      ok: false,
      exitCode: 127,
      ...projectVerificationFields({
        ok: false,
        exitCode: 127,
        stderr: '/bin/sh: 1: eslint: not found',
      }),
    },
    {
      ok: false,
      exitCode: 127,
      stderr: '/bin/sh: 1: pytest: not found',
    },
  ]
  for (const result of infrastructureResults) {
    const state = restoreTaskVerificationRepair()
    observeTaskVerificationRepair(state, {
      name: 'run_test',
      args: { command: 'npm test' },
    }, result, { mutationObserved: true })
    assert.equal(state.pending.size, 0, JSON.stringify(result))
    assert.equal(state.candidates.size, 0, JSON.stringify(result))
    assert.equal(state.consecutiveFailures, 0, JSON.stringify(result))
    assert.ok(state.lastIndeterminate, JSON.stringify(result))
    assert.match(buildTaskVerificationRepairPrompt(state), /inconclusive/)
    assert.match(taskVerificationRepairBlockerText(state), /not marked complete/)

    const restored = restoreTaskVerificationRepair(serializeTaskVerificationRepair(state))
    assert.equal(restored.lastIndeterminate?.scope, state.lastIndeterminate.scope)
    observeTaskVerificationRepair(restored, {
      name: 'run_test',
      args: { command: 'npm test' },
    }, { ok: true, exitCode: 0 }, { mutationObserved: true })
    assert.equal(restored.lastIndeterminate, null)
    assert.equal(restored.pending.size, 0)
  }

  const legacyProjectFailure = restoreTaskVerificationRepair()
  observeTaskVerificationRepair(legacyProjectFailure, {
    name: 'run_test',
    args: { command: 'npm test' },
  }, { ok: false, exitCode: 1 }, { mutationObserved: true })
  assert.equal(legacyProjectFailure.pending.size, 1)
  assert.equal(legacyProjectFailure.consecutiveFailures, 1)

  for (const toolName of ['bash_exec', 'run_command']) {
    const unavailable = restoreTaskVerificationRepair()
    unavailable.mutationEpoch = 1
    unavailable.mutationTargets.set('<workspace>', 1)
    observeTaskVerificationRepair(unavailable, {
      name: toolName,
      args: { command: 'pytest' },
    }, {
      ok: false,
      exitCode: 127,
      stderr: '/bin/sh: 1: pytest: not found',
    })
    assert.equal(unavailable.pending.size, 0, toolName)
    assert.equal(unavailable.consecutiveFailures, 0, toolName)
    assert.equal(unavailable.lastIndeterminate?.code, 'VERIFICATION_TOOLCHAIN_UNAVAILABLE')
  }
})

test('process tree cleanup failure remains the stable task verification diagnostic', () => {
  const state = restoreTaskVerificationRepair()
  observeTaskVerificationRepair(state, {
    name: 'run_test',
    args: { command: 'npm test' },
  }, {
    ok: false,
    exitCode: 1,
    code: 'PROCESS_TREE_CLEANUP_FAILED',
    processTreeCleanupFailed: true,
    stdout: 'partial test output before cleanup',
    stderr: 'a child process is still emitting output',
  }, { mutationObserved: true })

  assert.deepEqual(taskVerificationRepairDetails(state)?.checks.map((check) => ({
    code: check.code,
    diagnostic: check.diagnostic,
    status: check.status,
  })), [{
    code: 'PROCESS_TREE_CLEANUP_FAILED',
    diagnostic: 'PROCESS_TREE_CLEANUP_FAILED',
    status: 'indeterminate',
  }])
})

test('mixed project failure and infrastructure failure retain every terminal diagnosis', () => {
  const state = restoreTaskVerificationRepair()
  observeTaskVerificationMutation(state, ['packages/a/source.js'], {
    workspaceRoot: 'D:/workspace',
  })
  observeTaskVerificationRepair(state, {
    name: 'bash_exec',
    args: { command: 'npm test --workspace packages/a' },
  }, {
    ok: false,
    exitCode: 1,
    stderr: 'packages/a/source.test.js: expected 2, received 1',
  }, { workspaceRoot: 'D:/workspace' })
  observeTaskVerificationRepair(state, {
    name: 'bash_exec',
    args: { command: 'npx --no-install eslint packages/a' },
  }, {
    ok: false,
    exitCode: 127,
    stderr: '/bin/sh: 1: eslint: not found',
  }, { workspaceRoot: 'D:/workspace' })

  const details = taskVerificationRepairDetails(state)
  assert.equal(details?.version, 1)
  assert.deepEqual(details?.checks.map(({ status }) => status), ['failed', 'indeterminate'])
  assert.match(details?.checks[0]?.diagnostic || '', /expected 2, received 1/u)
  assert.equal(details?.checks[1]?.code, 'VERIFICATION_TOOLCHAIN_UNAVAILABLE')

  const restored = restoreTaskVerificationRepair(serializeTaskVerificationRepair(state))
  assert.deepEqual(taskVerificationRepairDetails(restored), details)
})

test('targeted verification failure opens debt only after a related mutation', () => {
  const state = restoreTaskVerificationRepair()
  observeTaskVerificationMutation(state, ['packages/b/unrelated.js'], {
    workspaceRoot: 'D:/workspace',
  })
  observeTaskVerificationRepair(state, {
    name: 'bash_exec',
    args: { command: 'python -m pytest packages/a/test_one.py' },
  }, {
    ok: false,
    exitCode: 1,
    stderr: 'assertion failed',
  }, {
    workspaceRoot: 'D:/workspace',
  })
  assert.equal(state.candidates.size, 1)
  assert.equal(state.pending.size, 0)
  assert.equal(state.consecutiveFailures, 0)
  assert.equal([...state.candidates.values()][0].coverage, 'targeted')
  assert.deepEqual([...state.candidates.values()][0].targetPaths, ['packages/a'])

  observeTaskVerificationMutation(state, ['packages/a/implementation.py'], {
    workspaceRoot: 'D:/workspace',
  })
  assert.equal(state.pending.size, 1)
  assert.equal(state.candidates.size, 0)
  assert.equal(state.consecutiveFailures, 0)
  assert.equal([...state.pending.values()][0].requiredEpoch, 2)

  observeTaskVerificationRepair(state, {
    name: 'bash_exec',
    args: { command: 'python -m pytest packages/a/test_one.py' },
  }, { ok: true, exitCode: 0 }, { workspaceRoot: 'D:/workspace' })
  assert.equal(state.pending.size, 0)
})

test('targeted verification success becomes stale after a later mutation', () => {
  const state = restoreTaskVerificationRepair()
  const call = {
    name: 'bash_exec',
    args: { command: 'python -m pytest packages/a/test_one.py' },
  }

  observeTaskVerificationRepair(state, call, { ok: true, exitCode: 0 }, {
    workspaceRoot: 'D:/workspace',
  })
  assert.equal(state.verified.size, 1)
  assert.equal([...state.verified.values()][0].coverage, 'targeted')

  const mutation = observeTaskVerificationMutation(state, ['packages/a/implementation.py'], {
    workspaceRoot: 'D:/workspace',
  })
  assert.equal(mutation.invalidated.length, 1)
  assert.equal(state.verified.size, 0)
  assert.equal(state.pending.size, 1)

  observeTaskVerificationRepair(state, call, { ok: true, exitCode: 0 }, {
    workspaceRoot: 'D:/workspace',
  })
  assert.equal(state.pending.size, 0)
})

test('long verification scope keeps the same identity across checkpoint recovery', () => {
  const state = restoreTaskVerificationRepair()
  const command = `custom-test-runner ${'suite-segment/'.repeat(180)}case.test.js`
  const call = { name: 'run_test', args: { command, cwd: 'D:/workspace' } }

  observeTaskVerificationRepair(state, call, {
    ok: false,
    exitCode: 1,
    stderr: 'case.test.js: assertion failed',
  }, { mutationObserved: true, workspaceRoot: 'D:/workspace' })

  assert.equal(state.pending.size, 1)
  const scopeBefore = [...state.pending.keys()][0]
  assert.ok(scopeBefore.length <= 2_010)
  assert.match(scopeBefore, /#[a-f0-9]{64}$/u)

  const restored = restoreTaskVerificationRepair(serializeTaskVerificationRepair(state))
  assert.deepEqual([...restored.pending.keys()], [scopeBefore])
  observeTaskVerificationRepair(restored, call, { ok: true, exitCode: 0 }, {
    workspaceRoot: 'D:/workspace',
  })
  assert.equal(restored.pending.size, 0)
})

test('a full equivalent check clears failure debt from a differently formatted full check', () => {
  const state = restoreTaskVerificationRepair()
  observeTaskVerificationRepair(state, {
    name: 'bash_exec',
    args: { command: 'pytest -q', cwd: 'D:/workspace' },
  }, {
    ok: false,
    exitCode: 1,
    stderr: 'tests/test_api.py: assertion failed',
  }, { mutationObserved: true, workspaceRoot: 'D:/workspace' })
  assert.equal(state.pending.size, 1)

  observeTaskVerificationRepair(state, {
    name: 'bash_exec',
    args: { command: 'pytest', cwd: 'D:/workspace' },
  }, { ok: true, exitCode: 0 }, { workspaceRoot: 'D:/workspace' })
  assert.equal(state.pending.size, 0)
  assert.equal(state.consecutiveFailures, 0)
})

test('a full check in an authorized external project clears only code targets in its cwd', () => {
  const projectDirectory = 'D:/authorized/external-project'
  const pending = new Set([
    '<workspace>',
    'D:/authorized/external-project/src/result.js',
    'D:/authorized/external-project/output/report.pdf',
    'D:/authorized/sibling/untouched.js',
  ])

  assert.equal(clearVerifiedMutationTargets(
    pending,
    {
      name: 'bash_exec',
      args: { command: 'npm test', cwd: projectDirectory },
    },
    { ok: true, exitCode: 0 },
    { projectDirectory },
  ), true)
  assert.deepEqual([...pending], [
    'D:/authorized/external-project/output/report.pdf',
    'D:/authorized/sibling/untouched.js',
  ])
})
