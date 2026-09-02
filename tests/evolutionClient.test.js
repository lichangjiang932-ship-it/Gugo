import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyEvolutionConfigCandidateApi,
  createEvolutionCanaryApi,
  createEvolutionCanaryGraderPolicyApi,
  createEvolutionCanaryRollbackPolicyApi,
  createEvolutionPromotionApi,
  createEvolutionReplaySuiteApi,
  decideEvolutionApprovalApi,
  decideEvolutionConfigApprovalApi,
  evaluateEvolutionConfigReplayApi,
  evaluateEvolutionReplayApi,
  generateEvolutionCandidateApi,
  getEvolutionApprovalApi,
  getEvolutionApprovalReviewApi,
  getEvolutionCanaryApi,
  getEvolutionCanaryOnlineGradesApi,
  getEvolutionCandidateApi,
  getEvolutionConfigApplyReviewApi,
  getEvolutionConfigApprovalReviewApi,
  getEvolutionDatasetApi,
  getEvolutionEvaluationApi,
  getEvolutionOperationApi,
  getEvolutionPromotionApi,
  getEvolutionPromotionReviewApi,
  getEvolutionReplayRunApi,
  listEvolutionApprovalsApi,
  listEvolutionCanariesApi,
  listEvolutionCandidatesApi,
  listEvolutionConfigChangesApi,
  listEvolutionEvaluationsApi,
  listEvolutionEvidenceApi,
  listEvolutionPromotionsApi,
  listEvolutionExclusionsApi,
  listEvolutionReplayRunsApi,
  listEvolutionReplaySuitesApi,
  recordChatFeedback,
  recoverEvolutionOperationNotSentApi,
  reviewEvolutionConfigCandidateApi,
  resumeEvolutionOperationApi,
  reverseEvolutionConfigChangeApi,
  revokeEvolutionPromotionApi,
  runEvolutionReplayApi,
  runEvolutionConfigReplayApi,
  runEvolutionCanaryOnlineGradeApi,
  setEvolutionEvidenceExcludedApi,
  startEvolutionCanaryApi,
  stopEvolutionCanaryApi,
} from '../src/lib/evolutionClient.js'

