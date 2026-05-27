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

async function renderPane(onClose, artifactOverride = artifact) {
  const dom = setupDom()
  const rootEl = dom.window.document.getElementById('root')
  const root = createRoot(rootEl)

  await act(async () => {
    root.render(
      <RightPreviewPane
        artifact={artifactOverride}
        onClose={onClose}
        onMessage={() => {}}
      />,
    )
  })

  return {
    dom,
    rootEl,
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
