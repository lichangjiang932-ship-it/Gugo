import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import { ArtifactReferenceLinks } from '../src/pages/ChatSplit/chatMessages/ArtifactCards.jsx'

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
