import assert from 'node:assert/strict'
import test from 'node:test'
import { getSideEffectTurnInteractionApi, resolveSideEffectTurnInteractionApi } from '../src/lib/sideEffectRecoveryClient.js'
import { normalizeServerSessionSnapshot } from '../src/lib/turnClient/sessionSnapshot.js'

const scope = { sessionId: 'session', turnId: 'turn', toolCallId: 'call' }
const pending = () => ({ ...scope, scopeKind: 'turn', scopeKey: JSON.stringify(['turn', scope.sessionId, scope.turnId]),
  argsDigest: 'a'.repeat(64), status: 'unknown', toolName: 'write_file', evidence: { targetSummary: ['output/report.md'] } })
const boundary = { id: 'blocked-event', sequence: 10, type: 'turn.blocked' }
const reply = body => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })

function mockFetch(t, implementation) {
  const previous = globalThis.fetch
  globalThis.fetch = implementation
  t.after(() => { globalThis.fetch = previous })
}

test('inline client fetches exactly the selected operation, forwards cancellation and never lists other tasks', async t => {
  const requests = []
  const controller = new AbortController()
  mockFetch(t, async (url, init) => { requests.push({ url, init }); return reply({ record: pending(), boundary }) })
  const result = await getSideEffectTurnInteractionApi({ ...scope, signal: controller.signal })
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, '/api/side-effects/unknown/turn?sessionId=session&turnId=turn&toolCallId=call')
  assert.equal(requests[0].init.signal, controller.signal)
  assert.equal(requests[0].init.method, undefined)
  assert.deepEqual(result, { record: pending(), boundary })
})

test('inactive operation is not a successful confirmation or a reason to retry', async t => {
  let count = 0
  mockFetch(t, async () => { count += 1; return reply({ record: null, boundary: null }) })
  assert.deepEqual(await getSideEffectTurnInteractionApi(scope), { record: null, boundary: null })
  assert.equal(count, 1)
})

test('cross-task and corrupt GET responses are rejected', async t => {
  let body
  mockFetch(t, async () => reply(body))
  for (const record of [
    { ...pending(), sessionId: 'other' }, { ...pending(), turnId: 'other' }, { ...pending(), toolCallId: 'other' },
    { ...pending(), scopeKey: '["turn","other","other"]' }, { ...pending(), argsDigest: 'wrong' },
    undefined,
  ]) {
    body = { record, boundary }
    await assert.rejects(getSideEffectTurnInteractionApi(scope), { code: 'SIDE_EFFECT_RECOVERY_SCOPE_MISMATCH' })
  }
  for (const invalid of [null, { ...boundary, type: 'turn.completed' }, { ...boundary, sequence: -1 }]) {
    body = { record: pending(), boundary: invalid }
    await assert.rejects(getSideEffectTurnInteractionApi(scope), { code: 'SIDE_EFFECT_RECOVERY_BOUNDARY_INVALID' })
  }
})

test('a reloaded confirmed operation requires a real receipt and never submits or resumes by reading it', async t => {
  let calls = 0
  let body = { record: { ...pending(), status: 'failed' }, boundary }
  mockFetch(t, async (url, init) => {
    calls += 1
    assert.equal(init.method, undefined)
    assert.ok(String(url).startsWith('/api/side-effects/unknown/turn?'))
    return reply(body)
  })
  await assert.rejects(getSideEffectTurnInteractionApi(scope), { code: 'SIDE_EFFECT_RECOVERY_RESPONSE_INVALID' })
  body = { ...body, confirmation: { resolution: 'failed', confirmedAt: 1000 }, resume: { kind: 'turn', ...scope } }
  assert.deepEqual(await getSideEffectTurnInteractionApi(scope), body)
  assert.equal(calls, 2)
  body = { ...body, confirmation: { resolution: 'committed', confirmedAt: 1000 } }
  await assert.rejects(getSideEffectTurnInteractionApi(scope), { code: 'SIDE_EFFECT_RECOVERY_RESPONSE_INVALID' })
})

