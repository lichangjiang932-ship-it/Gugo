import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import ChatMessages from '../../src/pages/ChatSplit/ChatMessages.jsx'
import ChatMiniTimeline from '../../src/pages/ChatSplit/chatMessages/ChatMiniTimeline.jsx'
import {
  buildChatTurnMarkers,
  CHAT_TIMELINE_MARKER_LIMIT,
} from '../../src/pages/ChatSplit/chatMessages/chatMiniTimeline.js'

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
  'chatTimeline.earlierTurns': 'Earlier turns, go to turn {number}',
  'chatTimeline.laterTurns': 'Later turns, go to turn {number}',
}

const t = (key, vars) => {
  const raw = translations[key] || key
  if (!vars) return raw
  return raw.replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? `{${name}}`))
}

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
    const markerList = rootElement.querySelector('.chat-mini-timeline-list')
    assert.equal(markers.length, 2)
    assert.equal(rootElement.querySelector('.chat-mini-timeline-list > span[aria-hidden="true"]'), null)
    assert.ok(markerList.classList.contains('w-8'))
    assert.ok(markerList.classList.contains('gap-0.5'))
    const activeStroke = markers[0].querySelector('span[aria-hidden="true"]')
    const idleStroke = markers[1].querySelector('span[aria-hidden="true"]')
    assert.ok(activeStroke.classList.contains('h-[3px]'))
    assert.ok(activeStroke.classList.contains('w-4'))
    assert.ok(idleStroke.classList.contains('w-2.5'))
    assert.ok(activeStroke.classList.contains('bg-ink/80'))
    assert.ok(idleStroke.classList.contains('bg-ink/25'))
    assert.ok(!activeStroke.classList.contains('bg-accent'))
    assert.equal(markers[0].getAttribute('aria-current'), 'step')

    await act(async () => {
      markers[1].dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true }))
    })
    const preview = rootElement.querySelector('[data-testid="chat-timeline-preview"]')
    assert.match(preview.textContent, /Add a moving background/)
    assert.doesNotMatch(preview.textContent, /Turn\s+2/)

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

