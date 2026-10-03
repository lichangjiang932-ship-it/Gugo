import assert from 'node:assert/strict'
import test from 'node:test'

import {
  commandCheckDescriptors,
  taskVerificationScopes,
} from '../server/services/loop/taskVerificationCheckScope.js'
import {
  clearVerifiedMutationTargets,
  isLocalMutationCall,
  isVerificationCall,
} from '../server/services/toolLoopHeuristics.js'

function kindsOf(command) {
  return commandCheckDescriptors(command).map((entry) => entry.kind)
}

function bashCall(command, args = {}) {
  return { name: 'bash_exec', args: { command, ...args } }
}

test('compound verification chains keep every check instead of being dropped', () => {
  assert.deepEqual(kindsOf('npm test && npm run lint'), ['test', 'lint'])
  assert.deepEqual(kindsOf('npm run lint && npm run typecheck'), ['lint', 'typecheck'])
  assert.deepEqual(kindsOf('cargo build && cargo test'), ['build', 'test'])

  const descriptors = commandCheckDescriptors('npm test && npm run lint')
  for (const descriptor of descriptors) assert.equal(descriptor.coverage, 'cwd')
  assert.deepEqual(
    descriptors.map((entry) => entry.commandScope),
    ['package-script:test', 'package-script:lint'],
  )
})

test('compound verification chains stay a verification call rather than a mutation', () => {
  const command = 'npm test && npm run lint'
  const call = bashCall(command)
  assert.equal(isVerificationCall(call), true)
  assert.equal(isLocalMutationCall(call), false)

  const pending = new Set(['<workspace>', 'src/app.js'])
  assert.equal(clearVerifiedMutationTargets(
    pending,
    call,
    { ok: true, exitCode: 0, stdout: 'all checks passed' },
  ), true)
  assert.deepEqual([...pending], [])
})

test('a cwd prelude applies to every check in the chain', () => {
  const scopes = taskVerificationScopes(
    bashCall('cd packages/api && npm test && npm run lint'),
    { ok: true, exitCode: 0 },
  )
  assert.deepEqual(scopes.map((scope) => scope.kind), ['test', 'lint'])
  assert.deepEqual(scopes.map((scope) => scope.cwd), ['packages/api', 'packages/api'])
})

test('one non-verification segment invalidates the whole chain', () => {
  for (const command of [
    'npm test && del victim.txt',
    'npm test && echo done',
    'npm test && npm run build > report.txt',
    'npm test && cd packages/api && npm run lint',
  ]) {
    assert.deepEqual(commandCheckDescriptors(command), [], command)
    assert.equal(isVerificationCall(bashCall(command)), false, command)
  }
})

test('a realistic batch of project checks is still a verification', () => {
  const command = [
    'npm run lint',
    'npm run typecheck',
    'npm test',
    'npm run build',
    'npm run check',
  ].join(' && ')
  const descriptors = commandCheckDescriptors(command)
  assert.deepEqual(
    descriptors.map((entry) => entry.commandScope),
    ['package-script:lint', 'package-script:typecheck', 'package-script:test', 'package-script:build', 'package-script:check'],
  )
  assert.equal(isLocalMutationCall(bashCall(command)), false)

  // The chain length is bounded so one command cannot fan out without limit.
  const tooLong = Array.from({ length: 9 }, () => 'npm test').join(' && ')
  assert.deepEqual(commandCheckDescriptors(tooLong), [])
})

test('install-free tool runners are stripped down to the real check', () => {
  const cases = new Map([
    ['npx --no-install eslint src', 'eslint'],
    ['pnpm exec jest', 'jest'],
    ['yarn exec vitest run', 'vitest'],
    ['poetry run pytest -q', 'pytest'],
    ['poetry run python -m pytest', 'pytest'],
    ['pdm run pytest', 'pytest'],
    ['uv run --no-sync pytest', 'pytest'],
  ])
  for (const [command, verifierFamily] of cases) {
    const descriptors = commandCheckDescriptors(command)
    assert.equal(descriptors.length, 1, command)
    assert.equal(descriptors[0].verifierFamily, verifierFamily, command)
    assert.equal(isVerificationCall(bashCall(command)), true, command)
  }
})

test('runners that may fetch a remote package are not verification', () => {
  for (const command of [
    'npx vitest run',
    'npx jest',
    'npx -y eslint src',
    'npx --yes eslint src',
    'pnpm dlx vitest run',
    'yarn dlx vitest run',
    'uv run pytest',
    'pipenv run pytest',
    'hatch run pytest',
  ]) {
    assert.deepEqual(commandCheckDescriptors(command), [], command)
    assert.equal(isVerificationCall(bashCall(command)), false, command)
  }
})

test('package script invocations keep their package-script verifier family', () => {
  for (const command of ['yarn test', 'yarn run test', 'pnpm test', 'bun run check']) {
    const descriptors = commandCheckDescriptors(command)
    assert.equal(descriptors.length, 1, command)
    assert.match(descriptors[0].verifierFamily, /^package-script:/u, command)
    assert.equal(descriptors[0].coverage, 'cwd', command)
  }
})

test('runner prefixes do not turn a mutating command into a verification', () => {
  for (const command of [
    'npx --no-install install',
    'poetry run install',
    'pdm run publish',
    'uv run --no-sync pip install requests',
  ]) {
    assert.deepEqual(commandCheckDescriptors(command), [], command)
    assert.equal(isVerificationCall(bashCall(command)), false, command)
  }
})