test('confirmation posts only the frozen identity, digest, boundary and explicit outcome', async t => {
  const requests = []
  const controller = new AbortController()
  mockFetch(t, async (url, init) => {
    requests.push({ url, init })
    return reply({ ok: true, record: { ...pending(), status: 'failed' }, resume: { kind: 'turn', ...scope } })
  })
  const result = await resolveSideEffectTurnInteractionApi({
    record: { ...pending(), args: { secret: 'must-not-post' }, failure: { message: 'must-not-post' } },
    boundary: { ...boundary, url: 'https://must-not-post.invalid' },
    resolution: 'failed', verificationConfirmed: true, confirmToolCallId: scope.toolCallId,
    signal: controller.signal,
  })
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    ...scope, argsDigest: pending().argsDigest, boundary,
    resolution: 'failed', verificationConfirmed: true, confirmToolCallId: scope.toolCallId,
  })
  assert.equal(requests[0].url, '/api/side-effects/resolve/turn')
  assert.equal(requests[0].init.signal, controller.signal)
  assert.equal(requests[0].init.method, 'POST')
  assert.deepEqual(result.resume, { kind: 'turn', ...scope })
})

test('ordinary approval, forged confirmation and malformed IDs cannot send a POST', async t => {
  mockFetch(t, () => assert.fail('invalid confirmation must not contact the server'))
  const valid = { record: pending(), boundary, resolution: 'failed', verificationConfirmed: true, confirmToolCallId: 'call' }
  for (const patch of [
    { verificationConfirmed: false }, { resolution: 'approve' }, { confirmToolCallId: 'other' },
  ]) await assert.rejects(resolveSideEffectTurnInteractionApi({ ...valid, ...patch }), { code: 'SIDE_EFFECT_RECOVERY_CONFIRMATION_REQUIRED' })
  await assert.rejects(getSideEffectTurnInteractionApi({ ...scope, turnId: ' padded ' }), { code: 'SIDE_EFFECT_RECOVERY_SCOPE_MISMATCH' })
  await assert.rejects(resolveSideEffectTurnInteractionApi({ ...valid, record: { ...pending(), scopeKey: 'wrong' } }), { code: 'SIDE_EFFECT_RECOVERY_SCOPE_MISMATCH' })
})

test('a lost or mismatched confirmation response is not retried or accepted as success', async t => {
  let count = 0
  let response = () => { throw new Error('response lost') }
  mockFetch(t, async () => { count += 1; return response() })
  const input = { record: pending(), boundary, resolution: 'failed', verificationConfirmed: true, confirmToolCallId: 'call' }
  await assert.rejects(resolveSideEffectTurnInteractionApi(input), /response lost/u)
  assert.equal(count, 1)
  for (const patch of [
    { resume: { kind: 'turn', ...scope, turnId: 'other' } },
    { record: { ...pending(), status: 'failed', argsDigest: 'b'.repeat(64) } }, { ok: false },
  ]) {
    response = () => reply({ ok: true, record: { ...pending(), status: 'failed' }, resume: { kind: 'turn', ...scope }, ...patch })
    await assert.rejects(resolveSideEffectTurnInteractionApi(input), { code: 'SIDE_EFFECT_RECOVERY_RESPONSE_INVALID' })
  }
  assert.equal(count, 4)
})

test('reloaded side-effect cards keep complete tool IDs and never inherit a settings link', () => {
  const toolCallId = `call_${'x'.repeat(220)}`
  for (const action of [{ kind: 'confirm_side_effect' }, { kind: 'open_settings', path: '/settings?tab=recovery' }]) {
    const result = normalizeServerSessionSnapshot({ complete: true, messages: [{
      id: 'turn:assistant', role: 'assistant', content: '', createdAt: 1,
      modelContext: { turnId: 'turn', turnEvidence: true, evidenceState: 'blocked',
        error: { code: 'SIDE_EFFECT_OUTCOME_UNKNOWN', retryable: false },
        recovery: { recoveryKind: 'side_effect_outcome_unknown', requiresUserVerification: true, toolCallId, recoveryAction: action } },
    }] })
    assert.equal(result.messages[0].meta.serverRecoveryToolCallId, toolCallId)
    assert.equal(result.messages[0].meta.serverRecoveryActionPath, null)
    assert.equal(result.messages[0].meta.serverRecoveryBlocked, true)
  }
})
