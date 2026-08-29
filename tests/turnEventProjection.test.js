import assert from 'node:assert/strict'
import test from 'node:test'

import {
  normalizePublicFailureCode,
  projectTurnEventForClient,
} from '../shared/turnEventProjection.js'
import { normalizeTurnFailure } from '../server/services/turnTerminalProjection.js'

test('public failure codes are uppercase, bounded, and restricted to stable identifiers', () => {
  assert.equal(normalizePublicFailureCode(' model_http_503 '), 'MODEL_HTTP_503')
  assert.equal(normalizePublicFailureCode('数据库密码=sekret'), 'TURN_FAILED')
  assert.equal(normalizePublicFailureCode('C:\\secret\\provider.exe'), 'TURN_FAILED')
  assert.equal(normalizePublicFailureCode(`A${'B'.repeat(128)}`), 'TURN_FAILED')
  assert.equal(normalizePublicFailureCode('invalid-code', 'turn_interrupted'), 'TURN_INTERRUPTED')
  assert.equal(normalizePublicFailureCode('invalid-code', 'also-invalid'), 'TURN_FAILED')
})

test('server failure normalization cannot leak arbitrary text through the code field', () => {
  assert.deepEqual(normalizeTurnFailure({
    code: '数据库密码=sekret',
    status: 401,
  }), {
    code: 'TURN_FAILED',
    retryable: false,
    status: 401,
  })
  assert.equal(normalizeTurnFailure({ code: ' model_timeout ' }).code, 'MODEL_TIMEOUT')
})

test('terminal failure projection strips server copy and preserves safe evidence fields', () => {
  const cases = [
    ['turn.failed', 'TURN_FAILED', { partialText: 'model-authored partial answer' }],
    ['turn.interrupted', 'TURN_INTERRUPTED', { text: 'model-authored streamed answer' }],
    ['turn.blocked', 'TURN_RECOVERY_BLOCKED', {
      partialText: 'model-authored recovery note',
      recoveryStatus: 'dead_letter',
      manualRetryable: true,
    }],
  ]

  for (const [type, fallbackCode, safeFields] of cases) {
    const event = {
      id: `${type}-id`,
      type,
      payload: {
        code: 'D:\\private\\provider.exe',
        message: '中文服务端失败文案',
        hint: 'internal retry hint',
        reason: 'database password=secret',
        retryable: type !== 'turn.blocked',
        artifactIds: ['artifact-1'],
        ...safeFields,
        error: {
          code: '数据库密码=secret',
          message: 'TypeError: private stack',
          hint: 'inspect C:\\private\\logs',
          reason: 'provider secret',
          retryable: type !== 'turn.blocked',
          manualRetryable: type === 'turn.blocked',
          status: 503,
          missingRequirements: ['model_service_available'],
        },
      },
    }
    const before = structuredClone(event)

    const projected = projectTurnEventForClient(event)

    assert.equal(projected.payload.code, fallbackCode, type)
    assert.equal(projected.payload.error.code, fallbackCode, type)
    for (const key of ['message', 'hint', 'reason']) {
      assert.equal(Object.hasOwn(projected.payload, key), false, `${type} payload.${key}`)
      assert.equal(Object.hasOwn(projected.payload.error, key), false, `${type} error.${key}`)
    }
    assert.deepEqual(projected.payload.artifactIds, ['artifact-1'], type)
    assert.equal(projected.payload.error.status, 503, type)
    assert.equal(projected.payload.error.manualRetryable, type === 'turn.blocked', type)
    assert.deepEqual(projected.payload.error.missingRequirements, ['model_service_available'], type)
    for (const [key, value] of Object.entries(safeFields)) {
      assert.deepEqual(projected.payload[key], value, `${type} payload.${key}`)
    }
    assert.deepEqual(event, before, `${type} input mutation`)
    assert.deepEqual(projectTurnEventForClient(projected), projected, `${type} idempotence`)
  }
})

test('terminal projection uses a valid nested code when a legacy failure has no top-level code', () => {
  const projected = projectTurnEventForClient({
    type: 'turn.failed',
    payload: {
      error: { code: 'model_http_429', retryable: true },
      partialText: 'work retained',
    },
  })

  assert.equal(projected.payload.code, 'MODEL_HTTP_429')
  assert.equal(projected.payload.error.code, 'MODEL_HTTP_429')
  assert.equal(projected.payload.partialText, 'work retained')
})

test('cancelled turns expose only a stable public code while retaining delivery evidence', () => {
  const projected = projectTurnEventForClient({
    type: 'turn.cancelled',
    payload: {
      reason: 'Cancelled by user',
      artifactIds: ['artifact-1'],
      deliveryArtifactIds: ['artifact-1'],
      iterations: 2,
    },
  })

  assert.deepEqual(projected.payload, {
    code: 'TURN_CANCELLED',
    artifactIds: ['artifact-1'],
    deliveryArtifactIds: ['artifact-1'],
    iterations: 2,
  })
})
