import assert from 'node:assert/strict'
import test from 'node:test'

import { buildToolStepResult } from '../server/services/jobAcceptanceRuntime.js'
import { evaluateTaskAcceptance } from '../server/services/jobTaskAcceptance.js'
import { createTaskReviewer } from '../server/services/taskReviewer.js'

const workerPass = '<task_evaluation>{"verdict":"pass","summary":"worker says done","issues":[],"evidence":["worker claim"]}</task_evaluation>'
const failedTaskVerification = {
  version: 1,
  checks: [{
    status: 'failed',
    kind: 'test',
    cwd: '.',
    commandScope: 'package-script:test',
    code: 'TASK_TEST_FAILED',
    diagnostic: '1 test failed',
  }],
}

test('host task-verification failure overrides a structured worker pass', () => {
  const acceptance = evaluateTaskAcceptance({
    text: workerPass,
    evidence: ['worker says tests pass'],
    taskVerification: failedTaskVerification,
  })

  assert.equal(acceptance.verdict, 'fixable')
  assert.equal(acceptance.source, 'task_verification')
  assert.match(acceptance.issues[0], /test@\./)
})

test('tool-step acceptance passes taskVerification to evaluators and enforces it afterward', async () => {
  let evaluatorInput = null
  const result = await buildToolStepResult({
    job: { id: 'job-verify', modelName: 'worker-model' },
    step: { id: 'step-verify', kind: 'verify' },
    result: {
      text: workerPass,
      evidence: ['worker says tests pass'],
      artifactIds: [],
      iterations: 1,
      taskVerification: failedTaskVerification,
    },
    taskEvaluator: async (input) => {
      evaluatorInput = input
      return {
        verdict: 'pass',
        summary: 'custom evaluator says pass',
        issues: [],
        evidence: [],
        source: 'custom',
      }
    },
    taskReviewGuard: async ({ acceptance }) => acceptance,
  })

  assert.deepEqual(evaluatorInput.taskVerification, failedTaskVerification)
  assert.equal(result.ok, false)
  assert.equal(result.acceptance.verdict, 'fixable')
  assert.equal(result.acceptance.source, 'task_verification')
})

test('independent reviewer fails fast on unresolved host verification', async () => {
  let reviewerCalls = 0
  const reviewer = createTaskReviewer({
    reviewerModelName: 'reviewer-model',
    runReviewerModel: async () => {
      reviewerCalls += 1
      return workerPass
    },
  })
  const acceptance = await reviewer({
    job: { id: 'job-review', userId: 'user-review', modelName: 'worker-model' },
    step: { id: 'verify-review', kind: 'verify' },
    text: workerPass,
    evidence: ['worker says tests pass'],
    workerModelName: 'worker-model',
    taskVerification: {
      version: 1,
      checks: [{
        status: 'indeterminate',
        kind: 'test',
        cwd: '.',
        code: 'COMMAND_TIMEOUT',
      }],
    },
  })

  assert.equal(reviewerCalls, 0)
  assert.equal(acceptance.verdict, 'blocked')
  assert.equal(acceptance.source, 'task_verification')
})
