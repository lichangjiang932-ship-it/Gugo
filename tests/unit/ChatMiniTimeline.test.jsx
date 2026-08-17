import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import ChatMessages from '../../src/pages/ChatSplit/ChatMessages.jsx'
import ChatMiniTimeline from '../../src/pages/ChatSplit/chatMessages/ChatMiniTimeline.jsx'
import { buildChatTurnMarkers } from '../../src/pages/ChatSplit/chatMessages/chatMiniTimeline.js'

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

const translations = {
  'chatTimeline.attachmentFallback': 'Attachment message',
  'chatTimeline.jumpTo': 'Go to turn',
  'chatTimeline.label': 'Conversation timeline',
  'chatTimeline.turn': 'Turn',
}

const t = (key) => translations[key] || key

test('turn markers represent user-started rounds and keep summaries compact', () => {
  const markers = buildChatTurnMarkers([
    { id: 'assistant-0', role: 'assistant', content: 'Welcome' },
    { id: 'user-1', role: 'user', content: `  Build   a site ${'with motion '.repeat(10)} ` },
    { id: 'assistant-1', role: 'assistant', content: 'Done' },
    { id: 'user-2', role: 'user', attachments: [{ name: 'reference.png' }] },
  ], 'Attachment message')

  assert.deepEqual(markers.map(({ messageIndex, number }) => ({ messageIndex, number })), [
    { messageIndex: 1, number: 1 },
    { messageIndex: 3, number: 2 },
  ])
  assert.ok(markers[0].summary.length <= 72)
  assert.doesNotMatch(markers[0].summary, /\s{2,}/)
  assert.equal(markers[1].summary, 'reference.png')
})

test('timeline previews, selects, highlights, and appends conversation turns', async () => {
  const dom = setupDom()
  const rootElement = dom.window.document.getElementById('root')
  const root = createRoot(rootElement)
  const selected = []
  const initialMessages = [
    { id: 'user-1', role: 'user', content: 'Create the first page' },
    { id: 'assistant-1', role: 'assistant', content: 'Created' },
    { id: 'user-2', role: 'user', content: 'Add a moving background' },
    { id: 'assistant-2', role: 'assistant', content: 'Updated' },
  ]

  const renderTimeline = (messages, activeTurnIndex = 0) => (
    <ChatMiniTimeline
      activeTurnIndex={activeTurnIndex}
      messages={messages}
      onSelectTurn={(messageIndex) => selected.push(messageIndex)}
      t={t}
    />
  )

  await act(async () => root.render(renderTimeline(initialMessages)))

  try {
    let markers = rootElement.querySelectorAll('[data-testid="chat-timeline-marker"]')
    assert.equal(markers.length, 2)
    assert.equal(markers[0].getAttribute('aria-current'), 'step')

    await act(async () => {
      markers[1].dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true }))
    })
    assert.match(rootElement.querySelector('[data-testid="chat-timeline-preview"]').textContent, /Add a moving background/)

    await act(async () => markers[1].click())
    assert.deepEqual(selected, [2])

    const nextMessages = [
      ...initialMessages,
      { id: 'user-3', role: 'user', content: 'Verify the animation' },
      { id: 'assistant-3', role: 'assistant', content: 'Verified' },
    ]
    await act(async () => root.render(renderTimeline(nextMessages, 4)))
    markers = rootElement.querySelectorAll('[data-testid="chat-timeline-marker"]')
    assert.equal(markers.length, 3)
    assert.equal(markers[2].getAttribute('aria-current'), 'step')
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('selecting a marker reveals a virtualized older turn before scrolling to it', async () => {
  const dom = setupDom()
  const rootElement = dom.window.document.getElementById('root')
  const root = createRoot(rootElement)
  const scrolledTurns = []
  dom.window.HTMLElement.prototype.scrollIntoView = function scrollIntoView(options) {
    scrolledTurns.push({ index: this.dataset.chatTurnIndex, options })
  }
  const messages = Array.from({ length: 42 }, (_, turn) => ([
    { id: `user-${turn}`, role: 'user', content: `Request ${turn + 1}` },
    { id: `assistant-${turn}`, role: 'assistant', content: `Answer ${turn + 1}` },
  ])).flat()

  await act(async () => {
    root.render(
      <ChatMessages
        messages={messages}
        state={{ permRequest: null }}
        workbenchMessage=""
      />,
    )
  })

  try {
    assert.equal(rootElement.querySelectorAll('[data-testid="chat-timeline-marker"]').length, 42)
    assert.equal(rootElement.querySelector('[data-chat-turn-index="0"]'), null)

    await act(async () => {
      rootElement.querySelector('[data-testid="chat-timeline-marker"]').click()
    })

    assert.ok(rootElement.querySelector('[data-chat-turn-index="0"]'))
    assert.deepEqual(scrolledTurns.at(-1), {
      index: '0',
      options: { block: 'center', behavior: 'smooth' },
    })
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})
