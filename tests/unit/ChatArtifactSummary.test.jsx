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
            serverArtifacts: [{
              id: 'final-pptx',
              filename: '修复量化交易平台.pptx',
              type: 'pptx',
              url: '/api/artifacts/final-pptx',
            }],
            serverDeliveryArtifactIds: ['final-pptx'],
          },
        }]}
        state={{ permRequest: null }}
        workbenchMessage=""
        selectedModel="test-model"
        onExampleClick={() => {}}
        onEditMessage={() => {}}
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
    assert.ok(rootElement.querySelector('[data-testid="artifact-open-card"]'))
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('generation only hides actions for the streaming assistant and completed messages still copy', async () => {
  const dom = setupDom()
  const rootElement = dom.window.document.getElementById('root')
  const root = createRoot(rootElement)
  const copiedTexts = []
  Object.defineProperty(dom.window.navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (text) => copiedTexts.push(text) },
  })
  const callbacks = {
    onExampleClick: () => {},
    onEditMessage: () => {},
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
      serverArtifacts: [{
        id: 'partial-final',
        filename: 'Partial-preview.html',
        type: 'html',
        url: '/api/artifacts/partial-final',
      }],
      serverDeliveryArtifactIds: ['partial-final'],
    },
  }
  const completedAssistantMessage = {
    id: 'assistant-complete',
    role: 'assistant',
    content: 'A completed answer remains copyable.',
    meta: { type: 'model_reply', streaming: false },
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
        messages={[completedAssistantMessage, userMessage, message]}
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
    assert.equal(rootElement.querySelectorAll('[data-testid="assistant-message-actions"]').length, 1)
    assert.equal(rootElement.querySelectorAll('.chat-message-actions').length, 2)
    const streamingCodeBlock = rootElement.querySelector('.chat-code-block')
    assert.ok(streamingCodeBlock)
    assert.equal(streamingCodeBlock.getElementsByTagName('button').length, 0)
    assert.equal(rootElement.querySelector('[data-testid="artifact-open-card"]'), null)
    const activeCopyButtons = rootElement.querySelectorAll('[data-testid="copy-message"]')
    assert.equal(activeCopyButtons.length, 2)
    await act(async () => {
      activeCopyButtons[0].click()
      activeCopyButtons[1].click()
      await Promise.resolve()
    })
    assert.deepEqual(copiedTexts, [completedAssistantMessage.content, userMessage.content])

    await act(async () => {
      root.render(
        <ChatMessages
          messages={[completedAssistantMessage, userMessage, { ...message, meta: { ...message.meta, streaming: false } }]}
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

    assert.equal(rootElement.querySelectorAll('[data-testid="assistant-message-actions"]').length, 2)
    assert.equal(rootElement.querySelectorAll('.chat-message-actions').length, 3)
    const completedCodeBlock = rootElement.querySelector('.chat-code-block')
    assert.ok(completedCodeBlock)
    assert.equal(completedCodeBlock.getElementsByTagName('button').length, 1)
    assert.ok(rootElement.querySelector('[data-testid="artifact-open-card"]'))
    const userBubble = rootElement.querySelector('[data-testid="user-message-bubble"]')
    assert.ok(userBubble)
    assert.equal(userBubble.querySelector('[data-testid="user-message-time"]'), null)
    assert.equal(userBubble.querySelector('.chat-message-actions'), null)
    assert.ok(userBubble.parentElement.querySelector('[data-testid="user-message-time"]'))
    assert.ok(userBubble.parentElement.querySelector('.chat-message-actions'))
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})
