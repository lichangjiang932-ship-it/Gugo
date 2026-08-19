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
    const activeNavigation = navigation.querySelector('[aria-current="page"]')
    assert.equal(activeNavigation.getAttribute('aria-label'), '相关文件')
    assert.equal(activeNavigation.querySelector('span.sr-only').textContent, '相关文件')
    assert.equal(rootElement.querySelector('[data-testid="workbench-file-count"]').textContent, '2')
    const resizeHandle = rootElement.querySelector('[data-testid="workbench-resize-handle"]')
    assert.ok(resizeHandle)
    assert.equal(resizeHandle.getAttribute('aria-orientation'), 'vertical')
    assert.equal(resizeHandle.getAttribute('aria-valuemax'), '704')
    const panel = rootElement.querySelector('[data-testid="right-workbench"]')
    assert.equal(panel.style.width, '520px')
    assert.match(panel.className, /\bmin-w-0\b/)
    assert.match(panel.className, /\bshrink\b/)
    assert.match(panel.className, /\boverflow-hidden\b/)
    assert.doesNotMatch(panel.className, /\bshrink-0\b/)
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

    const fileLinks = [...rootElement.querySelectorAll('[data-testid="workbench-file-open"]')]
    assert.equal(fileLinks.length, 2)
    assert.ok(fileLinks.every((link) => link.tagName === 'A' && link.getAttribute('href')))
    const directFileLink = fileLinks.find((link) => link.textContent.includes('analysis.xlsx'))
    assert.ok(directFileLink)
    await act(async () => {
      directFileLink.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    assert.equal(opened[0].directFile.filename, 'analysis.xlsx')

    const localPdfLink = fileLinks.find((link) => link.textContent.includes('填写后 答题卡.pdf'))
    assert.ok(localPdfLink)
    await act(async () => {
      localPdfLink.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    assert.equal(opened[1].directFile.filename, '填写后 答题卡.pdf')
    assert.equal(opened.length, 2)
    assert.doesNotMatch(rootElement.textContent, /Quarterly-report\.docx/)
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
      serverArtifacts: [{ id: 'failed-draft', filename: 'failed-draft.html', type: 'html', url: '/api/artifacts/failed-draft' }],
      serverDeliveryArtifactIds: ['failed-draft'],
    },
  }, {
    id: 'assistant-interrupted-source',
    role: 'assistant',
    content: 'Generation interrupted.',
    meta: {
      interrupted: true,
      serverArtifacts: [{ id: 'interrupted-draft', filename: 'interrupted-draft.html', type: 'html', url: '/api/artifacts/interrupted-draft' }],
      serverDeliveryArtifactIds: ['interrupted-draft'],
    },
  }, {
    id: 'assistant-paused-source',
    role: 'assistant',
    content: 'Generation paused.',
    meta: {
      paused: true,
      serverArtifacts: [{ id: 'paused-draft', filename: 'paused-draft.html', type: 'html', url: '/api/artifacts/paused-draft' }],
      serverDeliveryArtifactIds: ['paused-draft'],
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
    assert.doesNotMatch(rootElement.textContent, /live-draft|source-draft|Synthetic draft|Failed draft|failed-draft|interrupted-draft|paused-draft|old-draft/)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('right workbench lists user attachments with image thumbnails and opens them in the shared preview pane', async () => {
  const dom = setupDom()
  const rootElement = dom.window.document.getElementById('root')
  const root = createRoot(rootElement)
  const opened = []

  try {
    await act(async () => root.render(
      <RightWorkbench
        messages={[{
          id: 'user-with-files',
          role: 'user',
          content: '请查看附件',
          attachments: [{
            id: 'attachment-photo',
            name: '现场照片.JFIF',
            mimeType: 'image/jpeg',
            downloadUrl: '/api/attachments/attachment-photo/content',
          }, {
            id: 'attachment-audio',
            name: '访谈.opus',
            mimeType: 'audio/ogg',
            downloadUrl: '/api/attachments/attachment-audio/content',
          }],
        }]}
        activeTab="files"
        onTabChange={() => {}}
        onClose={() => {}}
        onOpenArtifact={(artifact) => opened.push(artifact)}
        onSendMessage={() => {}}
        isGenerating={false}
      />,
    ))

    assert.equal(rootElement.querySelector('[data-testid="workbench-file-count"]').textContent, '2')
    const links = [...rootElement.querySelectorAll('[data-testid="workbench-file-open"]')]
    assert.deepEqual(links.map((link) => link.textContent.trim()).map((value) => value.replace(/\s+/g, ' ')), [
      '访谈.opusaudio/ogg',
      '现场照片.JFIFimage/jpeg',
    ])
    const thumbnail = rootElement.querySelector('img[src*="attachment-photo"]')
    assert.ok(thumbnail)
    assert.match(thumbnail.getAttribute('src'), /preview=1/)

    const photoLink = links.find((link) => link.textContent.includes('现场照片.JFIF'))
    await act(async () => photoLink.dispatchEvent(new dom.window.MouseEvent('click', {
      bubbles: true,
      cancelable: true,
    })))
    assert.equal(opened.length, 1)
    assert.equal(opened[0].directFile.id, 'attachment-photo')
    assert.equal(opened[0].directFile.mimeType, 'image/jpeg')
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('right workbench prefers a verified formal local file over its managed preview artifact', async () => {
  const dom = setupDom()
  const rootElement = dom.window.document.getElementById('root')
  const root = createRoot(rootElement)
  const opened = []
  const turnId = 'formal-workbench-turn'
  const filePath = 'E:\\果\\gallery.html'

  try {
    await act(async () => root.render(
      <RightWorkbench
        messages={[{
          id: `${turnId}:assistant`,
          role: 'assistant',
          content: `已完成：${filePath}`,
          meta: {
            serverTurnId: turnId,
            serverArtifacts: [{
              id: 'managed-gallery',
              filename: 'gallery.html',
              type: 'html',
              url: '/api/artifacts/managed-gallery',
            }],
            serverDeliveryArtifactIds: ['managed-gallery'],
            verifiedLocalFiles: [{
              id: 'formal-gallery-receipt',
              path: filePath,
              filename: 'gallery.html',
              size: 2048,
              relatedArtifactIds: ['managed-gallery'],
            }],
          },
        }]}
        activeTab="files"
        onTabChange={() => {}}
        onClose={() => {}}
        onOpenArtifact={(artifact) => opened.push(artifact)}
        onSendMessage={() => {}}
        isGenerating={false}
      />,
    ))

    const links = [...rootElement.querySelectorAll('[data-testid="workbench-file-open"]')]
    assert.equal(links.length, 1)
    assert.match(links[0].getAttribute('href'), /\/api\/local-files\/verified\/formal-gallery-receipt/)
    assert.doesNotMatch(links[0].getAttribute('href'), /\/api\/artifacts\//)
    await act(async () => links[0].dispatchEvent(new dom.window.MouseEvent('click', {
      bubbles: true,
      cancelable: true,
    })))
    assert.equal(opened.length, 1)
    assert.equal(opened[0].directFile.path, filePath)
    assert.equal(opened[0].directFile.type, 'html')
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('right workbench keeps only the latest receipt for the same verified local path', async () => {
  const dom = setupDom()
  const rootElement = dom.window.document.getElementById('root')
  const root = createRoot(rootElement)
  const filePath = 'E:\\果\\gallery.html'
  const messageFor = ({ turnId, receiptId, size }) => ({
    id: `${turnId}:assistant`,
    role: 'assistant',
    content: `已完成：${filePath}`,
    meta: {
      serverTurnId: turnId,
      serverDeliveryArtifactIds: [],
      verifiedLocalFiles: [{
        id: receiptId,
        path: filePath,
        filename: 'gallery.html',
        size,
      }],
    },
  })

  try {
    await act(async () => root.render(
      <RightWorkbench
        messages={[
          messageFor({ turnId: 'gallery-first-turn', receiptId: 'gallery-first-receipt', size: 1024 }),
          messageFor({ turnId: 'gallery-latest-turn', receiptId: 'gallery-latest-receipt', size: 2048 }),
        ]}
        activeTab="files"
        onTabChange={() => {}}
        onClose={() => {}}
        onOpenArtifact={() => {}}
        onSendMessage={() => {}}
        isGenerating={false}
      />,
    ))

    const links = [...rootElement.querySelectorAll('[data-testid="workbench-file-open"]')]
    assert.equal(links.length, 1)
    assert.match(links[0].getAttribute('href'), /gallery-latest-receipt/)
    assert.doesNotMatch(links[0].getAttribute('href'), /gallery-first-receipt/)
    assert.equal(rootElement.querySelector('[data-testid="workbench-file-count"]').textContent, '1')
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('right workbench keeps only the latest receipt for the same normalized POSIX path', async () => {
  const dom = setupDom()
  const rootElement = dom.window.document.getElementById('root')
  const root = createRoot(rootElement)
  const messageFor = ({ turnId, receiptId, path }) => ({
    id: `${turnId}:assistant`,
    role: 'assistant',
    content: `Completed: ${path}`,
    meta: {
      serverTurnId: turnId,
      serverDeliveryArtifactIds: [],
      verifiedLocalFiles: [{
        id: receiptId,
        path,
        filename: 'gallery.html',
        size: 2048,
      }],
    },
  })

  try {
    await act(async () => root.render(
      <RightWorkbench
        messages={[
          messageFor({
            turnId: 'posix-first-turn',
            receiptId: 'posix-first-receipt',
            path: '/Users/alice/output/gallery.html',
          }),
          messageFor({
            turnId: 'posix-latest-turn',
            receiptId: 'posix-latest-receipt',
            path: '/Users/alice/output/cache/../gallery.html',
          }),
        ]}
        activeTab="files"
        onTabChange={() => {}}
        onClose={() => {}}
        onOpenArtifact={() => {}}
        onSendMessage={() => {}}
        isGenerating={false}
      />,
    ))

    const links = [...rootElement.querySelectorAll('[data-testid="workbench-file-open"]')]
    assert.equal(links.length, 1)
    assert.match(links[0].getAttribute('href'), /posix-latest-receipt/)
    assert.doesNotMatch(links[0].getAttribute('href'), /posix-first-receipt/)
    assert.equal(rootElement.querySelector('[data-testid="workbench-file-count"]').textContent, '1')
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})
