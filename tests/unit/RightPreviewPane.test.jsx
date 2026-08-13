import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import RightPreviewPane from '../../src/pages/ChatSplit/RightPreviewPane.jsx'
import { previewArtifactTabId } from '../../src/pages/ChatSplit/preview/previewTabs.js'

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

test('RightPreviewPane keeps multiple closable tabs and selects an adjacent tab on close', async () => {
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
  const { dom, rootEl, rerender, cleanup } = await renderPane(() => { closeCount += 1 }, first)
  const findTab = (filename) => [...rootEl.querySelectorAll('[role="tab"]')]
    .find((button) => button.textContent.includes(filename))
  const findClose = (filename) => [...rootEl.querySelectorAll('[data-testid="preview-tab-item"]')]
    .find((item) => item.querySelector('[role="tab"]')?.textContent.includes(filename))
    ?.querySelector('[data-testid="preview-tab-close"]')
  const click = async (element) => {
    assert.ok(element)
    await act(async () => {
      element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
    })
  }

  try {
    await rerender(second)
    await rerender(third)

    assert.equal(rootEl.querySelectorAll('[role="tab"]').length, 3)
    assert.equal(rootEl.querySelectorAll('[data-testid="preview-tab-close"]').length, 3)
    assert.equal(findTab('gamma.txt')?.getAttribute('aria-selected'), 'true')
    assert.equal(findTab('gamma.txt')?.tabIndex, 0)
    assert.equal(findTab('beta.txt')?.tabIndex, -1)
    assert.match(rootEl.querySelector('pre')?.textContent || '', /gamma content/)

    const endEvent = new dom.window.KeyboardEvent('keydown', {
      key: 'End',
      bubbles: true,
      cancelable: true,
    })
    await act(async () => {
      findTab('gamma.txt').dispatchEvent(endEvent)
    })
    assert.equal(endEvent.defaultPrevented, true)
    assert.equal(findTab('gamma.txt')?.getAttribute('aria-selected'), 'true')

    await act(async () => {
      findTab('gamma.txt').dispatchEvent(new dom.window.KeyboardEvent('keydown', {
        key: 'ArrowLeft',
        bubbles: true,
        cancelable: true,
      }))
    })
    assert.equal(findTab('beta.txt')?.getAttribute('aria-selected'), 'true')
    assert.equal(dom.window.document.activeElement, findTab('beta.txt'))
    assert.match(rootEl.querySelector('pre')?.textContent || '', /beta content/)

    await rerender({ ...second })
    assert.equal(rootEl.querySelectorAll('[role="tab"]').length, 3, 'reopening a file reuses its tab')
    assert.equal(findTab('beta.txt')?.getAttribute('aria-selected'), 'true')
    assert.match(rootEl.querySelector('pre')?.textContent || '', /beta content/)

    await click(findClose('beta.txt'))
    assert.equal(rootEl.querySelectorAll('[role="tab"]').length, 2)
    assert.equal(findTab('gamma.txt')?.getAttribute('aria-selected'), 'true', 'closing the middle tab selects its right neighbor')
    assert.equal(dom.window.document.activeElement, findTab('gamma.txt'), 'the selected neighbor receives focus')

    await click(findClose('gamma.txt'))
    assert.equal(rootEl.querySelectorAll('[role="tab"]').length, 1)
    assert.equal(findTab('alpha.txt')?.getAttribute('aria-selected'), 'true', 'closing the last tab selects its left neighbor')
    assert.equal(dom.window.document.activeElement, findTab('alpha.txt'), 'the remaining tab receives focus')
    assert.match(rootEl.querySelector('pre')?.textContent || '', /alpha content/)

    await click(findClose('alpha.txt'))
    assert.equal(closeCount, 1)
    assert.equal(rootEl.querySelectorAll('[role="tab"]').length, 0)
  } finally {
    await cleanup()
  }
})

test('RightPreviewPane keeps file and image previews in separate closable tabs', async () => {
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
  const { dom, rootEl, rerender, cleanup } = await renderPane(() => {}, textArtifact)
  const findTab = (filename) => [...rootEl.querySelectorAll('[role="tab"]')]
    .find((button) => button.textContent.includes(filename))

  try {
    await rerender(imageArtifact)

    assert.equal(rootEl.querySelectorAll('[role="tab"]').length, 2)
    assert.equal(rootEl.querySelectorAll('[data-testid="preview-tab-close"]').length, 2)
    assert.equal(findTab('page1_check.png')?.getAttribute('aria-selected'), 'true')
    const imageUrl = new URL(rootEl.querySelector('img[alt="page1_check.png"]')?.getAttribute('src'))
    assert.equal(imageUrl.origin + imageUrl.pathname, 'https://example.test/page1_check.png')
    assert.equal(imageUrl.searchParams.get('preview'), '1')

    await act(async () => {
      findTab('notes.txt').dispatchEvent(new dom.window.MouseEvent('click', {
        bubbles: true,
        cancelable: true,
      }))
    })

    assert.equal(findTab('notes.txt')?.getAttribute('aria-selected'), 'true')
    assert.match(rootEl.querySelector('pre')?.textContent || '', /notes content/)

    const imageClose = [...rootEl.querySelectorAll('[data-testid="preview-tab-item"]')]
      .find((item) => item.querySelector('[role="tab"]')?.textContent.includes('page1_check.png'))
      ?.querySelector('[data-testid="preview-tab-close"]')
    assert.ok(imageClose)
    imageClose.focus()
    await act(async () => {
      imageClose.dispatchEvent(new dom.window.MouseEvent('click', {
        bubbles: true,
        cancelable: true,
      }))
    })

    assert.equal(rootEl.querySelectorAll('[role="tab"]').length, 1)
    assert.equal(dom.window.document.activeElement, findTab('notes.txt'))
  } finally {
    await cleanup()
  }
})

test('RightPreviewPane restores focus to the opener after the final tab closes', async () => {
  let closeCount = 0
  let opener
  const { dom, rootEl, cleanup } = await renderPane(() => { closeCount += 1 }, artifact, (document) => {
    opener = document.createElement('button')
    opener.textContent = 'Open preview'
    document.body.insertBefore(opener, document.getElementById('root'))
    opener.focus()
  })

  try {
    const closeButton = rootEl.querySelector('[data-testid="preview-tab-close"]')
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

test('preview tab identity distinguishes same-name artifacts while reusing stable matches', () => {
  const directBase = {
    messageId: 'msg-direct',
    directFile: { filename: 'report.pdf', type: 'pdf' },
  }
  assert.notEqual(
    previewArtifactTabId({ ...directBase, directFile: { ...directBase.directFile, path: 'C:/one/report.pdf' } }),
    previewArtifactTabId({ ...directBase, directFile: { ...directBase.directFile, path: 'C:/two/report.pdf' } }),
  )

  const previewBase = {
    messageId: 'msg-preview',
    preview: { filename: 'notes.txt', type: 'text' },
  }
  const first = previewArtifactTabId({ ...previewBase, content: 'alpha', source: 'workspace-a' })
  const same = previewArtifactTabId({ ...previewBase, content: 'alpha', source: 'workspace-a' })
  const changedContent = previewArtifactTabId({ ...previewBase, content: 'beta', source: 'workspace-a' })
  const changedSource = previewArtifactTabId({ ...previewBase, content: 'alpha', source: 'workspace-b' })

  assert.equal(first, same)
  assert.notEqual(first, changedContent)
  assert.notEqual(first, changedSource)
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

test('RightPreviewPane renders local text files in the preview tab', async () => {
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
