import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { createLoopExecutionScope, assertLoopExecutionScope } from '../server/services/loop/executionScope.js'
import { localRequestRejection } from '../server/utils/localRequestPolicy.js'

test('execution scope is immutable, explicit and does not include credential environments', () => {
  const job = { id: 'turn', userId: 'owner', sessionId: 'session',
    modelName: 'local-model', modelProviderId: 'local-provider', MODEL_API_KEY: 'fixture-secret' }
  const scope = createLoopExecutionScope({ job, step: { id: 'step' }, projectDirectory: path.resolve('workspace') })
  assert.equal(scope.userId, 'owner')
  assert.equal(scope.modelProviderId, 'local-provider')
  assert.equal(Object.isFrozen(scope), true)
  assert.equal(JSON.stringify(scope).includes('fixture-secret'), false)
  assertLoopExecutionScope(scope, { job, step: { id: 'step' } })
  assert.throws(() => { scope.userId = 'another-owner' }, TypeError)
})

test('identity/model drift fails before the next model or tool phase', () => {
  const job = { id: 'turn', userId: 'owner', modelName: 'model', modelProviderId: 'provider' }
  const scope = createLoopExecutionScope({ job })
  for (const [key, value] of [['userId', 'foreign'], ['id', 'foreign-turn'],
    ['modelName', 'another-model'], ['modelProviderId', 'another-provider']]) {
    assert.throws(() => assertLoopExecutionScope(scope, { job: { ...job, [key]: value } }), {
      code: 'LOOP_EXECUTION_SCOPE_DRIFT',
    })
  }
  assert.throws(() => createLoopExecutionScope({ projectDirectory: 'relative' }), {
    code: 'LOOP_EXECUTION_SCOPE_INVALID',
  })
})

test('local HTTP source policy covers malformed authorities, IPv6 and native clients', () => {
  for (const host of ['attacker.example', '127.0.0.1@attacker.example',
    '127.0.0.1/path', 'localhost,attacker.example', undefined]) {
    assert.equal(localRequestRejection({ headers: { host }, method: 'POST' }).code, 'LOCAL_REQUEST_HOST_DENIED')
  }
  for (const host of ['127.0.0.1:3000', 'localhost:3000', '[::1]:3000']) {
    assert.equal(localRequestRejection({ headers: { host }, method: 'POST' }), null)
    assert.equal(localRequestRejection({ headers: { host, origin: 'null' }, method: 'GET' }), null)
    assert.equal(localRequestRejection({ headers: { host, origin: 'null' }, method: 'POST' }).code,
      'LOCAL_REQUEST_ORIGIN_DENIED')
  }
  assert.equal(localRequestRejection({ headers: { host: 'app.example' } }, { AUTH_MODE: 'multi_user' }), null)
})
