import assert from 'node:assert/strict'
import test from 'node:test'

import {
  describeJobModelFailure,
  isJobModelFailure,
  isJobModelFailureError,
  JobModelFailureError,
  wrapJobModelFailure,
} from '../server/services/jobModelFailure.js'

test('job model failures use fixed public messages and retain only safe binding fields', () => {
  const secret = 'sk-never-return-this'
  const error = Object.assign(new Error(`upstream rejected ${secret} at https://private.example.test`), {
    status: 401,
  })
  const failure = describeJobModelFailure(error, {
    modelProviderId: 'provider-local',
    modelName: 'agent-model',
    modelConfigRevision: 7,
  })

  assert.deepEqual(failure, {
    code: 'MODEL_AUTH_FAILED',
    message: 'The model service rejected the credentials. Check the API key or custom headers.',
    action: 'test_provider',
    statusCode: 502,
    providerId: 'provider-local',
    modelName: 'agent-model',
    configRevision: 7,
  })
  assert.doesNotMatch(JSON.stringify(failure), new RegExp(secret))
  assert.doesNotMatch(JSON.stringify(failure), /private\.example\.test/)
})

test('job model failure classification is fail-closed for unknown MODEL_* errors', () => {
  const unknown = Object.assign(new Error('internal planner invariant with sensitive detail'), {
    code: 'MODEL_INTERNAL_INVARIANT',
  })

  assert.equal(isJobModelFailure(unknown), false)
  assert.equal(describeJobModelFailure(unknown), null)
  assert.equal(wrapJobModelFailure(unknown), null)
})

test('job model failure classification maps known transport and context failures', () => {
  assert.equal(describeJobModelFailure(Object.assign(new Error('connect failed'), {
    code: 'ECONNREFUSED',
  })).code, 'MODEL_ENDPOINT_UNREACHABLE')
  assert.equal(describeJobModelFailure(Object.assign(new Error('prompt exceeds the available context size'), {
    status: 400,
  })).code, 'MODEL_CONTEXT_LIMIT')
  assert.equal(describeJobModelFailure(Object.assign(new Error('provider exploded'), {
    status: 503,
  })).code, 'MODEL_UPSTREAM_ERROR')
})

test('job model failure wrappers cannot be forged by assigning an error name', () => {
  const wrapped = new JobModelFailureError(Object.assign(new Error('unauthorized'), { status: 401 }))
  const forged = Object.assign(new Error('internal secret'), {
    name: 'JobModelFailureError',
    code: 'MODEL_AUTH_FAILED',
    action: 'test_provider',
  })

  assert.equal(isJobModelFailureError(wrapped), true)
  assert.equal(isJobModelFailureError(forged), false)
})
