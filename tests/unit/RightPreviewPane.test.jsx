import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import RightPreviewPane from '../../src/pages/ChatSplit/RightPreviewPane.jsx'

const artifact = {
  messageId: 'msg-1',
  content: '# Preview document',
  preview: {
    type: 'docx',
    title: 'Preview document',
    label: 'DOCX',
    summary: 'Document preview',
    filename: 'preview.docx',
    blocks: [{ type: 'heading', text: 'Preview document' }],
  },
}

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/',
  })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.SVGElement = dom.window.SVGElement
  globalThis.KeyboardEvent = dom.window.KeyboardEvent
  globalThis.MouseEvent = dom.window.MouseEvent
  globalThis.localStorage = dom.window.localStorage
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: dom.window.navigator,
  })
  globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0)
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id)
  return dom
}

async function renderPane(onClose, artifactOverride = artifact, prepareDocument) {
  const dom = setupDom()
  const rootEl = dom.window.document.getElementById('root')
  prepareDocument?.(dom.window.document)
  const root = createRoot(rootEl)

  const renderArtifact = async (nextArtifact) => {
    await act(async () => {
      root.render(
        <RightPreviewPane
          artifact={nextArtifact}
          onClose={onClose}
          onMessage={() => {}}
        />,
      )
    })
  }

  await renderArtifact(artifactOverride)

  return {
    dom,
    rootEl,
    rerender: renderArtifact,
    cleanup: async () => {
      await act(async () => {
        root.unmount()
      })
    },
  }
}

test('RightPreviewPane closes on Escape', async () => {
  let closeCount = 0
  const { dom, cleanup } = await renderPane(() => { closeCount += 1 })

  try {
    await act(async () => {
      dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      }))
    })

    assert.equal(closeCount, 1)
  } finally {
    await cleanup()
  }
})

test('RightPreviewPane reuses one preview slot when the selected artifact changes', async () => {
  let closeCount = 0
  const first = {
    messageId: 'msg-alpha',
    content: 'alpha content',
    preview: { type: 'text', label: 'FILE', filename: 'alpha.txt', summary: 'Alpha' },
  }
  const second = {
    messageId: 'msg-beta',
    content: 'beta content',
    preview: { type: 'text', label: 'FILE', filename: 'beta.txt', summary: 'Beta' },
  }
  const third = {
    messageId: 'msg-gamma',
    content: 'gamma content',
    preview: { type: 'text', label: 'FILE', filename: 'gamma.txt', summary: 'Gamma' },
  }
  const { rootEl, rerender, cleanup } = await renderPane(() => { closeCount += 1 }, first)

  try {
    assert.equal(rootEl.querySelectorAll('.chat-preview-pane').length, 1)
    assert.equal(rootEl.querySelectorAll('[data-testid="preview-header"]').length, 1)
    assert.equal(rootEl.querySelectorAll('[role="tab"]').length, 0)
    assert.equal(rootEl.querySelector('[data-testid="preview-current-file"]')?.textContent.trim(), 'alpha.txt')
    assert.match(rootEl.querySelector('pre')?.textContent || '', /alpha content/)

    await rerender(second)
    await rerender(third)

    assert.equal(rootEl.querySelectorAll('.chat-preview-pane').length, 1)
    assert.equal(rootEl.querySelectorAll('[data-testid="preview-header"]').length, 1)
    assert.equal(rootEl.querySelectorAll('[role="tab"]').length, 0)
    assert.equal(rootEl.querySelector('[data-testid="preview-current-file"]')?.textContent.trim(), 'gamma.txt')
    assert.match(rootEl.querySelector('pre')?.textContent || '', /gamma content/)
    assert.doesNotMatch(rootEl.textContent, /alpha content|beta content/)

    await rerender({ ...second })
    assert.equal(rootEl.querySelectorAll('.chat-preview-pane').length, 1)
    assert.equal(rootEl.querySelector('[data-testid="preview-current-file"]')?.textContent.trim(), 'beta.txt')
    assert.match(rootEl.querySelector('pre')?.textContent || '', /beta content/)
    assert.equal(closeCount, 0)
  } finally {
    await cleanup()
  }
})

