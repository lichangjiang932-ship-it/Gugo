import assert from 'node:assert/strict'
import test from 'node:test'

import { diagnosticPaths } from '../server/services/loop/taskVerificationAttribution.js'
import {
  compactVerificationDiagnostic,
  isDeterministicVerificationFailure,
  isDeterministicVerificationSuccess,
} from '../server/services/loop/taskVerificationResult.js'
import { projectVerificationFields } from '../server/utils/processExecutionFailure.js'

test('an unprojected result without an exit code is not a verification pass', () => {
  for (const result of [
    { ok: true },
    { ok: true, exitCode: null },
    { ok: true, exitCode: undefined },
  ]) {
    assert.equal(isDeterministicVerificationSuccess(result), false, JSON.stringify(result))
    assert.equal(isDeterministicVerificationFailure(result), false, JSON.stringify(result))
  }
  assert.equal(isDeterministicVerificationSuccess({ ok: true, exitCode: 0 }), true)
  assert.equal(isDeterministicVerificationSuccess({ ok: true, exitCode: '0' }), true)
  assert.equal(isDeterministicVerificationSuccess({ ok: true, exitCode: 1 }), false)
  assert.equal(isDeterministicVerificationSuccess({ ok: true, exitCode: 'boom' }), false)
  assert.equal(isDeterministicVerificationFailure({ ok: false, exitCode: 1 }), true)
})

test('the projection is the authority on the pass verdict', () => {
  const passing = { ok: true, exitCode: 0, stdout: '2 passing' }
  const projectedPass = { ...passing, ...projectVerificationFields(passing) }
  assert.equal(projectedPass.passed, true)
  assert.equal(isDeterministicVerificationSuccess(projectedPass), true)

  // A shell that reports the exit code through the projection rather than the
  // raw field is only a pass once that verdict exists.
  const projectedNoExitCode = { ...passing, ...projectVerificationFields({ ok: true }) }
  assert.equal(projectedNoExitCode.passed, true)
  assert.equal(isDeterministicVerificationSuccess(projectedNoExitCode), true)

  // Contradictory input - ok true with a failing exit code - is neither a pass
  // nor a deterministic failure, so it stays indeterminate.
  const contradictory = { ok: true, exitCode: 1 }
  assert.equal(isDeterministicVerificationSuccess(contradictory), false)
  assert.equal(isDeterministicVerificationFailure(contradictory), false)
})

test('failure paths win the bounded path budget over a long run of passing cases', () => {
  const passing = Array.from(
    { length: 900 },
    (_, index) => `PASS packages/unit/spec-${index}.test.js (12 ms)`,
  ).join('\n')
  const failing = [
    'FAIL packages/checkout/cart.test.js',
    '  at packages/checkout/cart.test.js:42:11',
    '  expected 3 to be 4',
    'FAIL packages/checkout/discount.test.js',
  ].join('\n')
  const result = { stdout: `${passing}\n${failing}`, exitCode: 1 }
  assert.ok(result.stdout.length > 20_000)

  const paths = diagnosticPaths(result)
  assert.deepEqual(paths.slice(0, 2), [
    'packages/checkout/cart.test.js',
    'packages/checkout/discount.test.js',
  ])
})

test('a failing path beyond both scan windows is still attributed', () => {
  const padding = 'x'.repeat(25_000)
  const paths = diagnosticPaths({
    stderr: [
      'FAIL packages/early/config.test.js',
      padding,
      'FAIL packages/middle/schema.test.js',
      padding,
      'FAIL packages/late/final.test.js',
    ].join('\n'),
    exitCode: 1,
  })
  assert.ok(paths.includes('packages/late/final.test.js'), paths.join(','))
  assert.ok(paths.includes('packages/early/config.test.js'), paths.join(','))
})

test('a long diagnostic keeps its trailing failure summary', () => {
  const diagnostic = compactVerificationDiagnostic(
    `${'PASS suites/ok.test.js\n'.repeat(400)}AssertionError: expected 2 to be 3`,
  )
  assert.match(diagnostic, /AssertionError: expected 2 to be 3/u)
  assert.ok(diagnostic.length <= 1_200)
})
