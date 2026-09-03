import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import ChatMessages from '../../src/pages/ChatSplit/ChatMessages.jsx'
import { HashRouter, useLocation } from '../../src/lib/router.jsx'

function RoutedChatMessages(props) {
  const location = useLocation()
  return <ChatMessages {...props} routeHash={location.hash} />
}

test('HashRouter message anchors reveal and center a target outside the mounted window', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/#/chat#message-user-2',
  })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.IS_REACT_ACT_ENVIRONMENT = true

  const rootElement = dom.window.document.getElementById('root')
  const root = createRoot(rootElement)
  const scrolled = []
  dom.window.HTMLElement.prototype.scrollIntoView = function scrollIntoView(options) {
    scrolled.push({ id: this.id, options })
  }
  const messages = Array.from({ length: 61 }, (_, turn) => ([
    { id: `user-${turn}`, role: 'user', content: `Request ${turn + 1}` },
    { id: `assistant-${turn}`, role: 'assistant', content: `Answer ${turn + 1}` },
  ])).flat()

  await act(async () => {
    root.render(
      <HashRouter>
        <RoutedChatMessages messages={messages} workbenchMessage="" />
      </HashRouter>,
    )
  })

  try {
    assert.equal(rootElement.querySelector('#message-user-2'), null)
    await act(async () => new Promise((resolve) => dom.window.setTimeout(resolve, 0)))
    assert.ok(rootElement.querySelector('#message-user-2'))
    assert.ok(rootElement.querySelectorAll('[data-chat-message-index]').length <= 80)
    await act(async () => new Promise((resolve) => dom.window.setTimeout(resolve, 100)))
    assert.deepEqual(scrolled.at(-1), {
      id: 'message-user-2',
      options: { block: 'center', behavior: 'smooth' },
    })
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})
