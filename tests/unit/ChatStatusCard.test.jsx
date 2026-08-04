import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import ChatStatusCard from '../../src/pages/ChatSplit/ChatStatusCard.jsx'

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/chat' })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.SVGElement = dom.window.SVGElement
  globalThis.MouseEvent = dom.window.MouseEvent
  globalThis.localStorage = dom.window.localStorage
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  return dom
}

test('status slash action renders inline context, model, task, and permission details', async () => {
  const dom = setupDom()
  const rootElement = dom.window.document.getElementById('root')
  const root = createRoot(rootElement)
  const actions = []
  try {
    await act(async () => {
      root.render(<ChatStatusCard
        session={{ id: 'chat-42' }}
        messages={[{ role: 'user', content: 'Inspect the project.' }, { role: 'assistant', content: 'Working on it.' }]}
        tasks={[{ id: 't1', status: 'running', sessionId: 'chat-42' }, { id: 't2', status: 'pending', sessionId: 'chat-42' }]}
        model="mimo-v2.5"
        contextWindow={100000}
        toolSpecs={[{ name: 'read_file' }]}
        systemPrompt="Be helpful."
        approvalMode="plan"
        onClose={() => actions.push('close')}
        onOpenTasks={() => actions.push('tasks')}
        onOpenContext={() => actions.push('context')}
      />)
    })

    const card = rootElement.querySelector('[data-testid="slash-status-card"]')
    assert.ok(card)
    assert.match(card.textContent, /chat-42/)
    assert.match(card.textContent, /mimo-v2\.5/)
    assert.match(card.textContent, /2/)
    assert.match(card.textContent, /1.*1/s)
    assert.ok(card.querySelector('[style*="width"]'))

    const buttons = [...card.querySelectorAll('button')]
    await act(async () => buttons[0].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    await act(async () => buttons.at(-1).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    await act(async () => buttons[1].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    assert.deepEqual(actions.sort(), ['close', 'context', 'tasks'])
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})
