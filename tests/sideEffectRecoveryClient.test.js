import assert from 'node:assert/strict'
import test from 'node:test'

import { setAuthToken } from '../src/lib/accountClient.js'
import {
  listSideEffectRecoveryHistoryApi,
  listUnknownSideEffectsApi,
  resolveUnknownSideEffectApi,
  safeSideEffectResumeDescriptor,
} from '../src/lib/sideEffectRecoveryClient.js'

test('side-effect resume descriptors require exact original turn, tool call, or job identity', () => {
  const turn = { scopeKind: 'turn', sessionId: 'session-1', turnId: 'turn-1', toolCallId: 'call-1' }
  const job = { scopeKind: 'job', jobId: 'job-1', stepId: 'step-1' }

  assert.deepEqual(safeSideEffectResumeDescriptor(turn, {
    kind: 'turn', sessionId: 'session-1', turnId: 'turn-1', toolCallId: 'call-1', ignored: true,
  }), { kind: 'turn', sessionId: 'session-1', turnId: 'turn-1', toolCallId: 'call-1' })
  assert.deepEqual(safeSideEffectResumeDescriptor(job, {
    kind: 'job', jobId: 'job-1', stepId: 'step-1', ignored: true,
  }), { kind: 'job', jobId: 'job-1', stepId: 'step-1' })
  assert.equal(safeSideEffectResumeDescriptor(turn, {
    kind: 'turn', sessionId: 'session-2', turnId: 'turn-1', toolCallId: 'call-1',
  }), null)
  assert.equal(safeSideEffectResumeDescriptor(turn, {
    kind: 'turn', sessionId: 'session-1', turnId: 'turn-2', toolCallId: 'call-1',
  }), null)
  assert.equal(safeSideEffectResumeDescriptor(turn, {
    kind: 'turn', sessionId: 'session-1', turnId: 'turn-1', toolCallId: 'call-other',
  }), null)
  assert.equal(safeSideEffectResumeDescriptor(turn, {
    kind: 'turn', sessionId: 'session-1', turnId: 'turn-1',
  }), null)
  assert.equal(safeSideEffectResumeDescriptor(job, {
    kind: 'job', jobId: 'job-1', stepId: 'step-2',
  }), null)
  assert.equal(safeSideEffectResumeDescriptor(turn, {
    kind: 'job', jobId: 'job-1', stepId: 'step-1',
  }), null)
})

test('side-effect recovery client forwards opaque cursors and preserves page metadata', async () => {
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  const requests = []
  globalThis.window = { localStorage: null, sessionStorage: null }
  setAuthToken('recovery-client-token')
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), init })
    return new Response(JSON.stringify({
      ok: true,
      records: [{ toolCallId: `call-${requests.length}` }],
      nextCursor: requests.length === 1 ? 'next/page+2' : null,
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  try {
    const pending = await listUnknownSideEffectsApi({
      limit: 25,
      cursor: 'page/1+cursor',
    })
    const history = await listSideEffectRecoveryHistoryApi()

    assert.deepEqual(pending, {
      records: [{ toolCallId: 'call-1' }],
      nextCursor: 'next/page+2',
    })
    assert.deepEqual(history, {
      records: [{ toolCallId: 'call-2' }],
      nextCursor: null,
    })
    assert.equal(
      requests[0].url,
      '/api/side-effects/unknown?limit=25&cursor=page%2F1%2Bcursor',
    )
    assert.equal(requests[1].url, '/api/side-effects/history?limit=50')
    assert.equal(requests[0].init.headers.Authorization, 'Bearer recovery-client-token')
    assert.equal(requests[1].init.headers.Authorization, 'Bearer recovery-client-token')
  } finally {
    setAuthToken('')
    globalThis.fetch = originalFetch
    globalThis.window = originalWindow
  }
})

test('resolve client returns the record but drops a cross-record resume descriptor', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({
    ok: true,
    record: { scopeKind: 'turn', sessionId: 'session-1', turnId: 'turn-1', toolCallId: 'call-1', status: 'failed' },
    resume: { kind: 'turn', sessionId: 'session-other', turnId: 'turn-1', toolCallId: 'call-1' },
  }), { status: 200, headers: { 'content-type': 'application/json' } })

  try {
    const result = await resolveUnknownSideEffectApi({
      record: { scopeKind: 'turn', sessionId: 'session-1', turnId: 'turn-1', toolCallId: 'call-1' },
      scopeKey: 'turn-scope',
      toolCallId: 'call-1',
      verificationConfirmed: true,
      confirmToolCallId: 'call-1',
      resolution: 'failed',
    })
    assert.equal(result.record.status, 'failed')
    assert.equal(result.resume, null)
  } finally {
    globalThis.fetch = originalFetch
  }
})
