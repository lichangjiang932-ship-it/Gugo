import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import { ToolCallTrace } from '../../src/pages/ChatSplit/chatMessages/ActivityTraces.jsx'
import { registerUiContributions } from '../../src/plugins/uiContributionRegistry.js'

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/',
  })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.SVGElement = dom.window.SVGElement
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  return dom
}

function CustomToolView({ call, stepNumber }) {
  return <article data-testid="custom-tool-view" data-tool-name={call.name}>Custom step {stepNumber}</article>
}

test('tool-view contributions replace only matching tool cards and restore defaults after disposal', async () => {
  const dom = setupDom()
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  const dispose = registerUiContributions('test.tool-renderer', [
    {
      id: 'review-tool',
      slot: 'tool-view',
      toolNames: ['review_output'],
      component: CustomToolView,
    },
  ])
  const calls = [
    { id: 'custom', name: 'review_output', status: 'success', arguments: '{}', result: 'ok' },
    { id: 'default', name: 'read_file', status: 'success', arguments: '{"path":"a.txt"}', result: 'ok' },
  ]

  try {
    await act(async () => root.render(<ToolCallTrace calls={calls} />))
    assert.equal(rootElement.querySelector('[data-testid="custom-tool-view"]')?.textContent, 'Custom step 1')
    assert.equal(rootElement.querySelectorAll('[data-testid="tool-call-step"]').length, 1)
    assert.equal(rootElement.querySelector('[data-ui-plugin="test.tool-renderer"]')?.dataset.uiPlugin, 'test.tool-renderer')

    await act(async () => { dispose() })
    assert.equal(rootElement.querySelector('[data-testid="custom-tool-view"]'), null)
    assert.equal(rootElement.querySelectorAll('[data-testid="tool-call-step"]').length, 2)
  } finally {
    dispose()
    await act(async () => root.unmount())
    dom.window.close()
  }
})
