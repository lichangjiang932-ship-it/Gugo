import assert from 'node:assert/strict'
import test from 'node:test'
import { translateKey } from '../src/i18n/translations.js'
import { normalizeModelRequestDiagnostics, modelRequestFailureCopy } from '../src/lib/modelRequestDiagnostics.js'
import { normalizeTurnFailurePayload } from '../src/lib/turnClient/turnFailurePayload.js'
import { buildIncompleteTaskPresentation } from '../src/pages/ChatSplit/chatMessages/messageRow/incompleteTaskPresentation.js'

const t = (lang) => (key, values = {}) => translateKey(key, lang).replace(/\{(\w+)\}/g, (match, name) => values[name] ?? match)
const diagnostic = { code: 'MODEL_REQUEST_OUTCOME_UNKNOWN', timeoutPhase: 'idle', timeoutMs: 180_000,
  transportPhase: 'response', upstreamCode: 'MODEL_TIMEOUT', partialContentChars: 24, contentRetained: true }

test('model request diagnostics retain only bounded public evidence and do not grant retry authority', () => {
  const value = normalizeModelRequestDiagnostics({ ...diagnostic, partialGeneration: { content: 'private checkpoint text' },
    modelRequestId: 'private-id', headers: { Authorization: 'private key' }, responseBody: 'secret body',
    safeToRetryGeneration: true, retryable: true, cause: { message: 'private stack' } })
  assert.deepEqual(value, diagnostic)
  assert.doesNotMatch(JSON.stringify(value), /private|secret|retryable|safeToRetry/)
  assert.equal(normalizeModelRequestDiagnostics({ code: 'SOMETHING_ELSE' }), null)
  const invalid = normalizeModelRequestDiagnostics({ ...diagnostic, timeoutMs: Infinity, partialContentChars: -1 })
  assert.equal(invalid.timeoutMs, undefined)
  assert.equal(invalid.contentRetained, false)
})

test('live and nested terminal payloads carry the same sanitized diagnostic without changing unknown status', () => {
  for (const payload of [{ code: diagnostic.code, retryable: false, modelRequestDiagnostics: diagnostic },
    { error: { code: diagnostic.code, retryable: false, modelRequestDiagnostics: diagnostic } }]) {
    const result = normalizeTurnFailurePayload(payload)
    assert.deepEqual(result.error.modelRequestDiagnostics, diagnostic)
    assert.equal(result.error.code, 'MODEL_REQUEST_OUTCOME_UNKNOWN')
    assert.equal(result.error.retryable, false)
  }
})

test('timeout presentation explains the actual deadline in Chinese and English, not a fictitious write failure', () => {
  const failure = { code: diagnostic.code, incompleteReason: 'model_request_outcome_unknown',
    modelRequestDiagnostics: diagnostic, missingRequirements: ['operation_outcome_verification'],
    retryable: false, manualRetryable: true }
  for (const lang of ['zh', 'en']) {
    const copy = modelRequestFailureCopy(failure, t(lang))
    assert.match(copy.reason, /180/)
    assert.match(copy.detail, lang === 'zh' ? /已收到的正文/ : /Received text/)
    const presentation = buildIncompleteTaskPresentation({ meta: { serverFailure: failure } }, t(lang))
    assert.equal(presentation.reason, copy.reason)
    assert.match(presentation.missing[0], lang === 'zh' ? /模型请求/ : /model request/)
    assert.doesNotMatch(presentation.missing[0], /确认上一次模型请求或写入操作/)
    assert.equal(presentation.retryable, false)
  }
})

test('connection, protocol, HTTP and legacy failures keep distinct truthful descriptions', () => {
  for (const [values, expected] of [
    [{ upstreamCode: 'ECONNRESET' }, /connection closed/],
    [{ upstreamCode: 'MODEL_STREAM_MALFORMED_FRAME' }, /stream was incomplete/],
    [{ upstreamStatus: 503 }, /HTTP 503/],
  ]) {
    const copy = modelRequestFailureCopy({ modelRequestDiagnostics: { code: diagnostic.code, ...values } }, t('en'))
    assert.match(copy.reason, expected)
  }
  const legacy = modelRequestFailureCopy({ code: diagnostic.code }, t('zh'))
  assert.doesNotMatch(legacy.reason, /60|180|超时|断开/)
  assert.equal(legacy.title, translateKey('chatMessages.modelRequestUnknownTitle', 'zh'))
})
