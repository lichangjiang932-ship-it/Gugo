import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import { I18nProvider } from '../../src/i18n/I18nProvider.jsx'
import { ChatRightPanels } from '../../src/pages/ChatSplit/ChatSplitView.jsx'

test('a generated file preview is the only mounted right panel', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/chat',
  })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.SVGElement = dom.window.SVGElement
  globalThis.MouseEvent = dom.window.MouseEvent
  globalThis.KeyboardEvent = dom.window.KeyboardEvent
  globalThis.localStorage = dom.window.localStorage
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  const noop = () => {}
  const baseProps = {
    workbenchOpen: true,
    messages: [],
    workbenchTab: 'files',
    onWorkbenchTabChange: noop,
    onCloseWorkbench: noop,
    onOpenArtifact: noop,
    onWorkbenchSend: noop,
    isGenerating: false,
    workbenchMessage: '',
    onClosePreview: noop,
    onPreviewMessage: noop,
  }

  try {
    await act(async () => root.render(
      <I18nProvider>
        <ChatRightPanels
          {...baseProps}
          previewArtifact={{ messageId: 'final-message', content: '', preview: null, directFile: {
            id: 'final-pdf', filename: 'final-report.pdf', type: 'pdf', url: '/api/artifacts/final-pdf',
          } }}
        />
      </I18nProvider>,
    ))

    assert.ok(rootElement.querySelector('[data-testid="direct-file-pane"]'))
    assert.equal(rootElement.querySelector('[data-testid="right-workbench"]'), null)

    await act(async () => root.render(
      <I18nProvider><ChatRightPanels {...baseProps} previewArtifact={null} /></I18nProvider>,
    ))
    assert.ok(rootElement.querySelector('[data-testid="right-workbench"]'))
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})
