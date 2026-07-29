import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import ChatComposer from '../../src/pages/ChatSplit/ChatComposer.jsx'
import { AppProvider } from '../../src/store/AppContext.jsx'

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
  globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0)
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id)
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: dom.window.navigator,
  })
  return dom
}

function composerProps() {
  return {
    input: '',
    setInput: () => {},
    onSend: () => {},
    attachments: [],
    setAttachments: () => {},
    showSlashMenu: false,
    setShowSlashMenu: () => {},
    selectedIndex: 0,
    setSelectedIndex: () => {},
    voiceState: 'idle',
    showContextPanel: false,
    isGenerating: false,
    onAbort: () => {},
    messages: [],
    onFileChange: () => {},
    onVoiceClick: () => {},
    onContextClick: () => {},
    onQuickSkillClick: () => {},
    handleKeyDown: () => {},
    skills: [],
    slashRegistry: null,
  }
}

async function click(dom, element, type = 'click') {
  await act(async () => {
    element.dispatchEvent(new dom.window.MouseEvent(type, {
      bubbles: true,
      cancelable: true,
    }))
    await Promise.resolve()
  })
}

test('chat local-file action opens the panel and all close controls work', async () => {
  const dom = setupDom()
  const originalFetch = globalThis.fetch
  let fetchCount = 0
  globalThis.fetch = async () => {
    fetchCount += 1
    return new Response(JSON.stringify({
      allFilesEnabled: false,
      grants: [],
      workspace: { enabled: false, path: null },
      runtime: { pickerAvailable: false },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const rootElement = dom.window.document.getElementById('root')
  const root = createRoot(rootElement)
  await act(async () => {
    root.render(<AppProvider><ChatComposer {...composerProps()} /></AppProvider>)
  })

  const action = rootElement.querySelector('[data-testid="local-files-chat-action"]')
  assert.ok(action)
  // 「本地文件」比「授权文件」更能让用户意识到「模型能读我电脑上的文件」。
  // 未授权时不显示计数,所以这里就是纯标签。
  assert.equal(action.textContent.trim(), '本地文件')

  try {
    await click(dom, action)
    let dialog = rootElement.querySelector('[role="dialog"][aria-label="本地文件"]')
    assert.ok(dialog)
    assert.ok(fetchCount > 0)

    const closeButton = dialog.querySelector('button[aria-label="取消"]')
    assert.ok(closeButton)
    await click(dom, closeButton)
    assert.equal(rootElement.querySelector('[role="dialog"]'), null)

    await click(dom, action)
    assert.ok(rootElement.querySelector('[role="dialog"]'))
    await act(async () => {
      dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      }))
    })
    assert.equal(rootElement.querySelector('[role="dialog"]'), null)

    await click(dom, action)
    dialog = rootElement.querySelector('[role="dialog"]')
    assert.ok(dialog)
    await click(dom, dialog, 'mousedown')
    assert.equal(rootElement.querySelector('[role="dialog"]'), null)
  } finally {
    globalThis.fetch = originalFetch
    await act(async () => root.unmount())
    dom.window.close()
  }
})