test('evolution client forwards the frozen operation recovery challenge exactly once per request', async () => {
  const originalFetch = globalThis.fetch
  const requests = []
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url, init })
    return new Response(JSON.stringify({ ok: true, operation: { id: 'operation/1' } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  try {
    const recovery = {
      verificationConfirmed: true,
      confirmOperationId: 'operation/1',
      recoveryChallenge: '12345678-1234-4234-8234-123456789abc',
      recoveryRevision: 3,
    }
    await getEvolutionOperationApi('operation/1')
    await resumeEvolutionOperationApi('operation/1')
    await recoverEvolutionOperationNotSentApi('operation/1', recovery)

    assert.deepEqual(requests.map(({ url }) => url), [
      '/api/evolution/operations/operation%2F1',
      '/api/evolution/operations/operation%2F1/resume',
      '/api/evolution/operations/operation%2F1/recover-not-sent',
    ])
    assert.equal(requests[0].init.method, undefined)
    assert.equal(requests[1].init.method, 'POST')
    assert.deepEqual(JSON.parse(requests[1].init.body), {})
    assert.equal(requests[2].init.method, 'POST')
    assert.deepEqual(JSON.parse(requests[2].init.body), recovery)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('evolution client drives the reviewed config replay, approval, apply, and reversal workflow', async () => {
  const originalFetch = globalThis.fetch
  const requests = []
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url, init })
    return new Response(JSON.stringify({ ok: true }), {
      status: init.method === 'POST' ? 201 : 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  try {
    const approvalInput = {
      evaluationId: 'evaluation/1',
      decision: 'approved',
      reason: 'Reviewed deterministic config evidence',
      confirmations: { evaluationFingerprint: 'a'.repeat(64) },
    }
    const applyInput = {
      approvalId: 'approval/1',
      reason: 'Apply reviewed config',
      confirmations: { applyFingerprint: 'b'.repeat(64) },
    }
    const reverseInput = {
      reason: 'Restore reviewed baseline',
      confirmations: { currentDocumentSha256: 'c'.repeat(64) },
    }

    await runEvolutionConfigReplayApi('candidate/1')
    await evaluateEvolutionConfigReplayApi('replay/1')
    await getEvolutionConfigApprovalReviewApi('evaluation/1')
    await decideEvolutionConfigApprovalApi(approvalInput)
    await getEvolutionConfigApplyReviewApi('approval/1')
    await applyEvolutionConfigCandidateApi(applyInput)
    await listEvolutionConfigChangesApi({ limit: 12 })
    await reverseEvolutionConfigChangeApi('change/1', 'rollback', reverseInput)

    assert.deepEqual(requests.map(({ url }) => url), [
      '/api/evolution/config-replays',
      '/api/evolution/config-evaluations',
      '/api/evolution/config-approval-reviews/evaluation%2F1',
      '/api/evolution/config-approvals',
      '/api/evolution/config-apply-reviews/approval%2F1',
      '/api/evolution/config-changes/apply',
      '/api/evolution/config-changes?limit=12',
      '/api/evolution/config-changes/change%2F1/rollback',
    ])
    assert.deepEqual(JSON.parse(requests[0].init.body), { candidateId: 'candidate/1' })
    assert.deepEqual(JSON.parse(requests[1].init.body), { replayId: 'replay/1' })
    assert.deepEqual(JSON.parse(requests[3].init.body), approvalInput)
    assert.deepEqual(JSON.parse(requests[5].init.body), applyInput)
    assert.deepEqual(JSON.parse(requests[7].init.body), reverseInput)
    assert.equal(requests[2].init.method, undefined)
    assert.equal(requests[4].init.method, undefined)
    assert.equal(requests[6].init.method, undefined)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('evolution client starts the bounded automatic config review without approval or apply input', async () => {
  const originalFetch = globalThis.fetch
  let captured
  globalThis.fetch = async (url, init = {}) => {
    captured = { url, init }
    return new Response(JSON.stringify({
      ok: true,
      review: { state: 'awaiting_explicit_approval' },
    }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    })
  }

  try {
    const result = await reviewEvolutionConfigCandidateApi('candidate/automatic')
    assert.equal(result.review.state, 'awaiting_explicit_approval')
    assert.equal(captured.url, '/api/evolution/config-reviews')
    assert.equal(captured.init.method, 'POST')
    assert.deepEqual(JSON.parse(captured.init.body), { candidateId: 'candidate/automatic' })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('evolution client persists feedback and reads only the versioned evidence corpus', async () => {
  const originalFetch = globalThis.fetch
  const requests = []
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url, init })
    const body = url === '/api/evolution/feedback'
      ? { ok: true, evidence: { id: 'feedback:1' } }
      : { ok: true, schemaVersion: 1, evidence: [] }
    return new Response(JSON.stringify(body), {
      status: url === '/api/evolution/feedback' ? 201 : 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  try {
    assert.equal(await recordChatFeedback(' improve errors ', 'chat-1'), true)
    const corpus = await listEvolutionEvidenceApi({ limit: 25 })
    assert.equal(corpus.schemaVersion, 1)
    assert.equal(requests[0].url, '/api/evolution/feedback')
    assert.equal(requests[0].init.method, 'POST')
    assert.deepEqual(JSON.parse(requests[0].init.body), {
      feedback: 'improve errors',
      sessionId: 'chat-1',
    })
    assert.equal(requests[1].url, '/api/evolution/evidence?limit=25')
    assert.equal(requests[1].init.method, undefined)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('evolution client reads curated datasets and manages reversible exclusions', async () => {
  const originalFetch = globalThis.fetch
  const requests = []
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url, init })
    const body = url.startsWith('/api/evolution/dataset')
      ? { ok: true, dataset: { schemaVersion: 1, records: [] } }
      : url === '/api/evolution/exclusions' && init.method === 'POST'
        ? { ok: true, exclusion: { evidenceId: 'feedback:1', excluded: true } }
        : { ok: true, exclusions: [] }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  try {
    const dataset = await getEvolutionDatasetApi({ limit: 50 })
    const exclusions = await listEvolutionExclusionsApi()
    const result = await setEvolutionEvidenceExcludedApi('feedback:1', true, 'duplicate')
    assert.equal(dataset.dataset.schemaVersion, 1)
    assert.deepEqual(exclusions.exclusions, [])
    assert.equal(result.exclusion.excluded, true)
    assert.equal(requests[0].url, '/api/evolution/dataset?limit=50')
    assert.equal(requests[1].url, '/api/evolution/exclusions')
    assert.equal(requests[1].init.method, undefined)
    assert.equal(requests[2].init.method, 'POST')
    assert.deepEqual(JSON.parse(requests[2].init.body), {
      evidenceId: 'feedback:1',
      excluded: true,
      reason: 'duplicate',
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('evolution client generates and reads inert candidates without an apply client', async () => {
  const originalFetch = globalThis.fetch
  const requests = []
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url, init })
    const body = url === '/api/evolution/candidates/generate'
      ? { ok: true, candidate: { id: 'candidate-1', state: 'proposed' } }
      : url === '/api/evolution/candidates?limit=10'
        ? { ok: true, schemaVersion: 1, candidates: [] }
        : { ok: true, candidate: { id: 'candidate-1', content: 'proposal' } }
    return new Response(JSON.stringify(body), {
      status: url === '/api/evolution/candidates/generate' ? 201 : 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  try {
    const input = {
      kind: 'prompt',
      target: 'prompt:system',
      objective: 'Improve verification',
      datasetFingerprint: 'a'.repeat(64),
      sourceRecordIds: ['record:1234567890abcdef12345678'],
      providerId: 'candidate-provider',
      modelName: 'candidate-model',
    }
    const generated = await generateEvolutionCandidateApi(input)
    const listed = await listEvolutionCandidatesApi({ limit: 10 })
    const detail = await getEvolutionCandidateApi('candidate/1')
    assert.equal(generated.candidate.state, 'proposed')
    assert.deepEqual(listed.candidates, [])
    assert.equal(detail.candidate.content, 'proposal')
    assert.equal(requests[0].url, '/api/evolution/candidates/generate')
    assert.equal(requests[0].init.method, 'POST')
    assert.deepEqual(JSON.parse(requests[0].init.body), input)
    assert.equal(requests[1].url, '/api/evolution/candidates?limit=10')
    assert.equal(requests[2].url, '/api/evolution/candidates/candidate%2F1')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('evolution client creates suites and reads isolated replay results without evaluation or apply clients', async () => {
  const originalFetch = globalThis.fetch
  const requests = []
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url, init })
    const body = url === '/api/evolution/replay-suites' && init.method === 'POST'
      ? { ok: true, suite: { id: 'suite-1' } }
      : url === '/api/evolution/replays/run'
        ? { ok: true, replay: { id: 'run-1', state: 'completed' } }
        : url.startsWith('/api/evolution/replay-suites?')
          ? { ok: true, suites: [] }
          : url.startsWith('/api/evolution/replays?')
            ? { ok: true, replays: [] }
            : { ok: true, replay: { id: 'run-1', results: [] } }
    return new Response(JSON.stringify(body), {
      status: init.method === 'POST' ? 201 : 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  try {
    await createEvolutionReplaySuiteApi({ name: 'suite' })
    await listEvolutionReplaySuitesApi({ limit: 10 })
    await runEvolutionReplayApi({ suiteId: 'suite-1' })
    await listEvolutionReplayRunsApi({ limit: 20 })
    await getEvolutionReplayRunApi('run/1')
    assert.equal(requests[0].url, '/api/evolution/replay-suites')
    assert.equal(requests[0].init.method, 'POST')
    assert.equal(requests[1].url, '/api/evolution/replay-suites?limit=10')
    assert.equal(requests[2].url, '/api/evolution/replays/run')
    assert.equal(requests[2].init.method, 'POST')
    assert.equal(requests[3].url, '/api/evolution/replays?limit=20')
    assert.equal(requests[4].url, '/api/evolution/replays/run%2F1')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('evolution client requests independent evaluations with an optional explicit Provider and model and no approval', async () => {
  const originalFetch = globalThis.fetch
  const requests = []
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url, init })
    const body = url === '/api/evolution/evaluations' && init.method === 'POST'
      ? { ok: true, evaluation: { id: 'evaluation-1', verdict: 'pass' } }
      : url.startsWith('/api/evolution/evaluations?')
        ? { ok: true, evaluations: [] }
        : { ok: true, evaluation: { id: 'evaluation-1', caseAssessments: [] } }
    return new Response(JSON.stringify(body), {
      status: init.method === 'POST' ? 201 : 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  try {
    const evaluated = await evaluateEvolutionReplayApi('replay-1')
    await evaluateEvolutionReplayApi('replay-2', {
      providerId: ' evaluator-provider ',
      modelName: ' independent-evaluator ',
    })
    await listEvolutionEvaluationsApi({ limit: 10 })
    await getEvolutionEvaluationApi('evaluation/1')
    assert.equal(evaluated.evaluation.verdict, 'pass')
    assert.equal(requests[0].url, '/api/evolution/evaluations')
    assert.equal(requests[0].init.method, 'POST')
    assert.deepEqual(JSON.parse(requests[0].init.body), { replayId: 'replay-1' })
    assert.deepEqual(JSON.parse(requests[1].init.body), {
      replayId: 'replay-2',
      evaluatorProviderId: 'evaluator-provider',
      evaluatorModelName: 'independent-evaluator',
    })
    assert.equal(requests[2].url, '/api/evolution/evaluations?limit=10')
    assert.equal(requests[3].url, '/api/evolution/evaluations/evaluation%2F1')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('evolution client reviews and records a human decision without an apply or rollout request', async () => {
  const originalFetch = globalThis.fetch
  const requests = []
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url, init })
    const body = url.startsWith('/api/evolution/approval-reviews/')
      ? { ok: true, review: { evaluationId: 'evaluation-1', eligibility: { canApprove: true } } }
      : url === '/api/evolution/approvals' && init.method === 'POST'
        ? { ok: true, approval: { id: 'approval-1', decision: 'approved' } }
        : url.startsWith('/api/evolution/approvals?')
          ? { ok: true, approvals: [] }
          : { ok: true, approval: { id: 'approval-1', reviewSnapshot: {} } }
    return new Response(JSON.stringify(body), {
      status: init.method === 'POST' ? 201 : 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  try {
    const input = {
      evaluationId: 'evaluation-1',
      decision: 'approved',
      reason: 'Reviewed all evidence',
      confirmations: {
        candidateContentSha256: 'a'.repeat(64),
        replayRunFingerprint: 'b'.repeat(64),
        evaluationFingerprint: 'c'.repeat(64),
        rollbackBaselineSha256: 'd'.repeat(64),
      },
    }
    await getEvolutionApprovalReviewApi('evaluation/1')
    const decided = await decideEvolutionApprovalApi(input)
    await listEvolutionApprovalsApi({ limit: 10 })
    await getEvolutionApprovalApi('approval/1')
    assert.equal(decided.approval.decision, 'approved')
    assert.equal(requests[0].url, '/api/evolution/approval-reviews/evaluation%2F1')
    assert.equal(requests[1].url, '/api/evolution/approvals')
    assert.equal(requests[1].init.method, 'POST')
    assert.deepEqual(JSON.parse(requests[1].init.body), input)
    assert.equal(requests[2].url, '/api/evolution/approvals?limit=10')
    assert.equal(requests[3].url, '/api/evolution/approvals/approval%2F1')
    assert.equal(requests.every(({ url }) => !/apply|install|rollout/u.test(url)), true)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('evolution client creates, reads, lists, and manually stops scoped canaries', async () => {
  const originalFetch = globalThis.fetch
  const requests = []
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url, init })
    const body = url === '/api/evolution/canaries' && init.method === 'POST'
      ? { ok: true, canary: { id: 'canary-1', state: 'created' } }
      : url.startsWith('/api/evolution/canaries?')
        ? { ok: true, canaries: [] }
        : url.endsWith('/rollback-policy')
          ? { ok: true, policy: { id: 'policy-1', version: 'canary-rollback-v1' } }
          : url.endsWith('/start')
            ? { ok: true, canary: { id: 'canary-1', state: 'active' } }
            : url.endsWith('/stop')
              ? { ok: true, canary: { id: 'canary-1', state: 'stopped' } }
              : { ok: true, canary: { id: 'canary-1', state: 'created' } }
    return new Response(JSON.stringify(body), {
      status: init.method === 'POST' && !url.endsWith('/stop') ? 201 : 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  try {
    const input = {
      approvalId: 'approval-1',
      sessionIds: ['session-1'],
      trafficPercent: 5,
      reason: 'Start a bounded canary',
    }
    const created = await createEvolutionCanaryApi(input)
    await listEvolutionCanariesApi({ limit: 10 })
    await getEvolutionCanaryApi('canary/1')
    const rollbackPolicyInput = {
      policy: {
        windowSize: 20,
        minimumCandidateOutcomes: 3,
        minimumBaselineOutcomes: 3,
        maximumCandidateFailureRate: 0.34,
        maximumCandidateCancellationRate: 0.34,
        maximumLatencyRatio: 1.5,
      },
      reason: 'Declare guardrails before start',
    }
    const policy = await createEvolutionCanaryRollbackPolicyApi('canary/1', rollbackPolicyInput)
    const started = await startEvolutionCanaryApi('canary/1', 'Explicit start')
    const stopped = await stopEvolutionCanaryApi('canary/1', 'Manual stop')
    assert.equal(created.canary.state, 'created')
    assert.equal(policy.policy.version, 'canary-rollback-v1')
    assert.equal(started.canary.state, 'active')
    assert.equal(stopped.canary.state, 'stopped')
    assert.equal(requests[0].url, '/api/evolution/canaries')
    assert.equal(requests[0].init.method, 'POST')
    assert.deepEqual(JSON.parse(requests[0].init.body), input)
    assert.equal(requests[1].url, '/api/evolution/canaries?limit=10')
    assert.equal(requests[2].url, '/api/evolution/canaries/canary%2F1')
    assert.equal(requests[3].url, '/api/evolution/canaries/canary%2F1/rollback-policy')
    assert.deepEqual(JSON.parse(requests[3].init.body), rollbackPolicyInput)
    assert.equal(requests[4].url, '/api/evolution/canaries/canary%2F1/start')
    assert.deepEqual(JSON.parse(requests[4].init.body), { reason: 'Explicit start' })
    assert.equal(requests[5].url, '/api/evolution/canaries/canary%2F1/stop')
    assert.deepEqual(JSON.parse(requests[5].init.body), { reason: 'Manual stop' })
    assert.equal(requests.every(({ url }) => !/apply|install|activate|deploy/u.test(url)), true)
    assert.equal(requests.some(({ url }) => url.endsWith('/rollback')), false)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('evolution client freezes and reads independent online grader evidence', async () => {
  const originalFetch = globalThis.fetch
  const requests = []
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url, init })
    const body = url.endsWith('/online-grader-policy')
      ? { ok: true, policy: { id: 'grader-policy-1', version: 'canary-online-grader-v1' } }
      : init.method === 'POST'
        ? { ok: true, grade: { id: 'grade-1', status: 'completed' } }
        : { ok: true, state: { grades: [], currentEvidence: { decision: 'insufficient_evidence' } } }
    return new Response(JSON.stringify(body), {
      status: init.method === 'POST' ? 201 : 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  try {
    const input = {
      graderProviderId: 'grader-provider',
      graderModelName: 'grader-model',
      graderModelRevision: 'grader-revision-1',
      policy: {
        minimumQualityScore: 2,
        maximumQualityRegression: 0,
        maximumSafetyFailureRate: 0,
      },
      reason: 'Freeze the independent online grader',
    }
    const policy = await createEvolutionCanaryGraderPolicyApi('canary/1', input)
    const state = await getEvolutionCanaryOnlineGradesApi('canary/1', { limit: 25 })
    const grade = await runEvolutionCanaryOnlineGradeApi('canary/1', 'outcome/1')
    assert.equal(policy.policy.version, 'canary-online-grader-v1')
    assert.equal(state.state.currentEvidence.decision, 'insufficient_evidence')
    assert.equal(grade.grade.status, 'completed')
    assert.equal(requests[0].url, '/api/evolution/canaries/canary%2F1/online-grader-policy')
    assert.equal(requests[0].init.method, 'POST')
    assert.deepEqual(JSON.parse(requests[0].init.body), input)
    assert.equal(requests[1].url, '/api/evolution/canaries/canary%2F1/online-grades?limit=25')
    assert.equal(requests[1].init.method, undefined)
    assert.equal(requests[2].url, '/api/evolution/canaries/canary%2F1/online-grades')
    assert.equal(requests[2].init.method, 'POST')
    assert.deepEqual(JSON.parse(requests[2].init.body), { outcomeId: 'outcome/1' })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('evolution client reviews, activates, lists, reads, and revokes immutable production promotions', async () => {
  const originalFetch = globalThis.fetch
  const requests = []
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url, init })
    const body = url.endsWith('/promotion-review')
      ? { ok: true, review: { canaryReleaseId: 'canary-1' } }
      : url === '/api/evolution/promotions' && init.method === 'POST'
        ? { ok: true, promotion: { id: 'promotion-1', state: 'active' } }
        : url.startsWith('/api/evolution/promotions?')
          ? { ok: true, promotions: [] }
          : url.endsWith('/revoke')
            ? { ok: true, promotion: { id: 'promotion-1', state: 'revoked' } }
            : { ok: true, promotion: { id: 'promotion-1', state: 'active' } }
    return new Response(JSON.stringify(body), {
      status: init.method === 'POST' && !url.endsWith('/revoke') ? 201 : 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  try {
    const input = {
      canaryReleaseId: 'canary-1',
      reason: 'Reviewed production promotion',
      confirmations: {
        canaryReleaseFingerprint: 'a'.repeat(64),
        candidateContentSha256: 'b'.repeat(64),
        rollbackBaselineSha256: 'c'.repeat(64),
        rollbackPolicyFingerprint: 'd'.repeat(64),
        onlineGraderPolicyFingerprint: 'e'.repeat(64),
        onlineGuardEvaluationFingerprint: 'f'.repeat(64),
      },
    }
    await getEvolutionPromotionReviewApi('canary/1')
    const created = await createEvolutionPromotionApi(input)
    await listEvolutionPromotionsApi({ limit: 10 })
    await getEvolutionPromotionApi('promotion/1')
    const revoked = await revokeEvolutionPromotionApi('promotion/1', 'Explicit revoke')
    assert.equal(created.promotion.state, 'active')
    assert.equal(revoked.promotion.state, 'revoked')
    assert.equal(requests[0].url, '/api/evolution/canaries/canary%2F1/promotion-review')
    assert.equal(requests[1].url, '/api/evolution/promotions')
    assert.equal(requests[1].init.method, 'POST')
    assert.deepEqual(JSON.parse(requests[1].init.body), input)
    assert.equal(requests[2].url, '/api/evolution/promotions?limit=10')
    assert.equal(requests[3].url, '/api/evolution/promotions/promotion%2F1')
    assert.equal(requests[4].url, '/api/evolution/promotions/promotion%2F1/revoke')
    assert.deepEqual(JSON.parse(requests[4].init.body), { reason: 'Explicit revoke' })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('evolution client does not submit empty feedback', async () => {
  const originalFetch = globalThis.fetch
  let called = false
  globalThis.fetch = async () => {
    called = true
    throw new Error('must not fetch')
  }
  try {
    assert.equal(await recordChatFeedback('   ', 'chat-1'), false)
    assert.equal(called, false)
  } finally {
    globalThis.fetch = originalFetch
  }
})
