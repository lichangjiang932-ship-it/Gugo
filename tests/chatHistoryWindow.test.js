import test from 'node:test'
import assert from 'node:assert/strict'
import { getUserInputHistory, shouldNavigateInputHistory } from '../src/pages/ChatSplit/useInputHistory.js'
import { getAnchoredWindowStart, getMessageWindow } from '../src/lib/messageWindow.js'

test('input history returns recent user prompts from newest to oldest', () => {
  const messages = [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'reply' },
    { role: 'user', content: 'second' },
    { role: 'user', content: 'third' },
  ]
  assert.deepEqual(getUserInputHistory(messages, 2), ['third', 'second'])
})

test('input history navigation only starts from an empty single-line input', () => {
  const event = (value, cursor = 0, extra = {}) => ({
    currentTarget: { value, selectionStart: cursor, selectionEnd: cursor },
    ...extra,
  })
  const matrix = [
    { name: 'empty up', event: event(''), direction: 'up', expected: true },
    { name: 'empty down', event: event(''), direction: 'down', expected: true },
    { name: 'whitespace-only', event: event('   ', 2), direction: 'up', expected: true },
    { name: 'non-empty up at start', event: event('one', 0), direction: 'up', expected: false },
    { name: 'non-empty down at end', event: event('one', 3), direction: 'down', expected: false },
    { name: 'multiline up at start', event: event('one\ntwo', 0), direction: 'up', expected: false },
    { name: 'multiline down at end', event: event('one\ntwo', 7), direction: 'down', expected: false },
    { name: 'empty multiline', event: event('\n', 0), direction: 'up', expected: false },
    { name: 'modified arrow', event: event('', 0, { shiftKey: true }), direction: 'up', expected: false },
    { name: 'unknown direction', event: event(''), direction: 'left', expected: false },
  ]
  for (const entry of matrix) {
    assert.equal(shouldNavigateInputHistory(entry.event, entry.direction), entry.expected, entry.name)
  }

  const selection = event('  ', 0)
  selection.currentTarget.selectionEnd = 1
  assert.equal(shouldNavigateInputHistory(selection, 'up'), false)
})

test('input history navigation setting disables both arrow directions', () => {
  const event = { currentTarget: { value: '', selectionStart: 0, selectionEnd: 0 } }
  assert.equal(shouldNavigateInputHistory(event, 'up', false), false)
  assert.equal(shouldNavigateInputHistory(event, 'down', false), false)
})

test('message window mounts at most 80 recent or target-anchored messages', () => {
  const messages = Array.from({ length: 205 }, (_, index) => ({ id: index }))
  const initial = getMessageWindow(messages)
  assert.equal(initial.hiddenCount, 125)
  assert.equal(initial.hiddenAfterCount, 0)
  assert.equal(initial.visibleMessages.length, 80)
  assert.equal(initial.visibleMessages[0].id, 125)

  const anchoredStart = getAnchoredWindowStart(messages.length, 100)
  const anchored = getMessageWindow(messages, 80, anchoredStart)
  assert.equal(anchored.hiddenCount, 60)
  assert.equal(anchored.hiddenAfterCount, 65)
  assert.equal(anchored.visibleMessages.length, 80)
  assert.equal(anchored.visibleMessages[0].id, 60)
  assert.equal(anchored.visibleMessages.at(-1).id, 139)
  assert.equal(getAnchoredWindowStart(messages.length, 0), 0)
  assert.equal(getAnchoredWindowStart(messages.length, 204), 125)
})
