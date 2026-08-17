import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import useChatMessageViewport from '../src/pages/ChatSplit/chatMessages/useChatMessageViewport.js'

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  return dom
}

function Harness({ messages, metrics, onElement, turns = [] }) {
  const viewport = useChatMessageViewport({ messages })
  return <div data-active-turn={viewport.activeTurnIndex ?? ''} ref={(element) => {
    if (!element) return
    if (!element.__viewportMetrics) {
      element.__viewportMetrics = metrics
      element.__scrollTop = 0
      Object.defineProperties(element, {
        scrollHeight: { configurable: true, get: () => element.__viewportMetrics.height },
        clientHeight: { configurable: true, get: () => element.__viewportMetrics.clientHeight },
        scrollTop: {
          configurable: true,
          get: () => element.__scrollTop,
          set: (value) => { element.__scrollTop = value },
        },
      })
    }
    element.__viewportMetrics = metrics
    viewport.bindContainer(element)
    onElement(element)
  }}>
    {turns.map((turnIndex) => <div key={turnIndex} data-chat-turn-index={turnIndex} />)}
  </div>
}

const streamingMessage = {
  id: 'assistant-1',
  role: 'assistant',
  content: 'working',
  meta: { streaming: true, serverTurnId: 'turn-1', serverLastSequence: 5 },
}

function pausedMessage() {
  return {
    ...streamingMessage,
    meta: {
      streaming: false,
      paused: true,
      serverTurnId: 'turn-1',
      serverLastSequence: 6,
      serverClarification: {
        request_type: 'directory',
        suggested_path: 'D:\\output',
        access_mode: 'read_write',
      },
    },
  }
}

test('directory clarification keeps a user who was at the bottom anchored to the new card', async () => {
  const dom = setupDom()
  const root = createRoot(document.getElementById('root'))
  const metrics = { height: 1000, clientHeight: 400 }
  let element
  try {
    await act(async () => root.render(<Harness messages={[streamingMessage]} metrics={metrics} onElement={(value) => { element = value }} />))
    metrics.height = 1200
    await act(async () => root.render(<Harness messages={[pausedMessage()]} metrics={metrics} onElement={(value) => { element = value }} />))
    assert.equal(element.scrollTop, 1200)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('directory clarification does not pull a user who deliberately scrolled upward', async () => {
  const dom = setupDom()
  const root = createRoot(document.getElementById('root'))
  const metrics = { height: 1000, clientHeight: 400 }
  let element
  try {
    await act(async () => root.render(<Harness messages={[streamingMessage]} metrics={metrics} onElement={(value) => { element = value }} />))
    await act(async () => {
      element.scrollTop = 200
      element.dispatchEvent(new dom.window.Event('scroll'))
    })
    metrics.height = 1200
    await act(async () => root.render(<Harness messages={[pausedMessage()]} metrics={metrics} onElement={(value) => { element = value }} />))
    assert.equal(element.scrollTop, 200)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('scrolling updates the active conversation turn from visible message anchors', async () => {
  const dom = setupDom()
  const root = createRoot(document.getElementById('root'))
  const metrics = { height: 1200, clientHeight: 400 }
  const messages = [
    { id: 'user-1', role: 'user', content: 'First request' },
    { id: 'assistant-1', role: 'assistant', content: 'First answer' },
    { id: 'user-2', role: 'user', content: 'Second request' },
    { id: 'assistant-2', role: 'assistant', content: 'Second answer' },
  ]
  let element

  try {
    await act(async () => root.render(
      <Harness
        messages={messages}
        metrics={metrics}
        onElement={(value) => { element = value }}
        turns={[0, 2]}
      />,
    ))

    const anchors = [...element.querySelectorAll('[data-chat-turn-index]')]
    element.getBoundingClientRect = () => ({ top: 0 })
    anchors[0].getBoundingClientRect = () => ({ top: 40 })
    anchors[1].getBoundingClientRect = () => ({ top: 360 })
    await act(async () => {
      element.scrollTop = 120
      element.dispatchEvent(new dom.window.Event('scroll'))
    })
    assert.equal(element.dataset.activeTurn, '0')

    anchors[0].getBoundingClientRect = () => ({ top: -280 })
    anchors[1].getBoundingClientRect = () => ({ top: 80 })
    await act(async () => {
      element.scrollTop = 520
      element.dispatchEvent(new dom.window.Event('scroll'))
    })
    assert.equal(element.dataset.activeTurn, '2')
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})
