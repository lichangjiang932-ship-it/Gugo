import assert from 'node:assert/strict'
import test from 'node:test'

import {
  getModelRequestRecoveryApi,
  parseModelRecoveryTarget,
  resolveModelRequestRecoveryApi,
  resumeResolvedModelRequestApi,
} from '../src/lib/modelRequestRecoveryClient.js'

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
  }
}

test('model request recovery client routes turn and job targets to their scoped APIs', async () => {
  const previousFetch = globalThis.fetch
  const calls = []
  const recovery = {
    scopeKind: 'job',
    jobId: 'job/1',
    stepId: 'step 1',
    checkpointRevision: 4,
    modelRequestId: 'mr_job_1',
    requestFingerprint: 'a'.repeat(64),
    providerId: 'provider-1',
    modelName: 'model-1',
    configRevision: 7,
    idempotencyKey: 'idem-1',
    status: 'unknown',
    resolution: 'unknown',
  }
  const responses = [
    { recovery: { scopeKind: 'turn', modelRequestId: 'mr_turn_1' } },
    { recovery },
    {
      recovery: { ...recovery, status: 'resolved_pending_resume', resolution: 'not_sent' },
      resume: { ready: true, jobId: 'job/1', stepId: 'step 1' },
    },
    {
      job: { id: 'job/1' },
      resume: { ready: true, jobId: 'job/1', stepId: 'step 1' },
    },
  ]
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, init })
    return jsonResponse(responses.shift())
  }

  try {
    await getModelRequestRecoveryApi({
      scopeKind: 'turn',
      sessionId: 'session 1',
      turnId: 'turn/1',
    })
    assert.deepEqual(await getModelRequestRecoveryApi({
      scopeKind: 'job',
      jobId: 'job/1',
      stepId: 'step 1',
    }), recovery)
    const resolved = await resolveModelRequestRecoveryApi({
      scopeKind: 'job',
      jobId: 'job/1',
      stepId: 'step 1',
      recovery,
      resolution: 'not_sent',
      verificationConfirmed: true,
      confirmModelRequestId: 'mr_job_1',
      note: 'checked provider ledger',
    })
    assert.deepEqual(resolved.resume, {
      ready: true,
      jobId: 'job/1',
      stepId: 'step 1',
    })
    await resumeResolvedModelRequestApi({
      scopeKind: 'job',
      jobId: 'job/1',
      stepId: 'step 1',
    })

    assert.deepEqual(calls.map(({ url }) => url), [
      '/api/turns/turn%2F1/model-request-recovery?sessionId=session+1',
      '/api/jobs/job%2F1/steps/step%201/model-request-recovery',
      '/api/jobs/job%2F1/steps/step%201/model-request-recovery/resolve',
      '/api/jobs/job%2F1/steps/step%201/model-request-recovery/resume',
    ])
    assert.equal(calls[2].init.method, 'POST')
    assert.deepEqual(JSON.parse(calls[2].init.body), {
      checkpointRevision: 4,
      modelRequestId: 'mr_job_1',
      requestFingerprint: 'a'.repeat(64),
      providerId: 'provider-1',
      modelName: 'model-1',
      configRevision: 7,
      idempotencyKey: 'idem-1',
      confirmModelRequestId: 'mr_job_1',
      verificationConfirmed: true,
      resolution: 'not_sent',
      note: 'checked provider ledger',
    })
    assert.equal(Object.hasOwn(JSON.parse(calls[2].init.body), 'checkpointSequence'), false)
    assert.equal(calls[3].init.method, 'POST')
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('settings model recovery target parser keeps job and turn identities separate', () => {
  assert.deepEqual(
    parseModelRecoveryTarget(
      '?tab=recovery&scopeKind=job&jobId=job%2F1&stepId=step+1&modelRequestId=mr_job_1',
      'active-session',
    ),
    {
      scopeKind: 'job',
      jobId: 'job/1',
      stepId: 'step 1',
      modelRequestId: 'mr_job_1',
    },
  )
  assert.deepEqual(
    parseModelRecoveryTarget('?turnId=turn-1&modelRequestId=mr_turn_1', 'active-session'),
    {
      scopeKind: 'turn',
      sessionId: 'active-session',
      turnId: 'turn-1',
      modelRequestId: 'mr_turn_1',
    },
  )
  assert.equal(parseModelRecoveryTarget('?scopeKind=job&jobId=job-1', 'active-session'), null)
  assert.equal(parseModelRecoveryTarget('?scopeKind=unsupported&turnId=turn-1', 'active-session'), null)
})
