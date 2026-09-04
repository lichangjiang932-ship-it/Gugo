import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveTaskVerificationLimits } from '../server/services/loop/taskVerificationRepairPresentation.js'

test('task verification limits are configurable within hard safety ceilings', () => {
  assert.deepEqual(resolveTaskVerificationLimits({}), {
    maxFailures: 3,
    maxTerminalChecks: 9,
  })
  assert.deepEqual(resolveTaskVerificationLimits({
    TASK_VERIFICATION_MAX_FAILURES: '4',
    TASK_VERIFICATION_MAX_TERMINAL_CHECKS: '32',
  }), {
    maxFailures: 4,
    maxTerminalChecks: 32,
  })
  assert.deepEqual(resolveTaskVerificationLimits({
    TASK_VERIFICATION_MAX_FAILURES: '999',
    TASK_VERIFICATION_MAX_TERMINAL_CHECKS: '999',
  }), {
    maxFailures: 5,
    maxTerminalChecks: 64,
  })
  assert.deepEqual(resolveTaskVerificationLimits({
    TASK_VERIFICATION_MAX_FAILURES: 'invalid',
    TASK_VERIFICATION_MAX_TERMINAL_CHECKS: '0',
  }), {
    maxFailures: 3,
    maxTerminalChecks: 9,
  })
})
