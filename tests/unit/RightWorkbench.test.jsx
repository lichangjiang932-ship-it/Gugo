import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import RightWorkbench from '../../src/pages/ChatSplit/RightWorkbench.jsx'
import WorkbenchFiles from '../../src/pages/ChatSplit/rightWorkbench/WorkbenchFiles.jsx'
import WorkbenchGit from '../../src/pages/ChatSplit/rightWorkbench/WorkbenchGit.jsx'
import { collectArtifacts } from '../../src/pages/ChatSplit/rightWorkbench/rightWorkbenchArtifacts.js'
import { translateKey } from '../../src/i18n/translations.js'

// Rendered without an I18nProvider, the components in this file fall back to zh,
// so the list is given the same table rather than a different one.
const t = (key, values = {}) => translateKey(key, 'zh').replace(/\{(\w+)\}/g, (_, name) => values[name])

/**
 * The artifact list is the workbench's "workspace files" tool. These tests render
 * the list itself so they can assert what it offers (which artifacts, dedup,
 * thumbnails, verification state) without mounting the whole panel.
 */
function ArtifactList({ attachments = [], messages = [], onOpenArtifact }) {
  return <WorkbenchFiles artifacts={collectArtifacts(messages, attachments)} onOpenArtifact={onOpenArtifact} t={t} />
}

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
  dom.window.HTMLElement.prototype.attachEvent = () => {}
  dom.window.HTMLElement.prototype.detachEvent = () => {}
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

