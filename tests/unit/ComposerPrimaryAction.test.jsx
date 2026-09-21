import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import ComposerActions from '../../src/pages/ChatSplit/chatComposer/ComposerActions.jsx'

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

test('composer primary action sends steering text while keeping stop independently available', async () => {
  const dom = setupDom()
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  let sends = 0
  let stops = 0
  const t = (key) => ({
    'chatComposer.attachment': 'Attach',
    'chatComposer.send': 'Send',
    'chatComposer.stop': 'Stop',
    'chatComposer.pause': 'Pause',
    'chat.modelPicker.unconfiguredSendBlocked': 'Configure a model first',
  })[key] || key
  const renderActions = ({
    hasDraftText = false,
    isGenerating = false,
    modelReadiness = { kind: 'ready', canSend: true },
    sendDisabled = false,
  } = {}) => (
    <ComposerActions
      approvalMode="normal"
      fileInputRef={{ current: null }}
      hasDraftText={hasDraftText}
      isGenerating={isGenerating}
      modelOptions={[{ name: 'local-model' }]}
      modelReadiness={modelReadiness}
      modelPickerOpen={false}
      onAbort={() => { stops += 1 }}
      onApprovalModeChange={() => {}}
      onCloseModelPicker={() => {}}
      onFileChange={() => {}}
      onManageModels={() => {}}
      onModelChange={() => {}}
      onOpenModelPicker={() => {}}
      onSend={() => { sends += 1 }}
      sendDisabled={sendDisabled}
      onVoiceClick={() => {}}
      selectedModel="local-model"
      t={t}
      voiceLabel="Voice"
      voiceState="idle"
    />
  )

  try {
    await act(async () => root.render(renderActions()))
    const sendButton = rootElement.querySelector('[data-testid="composer-primary-action"]')
    const fileInput = rootElement.querySelector('input[type="file"]')
    assert.match(fileInput.accept, /audio\/\*/)
    assert.match(fileInput.accept, /video\/\*/)
    assert.equal(sendButton.getAttribute('aria-label'), 'Send')
    assert.equal(sendButton.getAttribute('title'), 'Send')
    assert.match(sendButton.className, /\bh-8\b/)
    assert.match(sendButton.className, /\bw-8\b/)
    assert.ok(sendButton.querySelector('.lucide-send'))
    await act(async () => sendButton.click())
    assert.equal(sends, 1)
    assert.equal(stops, 0)

    await act(async () => root.render(renderActions({ isGenerating: true, sendDisabled: true })))
    const pauseButton = rootElement.querySelector('[data-testid="composer-primary-action"]')
    assert.equal(pauseButton, sendButton)
    assert.equal(pauseButton.disabled, false)
    // Product change: an empty draft during a running turn offers *pause*, not
    // stop. Same control, same onAbort path, renamed affordance.
    assert.equal(pauseButton.getAttribute('aria-label'), 'Pause')
    assert.equal(pauseButton.getAttribute('title'), 'Pause')
    assert.ok(pauseButton.querySelector('.lucide-pause'))
    await act(async () => pauseButton.click())
    assert.equal(sends, 1)
    assert.equal(stops, 1)
    assert.equal(rootElement.querySelector('[data-testid="composer-stop-action"]'), null)

    // Steering by text keeps the send path. `sendDisabled` is intentionally not
    // set here: when the composer reports send unavailable (e.g. an attachment
    // is still uploading) the send button must be disabled — that rule is
    // covered by ChatComposerFocus, and would make this click a no-op.
    await act(async () => root.render(renderActions({
      hasDraftText: true,
      isGenerating: true,
    })))
    const steerButton = rootElement.querySelector('[data-testid="composer-primary-action"]')
    const independentStopButton = rootElement.querySelector('[data-testid="composer-stop-action"]')
    assert.equal(steerButton, sendButton)
    assert.equal(steerButton.disabled, false)
    assert.equal(steerButton.getAttribute('aria-label'), 'Send')
    assert.equal(steerButton.getAttribute('title'), 'Send')
    assert.ok(steerButton.querySelector('.lucide-send'))
    assert.ok(independentStopButton)
    assert.equal(independentStopButton.getAttribute('aria-label'), 'Stop')
    assert.equal(independentStopButton.getAttribute('title'), 'Stop')
    assert.ok(independentStopButton.querySelector('.lucide-square'))
    await act(async () => steerButton.click())
    assert.equal(sends, 2)
    assert.equal(stops, 1)
    await act(async () => independentStopButton.click())
    assert.equal(sends, 2)
    assert.equal(stops, 2)

    await act(async () => root.render(renderActions({ sendDisabled: true })))
    assert.equal(rootElement.querySelector('[data-testid="composer-primary-action"]'), sendButton)
    assert.equal(sendButton.disabled, true)
    assert.equal(rootElement.querySelectorAll('[data-testid="composer-primary-action"]').length, 1)

    await act(async () => root.render(renderActions({
      modelReadiness: { kind: 'unconfigured', canSend: false },
    })))
    assert.equal(sendButton.disabled, false)
    assert.equal(sendButton.getAttribute('aria-label'), 'Configure a model first')
    assert.equal(sendButton.getAttribute('title'), 'Configure a model first')
    await act(async () => sendButton.click())
    assert.equal(sends, 3)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})
