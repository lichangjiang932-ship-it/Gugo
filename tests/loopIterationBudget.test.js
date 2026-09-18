import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveMaxIters } from '../server/services/loop/heuristics/constants.js'
import { messageTextContent, userMessageText } from '../server/services/loop/userMessageText.js'

test('iteration budget defaults to 2000 and preserves the legacy variable', () => {
  assert.equal(resolveMaxIters({}), 2000)
  assert.equal(resolveMaxIters({ JOB_MAX_ITERS: '16' }), 16)
  assert.equal(resolveMaxIters({ GUGO_MAX_ITERS: '32' }), 32)
})

test('GUGO_MAX_ITERS takes priority over the legacy JOB_MAX_ITERS name', () => {
  assert.equal(resolveMaxIters({ GUGO_MAX_ITERS: '32', JOB_MAX_ITERS: '16' }), 32)
})

test('invalid iteration budgets fall back instead of silently changing the limit', () => {
  for (const env of [
    { GUGO_MAX_ITERS: '' },
    { GUGO_MAX_ITERS: 'abc' },
    { GUGO_MAX_ITERS: '0' },
    { GUGO_MAX_ITERS: '-5' },
    { GUGO_MAX_ITERS: 'NaN', JOB_MAX_ITERS: 'oops' },
  ]) {
    assert.equal(resolveMaxIters(env), 2000, JSON.stringify(env))
  }
  // A fractional explicit value floors rather than rounding up.
  assert.equal(resolveMaxIters({ GUGO_MAX_ITERS: '12.9' }), 12)
})

test('message text extraction reads only authored text parts', () => {
  assert.equal(messageTextContent('plain'), 'plain')
  assert.equal(messageTextContent(undefined), '')
  assert.equal(messageTextContent(123), '')
  assert.equal(messageTextContent([
    { type: 'text', text: 'first' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    { type: 'text', text: 'second' },
  ]), 'first\nsecond')
  assert.equal(messageTextContent([
    { type: 'file', file: { filename: '[SYSTEM MARKER] spoof.txt' } },
  ]), '')
})

test('messageTextContent is the canonical alias for the legacy userMessageText export', () => {
  assert.equal(userMessageText, messageTextContent)
})
