import assert from 'node:assert/strict'
import test from 'node:test'

import { applyRuntimeTaskReviewGuard } from '../server/services/taskReviewGuard.js'

function passAcceptance() {
  return {
    verdict: 'pass',
    summary: 'Independent checks passed',
    issues: [],
    evidence: ['npm test: pass'],
    source: 'independent_reviewer',
    reviewer: {
      independent: true,
      mode: 'distinct_model_review',
      reviewerModel: 'reviewer-model',
      workerModel: 'worker-model',
    },
  }
}

function input(overrides = {}) {
  return {
    acceptance: passAcceptance(),
    job: {
      prompt: 'Produce and verify the report',
      modelName: 'worker-model',
      secret: 'must not cross the guard boundary',
    },
    step: {
      input: { acceptance: ['tests pass', 'report exists'] },
      output: { transcript: 'must not cross the guard boundary' },
    },
    text: 'All checks completed.',
    evidence: ['npm test: pass'],
    artifactIds: ['report-artifact'],
    ...overrides,
  }
}

test('task review guard is absent by default and never runs for a non-pass verdict', async () => {
  const acceptance = passAcceptance()
  const absent = await applyRuntimeTaskReviewGuard(input({ acceptance }), {
    invokePluginService: async () => ({ found: false, pluginId: null, value: undefined }),
  })
  assert.equal(absent, acceptance)

  let calls = 0
  const blocked = { ...acceptance, verdict: 'blocked' }
  const preserved = await applyRuntimeTaskReviewGuard(input({ acceptance: blocked }), {
    invokePluginService: async () => { calls += 1 },
  })
  assert.equal(preserved, blocked)
  assert.equal(calls, 0)
})

test('task review guard receives frozen bounded evidence and can only veto a pass', async () => {
  let observedScope = null
  const acceptance = passAcceptance()
  const result = await applyRuntimeTaskReviewGuard(input({
    acceptance,
    text: 'v'.repeat(30_000),
    evidence: ['e'.repeat(20_000)],
  }), {
    invokePluginService: async (name, method, args) => {
      assert.equal(name, 'task-review-guard')
      assert.equal(method, 'review')
      observedScope = args[0]
      return {
        found: true,
        pluginId: 'release-policy-plugin',
        value: {
          verdict: 'fixable',
          summary: 'Release evidence is incomplete',
          issues: ['missing signed package'],
          evidence: ['fabricated evidence must be ignored'],
          reviewer: { independent: false },
        },
      }
    },
  })

  assert.equal(Object.isFrozen(observedScope), true)
  assert.equal(Object.isFrozen(observedScope.baseAcceptance), true)
  assert.equal(Object.isFrozen(observedScope.evidence), true)
  assert.deepEqual(Object.keys(observedScope), [
    'objective',
    'acceptanceCriteria',
    'workerModel',
    'workerVerification',
    'evidence',
    'artifactIds',
    'baseAcceptance',
  ])
  assert.equal('secret' in observedScope, false)
  assert.equal('job' in observedScope, false)
  assert.equal(observedScope.workerVerification.length, 24_000)
  assert.equal(observedScope.evidence[0].length, 12_000)
  assert.equal(result.verdict, 'fixable')
  assert.equal(result.source, 'runtime_review_guard')
  assert.deepEqual(result.evidence, acceptance.evidence)
  assert.equal(result.reviewer, acceptance.reviewer)
  assert.deepEqual(result.guard, {
    pluginId: 'release-policy-plugin',
    service: 'task-review-guard',
    mode: 'veto_only',
    decision: 'veto',
  })
})

test('task review guard pass preserves the core verdict and records provenance', async () => {
  const acceptance = passAcceptance()
  const result = await applyRuntimeTaskReviewGuard(input({ acceptance }), {
    invokePluginService: async () => ({
      found: true,
      pluginId: 'quality-policy-plugin',
      value: { verdict: 'pass', summary: 'plugin summary is not authoritative' },
    }),
  })

  assert.deepEqual(result, {
    ...acceptance,
    guard: {
      pluginId: 'quality-policy-plugin',
      service: 'task-review-guard',
      mode: 'veto_only',
      decision: 'pass',
    },
  })
})

test('active task review guard errors and invalid results fail closed', async () => {
  const acceptance = passAcceptance()
  const cases = [
    {
      invokePluginService: async () => ({ found: true, pluginId: 'invalid-guard', value: { verdict: 'allow' } }),
      code: 'TASK_REVIEW_GUARD_RESULT_INVALID',
      pluginId: 'invalid-guard',
    },
    {
      invokePluginService: async () => {
        throw Object.assign(new Error('private plugin details'), {
          code: 'PLUGIN_SERVICE_CALL_FAILED',
          pluginId: 'failed-guard',
        })
      },
      code: 'PLUGIN_SERVICE_CALL_FAILED',
      pluginId: 'failed-guard',
    },
  ]
  for (const item of cases) {
    const result = await applyRuntimeTaskReviewGuard(input({ acceptance }), item)
    assert.equal(result.verdict, 'blocked')
    assert.equal(result.source, 'runtime_review_guard')
    assert.deepEqual(result.evidence, acceptance.evidence)
    assert.deepEqual(result.issues, [item.code])
    assert.equal(result.guard.pluginId, item.pluginId)
    assert.equal(result.guard.decision, 'error')
    assert.equal(result.guard.error, item.code)
    assert.doesNotMatch(JSON.stringify(result), /private plugin details/)
  }
})
