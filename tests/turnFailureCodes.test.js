import assert from 'node:assert/strict'
import test from 'node:test'

import {
  PERMANENT_FAILED_RETRY_REJECTION_CODES,
  TURN_HOST_CONFIGURATION_FAILURE_CODES,
  TURN_HOST_PRE_EXECUTION_FAILURE_CODES,
  TURN_HOST_TRANSIENT_FAILURE_CODES,
  TURN_HOST_UNAVAILABLE_FAILURE_CODES,
} from '../shared/turnFailureCodes.js'
import {
  isPermanentFailedRetryRejectionFailure,
  isRuntimeInterruptionFailure,
  isRuntimeUnavailableFailure,
} from '../src/lib/chatFlowGuards.js'
import {
  describeTurnEngineHostUnavailableError,
  isTurnEngineHostUnavailableError,
} from '../server/services/turnEngineHostErrorContract.js'
import { isPermanentFailedRetryRejectionCode } from '../server/services/turnFailedRetryRejection.js'

function shapes(code) {
  return [
    { code },
    { error: { code } },
    { payload: { error: { code } } },
  ]
}

test('client and server agree on every permanent failed-retry rejection code', () => {
  assert.equal(PERMANENT_FAILED_RETRY_REJECTION_CODES.has('TURN_FAILED_RETRY_CONFLICT'), true)
  for (const code of PERMANENT_FAILED_RETRY_REJECTION_CODES) {
    assert.equal(isPermanentFailedRetryRejectionCode(code), true, code)
    for (const value of shapes(code)) {
      assert.equal(isPermanentFailedRetryRejectionFailure(value), true, code)
    }
  }
})

test('the client does not reject a retry the server would still accept', () => {
  for (const code of ['TURN_FAILED_RETRY_RETRYABLE', 'TURN_INTERRUPTED', 'RUNTIME_NOT_READY']) {
    assert.equal(isPermanentFailedRetryRejectionCode(code), false, code)
    assert.equal(isPermanentFailedRetryRejectionFailure({ code }), false, code)
  }
})

test('every host code the server reports 503 for is a client runtime failure', () => {
  for (const code of TURN_HOST_UNAVAILABLE_FAILURE_CODES) {
    assert.equal(isTurnEngineHostUnavailableError({ code }), true, code)
    const described = describeTurnEngineHostUnavailableError({ code })
    assert.equal(described?.statusCode, 503, code)
    assert.equal(
      isRuntimeUnavailableFailure({ code }) || isRuntimeInterruptionFailure({ code }),
      true,
      code,
    )
  }
})

test('a transient session-activity failure is a retryable runtime failure', () => {
  for (const code of TURN_HOST_TRANSIENT_FAILURE_CODES) {
    assert.equal(isRuntimeUnavailableFailure({ code }), true, code)
    assert.equal(
      describeTurnEngineHostUnavailableError({ code })?.error?.message,
      'turn activity could not be verified; retry shortly',
      code,
    )
  }
})

test('configuration failures are the only ones that ask for a runtime restart', () => {
  const restartCodes = [...TURN_HOST_UNAVAILABLE_FAILURE_CODES].filter((code) => (
    describeTurnEngineHostUnavailableError({ code })?.error?.action === 'restart_runtime'
  ))
  assert.deepEqual(new Set(restartCodes), TURN_HOST_CONFIGURATION_FAILURE_CODES)
})

test('the client host-pre-execution table invents no code the server cannot report', () => {
  for (const code of TURN_HOST_PRE_EXECUTION_FAILURE_CODES) {
    const known = isTurnEngineHostUnavailableError({ code }) || code === 'RUNTIME_NOT_READY'
    assert.equal(known, true, code)
    assert.equal(isRuntimeUnavailableFailure({ code }), true, code)
  }
})
