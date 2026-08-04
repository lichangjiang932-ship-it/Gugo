import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import RightWorkbench from '../../src/pages/ChatSplit/RightWorkbench.jsx'

function setupDom() {
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
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: dom.window.navigator,
  })
  return dom
}

test('right workbench renders vertical actions and opens generated files', async () => {
  const dom = setupDom()
  const rootElement = dom.window.document.getElementById('root')
  const root = createRoot(rootElement)
  const opened = []

  try {
    await act(async () => {
      root.render(
        <RightWorkbench
          messages={[{
            id: 'assistant-1',
            role: 'assistant',
            content: 'The generated report is ready.',
            meta: {
              artifactType: 'docx',
              artifactTitle: 'Quarterly report',
              artifactSource: '# Quarterly report\n\n## Summary\nComplete.',
            },
          }, {
            id: 'assistant-2',
            role: 'assistant',
            content: 'Server artifact ready.',
            meta: {
              serverArtifacts: [{ id: 'artifact-1', filename: 'analysis.xlsx', type: 'xlsx', url: '/api/artifacts/turn/artifact-1/download' }],
            },
          }]}
          activeTab="files"
          onTabChange={() => {}}
          onClose={() => {}}
          onOpenArtifact={(artifact) => opened.push(artifact)}
          onSendMessage={() => {}}
          isGenerating={false}
        />,
      )
    })

    const navigation = rootElement.querySelector('[data-testid="workbench-navigation"]')
    assert.ok(navigation)
    assert.match(navigation.className, /flex-col/)
    assert.equal(navigation.querySelectorAll(':scope > button').length, 4)
    assert.equal(rootElement.querySelector('[data-testid="workbench-file-count"]').textContent, '2')

    const serverArtifactLink = rootElement.querySelector('[data-testid="workbench-files"] a[download="analysis.xlsx"]')
    assert.ok(serverArtifactLink)
    assert.match(serverArtifactLink.href, /\/api\/artifacts\/turn\/artifact-1\/download/)

    const fileButton = rootElement.querySelector('[data-testid="workbench-files"] button')
    assert.ok(fileButton)
    assert.match(fileButton.textContent, /Quarterly-report\.docx/)
    await act(async () => {
      fileButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    assert.equal(opened.length, 1)
    assert.equal(opened[0].preview.filename, 'Quarterly-report.docx')
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})
