import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import { ArtifactReferenceLinks } from '../src/pages/ChatSplit/chatMessages/ArtifactCards.jsx'
import MessageRow from '../src/pages/ChatSplit/chatMessages/MessageRow.jsx'

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.SVGElement = dom.window.SVGElement
  globalThis.MouseEvent = dom.window.MouseEvent
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  return dom
}

test('generated file names render as highlighted links and open the right-pane payload', async () => {
  const dom = setupDom()
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  const opened = []
  const msg = {
    id: 'message-1',
    content: 'The calculator is ready.',
    meta: { serverArtifacts: [{ id: 'file-1', filename: 'calculator.html', type: 'html', url: '/api/artifacts/file-1' }] },
  }
  const preview = { type: 'html', filename: 'generated.html', html: '<main>Calculator</main>' }

  try {
    await act(async () => root.render(<ArtifactReferenceLinks msg={msg} preview={preview} onOpen={(artifact) => opened.push(artifact)} />))
    const link = rootElement.querySelector('button')
    assert.ok(link)
    assert.match(link.textContent, /calculator\.html/)
    assert.match(link.className, /bg-ember-soft/)
    await act(async () => link.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    assert.equal(opened[0].preview.filename, 'calculator.html')
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('a completed artifact keeps its narration and file link while a later reply is generating', async () => {
  const dom = setupDom()
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  const msg = {
    id: 'completed-artifact-message',
    role: 'assistant',
    content: '<!doctype html><html><body><h1>Calculator source</h1></body></html>',
    timestamp: Date.now(),
    meta: {
      streaming: false,
      serverArtifacts: [{ id: 'file-1', filename: 'calculator.html', type: 'html', url: '/api/artifacts/file-1' }],
    },
  }
  const t = (key) => key === 'chat.serverTurn.completed' ? '已完成' : key

  try {
    await act(async () => root.render(
      <MessageRow
        msg={msg}
        rowKey={msg.id}
        generatingMessageId="newer-assistant-message"
        isGenerating
        lang="zh"
        t={t}
      />,
    ))
    assert.match(rootElement.textContent, /已完成/)
    assert.match(rootElement.textContent, /calculator\.html/)
    assert.doesNotMatch(rootElement.textContent, /Calculator source/)
    assert.ok(rootElement.querySelector('[data-testid="artifact-open-card"]'))
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})