test('the header toolbar offers exactly the three tools and the panel resizes', async () => {
  const dom = setupDom()
  // A stored width proves the panel keeps the reader's chosen size across mounts.
  dom.window.localStorage.setItem('yma:right-workbench-width', '520')
  const rootElement = dom.window.document.getElementById('root')
  const root = createRoot(rootElement)
  const selectedTabs = []

  try {
    await act(async () => {
      root.render(
        <RightWorkbench
          activeTab="files"
          onTabChange={(tab) => selectedTabs.push(tab)}
          onClose={() => {}}
          onOpenArtifact={() => {}}
          onSendMessage={() => {}}
          isGenerating={false}
        />,
      )
    })

    // The vertical edge strip is gone; the top bar follows the reference order.
    assert.equal(rootElement.querySelector('[data-testid="workbench-tool-rail"]'), null)
    const toolbar = rootElement.querySelector('[data-testid="workbench-tool-switch"]')
    assert.ok(toolbar)
    assert.doesNotMatch(toolbar.className, /flex-col/)
    const orderedIds = [
      'workbench-tool-entry', 'workbench-tool-forward', 'workbench-tool-select', 'workbench-tool-refresh',
      'workbench-tool-settings', 'workbench-tool-open-external', 'workbench-tool-expand', 'workbench-close',
    ]
    const shownIds = [...toolbar.querySelectorAll('[data-testid]')]
      .map((node) => node.getAttribute('data-testid'))
      .filter((id) => orderedIds.includes(id))
    assert.deepEqual(shownIds, orderedIds, 'icons appear exactly in the reference order')
    // Selection awaits the Preview runtime; preview controls stay quiet off the browser tab.
    assert.equal(toolbar.querySelector('[data-testid="workbench-tool-select"]').disabled, true)
    assert.equal(toolbar.querySelector('[data-testid="workbench-tool-refresh"]').disabled, true)
    // The tooltip speaks the reader's language like every other label on the bar.
    assert.equal(toolbar.querySelector('[data-testid="workbench-settings-tip"]').textContent, '预览设置')
    // The bar itself only holds those icons, so switching tools lives in the
    // settings menu: all three, each with its own label and shortcut, none lost.
    const menu = toolbar.querySelector('[role="menu"]')
    assert.ok(menu)
    const tools = [...menu.querySelectorAll('[data-tool]')]
    assert.deepEqual(tools.map((node) => node.getAttribute('data-tool')), ['files', 'browser', 'terminal'])
    assert.ok(tools.every((node) => node.parentElement === menu), 'tools are menu entries, not a second bar')
    assert.equal(tools[0].getAttribute('aria-current'), 'page')
    // The label carries its own key, so a tooltip can never promise a shortcut
    // nobody bound.
    assert.equal(tools[0].getAttribute('title'), '工作区文件（Ctrl+Alt+F）')
    assert.equal(tools[1].getAttribute('title'), '浏览器（Ctrl+T）')
    assert.equal(tools[2].getAttribute('title'), '终端（Ctrl+\\）')
    // With no workspace named there is nothing to copy, and the entry says so.
    assert.equal(menu.querySelector('[data-testid="preview-menu-copy-workspace"]').disabled, true)

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
      toolbar.querySelector('[data-testid="workbench-tool-entry"]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
    assert.deepEqual(selectedTabs, ['entry'])
    // A tool in the menu is one press away, and the menu closes behind it.
    const menuDetails = toolbar.querySelector('[data-testid="workbench-tool-settings"]').closest('details')
    menuDetails.open = true
    await act(async () => {
      toolbar.querySelector('[data-tool="browser"]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
    assert.deepEqual(selectedTabs, ['entry', 'browser'])
    assert.equal(menuDetails.open, false)

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
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('the artifact list opens the generated and delivered files it lists', async () => {
  const dom = setupDom()
  const rootElement = dom.window.document.getElementById('root')
  const root = createRoot(rootElement)
  const opened = []

  try {
    await act(async () => {
      root.render(
        <ArtifactList
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
          onOpenArtifact={(artifact) => opened.push(artifact)}
        />,
      )
    })

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
      <ArtifactList
        messages={messages}
        activeTab="files"
        onTabChange={() => {}}
        onClose={() => {}}
        onOpenArtifact={() => {}}
        onSendMessage={() => {}}
        isGenerating
      />,
    ))

    assert.equal(rootElement.querySelectorAll('[data-testid="workbench-file-open"]').length, 1)
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
      <ArtifactList
        attachments={[{
          id: 'attachment-video',
          name: '现场片段.mp4',
          mimeType: 'video/mp4',
          downloadUrl: '/api/attachments/attachment-video/content',
        }]}
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

    assert.equal(rootElement.querySelectorAll('[data-testid="workbench-file-open"]').length, 3)
    const links = [...rootElement.querySelectorAll('[data-testid="workbench-file-open"]')]
    assert.deepEqual(links.map((link) => link.textContent.trim()).map((value) => value.replace(/\s+/g, ' ')), [
      '现场片段.mp4video/mp4',
      '访谈.opusaudio/ogg',
      '现场照片.JFIFimage/jpeg',
    ])
    const thumbnail = rootElement.querySelector('img[src*="attachment-photo"]')
    assert.ok(thumbnail)
    assert.match(thumbnail.getAttribute('src'), /preview=1/)

    const videoLink = links.find((link) => link.textContent.includes('现场片段.mp4'))
    await act(async () => videoLink.dispatchEvent(new dom.window.MouseEvent('click', {
      bubbles: true,
      cancelable: true,
    })))
    assert.equal(opened.length, 1)
    assert.equal(opened[0].directFile.id, 'attachment-video')
    assert.equal(opened[0].directFile.mimeType, 'video/mp4')

    const photoLink = links.find((link) => link.textContent.includes('现场照片.JFIF'))
    await act(async () => photoLink.dispatchEvent(new dom.window.MouseEvent('click', {
      bubbles: true,
      cancelable: true,
    })))
    assert.equal(opened.length, 2)
    assert.equal(opened[1].directFile.id, 'attachment-photo')
    assert.equal(opened[1].directFile.mimeType, 'image/jpeg')
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
      <ArtifactList
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

test('right workbench shows and opens retained files as verification-pending', async () => {
  const dom = setupDom()
  const rootElement = dom.window.document.getElementById('root')
  const root = createRoot(rootElement)
  const opened = []
  const turnId = 'retained-workbench-turn'
  const filePath = 'E:\\output\\partially-updated.html'

  try {
    await act(async () => root.render(
      <ArtifactList
        messages={[{
          id: `${turnId}:assistant`,
          role: 'assistant',
          content: `产物验证未完成，已保留：${filePath}`,
          meta: {
            failed: true,
            serverTurnId: turnId,
            serverDeliveryArtifactIds: [],
            retainedLocalFiles: [{
              id: 'retained-workbench-receipt',
              path: filePath,
              filename: 'partially-updated.html',
              size: 2048,
              retainedAt: 123,
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

    const link = rootElement.querySelector('[data-testid="workbench-file-open"]')
    assert.ok(link)
    assert.match(link.getAttribute('href'), /\/api\/local-files\/retained\/retained-workbench-receipt\?turnId=retained-workbench-turn/)
    await act(async () => link.dispatchEvent(new dom.window.MouseEvent('click', {
      bubbles: true,
      cancelable: true,
    })))
    assert.equal(opened.length, 1)
    assert.equal(opened[0].directFile.path, filePath)
    assert.equal(opened[0].directFile.retainedLocalFile, true)
    assert.equal(opened[0].directFile.verificationPending, true)
    assert.equal(Object.hasOwn(opened[0].directFile, 'verifiedLocalFile'), false)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('right workbench exposes retained receipts from a paused streaming turn', async () => {
  const dom = setupDom()
  const rootElement = dom.window.document.getElementById('root')
  const root = createRoot(rootElement)

  try {
    await act(async () => root.render(
      <ArtifactList
        messages={[{
          id: 'paused-receipt-message',
          role: 'assistant',
          content: 'Paused after writing the draft.',
          meta: {
            streaming: true,
            paused: true,
            serverTurnId: 'paused-receipt-turn',
            serverArtifacts: [{
              id: 'paused-managed-draft',
              filename: 'managed-draft.html',
              url: '/api/artifacts/paused-managed-draft',
            }],
            serverDeliveryArtifactIds: ['paused-managed-draft'],
            retainedLocalFiles: [{
              id: 'paused-retained-receipt',
              path: 'E:\\output\\paused-draft.html',
              filename: 'paused-draft.html',
              retainedAt: 123,
            }],
          },
        }]}
        activeTab="files"
        onTabChange={() => {}}
        onClose={() => {}}
        onOpenArtifact={() => {}}
        onSendMessage={() => {}}
        isGenerating
      />,
    ))

    assert.equal(rootElement.querySelectorAll('[data-testid="workbench-file-open"]').length, 1)
    assert.match(rootElement.textContent, /paused-draft\.html/)
    assert.doesNotMatch(rootElement.textContent, /managed-draft\.html/)
    assert.match(
      rootElement.querySelector('[data-testid="workbench-file-open"]').getAttribute('href'),
      /\/api\/local-files\/retained\/paused-retained-receipt/,
    )
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
      <ArtifactList
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
    assert.equal(rootElement.querySelectorAll('[data-testid="workbench-file-open"]').length, 1)
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
      <ArtifactList
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
    assert.equal(rootElement.querySelectorAll('[data-testid="workbench-file-open"]').length, 1)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('the changes panel reads real git status and diff', async () => {
  const dom = setupDom()
  const rootElement = dom.window.document.getElementById('root')
  const root = createRoot(rootElement)
  const calls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    const target = String(url)
    calls.push(target)
    if (target.includes('/git/status')) {
      return new Response(JSON.stringify({
        ok: true,
        branch: 'feature/git-panel',
        files: [{ status: 'M', path: 'src/app.js' }],
      }), { headers: { 'Content-Type': 'application/json' } })
    }
    return new Response(JSON.stringify({ ok: true, diff: '-const one = 1\n+const one = 2' }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }

  try {
    // The changes tab left the tool rail with the other non-tools, so the panel is
    // exercised directly: what it must keep proving is that it reads real git
    // status and a real diff rather than rendering placeholders.
    await act(async () => { root.render(<WorkbenchGit t={t} />) })
    await act(async () => { await Promise.resolve() })
    const panel = rootElement.querySelector('[data-testid="workbench-git"]')
    assert.ok(panel, 'the changes panel renders')
    assert.deepEqual(calls, ['/api/workbench/git/status'])
    // The label comes from the real translation table, so a missing key would
    // surface here as the raw key rather than a sentence.
    assert.match(panel.textContent, /feature\/git-panel/)
    assert.match(panel.textContent, /变更文件/)

    await act(async () => {
      panel.querySelector('[data-testid="workbench-git-file"]')
        .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
    assert.deepEqual(calls[1], '/api/workbench/git/diff')
    const diff = panel.querySelectorAll('[data-testid="workbench-git-diff"] pre')
    assert.deepEqual([...diff].map((line) => line.textContent), ['-const one = 1', '+const one = 2'])
  } finally {
    globalThis.fetch = originalFetch
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('the toolbar walks back to entry, forward to the tool, grows the panel and copies the path', async () => {
  const dom = setupDom()
  const rootElement = dom.window.document.getElementById('root')
  const root = createRoot(rootElement)
  const tabs = []
  const copied = []
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      ...dom.window.navigator,
      clipboard: { writeText: async (value) => copied.push(value) },
    },
  })
  try {
    await act(async () => {
      root.render(
        <RightWorkbench
          activeTab="files"
          onTabChange={(tab) => tabs.push(tab)}
          onClose={() => {}}
          onOpenArtifact={() => {}}
          onSendMessage={() => {}}
          isGenerating={false}
          selectedWorkspacePath="/wsp/project"
        />,
      )
    })

    const back = rootElement.querySelector('[data-testid="workbench-tool-entry"]')
    const forward = rootElement.querySelector('[data-testid="workbench-tool-forward"]')
    assert.equal(forward.disabled, true, 'no history yet, so forward is greyed like the reference')
    await act(async () => back.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    assert.deepEqual(tabs, ['entry'])
    // The step back is remembered: forward walks straight to the tool again.
    await act(async () => forward.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    assert.deepEqual(tabs, ['entry', 'files'])
    assert.equal(forward.disabled, true, 'history is consumed')

    const panel = rootElement.querySelector('[data-testid="right-workbench"]')
    const readerWidth = panel.style.width
    const expand = rootElement.querySelector('[data-testid="workbench-tool-expand"]')
    await act(async () => expand.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    assert.equal(panel.style.width, '704px', 'expand grows to the widest allowed panel')
    await act(async () => expand.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    assert.equal(panel.style.width, readerWidth, 'the second click restores the reader own width')

    // The workspace path is still one press away, and it is the real path.
    const copy = rootElement.querySelector('[data-testid="preview-menu-copy-workspace"]')
    assert.equal(copy.disabled, false)
    await act(async () => copy.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    assert.deepEqual(copied, ['/wsp/project'])

    // Preview controls stay disabled until a browser tab is showing.
    assert.equal(rootElement.querySelector('[data-testid="workbench-tool-refresh"]').disabled, true)
    assert.equal(rootElement.querySelector('[data-testid="workbench-tool-open-external"]').disabled, true)
  } finally {
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator)
    else delete globalThis.navigator
    await act(async () => root.unmount())
    dom.window.close()
  }
})
