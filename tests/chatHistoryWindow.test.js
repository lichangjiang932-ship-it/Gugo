import test from 'node:test'
import assert from 'node:assert/strict'
import { getUserInputHistory, shouldNavigateInputHistory } from '../src/pages/ChatSplit/useInputHistory.js'
import { getExpandedWindowCount, getMessageWindow } from '../src/lib/messageWindow.js'

test('input history returns recent user prompts from newest to oldest', () => {
  const messages = [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'reply' },
    { role: 'user', content: 'second' },
    { role: 'user', content: 'third' },
  ]
  assert.deepEqual(getUserInputHistory(messages, 2), ['third', 'second'])
})

test('input history only captures arrow keys at multiline boundaries', () => {
  const event = (value, cursor) => ({
    currentTarget: { value, selectionStart: cursor, selectionEnd: cursor },
  })
  assert.equal(shouldNavigateInputHistory(event('one\ntwo', 0), 'up'), true)
  assert.equal(shouldNavigateInputHistory(event('one\ntwo', 5), 'up'), false)
  assert.equal(shouldNavigateInputHistory(event('one\ntwo', 3), 'down'), false)
  assert.equal(shouldNavigateInputHistory(event('one\ntwo', 7), 'down'), true)
})

test('message window mounts the recent 80 messages and expands by page', () => {
  const messages = Array.from({ length: 205 }, (_, index) => ({ id: index }))
  const initial = getMessageWindow(messages)
  assert.equal(initial.hiddenCount, 125)
  assert.equal(initial.visibleMessages.length, 80)
  assert.equal(initial.visibleMessages[0].id, 125)

  const expanded = getMessageWindow(messages, 160)
  assert.equal(expanded.hiddenCount, 45)
  assert.equal(expanded.visibleMessages[0].id, 45)
  assert.equal(getExpandedWindowCount(messages.length, 12), 240)
})
