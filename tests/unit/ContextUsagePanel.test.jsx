import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'

import { I18nProvider, useT } from '../../src/i18n/I18nProvider.jsx'
import ComposerActions from '../../src/pages/ChatSplit/chatComposer/ComposerActions.jsx'
import ContextUsagePanel from '../../src/pages/ChatSplit/chatMessages/ContextUsagePanel.jsx'
import RequestDiagnostics from '../../src/pages/ChatSplit/chatMessages/RequestDiagnostics.jsx'
import { buildPendingContextUsage } from '../../src/lib/contextMeter.js'

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

function DiagnosticsHarness({ usage }) {
  const { t } = useT()
  return <RequestDiagnostics usage={usage} t={t} />
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

test('request diagnostics show public observations and host timing, never raw wire data', async () => {
  const dom = setupDom()
  const root = createRoot(document.getElementById('root'))
  try {
    await act(async () => root.render(<I18nProvider><DiagnosticsHarness usage={{
      modelWireDiagnostics: { version: 1, stage: 'wire', available: true, identityComparable: true,
        prefixComparable: true, prefixChanged: false, toolsChanged: true, toolCount: 12, secret: 'PRIVATE_DIAGNOSTIC' },
      modelTiming: { version: 1, startedAt: 1000, firstProgressAt: 1500, firstPublicAt: 2500 },
    }} /></I18nProvider>))
    const details = document.querySelector('[data-testid="request-diagnostics"]')
    assert.ok(details)
    assert.equal(details.dataset.prefix, 'same')
    assert.equal(details.dataset.tools, 'changed')
    assert.match(details.textContent, /0.5 s/)
    assert.match(details.textContent, /1.5 s/)
    assert.match(details.textContent, /12/)
    assert.doesNotMatch(details.textContent, /PRIVATE_DIAGNOSTIC/)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('the context popover receives keyboard focus and Escape returns it without propagating', async () => {
  const dom = setupDom()
  const root = createRoot(document.getElementById('root'))
  try {
    await act(async () => root.render(<I18nProvider><ComposerHarness contextUsage={{ estimatedTokens: 100, contextWindow: 128000 }} /></I18nProvider>))
    const ring = document.querySelector('[data-testid="context-ring"]')
    ring.focus()
    await act(async () => ring.click())
    const dialog = document.querySelector('[data-testid="context-usage-panel"]')
    assert.equal(document.activeElement === dialog, true)
    let escaped = 0
    const listener = () => { escaped += 1 }
    dom.window.addEventListener('keydown', listener)
    await act(async () => dialog.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    dom.window.removeEventListener('keydown', listener)
    assert.equal(document.querySelector('[data-testid="context-usage-panel"]'), null)
    assert.equal(document.activeElement === ring, true)
    assert.equal(escaped, 0)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

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
    assert.ok(document.querySelector('[data-testid="context-usage-panel"]'))
    const text = document.body.textContent
    assert.match(text, /上下文已用/)
    assert.doesNotMatch(text, /会话累计 Token|详情/)
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

test('context panel keeps historical measured input separate from pending occupancy', async () => {
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
    assert.match(document.body.textContent, /0\.1%/)
    assert.match(document.body.textContent, /~1K \/ 1M/)
    assert.doesNotMatch(document.body.textContent, /331K/)
    assert.equal(document.querySelector('[data-testid=context-last-request]'), null)
    assert.equal(document.querySelector('[data-testid="context-usage-panel"]')?.getAttribute('role'), 'dialog')
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
    assert.match(document.body.textContent, /~5K \/ 128K/)
    assert.equal(document.querySelector('[data-testid=context-last-request]'), null)
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
    const ring = document.querySelector('[data-testid="context-ring"]')
    assert.match(ring?.getAttribute('aria-label') || '', /3\.9% · ~5,000 tokens · \/ 128,000 tokens/)

    await act(async () => ring.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    assert.match(document.body.textContent, /~5K \/ 128K/)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('an estimated model window shows its percentage without a visible approximation badge', async () => {
  const dom = setupDom()
  const rootElement = dom.window.document.getElementById('root')
  const root = createRoot(rootElement)
  const contextUsage = {
    actualPromptTokens: null,
    estimatedTokens: 22917,
    contextWindow: 128000,
    contextWindowAuthoritative: false,
    contextWindowEstimated: true,
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
    const ring = document.querySelector('[data-testid="context-ring"]')
    assert.match(ring?.getAttribute('aria-label'), /18% · ~22,917 tokens · \/ 128,000 tokens · 估算窗口/)
    assert.equal(document.querySelector('[data-testid="context-ring-estimated"]'), null)
    assert.equal(document.querySelector('[data-testid="context-ring-arc"]')?.getAttribute('stroke-width'), '1.5')

    await act(async () => ring.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    assert.match(document.body.textContent, /~22\.9K \/ 128K/)
    assert.match(document.body.textContent, /18%/)
    assert.doesNotMatch(document.body.textContent, /≈|详情/)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('an unresolved window stays unknown instead of borrowing the 128k fallback', async () => {
  const dom = setupDom()
  const rootElement = dom.window.document.getElementById('root')
  const root = createRoot(rootElement)
  const contextUsage = {
    actualPromptTokens: null,
    estimatedTokens: 22917,
    contextWindow: 128000,
    contextWindowKnown: false,
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
    const ring = document.querySelector('[data-testid="context-ring"]')
    assert.match(ring?.getAttribute('aria-label'), /有效窗口未知/)
    assert.equal(document.querySelector('[data-testid="context-ring-arc"]'), null)
    const track = ring?.querySelector('circle')
    assert.equal(track?.getAttribute('stroke-dasharray'), null, 'the unknown state is a continuous circle, not dots')
    await act(async () => ring.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    assert.match(document.body.textContent, /有效窗口未知/)
    assert.doesNotMatch(document.body.textContent, /128K|详情/)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('correlated retained context avoids recounting uncompressed UI history', async () => {
  const dom = setupDom()
  const rootElement = dom.window.document.getElementById('root')
  const root = createRoot(rootElement)
  const localUsage = {
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
  const contextUsage = buildPendingContextUsage({ messages: [], estimate: () => localUsage, selectedModel: 'm', selectedModelProviderId: 'p', contextWindow: 128000, contextWindowAuthoritative: true, allowServerBaseline: true,
    observation: { version: 1, stage: 'retained', requestId: 'r', physicalAttempt: 1, modelName: 'm', providerId: 'p', configuredModelName: 'm', configuredProviderId: 'p', configRevision: null, contextWindow: 128000, inputEstimatedTokens: 16000, inputTokens: null, retainedEstimatedTokens: 16000 } })
  try {
    await act(async () => root.render(
      <I18nProvider>
        <ComposerHarness contextUsage={contextUsage} />
      </I18nProvider>,
    ))
    const ring = document.querySelector('[data-testid="context-ring"]')
    assert.match(ring?.getAttribute('aria-label') || '', /13% · ~16,000 tokens · \/ 128,000 tokens/)

    await act(async () => ring.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    assert.match(document.body.textContent, /~16K \/ 128K/)
    assert.doesNotMatch(document.body.textContent, /~96K \/ 128K/)
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
    const ring = document.querySelector('[data-testid="context-ring"]')
    assert.ok(ring)
    assert.match(ring.getAttribute('aria-label') || '', /0\.1% · ~1,000 tokens · \/ 1,000,000 tokens/)
    assert.equal(document.querySelector('[data-testid="context-usage-popover"]'), null)

    await act(async () => ring.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    const popover = document.querySelector('[data-testid="context-usage-popover"]')
    assert.ok(popover)
    const layer = popover.closest('[data-host-popover]')
    assert.equal(layer.parentElement === document.body, true)
    assert.equal(layer.style.position, 'fixed')
    assert.ok(parseFloat(layer.style.width) <= window.innerWidth - 24)
    const panel = document.querySelector('[data-testid="context-usage-panel"]')
    assert.equal(panel?.getAttribute('data-density'), 'compact')
    assert.match(panel?.className || '', /py-2\.5/)
    assert.equal(document.querySelector('[data-testid="context-usage-details"]'), null)
    assert.equal(panel?.querySelector('details'), null)
    const usageRows = [...document.querySelectorAll('[data-testid="context-usage-row"]')]
    assert.equal(usageRows.length, 3)
    assert.equal(usageRows.every((row) => row.className.includes('py-0.5')), true)
    assert.equal(ring.getAttribute('aria-expanded'), 'true')

    await act(async () => dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    assert.equal(document.querySelector('[data-testid="context-usage-popover"]'), null)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})
