import assert from 'node:assert/strict'
import test from 'node:test'

import { registerPlugin, unregisterPlugin } from '../server/plugins/pluginRegistry.js'
import { createDefaultExecuteStep } from '../server/services/jobRuntime.js'
import { createTaskReviewer } from '../server/services/taskReviewer.js'

const workerPass = '<task_evaluation>{"verdict":"pass","summary":"worker says done","issues":[],"evidence":["worker claim"]}</task_evaluation>'

function reviewInput(overrides = {}) {
  return {
    job: { id: 'job-review', userId: 'user-review', prompt: 'Produce a verified report', modelName: 'worker-model', steps: [] },
    step: { id: 'verify-review', kind: 'verify', input: { acceptance: ['tests pass', 'report exists'] } },
    text: workerPass,
    evidence: ['npm test: pass'],
    artifactIds: ['report-artifact'],
    workerModelName: 'worker-model',
    ...overrides,
  }
}

test('unconfigured reviewer preserves compatibility but labels worker self-evaluation honestly', async () => {
  const reviewer = createTaskReviewer({ reviewerModelName: '' })
  const acceptance = await reviewer(reviewInput())

  assert.equal(acceptance.verdict, 'pass')
  assert.equal(acceptance.reviewer.independent, false)
  assert.equal(acceptance.reviewer.mode, 'reviewer_not_configured')
  assert.equal(acceptance.reviewer.workerModel, 'worker-model')
  assert.equal(acceptance.reviewer.reviewerModel, null)
})

test('required independent review fails closed when reviewer is missing or matches the worker', async () => {
  for (const reviewerModelName of ['', 'worker-model']) {
    const reviewer = createTaskReviewer({ reviewerModelName, requireIndependent: true })
    const acceptance = await reviewer(reviewInput())
    assert.equal(acceptance.verdict, 'blocked')
    assert.equal(acceptance.reviewer.independent, false)
    assert.match(acceptance.summary, /独立 Reviewer/)
  }
  const unknownWorker = createTaskReviewer({ reviewerModelName: 'reviewer-model', requireIndependent: true })
  const unknownAcceptance = await unknownWorker(reviewInput({
    workerModelName: '',
    job: { ...reviewInput().job, modelName: null },
  }))
  assert.equal(unknownAcceptance.verdict, 'blocked')
  assert.equal(unknownAcceptance.reviewer.mode, 'worker_model_unknown')
})

test('distinct reviewer model receives bounded evidence and returns an isolated structured verdict', async () => {
  let request = null
  const reviewer = createTaskReviewer({
    reviewerModelName: 'reviewer-model',
    runReviewerModel: async (input) => {
      request = input
      return '<task_evaluation>{"verdict":"fixable","summary":"artifact was not inspected","issues":["missing artifact readback"],"evidence":["tests pass"]}</task_evaluation>'
    },
  })
  const acceptance = await reviewer(reviewInput())

  assert.equal(request.modelName, 'reviewer-model')
  assert.equal(request.userId, 'user-review')
  assert.ok(request.messages.some((message) => /must not trust the worker self-evaluation/.test(message.content)))
  assert.ok(request.messages.some((message) => /report-artifact/.test(message.content)))
  assert.equal(acceptance.verdict, 'fixable')
  assert.equal(acceptance.source, 'independent_reviewer')
  assert.deepEqual(acceptance.reviewer, {
    independent: true,
    mode: 'distinct_model_review',
    reviewerModel: 'reviewer-model',
    workerModel: 'worker-model',
  })
})

test('configured reviewer fails closed on malformed output or model failure', async () => {
  const malformed = createTaskReviewer({
    reviewerModelName: 'reviewer-model',
    runReviewerModel: async () => 'looks good',
  })
  const malformedAcceptance = await malformed(reviewInput())
  assert.equal(malformedAcceptance.verdict, 'blocked')
  assert.deepEqual(malformedAcceptance.issues, ['missing_or_invalid_task_evaluation'])

  const failed = createTaskReviewer({
    reviewerModelName: 'reviewer-model',
    runReviewerModel: async () => { throw new Error('review endpoint unavailable') },
  })
  const failedAcceptance = await failed(reviewInput())
  assert.equal(failedAcceptance.verdict, 'blocked')
  assert.equal(failedAcceptance.reviewer.mode, 'reviewer_error')
  assert.match(failedAcceptance.reviewer.error, /endpoint unavailable/)
})

test('trusted runtime task review guard can veto but not replace an independent reviewer pass', async () => {
  await registerPlugin({
    id: 'task-review-guard-test',
    name: 'Task review guard test',
    version: '1.0.0',
    contributes: ['service:task-review-guard'],
  }, (ctx) => {
    ctx.services.provide('task-review-guard', {
      review(scope) {
        assert.equal(scope.baseAcceptance.reviewer.independent, true)
        assert.equal('job' in scope, false)
        return {
          verdict: 'blocked',
          summary: 'Signed release evidence is missing',
          issues: ['missing release signature'],
        }
      },
    })
  })

  try {
    const taskEvaluator = createTaskReviewer({
      reviewerModelName: 'reviewer-model',
      requireIndependent: true,
      runReviewerModel: async () => '<task_evaluation>{"verdict":"pass","summary":"independent checks pass","issues":[],"evidence":["npm test pass"]}</task_evaluation>',
    })
    const execute = createDefaultExecuteStep({
      enableServerTools: false,
      runModel: async () => workerPass,
      taskEvaluator,
    })
    const review = reviewInput()
    const result = await execute({ job: review.job, step: review.step })

    assert.equal(result.ok, false)
    assert.equal(result.acceptance.verdict, 'blocked')
    assert.equal(result.acceptance.source, 'runtime_review_guard')
    assert.equal(result.acceptance.reviewer.independent, true)
    assert.deepEqual(result.acceptance.guard, {
      pluginId: 'task-review-guard-test',
      service: 'task-review-guard',
      mode: 'veto_only',
      decision: 'veto',
    })
  } finally {
    assert.equal(await unregisterPlugin('task-review-guard-test'), true)
  }
})

test('independent reviewer can veto a worker pass in the default job executor', async () => {
  const taskEvaluator = createTaskReviewer({
    reviewerModelName: 'reviewer-model',
    requireIndependent: true,
    runReviewerModel: async () => '<task_evaluation>{"verdict":"blocked","summary":"no reproducible evidence","issues":["missing command output"],"evidence":[]}</task_evaluation>',
  })
  const execute = createDefaultExecuteStep({
    enableServerTools: false,
    runModel: async () => workerPass,
    taskEvaluator,
  })
  const input = reviewInput()
  const result = await execute({ job: input.job, step: input.step })

  assert.equal(result.ok, false)
  assert.equal(result.acceptance.verdict, 'blocked')
  assert.equal(result.acceptance.reviewer.independent, true)
  assert.equal(result.acceptance.reviewer.reviewerModel, 'reviewer-model')
  assert.equal(result.error, 'no reproducible evidence')
})
