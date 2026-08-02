import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import ChatMessages from '../../src/pages/ChatSplit/ChatMessages.jsx'

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/',
  })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.SVGElement = dom.window.SVGElement
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

test('tool artifact renders final explanation and file card together', async () => {
  const dom = setupDom()
  const rootElement = dom.window.document.getElementById('root')
  const root = createRoot(rootElement)
  const artifactSource = '# 修复量化交易平台\n\n---\n\n## 验证\n- 刷新正常\n- 定时器已清理'

  await act(async () => {
    root.render(
      <ChatMessages
        messages={[{
          id: 'assistant-1',
          role: 'assistant',
          content: '已修复页面刷新、定时器清理和数据加载问题，相关验证已通过。',
          meta: {
            type: 'model_reply',
            modelName: 'test-model',
            artifactType: 'pptx',
            artifactTitle: '修复量化交易平台',
            artifactSource,
          },
        }]}
        state={{ permRequest: null }}
        workbenchMessage=""
        showContextPanel={false}
        setShowContextPanel={() => {}}
        selectedModel="test-model"
        onExampleClick={() => {}}
        onEditMessage={() => {}}
        onRegenerateMessage={() => {}}
        onDeleteMessage={() => {}}
        onPermAllow={() => {}}
        onPermDeny={() => {}}
        onNavigatePermissions={() => {}}
        onOpenInPreview={() => {}}
        onExpandCompaction={() => {}}
        onQuoteSelection={() => {}}
      />,
    )
  })

  try {
    assert.match(rootElement.textContent, /已修复页面刷新、定时器清理和数据加载问题/)
    assert.match(rootElement.textContent, /修复量化交易平台\.pptx/)
    assert.match(rootElement.textContent, /上下文（估算）/)
  assert.match(rootElement.textContent, /1,000,000/)
    assert.ok(rootElement.querySelector('button[title="在右侧预览面板打开"]'))
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('streaming assistant does not render completed result actions', async () => {
  const dom = setupDom()
  const rootElement = dom.window.document.getElementById('root')
  const root = createRoot(rootElement)
  const callbacks = {
    onExampleClick: () => {},
    onEditMessage: () => {},
    onRegenerateMessage: () => {},
    onDeleteMessage: () => {},
    onPermAllow: () => {},
    onPermDeny: () => {},
    onNavigatePermissions: () => {},
    onOpenInPreview: () => {},
    onExpandCompaction: () => {},
    onQuoteSelection: () => {},
  }
  const message = {
    id: 'assistant-streaming',
    role: 'assistant',
    content: '```js\nconst partial = true\n```',
    meta: {
      type: 'model_reply',
      streaming: true,
      artifactType: 'html',
      artifactTitle: 'Partial preview',
      artifactSource: '<!doctype html><html><body>partial</body></html>',
    },
  }
  const userMessage = {
    id: 'user-before-stream',
    role: 'user',
    content: 'Keep the stream intact',
    meta: {},
  }

  await act(async () => {
    root.render(
      <ChatMessages
        messages={[userMessage, message]}
        state={{ permRequest: null }}
        workbenchMessage=""
        showContextUsage={false}
        showContextPanel={false}
        setShowContextPanel={() => {}}
        selectedModel="test-model"
        isGenerating
        {...callbacks}
      />,
    )
  })

  try {
    assert.equal(rootElement.querySelector('[data-testid="assistant-message-actions"]'), null)
    assert.equal(rootElement.querySelector('.chat-message-actions'), null)
    assert.equal(rootElement.querySelector('.chat-code-block button'), null)
    assert.equal(rootElement.querySelector('[data-testid="artifact-open-card"]'), null)

    await act(async () => {
      root.render(
        <ChatMessages
          messages={[userMessage, { ...message, meta: { ...message.meta, streaming: false } }]}
          state={{ permRequest: null }}
          workbenchMessage=""
          showContextUsage={false}
          showContextPanel={false}
          setShowContextPanel={() => {}}
          selectedModel="test-model"
          isGenerating={false}
          {...callbacks}
        />,
      )
    })

    assert.ok(rootElement.querySelector('[data-testid="assistant-message-actions"]'))
    assert.ok(rootElement.querySelector('.chat-message-actions'))
    assert.ok(rootElement.querySelector('.chat-code-block button'))
    assert.ok(rootElement.querySelector('[data-testid="artifact-open-card"]'))
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})