test('RightPreviewPane switches the same slot between text and direct image files', async () => {
  const textArtifact = {
    messageId: 'msg-file-tab',
    content: 'notes content',
    preview: { type: 'text', label: 'FILE', filename: 'notes.txt' },
  }
  const imageArtifact = {
    messageId: 'msg-image-tab',
    content: '',
    preview: null,
    directFile: {
      id: 'image-file-1',
      filename: 'page1_check.png',
      type: 'png',
      url: 'https://example.test/page1_check.png',
    },
  }
  const { rootEl, rerender, cleanup } = await renderPane(() => {}, textArtifact)

  try {
    assert.match(rootEl.querySelector('pre')?.textContent || '', /notes content/)
    await rerender(imageArtifact)

    assert.equal(rootEl.querySelectorAll('.chat-preview-pane').length, 1)
    assert.equal(rootEl.querySelectorAll('[role="tab"]').length, 0)
    assert.equal(rootEl.querySelector('[data-testid="preview-current-file"]')?.textContent.trim(), 'page1_check.png')
    const imageUrl = new URL(rootEl.querySelector('img[alt="page1_check.png"]')?.getAttribute('src'))
    assert.equal(imageUrl.origin + imageUrl.pathname, 'https://example.test/page1_check.png')
    assert.equal(imageUrl.searchParams.get('preview'), '1')
    assert.equal(rootEl.querySelector('pre'), null)

    await rerender(textArtifact)
    assert.equal(rootEl.querySelectorAll('.chat-preview-pane').length, 1)
    assert.equal(rootEl.querySelector('[data-testid="preview-current-file"]')?.textContent.trim(), 'notes.txt')
    assert.match(rootEl.querySelector('pre')?.textContent || '', /notes content/)
    assert.equal(rootEl.querySelector('img[alt="page1_check.png"]'), null)
  } finally {
    await cleanup()
  }
})

test('RightPreviewPane restores focus to the opener when the single preview closes', async () => {
  let closeCount = 0
  let opener
  const { dom, rootEl, cleanup } = await renderPane(() => { closeCount += 1 }, artifact, (document) => {
    opener = document.createElement('button')
    opener.textContent = 'Open preview'
    document.body.insertBefore(opener, document.getElementById('root'))
    opener.focus()
  })

  try {
    const closeButton = rootEl.querySelector('[data-testid="preview-close"]')
    assert.ok(closeButton)
    closeButton.focus()
    assert.equal(dom.window.document.activeElement, closeButton)

    await act(async () => {
      closeButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
    })

    assert.equal(closeCount, 1)
    assert.equal(dom.window.document.activeElement, opener)
  } finally {
    await cleanup()
  }
})

test('RightPreviewPane closes when the backdrop is clicked', async () => {
  let closeCount = 0
  const { dom, rootEl, cleanup } = await renderPane(() => { closeCount += 1 })

  try {
    const backdrop = rootEl.querySelector('[data-testid="preview-backdrop"]')
    assert.ok(backdrop)

    await act(async () => {
      backdrop.dispatchEvent(new dom.window.MouseEvent('click', {
        bubbles: true,
        cancelable: true,
      }))
    })

    assert.equal(closeCount, 1)
  } finally {
    await cleanup()
  }
})

test('RightPreviewPane closes from the enlarged X button', async () => {
  let closeCount = 0
  const { dom, rootEl, cleanup } = await renderPane(() => { closeCount += 1 })

  try {
    const closeButton = rootEl.querySelector('button[aria-label="关闭预览"]')
    assert.ok(closeButton)
    assert.match(closeButton.className, /\bw-10\b/)
    assert.match(closeButton.className, /\bh-10\b/)

    await act(async () => {
      closeButton.dispatchEvent(new dom.window.MouseEvent('click', {
        bubbles: true,
        cancelable: true,
      }))
    })

    assert.equal(closeCount, 1)
  } finally {
    await cleanup()
  }
})

test('RightPreviewPane shows a clickable X when preview is unavailable', async () => {
  let closeCount = 0
  const { dom, rootEl, cleanup } = await renderPane(() => { closeCount += 1 }, {
    messageId: 'msg-null',
    content: '# Unsupported artifact',
    preview: null,
  })

  try {
    const closeButton = rootEl.querySelector('button[aria-label="关闭预览"]')
    assert.ok(closeButton)
    assert.equal(closeButton.textContent.trim(), '')

    await act(async () => {
      closeButton.dispatchEvent(new dom.window.MouseEvent('click', {
        bubbles: true,
        cancelable: true,
      }))
    })

    assert.equal(closeCount, 1)
  } finally {
    await cleanup()
  }
})

test('RightPreviewPane renders local text files in the single preview slot', async () => {
  const { rootEl, cleanup } = await renderPane(() => {}, {
    messageId: 'msg-file',
    content: 'alpha\nbeta',
    preview: {
      type: 'text',
      title: 'notes.txt',
      label: 'FILE',
      summary: '2 lines',
      filename: 'notes.txt',
    },
  })

  try {
    assert.match(rootEl.textContent, /notes\.txt/)
    assert.match(rootEl.querySelector('pre')?.textContent || '', /alpha\nbeta/)
  } finally {
    await cleanup()
  }
})

test('RightPreviewPane opens a direct generated file in the right pane', async () => {
  const { rootEl, cleanup } = await renderPane(() => {}, {
    messageId: 'msg-direct-file',
    content: '',
    preview: null,
    directFile: {
      id: 'file-1',
      filename: 'report.docx',
      type: 'docx',
      url: '',
    },
  })

  try {
    assert.ok(rootEl.querySelector('[data-testid="direct-file-pane"]'))
    assert.match(rootEl.textContent, /report\.docx/)
    assert.ok(rootEl.querySelector('[data-testid="direct-file-content"]'))
  } finally {
    await cleanup()
  }
})