test('deep timelines keep a fixed button bound with accessible earlier and later navigation', async () => {
  const dom = setupDom()
  const rootElement = dom.window.document.getElementById('root')
  const root = createRoot(rootElement)
  const selected = []
  const messages = Array.from({ length: 240 }, (_, turn) => ([
    { id: `user-${turn}`, role: 'user', content: `Request ${turn + 1}` },
    { id: `assistant-${turn}`, role: 'assistant', content: `Answer ${turn + 1}` },
  ])).flat()

  await act(async () => {
    root.render(
      <ChatMiniTimeline
        activeTurnIndex={241}
        messages={messages}
        onSelectTurn={(messageIndex) => selected.push(messageIndex)}
        t={t}
      />,
    )
  })

  try {
    const timeline = rootElement.querySelector('[data-testid="chat-mini-timeline"]')
    const markers = timeline.querySelectorAll('[data-testid="chat-timeline-marker"]')
    const earlier = timeline.querySelector('[data-testid="chat-timeline-earlier"]')
    const later = timeline.querySelector('[data-testid="chat-timeline-later"]')
    const active = timeline.querySelector('[aria-current="step"]')

    assert.equal(markers.length, CHAT_TIMELINE_MARKER_LIMIT)
    assert.equal(timeline.querySelectorAll('button').length, CHAT_TIMELINE_MARKER_LIMIT + 2)
    assert.equal(active.dataset.turnIndex, '240')
    assert.equal(active.tagName, 'BUTTON')
    assert.match(earlier.getAttribute('aria-label'), /^Earlier turns, go to turn \d+$/)
    assert.match(later.getAttribute('aria-label'), /^Later turns, go to turn \d+$/)

    earlier.focus()
    assert.equal(dom.window.document.activeElement, earlier)
    await act(async () => earlier.click())
    await act(async () => later.click())
    assert.deepEqual(selected, [228, 252])
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('selecting a marker reveals an older turn while keeping mounted rows bounded', async () => {
  const dom = setupDom()
  const rootElement = dom.window.document.getElementById('root')
  const root = createRoot(rootElement)
  const scrolledTurns = []
  let centeredTurn = null
  dom.window.HTMLElement.prototype.scrollIntoView = function scrollIntoView(options) {
    scrolledTurns.push({ index: this.dataset.chatTurnIndex, options })
    centeredTurn = Number(this.dataset.chatTurnIndex)
    const scrollRegion = this.closest('.chat-scroll-region')
    if (scrollRegion) {
      Object.defineProperty(scrollRegion, 'scrollHeight', { configurable: true, value: 1_000 })
      Object.defineProperty(scrollRegion, 'clientHeight', { configurable: true, value: 100 })
      scrollRegion.scrollTop = 450
    }
  }
  dom.window.HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
    if (this.classList.contains('chat-scroll-region')) {
      return { top: 0, bottom: 100, height: 100, left: 0, right: 100, width: 100 }
    }
    const turnIndex = Number(this.dataset.chatTurnIndex)
    if (centeredTurn != null && Number.isInteger(turnIndex)) {
      const top = 20 + ((turnIndex - centeredTurn) * 20)
      return { top, bottom: top + 10, height: 10, left: 0, right: 100, width: 100 }
    }
    return { top: 0, bottom: 0, height: 0, left: 0, right: 0, width: 0 }
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
    assert.equal(
      rootElement.querySelectorAll('[data-testid="chat-timeline-marker"]').length,
      CHAT_TIMELINE_MARKER_LIMIT,
    )
    assert.ok(
      rootElement.querySelectorAll('[data-testid="chat-mini-timeline"] button').length
        <= CHAT_TIMELINE_MARKER_LIMIT + 2,
    )
    assert.equal(rootElement.querySelector('[data-chat-turn-index="0"]'), null)

    let earlier = rootElement.querySelector('[data-testid="chat-timeline-earlier"]')
    let navigationCount = 0
    while (earlier) {
      await act(async () => earlier.click())
      navigationCount += 1
      assert.ok(navigationCount < 10)
      assert.ok(
        rootElement.querySelectorAll('[data-testid="chat-mini-timeline"] button').length
          <= CHAT_TIMELINE_MARKER_LIMIT + 2,
      )
      earlier = rootElement.querySelector('[data-testid="chat-timeline-earlier"]')
    }

    assert.ok(rootElement.querySelector('[data-chat-turn-index="0"]'))
    assert.equal(
      rootElement.querySelector('[data-testid="chat-timeline-marker"]')?.dataset.turnIndex,
      '0',
    )
    assert.equal(
      rootElement.querySelector('[data-testid="chat-timeline-marker"]')?.getAttribute('aria-current'),
      'step',
    )
    assert.equal(rootElement.querySelectorAll('[data-message-role]').length, 80)
    assert.equal(rootElement.querySelector('[data-chat-turn-index="83"]'), null)
    assert.deepEqual(scrolledTurns.at(-1), {
      index: '0',
      options: { block: 'center', behavior: 'smooth' },
    })

    await act(async () => {
      rootElement.querySelector('[aria-label="回到底部"]').click()
    })
    assert.equal(rootElement.querySelector('[data-chat-turn-index="0"]'), null)
    assert.ok(rootElement.querySelector('[data-chat-turn-index="82"]'))
    assert.equal(rootElement.querySelectorAll('[data-message-role]').length, 80)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('loading earlier messages preserves an assistant first-row anchor', async () => {
  const dom = setupDom()
  const rootElement = dom.window.document.getElementById('root')
  const root = createRoot(rootElement)
  dom.window.HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
    if (this.classList.contains('chat-scroll-region')) {
      return { top: 0, bottom: 100, height: 100, left: 0, right: 100, width: 100 }
    }
    if (this.dataset.chatMessageIndex != null) {
      const rows = [...rootElement.querySelectorAll('[data-chat-message-index]')]
      const top = rows.indexOf(this) * 20
      return { top, bottom: top + 10, height: 10, left: 0, right: 100, width: 100 }
    }
    return { top: 0, bottom: 0, height: 0, left: 0, right: 0, width: 0 }
  }
  const messages = Array.from({ length: 81 }, (_, index) => ({
    id: `message-${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `Message ${index + 1}`,
  }))

  await act(async () => root.render(<ChatMessages messages={messages} workbenchMessage="" />))

  try {
    const scrollRegion = rootElement.querySelector('.chat-scroll-region')
    const firstVisible = rootElement.querySelector('[data-chat-message-index]')
    assert.equal(firstVisible.dataset.chatMessageIndex, '1')
    assert.equal(firstVisible.dataset.messageRole, 'assistant')
    scrollRegion.scrollTop = 120

    const loadEarlier = rootElement.querySelector('.chat-conversation-column > div button')
    await act(async () => loadEarlier.click())

    assert.equal(rootElement.querySelector('[data-chat-message-index]').dataset.chatMessageIndex, '0')
    assert.equal(scrollRegion.scrollTop, 140)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})
