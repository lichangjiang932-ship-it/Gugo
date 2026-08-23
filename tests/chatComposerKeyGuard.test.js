import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isChatCompositionEvent,
  shouldSubmitChatKey,
} from '../src/pages/ChatSplit/chatComposerKeyGuard.js'

test('chat composer submits only an unmodified Enter outside IME composition', () => {
  assert.equal(shouldSubmitChatKey({ key: 'Enter' }), true)
  assert.equal(shouldSubmitChatKey({ key: 'Enter', shiftKey: true }), false)
  assert.equal(shouldSubmitChatKey({ key: 'a' }), false)
})

test('chat composer never submits or navigates history while an IME composition is active', () => {
  const events = [
    { key: 'Enter', isComposing: true },
    { key: 'Enter', nativeEvent: { isComposing: true } },
    { key: 'Enter', keyCode: 229 },
    { key: 'ArrowUp', nativeEvent: { keyCode: 229 } },
  ]

  for (const event of events) {
    assert.equal(isChatCompositionEvent(event), true)
    assert.equal(shouldSubmitChatKey(event), false)
  }
})
