import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeTurnFailure } from '../server/services/turnTerminalProjection.js'
import { projectTurnEventForClient } from '../shared/turnEventProjection.js'
import { createTurnEvent } from '../shared/turnEvents.js'
import { formatRunEvent } from '../bin/cli/runOutput.js'

test('known unloaded-model HTTP failures become fixed diagnostics without retaining upstream private text', () => {
  const source = Object.assign(new Error('No models loaded. token=private-token-value opaque-provider-secret '
    + '<think>PRIVATE_REASONING</think> https://user:password@private.invalid/path?key=private-query'), { status: 400 })
  const failure = normalizeTurnFailure(source)
  assert.equal(failure.code, 'MODEL_NOT_LOADED')
  assert.equal(failure.status, 400)
  assert.equal(failure.retryable, false)
  const event = createTurnEvent({ id: 'not-loaded-event', sessionId: 'not-loaded-session', turnId: 'not-loaded-turn',
    sequence: 0, type: 'turn.failed', payload: { code: failure.code, error: failure } })
  const projected = projectTurnEventForClient(event)
  const rendered = formatRunEvent(projected, { format: 'text' })
  assert.match(rendered.stderr, /No model is loaded/i)
  assert.match(rendered.stderr, /lms load/)
  assert.doesNotMatch(JSON.stringify(projected) + rendered.stderr, /private-|PRIVATE_|opaque-provider|password/)
  assert.equal(source.code, undefined, 'terminal normalization cannot change transport retry classification')
})

test('ordinary HTTP 400 and protected authority/outcome codes retain their existing semantics', () => {
  assert.deepEqual(normalizeTurnFailure(Object.assign(new Error('Private invalid request details'), { status: 400 })),
    { code: 'TURN_FAILED', retryable: false, status: 400 })
  for (const code of ['MODEL_REQUEST_OUTCOME_UNKNOWN', 'SIDE_EFFECT_OUTCOME_UNKNOWN', 'APPROVAL_DENIED']) {
    const failure = normalizeTurnFailure({ code, status: 400, message: 'No models loaded.', retryable: false })
    assert.equal(failure.code, code)
    assert.equal(failure.retryable, false)
  }
  assert.equal(normalizeTurnFailure({ status: 503, message: 'No models loaded.' }).code, 'TURN_FAILED')
  assert.equal(normalizeTurnFailure({ message: 'No models loaded.' }).code, 'TURN_FAILED')
})
