import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import ChatComposer from '../../src/pages/ChatSplit/ChatComposer.jsx'

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body><button id="outside">Outside</button><div id="root"></div></body></html>', {
    url: 'http://localhost/chat',
  })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.SVGElement = dom.window.SVGElement
  globalThis.MouseEvent = dom.window.MouseEvent
  globalThis.localStorage = dom.window.localStorage
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  dom.window.HTMLElement.prototype.attachEvent = () => {}
  dom.window.HTMLElement.prototype.detachEvent = () => {}
  return dom
}

test('composer whitespace focuses the textarea while controls keep their own click behavior', async () => {
  const dom = setupDom()
  const rootElement = document.getElementById('root')
  const outside = document.getElementById('outside')
  const root = createRoot(rootElement)
  let modelPickerOpens = 0
  let sends = 0

  try {
    await act(async () => root.render(
      <ChatComposer
        input=""
        setInput={() => {}}
        onSend={() => { sends += 1 }}
        attachments={[]}
        setAttachments={() => {}}
        voiceState="idle"
        modelPickerOpen={false}
        modelOptions={[]}
        selectedModel="local-model"
        isGenerating={false}
        onAbort={() => {}}
        onFileChange={() => {}}
        onVoiceClick={() => {}}
        onOpenModelPicker={() => { modelPickerOpens += 1 }}
        onCloseModelPicker={() => {}}
        onModelChange={() => {}}
        onManageModels={() => {}}
        approvalMode="normal"
        onApprovalModeChange={() => {}}
        handleKeyDown={() => {}}
      />,
    ))

    const textarea = rootElement.querySelector('textarea')
    const surface = rootElement.querySelector('[data-testid="chat-composer-surface"]')
    const actions = rootElement.querySelector('[data-testid="chat-composer-actions"]')
    const modelPicker = rootElement.querySelector('[data-testid="model-picker-trigger"]')
    const sendButton = rootElement.querySelector('.lucide-send')?.closest('button')

    assert.ok(textarea.placeholder.trim())
    assert.equal(textarea.getAttribute('aria-label'), textarea.placeholder)
    assert.equal(surface.classList.contains('cursor-text'), false)
    for (const className of ['border-neutral-200', 'hover:border-neutral-300', 'focus-within:border-blue-400/60']) {
      assert.ok(surface.classList.contains(className), `composer surface is missing ${className}`)
    }
    assert.ok(surface.classList.contains('shadow-sm'))
    assert.ok(surface.classList.contains('focus-within:shadow-md'))
    assert.ok(textarea.classList.contains('cursor-text'))
    assert.ok(textarea.parentElement.classList.contains('cursor-text'))
    assert.ok(textarea.classList.contains('placeholder:text-ink-soft'))

    outside.focus()
    await act(async () => surface.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    assert.equal(document.activeElement, textarea)
    assert.equal(rootElement.querySelector('#chat-input-history-hint')?.textContent, '↑/↓ 查看历史输入 · Enter 发送 · Shift+Enter 换行')
    assert.equal(textarea.getAttribute('aria-describedby'), 'chat-input-history-hint')
    assert.ok(rootElement.querySelector('#chat-input-history-hint').classList.contains('peer-focus:block'))

    outside.focus()
    await act(async () => actions.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    assert.equal(document.activeElement, textarea)

    outside.focus()
    await act(async () => modelPicker.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    assert.equal(modelPickerOpens, 1)
    assert.notEqual(document.activeElement, textarea)

    outside.focus()
    await act(async () => sendButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    assert.equal(sends, 1)
    assert.notEqual(document.activeElement, textarea)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})
