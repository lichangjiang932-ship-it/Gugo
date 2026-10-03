import assert from 'node:assert/strict'
import test from 'node:test'
import { parseModelProviderResponse } from '../server/adapters/modelProviderResponse.js'
import { modelProviderResponseEvents } from '../server/adapters/modelNonStreaming.js'
import { isContextLengthError, redactModelError } from '../server/adapters/modelProxyErrors.js'
import { buildModelProviderRequest } from '../server/adapters/modelRequestBuilder.js'
import { modelRequestOutcomeUnknown } from '../server/adapters/modelRequestOutcome.js'
import { isRetryableError } from '../server/utils/modelRetry.js'
import { isProviderFailoverError } from '../server/adapters/modelFailover.js'
import { normalizeTurnFailure } from '../server/services/turnTerminalProjection.js'
import { projectTurnEventForClient } from '../shared/turnEventProjection.js'
import { getVisibleModelErrorMessage } from '../src/lib/chatFlowGuards.js'
import { buildIncompleteTaskPresentation } from '../src/pages/ChatSplit/chatMessages/messageRow/incompleteTaskPresentation.js'
import { createTurnEvent } from '../shared/turnEvents.js'
import { runModelStep } from '../server/services/loop/step.js'

const STOP_CODE = 'MODEL_PROVIDER_STOP_REASON_ERROR'
const EXPLANATION = '无法继续这项请求。可以改为提供公开、非敏感资料。'
const unsafeTool = { id: 'blocked-call', type: 'function', function: {
  name: 'write_file', arguments: '{"path":"never.txt","content":"PRIVATE_TOOL_BODY"}',
} }

function refusal(finishReason = 'content_filter', content = EXPLANATION) {
  return { choices: [{ message: { content, tool_calls: [unsafeTool] }, finish_reason: finishReason }] }
}

function parseFailure(data) {
  let failure
  assert.throws(() => parseModelProviderResponse(data), (error) => {
    failure = error
    return error.code === STOP_CODE
  })
  return failure
}

test('compatible stop failures retain public explanations without accepting tool results', () => {
  for (const reason of ['content_filter', 'refusal', 'error', 'cancelled', 'unknown_finish_reason']) {
    const failure = parseFailure(refusal(reason))
    assert.equal(failure.reason, EXPLANATION)
    assert.equal(failure.stopReason, reason)
    assert.equal(failure.retryable, false)
    assert.equal(failure.modelRequestOutcome, 'failed')
    assert.equal(isRetryableError(failure), false)
    assert.equal(isProviderFailoverError(failure), false)
    assert.equal(modelRequestOutcomeUnknown(failure, { modelRequestId: 'known-stop' }), failure)
    assert.equal(failure.partialModelResult, undefined)
    assert.equal(failure.toolCalls, undefined)
    assert.doesNotMatch(JSON.stringify(failure), /PRIVATE_TOOL_BODY/)
    assert.throws(() => [...modelProviderResponseEvents(refusal(reason), {})], { code: STOP_CODE })
  }
})

test('diagnostics accept public refusal/text parts but omit thought and tool payloads', () => {
  const failure = parseFailure(refusal('refusal', [
    { type: 'reasoning', text: 'PRIVATE_REASONING_FIELD' },
    { type: 'tool_call', text: 'PRIVATE_TOOL_FIELD' },
    { type: 'text', text: '<think>PRIVATE_THOUGHT</think>' + EXPLANATION },
    { type: 'text', text: '<tool_call>{"name":"write_file","arguments":"PRIVATE_TOOL_PROTOCOL"}</tool_call>' },
  ]))
  assert.equal(failure.reason, EXPLANATION)
  assert.doesNotMatch(failure.message, /PRIVATE_/)
  const direct = refusal('refusal', null)
  direct.choices[0].message.refusal = EXPLANATION
  assert.equal(parseFailure(direct).reason, EXPLANATION)
  assert.equal(parseFailure(refusal('refusal', '<think>PRIVATE_UNCLOSED_THOUGHT')).reason, undefined)
  assert.equal(parseFailure(refusal('refusal', 'PRIVATE_ORPHAN_THOUGHT</think>')).reason, undefined)
})

test('diagnostics are bounded and redact pattern and configured secrets before public display', () => {
  const failure = parseFailure(refusal('content_filter',
    `Cannot continue. token=sk-synthetic-credential-value authorization: Bearer synthetic-bearer-value ${'x'.repeat(4000)}`))
  assert.ok(failure.reason.length <= 2000)
  assert.doesNotMatch(failure.reason, /sk-synthetic-credential-value|synthetic-bearer-value/)
  const configured = parseFailure(refusal('refusal', 'Cannot continue for opaque-credential-value or opaque-header-value.'))
  redactModelError(configured, { apiKey: 'opaque-credential-value', headers: { 'x-key': 'opaque-header-value' } })
  assert.doesNotMatch(configured.reason, /opaque-credential-value|opaque-header-value/)
})

