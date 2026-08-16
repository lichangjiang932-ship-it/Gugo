import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'

import { I18nProvider, useT } from '../../src/i18n/I18nProvider.jsx'
import ComposerActions from '../../src/pages/ChatSplit/chatComposer/ComposerActions.jsx'
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

function Harness({ contextUsage }) {
  const { t } = useT()
  return <ContextUsagePanel
    contextUsage={contextUsage}
    contextWindow={128000}
    t={t}
  />
}

function ComposerHarness({ contextUsage }) {
  const { t } = useT()
  const fileInputRef = useRef(null)
  const [open, setOpen] = useState(false)
  return <ComposerActions
    approvalMode="normal"
    contextPanelOpen={open}
    contextUsage={contextUsage}
    fileInputRef={fileInputRef}
    isGenerating={false}
    modelOptions={[{ name: 'deepseek-v4', contextWindow: 1000000 }]}
    modelPickerOpen={false}
    onApprovalModeChange={() => {}}
    onCloseModelPicker={() => {}}
    onFileChange={() => {}}
    onManageModels={() => {}}
    onModelChange={() => {}}
    onOpenModelPicker={() => {}}
    onSend={() => {}}
    onToggleContext={() => setOpen((current) => !current)}
    sendDisabled
    selectedModel="deepseek-v4"
    t={t}
  />
}

test('context panel shows compact total plus system, tools, and conversation breakdown', async () => {
  const dom = setupDom()
  const rootElement = dom.window.document.getElementById('root')
  const root = createRoot(rootElement)
  const contextUsage = {
    estimatedTokens: 30000,
    cumulativeTokens: 279000000,
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
        <Harness contextUsage={contextUsage} />
      </I18nProvider>,
    ))
    assert.ok(rootElement.querySelector('[data-testid="context-usage-panel"]'))
    const text = rootElement.textContent
    assert.match(text, /当前有效上下文/)
    assert.match(text, /会话累计 Token/)
    assert.match(text, /279M/)
    assert.match(text, /~30K \/ 128K/)
    assert.match(text, /23%/)
    assert.match(text, /系统提示词/)
    assert.match(text, /工具/)
    assert.match(text, /对话消息/)
    assert.match(text, /~8K/)
    assert.match(text, /~12K/)
    assert.match(text, /~10K/)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('context panel prefers measured prompt tokens and matches the model-circle summary', async () => {
  const dom = setupDom()
  const rootElement = dom.window.document.getElementById('root')
  const root = createRoot(rootElement)
  const contextUsage = { actualPromptTokens: 331000, estimatedTokens: 1000, percent: 1, contextWindow: 1000000, systemTokens: 1500, messageTokens: 262000, toolCallTokens: 2000, attachmentTokens: 0, toolSpecTokens: 4700 }
  try {
    await act(async () => root.render(
      <I18nProvider>
        <Harness contextUsage={contextUsage} />
      </I18nProvider>,
    ))
    assert.match(rootElement.textContent, /33%/)
    assert.match(rootElement.textContent, /331K \/ 1M/)
    assert.doesNotMatch(rootElement.textContent, /~331K \/ 1M/)
    assert.equal(rootElement.querySelector('[data-testid="context-usage-panel"]')?.getAttribute('role'), 'dialog')
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('context panel treats measured zero as real usage', async () => {
  const dom = setupDom()
  const rootElement = dom.window.document.getElementById('root')
  const root = createRoot(rootElement)
  const contextUsage = {
    actualPromptTokens: 0,
    estimatedTokens: 5000,
    contextWindow: 128000,
    systemTokens: 100,
    messageTokens: 200,
    toolCallTokens: 0,
    attachmentTokens: 0,
    toolSpecTokens: 0,
  }
  try {
    await act(async () => root.render(
      <I18nProvider>
        <Harness contextUsage={contextUsage} />
      </I18nProvider>,
    ))
    assert.match(rootElement.textContent, /0 \/ 128K/)
    assert.doesNotMatch(rootElement.textContent, /~5K \/ 128K/)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('context panel and model circle fall back to estimates when measured usage is missing', async () => {
  const dom = setupDom()
  const rootElement = dom.window.document.getElementById('root')
  const root = createRoot(rootElement)
  const contextUsage = {
    actualPromptTokens: null,
    estimatedTokens: 5000,
    percent: 4,
    contextWindow: 128000,
    systemTokens: 100,
    messageTokens: 200,
    toolCallTokens: 0,
    attachmentTokens: 0,
    toolSpecTokens: 0,
  }
  try {
    await act(async () => root.render(
      <I18nProvider>
        <ComposerHarness contextUsage={contextUsage} />
      </I18nProvider>,
    ))
    const ring = rootElement.querySelector('[data-testid="context-ring"]')
    assert.match(ring?.getAttribute('aria-label') || '', /4% · ~5,000 \/ 128,000 tokens/)

    await act(async () => ring.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    assert.match(rootElement.textContent, /~5K \/ 128K/)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('server request estimate wins over uncompressed client history without pretending to be measured', async () => {
  const dom = setupDom()
  const rootElement = dom.window.document.getElementById('root')
  const root = createRoot(rootElement)
  const contextUsage = {
    actualPromptTokens: null,
    serverEstimatedPromptTokens: 16000,
    estimatedTokens: 96000,
    percent: 75,
    contextWindow: 128000,
    systemTokens: 100,
    messageTokens: 90000,
    toolCallTokens: 0,
    attachmentTokens: 0,
    toolSpecTokens: 0,
  }
  try {
    await act(async () => root.render(
      <I18nProvider>
        <ComposerHarness contextUsage={contextUsage} />
      </I18nProvider>,
    ))
    const ring = rootElement.querySelector('[data-testid="context-ring"]')
    assert.match(ring?.getAttribute('aria-label') || '', /13% · ~16,000 \/ 128,000 tokens/)

    await act(async () => ring.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    assert.match(rootElement.textContent, /~16K \/ 128K/)
    assert.doesNotMatch(rootElement.textContent, /~96K \/ 128K/)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('model context circle toggles the usage popover and closes it with Escape', async () => {
  const dom = setupDom()
  const rootElement = dom.window.document.getElementById('root')
  const root = createRoot(rootElement)
  const contextUsage = { actualPromptTokens: 331000, estimatedTokens: 1000, percent: 1, contextWindow: 1000000, systemTokens: 1500, messageTokens: 262000, toolCallTokens: 2000, attachmentTokens: 0, toolSpecTokens: 4700 }
  try {
    await act(async () => root.render(
      <I18nProvider>
        <ComposerHarness contextUsage={contextUsage} />
      </I18nProvider>,
    ))
    const ring = rootElement.querySelector('[data-testid="context-ring"]')
    assert.ok(ring)
    assert.match(ring.getAttribute('aria-label') || '', /33% · 331,000 \/ 1,000,000 tokens/)
    assert.equal(rootElement.querySelector('[data-testid="context-usage-popover"]'), null)

    await act(async () => ring.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    assert.ok(rootElement.querySelector('[data-testid="context-usage-popover"]'))
    assert.equal(ring.getAttribute('aria-expanded'), 'true')

    await act(async () => dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    assert.equal(rootElement.querySelector('[data-testid="context-usage-popover"]'), null)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})
