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

test('composer primary action switches in place from send to stop', async () => {
  const dom = setupDom()
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  let sends = 0
  let stops = 0
  const t = (key) => ({
    'chatComposer.attachment': 'Attach',
    'chatComposer.send': 'Send',
    'chatComposer.stop': 'Stop',
    'chat.modelPicker.unconfiguredSendBlocked': 'Configure a model first',
  })[key] || key
  const renderActions = ({
    isGenerating = false,
    modelReadiness = { kind: 'ready', canSend: true },
    sendDisabled = false,
  } = {}) => (
    <ComposerActions
      approvalMode="normal"
      fileInputRef={{ current: null }}
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
    const stopButton = rootElement.querySelector('[data-testid="composer-primary-action"]')
    assert.equal(stopButton, sendButton)
    assert.equal(stopButton.disabled, false)
    assert.equal(stopButton.getAttribute('aria-label'), 'Stop')
    assert.equal(stopButton.getAttribute('title'), 'Stop')
    assert.ok(stopButton.querySelector('.lucide-square'))
    await act(async () => stopButton.click())
    assert.equal(sends, 1)
    assert.equal(stops, 1)

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
    assert.equal(sends, 2)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})
