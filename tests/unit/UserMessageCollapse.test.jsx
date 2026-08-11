import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import ChatMessages from '../../src/pages/ChatSplit/ChatMessages.jsx'
import {
  USER_MESSAGE_COLLAPSE_CHARACTER_LIMIT,
  USER_MESSAGE_COLLAPSE_LINE_LIMIT,
  shouldCollapseUserMessage,
} from '../../src/pages/ChatSplit/chatMessages/messageContent.js'

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/',
  })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.SVGElement = dom.window.SVGElement
  globalThis.MouseEvent = dom.window.MouseEvent
  globalThis.localStorage = dom.window.localStorage
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0)
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id)
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: dom.window.navigator,
  })
  return dom
}

function renderMessages(root, messages) {
  root.render(
    <ChatMessages
      messages={messages}
      state={{ permRequest: null }}
      workbenchMessage=""
      showContextUsage={false}
      showContextPanel={false}
      setShowContextPanel={() => {}}
      selectedModel="test-model"
      onPermAllow={() => {}}
      onPermDeny={() => {}}
      onNavigatePermissions={() => {}}
      onOpenInPreview={() => {}}
      onExpandCompaction={() => {}}
      onQuoteSelection={() => {}}
    />,
  )
}

test('user-message collapse thresholds are deterministic at their boundaries', () => {
  assert.equal(shouldCollapseUserMessage('a'.repeat(USER_MESSAGE_COLLAPSE_CHARACTER_LIMIT)), false)
  assert.equal(shouldCollapseUserMessage('a'.repeat(USER_MESSAGE_COLLAPSE_CHARACTER_LIMIT + 1)), true)
  assert.equal(shouldCollapseUserMessage(Array(USER_MESSAGE_COLLAPSE_LINE_LIMIT).fill('line').join('\n')), false)
  assert.equal(shouldCollapseUserMessage(Array(USER_MESSAGE_COLLAPSE_LINE_LIMIT + 1).fill('line').join('\n')), true)
})

test('long user messages default to a semantic collapsed preview and can be toggled', async () => {
  const dom = setupDom()
  const rootElement = dom.window.document.getElementById('root')
  const root = createRoot(rootElement)
  const content = Array.from({ length: USER_MESSAGE_COLLAPSE_LINE_LIMIT + 3 }, (_, index) => `line ${index}`).join('\n')

  try {
    await act(async () => renderMessages(root, [{
      id: 'long-user-message',
      role: 'user',
      content,
      attachments: [{ id: 'attachment-1', name: 'notes.txt' }],
      meta: {},
    }]))

    const toggle = rootElement.querySelector('[data-testid="user-message-collapse-toggle"]')
    const messageContent = rootElement.querySelector('[data-testid="user-message-content"]')
    assert.ok(toggle)
    assert.ok(messageContent)
    assert.equal(toggle.getAttribute('aria-expanded'), 'false')
    assert.equal(toggle.getAttribute('aria-controls'), messageContent.id)
    assert.ok(messageContent.textContent.length < content.length)
    assert.doesNotMatch(messageContent.textContent, /line 10/)
    assert.match(rootElement.textContent, /notes\.txt/)

    await act(async () => toggle.click())
    assert.equal(toggle.getAttribute('aria-expanded'), 'true')
    assert.equal(messageContent.textContent, content)

    await act(async () => toggle.click())
    assert.equal(toggle.getAttribute('aria-expanded'), 'false')
    assert.ok(messageContent.textContent.length < content.length)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('short user messages render without a collapse control', async () => {
  const dom = setupDom()
  const rootElement = dom.window.document.getElementById('root')
  const root = createRoot(rootElement)

  try {
    await act(async () => renderMessages(root, [{
      id: 'short-user-message',
      role: 'user',
      content: 'A concise prompt stays fully visible.',
      meta: {},
    }]))

    assert.equal(rootElement.querySelector('[data-testid="user-message-collapse-toggle"]'), null)
    assert.equal(rootElement.querySelector('[data-testid="user-message-content"]').textContent, 'A concise prompt stays fully visible.')
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})
