import assert from 'node:assert/strict'
import test from 'node:test'
import { approvalDecisionNoticeKey, approvalErrorKey, localizeApprovalError } from '../src/lib/approvalErrorPresentation.js'
import { translateKey } from '../src/i18n/translations.js'

test('approval presentation maps actual REST codes before generic HTTP fallback', () => {
  const cases = [
    ['unauthorized', 'unauthorized'], ['not_found', 'notFound'], ['APPROVAL_NOT_FOUND', 'notFound'],
    ['approval_expired', 'expired'], ['PERMISSION_APPROVAL_STALE', 'stalePermissions'],
    ['PERMISSION_APPROVAL_INVALID', 'invalidRequest'], ['PERMISSION_ESCALATION_REQUIRED', 'escalationRequired'],
    ['PERMISSION_APPROVAL_EDIT_FORBIDDEN', 'editForbidden'], ['PERMISSION_APPROVAL_REMEMBER_FORBIDDEN', 'rememberForbidden'],
    ['APPROVAL_EDIT_ARGS_REQUIRED', 'invalidArguments'], ['APPROVAL_TARGET_REQUIRED', 'invalidRequest'],
    ['INVALID_APPROVAL_DECISION', 'invalidRequest'], ['bad_request', 'invalidRequest'], ['APPROVAL_DECISION_FAILED', 'unavailable'],
  ]
  for (const [code, key] of cases) {
    const error = Object.freeze({ code, status: 409, message: 'offline-private-fixture' })
    assert.equal(approvalErrorKey(error), `approvals.errors.${key}`)
    for (const locale of ['zh', 'en']) {
      const expected = translateKey(`approvals.errors.${key}`, locale)
      assert.notEqual(expected, key)
      assert.equal(localizeApprovalError(error, (name) => translateKey(name, locale)), expected)
    }
  }
})

test('unknown errors use bounded status categories without reading or exposing raw messages', () => {
  for (const [status, key] of [[400, 'invalidRequest'], [401, 'unauthorized'], [403, 'forbidden'],
    [404, 'notFound'], [409, 'conflict'], [410, 'expired'], [422, 'invalidArguments'], [503, 'unavailable'],
    [undefined, 'unknown'], [200, 'unknown'], [0, 'unknown'], ['401', 'unauthorized'], [Symbol('invalid'), 'unknown']]) {
    const error = Object.freeze({ code: 'PRIVATE_UNKNOWN_CODE', status,
      get message() { throw new Error('presentation must not inspect raw text') } })
    assert.equal(approvalErrorKey(error), `approvals.errors.${key}`)
  }
  for (const code of ['constructor', '__proto__', 'toString', { private: true }, null]) {
    assert.equal(approvalErrorKey({ code }), 'approvals.errors.unknown')
  }
  assert.equal(approvalErrorKey(null), 'approvals.errors.unknown')
})

test('HTTP 200 decision notices require an explicit persisted already-decided receipt', () => {
  const expired = Object.freeze({ ok: false, alreadyDecided: true, approval: Object.freeze({ status: 'expired' }) })
  assert.equal(approvalDecisionNoticeKey(expired), 'approvals.errors.expired')
  for (const status of ['approved', 'denied', 'edited', 'cancelled', undefined]) {
    assert.equal(approvalDecisionNoticeKey({ ok: false, alreadyDecided: true, approval: { status } }), 'approvals.errors.conflict')
  }
  for (const value of [undefined, null, { ok: true }, { ok: false }, { alreadyDecided: true },
    { ok: true, alreadyDecided: true, approval: { status: 'expired' } },
    { ok: false, alreadyDecided: 'true', approval: { status: 'expired' } }]) {
    assert.equal(approvalDecisionNoticeKey(value), null)
  }
})
