import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import { I18nProvider, useT } from '../../src/i18n/I18nProvider.jsx'
import ContextUsagePanel from '../../src/pages/ChatSplit/chatMessages/ContextUsagePanel.jsx'

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
  return dom
}

function Harness({ contextUsage, onClose }) {
  const { t } = useT()
  return <ContextUsagePanel
    contextUsage={contextUsage}
    contextWindow={128000}
    messages={[{ id: 'a', role: 'user' }, { id: 'b', role: 'assistant' }]}
    selectedModel="deepseek-v4"
    onClose={onClose}
    t={t}
  />
}

test('context panel reports usage, remaining, system prompt, tools, and messages', async () => {
  const dom = setupDom()
  const rootElement = dom.window.document.getElementById('root')
  const root = createRoot(rootElement)
  const contextUsage = {
    estimatedTokens: 30000,
    percent: 23,
    contextWindow: 128000,
    visibleCharacters: 1200,
    messageTokens: 9000,
    toolCallTokens: 4000,
    attachmentTokens: 1000,
    toolSpecTokens: 8000,
    systemTokens: 8000,
  }
  try {
    await act(async () => root.render(
      <I18nProvider>
        <Harness contextUsage={contextUsage} onClose={() => {}} />
      </I18nProvider>,
    ))
    assert.ok(rootElement.querySelector('[data-testid="context-usage-panel"]'))
    const text = rootElement.textContent
    assert.match(text, /30,000 \/ 128,000/)
    assert.match(text, /23%/)
    assert.match(text, /98,000/) // remaining = 128000 - 30000
    assert.match(text, /系统提示词/)
    assert.match(text, /工具定义/)
    assert.match(text, /对话消息/)
    assert.match(text, /2/)
    assert.match(text, /deepseek-v4/)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('context panel close button calls onClose', async () => {
  const dom = setupDom()
  const rootElement = dom.window.document.getElementById('root')
  const root = createRoot(rootElement)
  let closed = false
  const contextUsage = { estimatedTokens: 1000, percent: 1, contextWindow: 128000, systemTokens: 16, messageTokens: 900, toolCallTokens: 0, attachmentTokens: 0, toolSpecTokens: 0 }
  try {
    await act(async () => root.render(
      <I18nProvider>
        <Harness contextUsage={contextUsage} onClose={() => { closed = true }} />
      </I18nProvider>,
    ))
    const closeButton = [...rootElement.querySelectorAll('button')].find((button) => button.title === '关闭上下文详情')
    assert.ok(closeButton)
    await act(async () => closeButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    assert.equal(closed, true)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})
