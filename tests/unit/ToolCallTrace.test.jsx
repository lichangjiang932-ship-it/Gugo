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

test('ToolCallTrace renders an accessible summary and numbered running steps', () => {
  const markup = renderTrace([
    { id: 'read-1', name: 'read_file', arguments: '{"path":"D:/work/a.js"}', status: 'success' },
    { id: 'bash-1', name: 'bash_exec', arguments: '{"command":"npm test"}', status: 'running' },
  ])

  assert.match(markup, /aria-expanded="true"/)
  assert.match(markup, /aria-controls=/)
  assert.match(markup, /执行过程/)
  assert.match(markup, /进行中 · 1 步/)
  assert.match(markup, />1<\/div>/)
  assert.match(markup, />2<\/div>/)
  assert.equal((markup.match(/data-testid="tool-call-step"/g) || []).length, 2)
})

test('ToolCallTrace omits empty and invalid call lists', () => {
  assert.equal(renderTrace([]), '')
  assert.equal(renderTrace(null), '')
})

test('ToolCallTrace opens for a newly added running step but respects a manual collapse', async () => {
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
  const renderCalls = async (calls) => act(async () => root.render(
    <I18nProvider><ToolCallTrace calls={calls} /></I18nProvider>,
  ))

  try {
    const completed = [
      { id: 'read-1', name: 'read_file', arguments: '{}', status: 'success' },
    ]
    await renderCalls(completed)
    const summary = rootElement.querySelector('.chat-activity-summary')
    assert.equal(summary.getAttribute('aria-expanded'), 'false')

    await renderCalls([
      ...completed,
      { id: 'bash-1', name: 'bash_exec', arguments: '{}', status: 'running' },
    ])
    assert.equal(summary.getAttribute('aria-expanded'), 'true')

    await act(async () => summary.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    assert.equal(summary.getAttribute('aria-expanded'), 'false')

    await renderCalls([
      ...completed,
      { id: 'bash-1', name: 'bash_exec', arguments: '{}', status: 'running', liveOutput: 'still running' },
      { id: 'write-1', name: 'write_file', arguments: '{}', status: 'running' },
    ])
    assert.equal(summary.getAttribute('aria-expanded'), 'false')
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})
