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
  globalThis.PointerEvent = dom.window.MouseEvent
  globalThis.localStorage = dom.window.localStorage
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: dom.window.navigator,
  })
  Object.defineProperty(dom.window, 'innerWidth', { configurable: true, writable: true, value: 1024 })
  return dom
}

function pointerEvent(dom, type, values) {
  const event = new dom.window.Event(type, { bubbles: true, cancelable: true })
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(event, key, { configurable: true, value })
  }
  return event
}

test('right workbench renders compact tabs, persists width, and opens generated files', async () => {
  const dom = setupDom()
  dom.window.localStorage.setItem('yma:right-workbench-width', '520')
  const rootElement = dom.window.document.getElementById('root')
  const root = createRoot(rootElement)
  const opened = []
  const selectedTabs = []

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
              serverArtifacts: [
                { id: 'artifact-1', filename: 'analysis.xlsx', type: 'xlsx', url: '/api/artifacts/turn/artifact-1/download' },
                { id: 'artifact-2', filename: '填写后 答题卡.pdf', type: 'pdf', url: '/api/artifacts/%E5%A1%AB%E5%86%99%E5%90%8E%20%E7%AD%94%E9%A2%98%E5%8D%A1.pdf' },
              ],
              serverDeliveryArtifactIds: ['artifact-1', 'artifact-2'],
            },
          }]}
          activeTab="files"
          onTabChange={(tab) => selectedTabs.push(tab)}
          onClose={() => {}}
          onOpenArtifact={(artifact) => opened.push(artifact)}
          onSendMessage={() => {}}
          isGenerating={false}
        />,
      )
    })

    const navigation = rootElement.querySelector('[data-testid="workbench-navigation"]')
    assert.ok(navigation)
    assert.match(navigation.className, /flex/)
    assert.equal(navigation.querySelectorAll(':scope > button').length, 4)
    assert.equal(navigation.querySelector('[aria-current="page"] span.truncate').textContent, '相关文件')
    assert.equal(rootElement.querySelector('[data-testid="workbench-file-count"]').textContent, '3')
    const resizeHandle = rootElement.querySelector('[data-testid="workbench-resize-handle"]')
    assert.ok(resizeHandle)
    assert.equal(resizeHandle.getAttribute('aria-orientation'), 'vertical')
    assert.equal(resizeHandle.getAttribute('aria-valuemax'), '704')
    const panel = rootElement.querySelector('[data-testid="right-workbench"]')
    assert.equal(panel.style.width, '520px')
    assert.equal(dom.window.localStorage.getItem('yma:right-workbench-width'), '520')

    await act(async () => {
      navigation.querySelectorAll(':scope > button')[1].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
    assert.deepEqual(selectedTabs, ['chat'])

    resizeHandle.setPointerCapture = () => {}
    await act(async () => {
      resizeHandle.dispatchEvent(pointerEvent(dom, 'pointerdown', { pointerId: 3, clientX: 600, button: 2 }))
      dom.window.dispatchEvent(pointerEvent(dom, 'pointermove', { pointerId: 3, clientX: 500 }))
      dom.window.dispatchEvent(pointerEvent(dom, 'pointerup', { pointerId: 3, clientX: 500 }))
    })
    assert.equal(panel.style.width, '520px', 'secondary pointer button must not resize the panel')

    await act(async () => {
      resizeHandle.dispatchEvent(pointerEvent(dom, 'pointerdown', { pointerId: 4, clientX: 600, button: 0 }))
      assert.equal(dom.window.document.activeElement, resizeHandle)
      dom.window.dispatchEvent(pointerEvent(dom, 'pointermove', { pointerId: 4, clientX: 500 }))
      dom.window.dispatchEvent(pointerEvent(dom, 'pointerup', { pointerId: 4, clientX: 500 }))
    })
    assert.equal(panel.style.width, '620px')
    assert.equal(dom.window.localStorage.getItem('yma:right-workbench-width'), '620')

    await act(async () => {
      resizeHandle.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    })
    assert.equal(panel.style.width, '644px')

    await act(async () => {
      resizeHandle.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    })
    assert.equal(panel.style.width, '420px')
    assert.equal(dom.window.localStorage.getItem('yma:right-workbench-width'), '420')

    dom.window.innerWidth = 690
    await act(async () => dom.window.dispatchEvent(new dom.window.Event('resize')))
    assert.equal(panel.style.width, '370px')
    assert.equal(resizeHandle.getAttribute('aria-valuenow'), '370')
    assert.equal(resizeHandle.getAttribute('aria-valuemax'), '370')

    const serverArtifactLink = rootElement.querySelector('[data-testid="workbench-files"] a[download="analysis.xlsx"]')
    assert.ok(serverArtifactLink)
    assert.match(serverArtifactLink.href, /\/api\/artifacts\/turn\/artifact-1\/download/)

    const fileButtons = [...rootElement.querySelectorAll('[data-testid="workbench-files"] button')]
    const directFileButton = fileButtons.find((button) => button.textContent.includes('analysis.xlsx'))
    assert.ok(directFileButton)
    await act(async () => {
      directFileButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    assert.equal(opened[0].directFile.filename, 'analysis.xlsx')

    const localPdfButton = fileButtons.find((button) => button.textContent.includes('填写后 答题卡.pdf'))
    assert.ok(localPdfButton)
    await act(async () => {
      localPdfButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    assert.equal(opened[1].directFile.filename, '填写后 答题卡.pdf')

    const fileButton = fileButtons.find((button) => button.textContent.includes('Quarterly-report.docx'))
    assert.ok(fileButton)
    await act(async () => {
      fileButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    assert.equal(opened.length, 3)
    assert.equal(opened[2].preview.filename, 'Quarterly-report.docx')
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('right workbench hides live intermediates and synthetic previews outside delivery', async () => {
  const dom = setupDom()
  const rootElement = dom.window.document.getElementById('root')
  const root = createRoot(rootElement)
  const messages = [{
    id: 'assistant-running',
    role: 'assistant',
    content: 'Working...',
    meta: {
      streaming: true,
      serverArtifacts: [{ id: 'live-draft', filename: 'live-draft.pdf', type: 'pdf', url: '/api/artifacts/live-draft' }],
    },
  }, {
    id: 'assistant-empty-source',
    role: 'assistant',
    content: 'No delivery.',
    meta: {
      artifactType: 'html',
      artifactTitle: 'Synthetic draft',
      artifactSource: '<!doctype html><html><body>Draft</body></html>',
      serverArtifacts: [{ id: 'source-draft', filename: 'source-draft.html', type: 'html', url: '/api/artifacts/source-draft' }],
      serverDeliveryArtifactIds: [],
    },
  }, {
    id: 'assistant-failed-source',
    role: 'assistant',
    content: 'Generation failed.',
    meta: {
      failed: true,
      artifactType: 'html',
      artifactTitle: 'Failed draft',
      artifactSource: '<!doctype html><html><body>Failed</body></html>',
    },
  }, {
    id: 'assistant-final',
    role: 'assistant',
    content: 'Final ready.',
    meta: {
      serverArtifacts: [
        { id: 'old-draft', filename: 'old-draft.pdf', type: 'pdf', url: '/api/artifacts/old-draft' },
        { id: 'final', filename: 'final-report.pdf', type: 'pdf', url: '/api/artifacts/final' },
      ],
      serverDeliveryArtifactIds: ['final'],
    },
  }]

  try {
    await act(async () => root.render(
      <RightWorkbench
        messages={messages}
        activeTab="files"
        onTabChange={() => {}}
        onClose={() => {}}
        onOpenArtifact={() => {}}
        onSendMessage={() => {}}
        isGenerating
      />,
    ))

    assert.equal(rootElement.querySelector('[data-testid="workbench-file-count"]').textContent, '1')
    assert.match(rootElement.textContent, /final-report\.pdf/)
    assert.doesNotMatch(rootElement.textContent, /live-draft|source-draft|Synthetic draft|Failed draft|old-draft/)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})
