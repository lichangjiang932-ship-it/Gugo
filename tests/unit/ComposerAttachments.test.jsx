import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import ComposerAttachments from '../../src/pages/ChatSplit/chatComposer/ComposerAttachments.jsx'

test('every uploaded attachment opens the shared preview while unfinished files stay inert', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/chat',
  })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.SVGElement = dom.window.SVGElement
  globalThis.MouseEvent = dom.window.MouseEvent
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  const opened = []
  const t = (key) => key === 'chatMessages.openPreviewTitle' ? 'Open on the right' : key

  try {
    await act(async () => root.render(
      <ComposerAttachments
        attachments={[
          { id: 'photo', kind: 'image', name: 'portrait.jpg', sizeKB: '12.0', dataUrl: 'data:image/jpeg;base64,AA==' },
          { id: 'document', kind: 'file', name: 'report.docx', sizeKB: '4.2', downloadUrl: '/api/attachments/document/content' },
          { id: 'pending', kind: 'file', name: 'pending.txt', sizeKB: '1.0', uploadStatus: 'uploading' },
        ]}
        onClear={() => {}}
        onOpen={(attachment) => opened.push(attachment)}
        onRemove={() => {}}
        t={t}
      />,
    ))

    const openButtons = [...rootElement.querySelectorAll('[data-testid="composer-attachment-open"]')]
    assert.deepEqual(openButtons.map((button) => button.getAttribute('aria-label')), [
      'Open on the right: portrait.jpg',
      'Open on the right: report.docx',
    ])
    assert.equal(rootElement.querySelector('[aria-label="Open on the right: pending.txt"]'), null)

    await act(async () => openButtons[1].dispatchEvent(new dom.window.MouseEvent('click', {
      bubbles: true,
      cancelable: true,
    })))
    assert.equal(opened.length, 1)
    assert.equal(opened[0].id, 'document')
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})
