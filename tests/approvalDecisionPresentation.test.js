import assert from 'node:assert/strict'
import test from 'node:test'
import { decisionReceiptNotice, decisionFailureNotice } from '../src/lib/approvalDecisionPresentation.js'
const request = { id: 'approval-a', name: 'write_file' }
const owner = { sessionId: 'session-a', turnId: 'turn-a' }
const receipt = status => ({ ok: true, alreadyDecided: false, approval: { id: request.id, toolName: request.name, sessionId: owner.sessionId, status } })
test('only a correlated host receipt confirms the approval decision, never tool execution', () => {
  for (const status of ['approved', 'denied', 'edited']) {
    const notice = decisionReceiptNotice(receipt(status), request, owner)
    assert.equal(notice.state, 'resolved')
    assert.equal(notice.outcome, status)
    assert.equal(JSON.stringify(notice).includes('executionSucceeded'), false)
  }
})
test('missing, mismatched and future receipts remain unknown', () => {
  for (const value of [null, {}, { ok: true }, { ...receipt('approved'), approval: { ...receipt('approved').approval, id: 'other' } },
    { ...receipt('approved'), approval: { ...receipt('approved').approval, sessionId: 'foreign' } },
    { ...receipt('approved'), approval: { ...receipt('approved').approval, toolName: 'bash_exec' } },
    { ...receipt('approved'), approval: { ...receipt('approved').approval, turnId: 'other-turn' } }, receipt('pending'), receipt('future')]) {
    assert.equal(decisionReceiptNotice(value, request, owner).state, 'unknown')
  }
})
test('non-string correlation IDs cannot become decision evidence', () => {
  assert.equal(decisionReceiptNotice({ ok: true, approval: { id: 12, status: 'approved' } }, { id: 12 }, owner).state, 'unknown')
})

test('already-decided receipts report the recorded decision, not success of this click', () => {
  const value = { ...receipt('denied'), ok: false, alreadyDecided: true }
  assert.equal(decisionReceiptNotice(value, request, owner).outcome, 'already-denied')
  assert.equal(decisionReceiptNotice(receipt('expired'), request, owner).state, 'error')
})
test('public failure presentation never copies private transport strings or permits replay', () => {
  const error = Object.assign(new Error('PRIVATE_CREDENTIAL_BODY'), { status: 503, code: 'APPROVAL_DECISION_FAILED' })
  const notice = decisionFailureNotice(error)
  assert.equal(notice.state, 'unknown')
  assert.equal(JSON.stringify(notice).includes(error.message), false)
  assert.equal(decisionFailureNotice({ status: 403 }).state, 'error')
})