test('only the explicit provider-stop code transports a sanitized diagnostic to the existing UI', () => {
  const failure = normalizeTurnFailure(parseFailure(refusal()))
  const event = projectTurnEventForClient({ type: 'turn.failed', payload: { code: STOP_CODE, error: failure } })
  assert.equal(event.payload.error.reason, EXPLANATION)
  const t = (key) => key
  const message = { meta: { failed: true, serverFailure: { ...event.payload.error, incompleteReason: 'model_call_interrupted' } } }
  assert.equal(getVisibleModelErrorMessage(message, t), EXPLANATION)
  assert.equal(buildIncompleteTaskPresentation(message, t).reason, EXPLANATION)
  for (const code of ['UNKNOWN_INTERNAL_FAILURE', 'MODEL_REQUEST_OUTCOME_UNKNOWN']) {
    const projected = projectTurnEventForClient({ type: 'turn.failed', payload: {
      error: { code, reason: 'PRIVATE_INTERNAL_ERROR', message: 'PRIVATE_INTERNAL_ERROR', retryable: false },
    } })
    assert.doesNotMatch(JSON.stringify(projected), /PRIVATE_INTERNAL_ERROR/)
  }
})

test('request-bound secrets are removed before a diagnostic is truncated', () => {
  const apiKey = 'opaque-api-key-at-clipping-boundary'
  const providerRequest = buildModelProviderRequest({
    config: { baseUrl: 'https://diagnostic.example.invalid/v1', modelName: 'fixture', apiKey },
    profile: { kind: 'openai-compatible' }, messages: [{ role: 'user', content: 'fixture' }],
  })
  let failure
  assert.throws(() => parseModelProviderResponse(refusal('refusal', 'z'.repeat(1995) + apiKey), {}, { providerRequest }), (error) => {
    failure = error
    return error.code === STOP_CODE
  })
  assert.equal(failure.reason.length, 2000)
  assert.equal(failure.reason.endsWith('opaqu'), false, 'a clipped credential fragment must not survive later redaction')
})

test('new terminal schemas permit only normalized provider diagnostic reasons', () => {
  const create = (code, reason) => createTurnEvent({
    id: 'diagnostic-event', sessionId: 'diagnostic-session', turnId: 'diagnostic-turn', sequence: 0,
    type: 'turn.failed', payload: { code, error: { code, reason, retryable: false } },
  })
  assert.equal(create(STOP_CODE, EXPLANATION).payload.error.reason, EXPLANATION)
  for (const reason of ['token=synthetic-secret', '<think>private</think>public', 'x'.repeat(2001)]) {
    assert.throws(() => create(STOP_CODE, reason))
  }
  assert.throws(() => create('UNKNOWN_INTERNAL_ERROR', EXPLANATION))
})

test('provider explanation text and request-error plugins cannot initiate a retry', async () => {
  const failure = parseFailure(refusal('refusal', 'The provider context window is too small; reduce the length.'))
  assert.equal(isContextLengthError(failure), false, 'display prose must not become a context-recovery trigger')
  let calls = 0
  let retryDecisions = 0
  await assert.rejects(runModelStep({
    request: {},
    runModel: async () => { calls += 1; throw failure },
    loopEvents: { waterfall: async (event, value) => {
      if (event !== 'request-error') return value
      retryDecisions += 1
      return { kind: 'retry' }
    } },
  }), (error) => error === failure)
  assert.equal(calls, 1)
  assert.equal(retryDecisions, 0)
})

test('ordinary compatible status metadata does not become a model finish reason', () => {
  for (const status of [200, '200', 'success', 'ok', 'completed']) {
    for (const wrapper of [{ status }, { response: { status } }]) {
      const parsed = parseModelProviderResponse({ ...wrapper, choices: [{ message: { content: 'Public reply.' } }] })
      assert.equal(parsed.content, 'Public reply.')
      assert.equal(parsed.finishReason, null, 'metadata must preserve the legacy missing-finish contract')
    }
  }
})

test('formal Responses statuses and explicit failure or truncation statuses retain their semantics', () => {
  for (const wrapper of [{ status: 200 }, { status: 'success' }]) {
    for (const status of ['failed', 'cancelled', 'incomplete']) {
      const data = { ...wrapper, response: { object: 'response', status }, choices: [{ message: { content: EXPLANATION } }] }
      if (status === 'incomplete') assert.equal(parseModelProviderResponse(data).finishReason, 'length')
      else assert.equal(parseFailure(data).stopReason, status)
    }
  }
  for (const status of ['failed', 'cancelled']) {
    assert.equal(parseFailure({ status, choices: [{ message: { content: EXPLANATION } }] }).stopReason, status)
  }
  assert.equal(parseModelProviderResponse({ status: 'incomplete', content: 'Partial reply.' }).finishReason, 'length')
  assert.equal(parseModelProviderResponse({ object: 'response', status: 'completed', output_text: 'Public reply.' }).finishReason, 'stop')
  assert.equal(parseFailure({ object: 'response', status: 'future_response_status', output_text: EXPLANATION }).stopReason, 'future_response_status')
})

test('explicit compatible finish reasons remain authoritative and unknown values still fail', () => {
  for (const status of [200, 'success', 'failed', 'incomplete']) {
    const stopped = parseModelProviderResponse({ status, choices: [{ message: { content: 'Public reply.' }, finish_reason: 'stop' }] })
    assert.equal(stopped.finishReason, 'stop')
    for (const finishReason of ['success', 'future_finish_reason']) {
      assert.equal(parseFailure({ status, ...refusal(finishReason) }).stopReason, finishReason)
    }
  }
})
