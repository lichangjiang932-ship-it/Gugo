import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'

import { I18nProvider } from '../../src/i18n/I18nProvider.jsx'
import { ToolCallTrace } from '../../src/pages/ChatSplit/chatMessages/ActivityTraces.jsx'

function renderTrace(calls) {
  return renderToStaticMarkup(
    <I18nProvider>
      <ToolCallTrace calls={calls} />
    </I18nProvider>,
  )
}

test('ToolCallTrace renders one lightweight accessible timeline without a visible title', () => {
  const markup = renderTrace([
    { id: 'read-1', name: 'read_file', arguments: '{"path":"D:/work/a.js"}', status: 'success' },
    { id: 'bash-1', name: 'bash_exec', arguments: '{"command":"npm test"}', status: 'running' },
  ])

  assert.match(markup, /class="chat-run-timeline"/)
  assert.doesNotMatch(markup, /chat-activity-title/)
  assert.match(markup, /aria-label="2 tool calls"/)
  assert.doesNotMatch(markup, /执行过程/)
  assert.match(markup, /chat-tool-step-marker/)
  assert.equal((markup.match(/data-testid="tool-call-step"/g) || []).length, 2)
})

test('ToolCallTrace omits empty and invalid call lists', () => {
  assert.equal(renderTrace([]), '')
  assert.equal(renderTrace(null), '')
})

test('ToolCallTrace renders a terminal stopped step without a busy spinner', () => {
  const markup = renderTrace([
    { id: 'stopped-1', name: 'bash_exec', arguments: '{"command":"npm test"}', status: 'cancelled' },
  ])

  assert.match(markup, /data-status="cancelled"/)
  assert.match(markup, /aria-busy="false"/)
  assert.match(markup, /Stopped/)
  assert.doesNotMatch(markup, /animate-spin/)
})

test('ToolCallTrace renders a stopped Agent without an empty result disclosure', () => {
  const markup = renderTrace([{
    id: 'agent-stopped',
    name: 'Agent',
    arguments: '{"description":"Review files","subagent_type":"reviewer"}',
    status: 'cancelled',
  }])

  assert.match(markup, /data-status="cancelled"/)
  assert.match(markup, /Stopped/)
  assert.doesNotMatch(markup, /animate-spin/)
  assert.doesNotMatch(markup, /子代理结果/)
})

test('ToolCallTrace keeps the latest four steps visible and can reveal older history', async () => {
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
  dom.window.matchMedia = () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  })
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)

  try {
    const calls = Array.from({ length: 8 }, (_, index) => ({
      id: `read-${index + 1}`,
      name: 'read_file',
      arguments: JSON.stringify({ path: `file-${index + 1}.txt` }),
      status: index === 7 ? 'running' : 'success',
    }))
    await act(async () => root.render(
      <I18nProvider><ToolCallTrace calls={calls} /></I18nProvider>,
    ))

    const history = rootElement.querySelector('.chat-timeline-history')
    assert.ok(history)
    assert.equal(history.getAttribute('aria-expanded'), 'false')
    assert.equal(rootElement.querySelectorAll('[data-testid="tool-call-step"]').length, 4)
    assert.doesNotMatch(rootElement.textContent, /file-1\.txt/)
    assert.match(rootElement.textContent, /file-8\.txt/)

    await act(async () => history.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    assert.equal(history.getAttribute('aria-expanded'), 'true')
    assert.equal(rootElement.querySelectorAll('[data-testid="tool-call-step"]').length, 8)
    assert.match(rootElement.textContent, /file-1\.txt/)

    await act(async () => history.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    assert.equal(rootElement.querySelectorAll('[data-testid="tool-call-step"]').length, 4)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('ToolCallTrace never hides an older running call behind newer completed calls', () => {
  const calls = Array.from({ length: 5 }, (_, index) => ({
    id: `parallel-${index + 1}`,
    name: 'read_file',
    arguments: JSON.stringify({ path: `parallel-${index + 1}.txt` }),
    status: index === 0 ? 'running' : 'success',
  }))
  const markup = renderTrace(calls)

  assert.match(markup, /parallel-1\.txt/)
  assert.match(markup, /data-status="running"/)
  assert.match(markup, /aria-busy="true"/)
})

test('ToolCallTrace defaults the running command open and preserves the selected detail across live updates', async () => {
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
  dom.window.matchMedia = () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  })
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  const calls = [
    { id: 'read-stable', name: 'read_file', arguments: '{"path":"D:/work/a.js"}', status: 'success', result: 'alpha' },
    { id: 'command-stable', name: 'bash_exec', arguments: '{"command":"npm test"}', status: 'running', liveOutput: 'starting' },
  ]

  try {
    await act(async () => root.render(
      <I18nProvider><ToolCallTrace calls={calls} /></I18nProvider>,
    ))

    let toggles = [...rootElement.querySelectorAll('[data-testid="tool-step-toggle"]')]
    assert.deepEqual(toggles.map((toggle) => toggle.getAttribute('aria-expanded')), ['false', 'true'])
    assert.equal(rootElement.querySelectorAll('[data-testid="tool-step-details"]').length, 1)
    assert.match(rootElement.querySelector('[data-testid="tool-step-details"]').textContent, /starting/)

    await act(async () => toggles[0].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    toggles = [...rootElement.querySelectorAll('[data-testid="tool-step-toggle"]')]
    assert.deepEqual(toggles.map((toggle) => toggle.getAttribute('aria-expanded')), ['true', 'false'])
    assert.equal(rootElement.querySelectorAll('[data-testid="tool-step-details"]').length, 1)
    assert.match(rootElement.querySelector('[data-testid="tool-step-details"]').textContent, /alpha/)

    await act(async () => toggles[1].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    toggles = [...rootElement.querySelectorAll('[data-testid="tool-step-toggle"]')]
    assert.deepEqual(toggles.map((toggle) => toggle.getAttribute('aria-expanded')), ['false', 'true'])
    assert.equal(rootElement.querySelectorAll('[data-testid="tool-step-details"]').length, 1)

    await act(async () => root.render(
      <I18nProvider>
        <ToolCallTrace calls={calls.map((call) => (
          call.id === 'command-stable'
            ? { ...call, liveOutput: 'starting\n42 tests passed' }
            : { ...call }
        ))} />
      </I18nProvider>,
    ))
    toggles = [...rootElement.querySelectorAll('[data-testid="tool-step-toggle"]')]
    assert.equal(toggles[1].getAttribute('aria-expanded'), 'true')
    assert.match(rootElement.querySelector('[data-testid="tool-step-details"]').textContent, /42 tests passed/)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})
