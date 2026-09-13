import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import ChatMessages from '../src/pages/ChatSplit/ChatMessages.jsx'

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/chat',
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

const messages = [
  { id: 'user-one', role: 'user', content: 'First direction', timestamp: 1, meta: {} },
  { id: 'assistant-one', role: 'assistant', content: 'First answer', timestamp: 2, meta: {} },
  { id: 'user-two', role: 'user', content: 'Second direction', timestamp: 3, meta: {} },
]

function renderMessages(root, props = {}) {
  root.render(<ChatMessages
    messages={messages}
    sessionId="session-one"
    workbenchMessage=""
    onForkMessage={() => {}}
    onQuoteSelection={() => {}}
    {...props}
  />)
}

test('completed user and assistant rows can fork at their exact message while active or draft sessions cannot', async () => {
  const dom = setupDom()
  const rootElement = dom.window.document.getElementById('root')
  const root = createRoot(rootElement)
  const forked = []

  try {
    await act(async () => renderMessages(root, {
      onForkMessage: (message) => forked.push(message.id),
    }))

    let userButtons = [...rootElement.querySelectorAll('[data-testid="fork-user-message"]')]
    let assistantButtons = [...rootElement.querySelectorAll('[data-testid="fork-assistant-message"]')]
    assert.equal(userButtons.length, 2)
    assert.equal(assistantButtons.length, 1)
    await act(async () => userButtons[0].click())
    await act(async () => assistantButtons[0].click())
    assert.deepEqual(forked, ['user-one', 'assistant-one'])

    await act(async () => renderMessages(root, {
      forkingMessageId: 'assistant-one',
      onForkMessage: (message) => forked.push(message.id),
    }))
    userButtons = [...rootElement.querySelectorAll('[data-testid="fork-user-message"]')]
    assistantButtons = [...rootElement.querySelectorAll('[data-testid="fork-assistant-message"]')]
    assert.equal(userButtons.every((button) => !button.disabled), true)
    assert.equal(assistantButtons[0].disabled, true)

    await act(async () => renderMessages(root, { isGenerating: true }))
    assert.equal(rootElement.querySelector('[data-testid^="fork-"]'), null)

    await act(async () => renderMessages(root, { sessionId: '' }))
    assert.equal(rootElement.querySelector('[data-testid^="fork-"]'), null)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})
