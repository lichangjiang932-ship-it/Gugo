import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act, useState } from 'react'
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
    for (const className of ['chat-composer-surface', 'min-h-[108px]', 'rounded-[22px]', 'border']) {
      assert.ok(surface.classList.contains(className), `composer surface is missing ${className}`)
    }
    assert.equal(surface.classList.contains('focus-within:-translate-y-px'), false)
    assert.equal(surface.classList.contains('focus-within:border-blue-400/60'), false)
    assert.ok(textarea.classList.contains('cursor-text'))
    assert.ok(textarea.parentElement.classList.contains('cursor-text'))
    assert.ok(textarea.classList.contains('placeholder:text-ink-soft'))

    outside.focus()
    await act(async () => surface.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    assert.equal(document.activeElement, textarea)
    assert.equal(rootElement.querySelector('#chat-input-history-hint'), null)
    assert.equal(textarea.hasAttribute('aria-describedby'), false)

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

test('composer places compact project selection outside the input upper-left and hides it after selection', async () => {
  const dom = setupDom()
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  const selectedPaths = []

  function Harness() {
    const [selectedWorkspacePath, setSelectedWorkspacePath] = useState('')
    return (
      <ChatComposer
        input=""
        setInput={() => {}}
        onSend={() => {}}
        attachments={[]}
        setAttachments={() => {}}
        modelPickerOpen={false}
        modelOptions={[]}
        selectedModel="local-model"
        isGenerating={false}
        onAbort={() => {}}
        onFileChange={() => {}}
        onOpenModelPicker={() => {}}
        onCloseModelPicker={() => {}}
        onModelChange={() => {}}
        onManageModels={() => {}}
        approvalMode="normal"
        onApprovalModeChange={() => {}}
        handleKeyDown={() => {}}
        recentWorkspaces={[{ path: 'D:\\Work\\alpha', name: 'Alpha', usedAt: 1 }]}
        selectedWorkspacePath={selectedWorkspacePath}
        showWorkspacePicker={!selectedWorkspacePath}
        onSelectWorkspace={async (path) => {
          selectedPaths.push(path)
          setSelectedWorkspacePath(path)
          return { path }
        }}
      />
    )
  }

  try {
    await act(async () => root.render(<Harness />))
    const strip = rootElement.querySelector('[data-testid="chat-composer-project-strip"]')
    const surface = rootElement.querySelector('[data-testid="chat-composer-surface"]')
    assert.ok(strip)
    assert.equal(strip.parentElement, surface.parentElement)
    assert.equal(strip.nextElementSibling, surface)
    assert.equal(surface.contains(strip), false)

    await act(async () => strip.querySelector('[data-testid="workspace-project-trigger"]').click())
    const option = strip.querySelector('[data-testid="workspace-project-option"]')
    assert.ok(option)
    await act(async () => {
      option.click()
      await Promise.resolve()
    })

    assert.deepEqual(selectedPaths, ['D:\\Work\\alpha'])
    assert.equal(rootElement.querySelector('[data-testid="chat-composer-project-strip"]'), null)
    assert.ok(rootElement.querySelector('[data-testid="chat-composer-surface"]'))
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('running composer sends text or attachments and pauses only an empty draft', async () => {
  const dom = setupDom()
  const element = document.getElementById('root')
  const root = createRoot(element)
  let sent = 0
  let paused = 0
  const render = async ({ input = '', attachments = [] } = {}) => act(async () => root.render(
    <ChatComposer
      input={input} attachments={attachments} setInput={() => {}} setAttachments={() => {}}
      onSend={() => { sent += 1 }} onAbort={() => { paused += 1 }}
      isGenerating modelPickerOpen={false} modelOptions={[]} selectedModel="local-model"
      onFileChange={() => {}} onOpenModelPicker={() => {}} onCloseModelPicker={() => {}}
      onModelChange={() => {}} onManageModels={() => {}}
      approvalMode="normal" onApprovalModeChange={() => {}} handleKeyDown={() => {}}
    />,
  ))
  try {
    await render({ attachments: [{ id: 'owned-file', name: 'brief.txt', kind: 'text', uploadStatus: 'ready' }] })
    let primary = element.querySelector('[data-testid="composer-primary-action"]')
    assert.ok(primary.querySelector('.lucide-send'), 'a ready attachment alone is a send, never pause')
    await act(async () => primary.click())
    assert.equal(sent, 1)
    assert.equal(paused, 0)

    for (const uploadStatus of ['uploading', 'error']) {
      await render({ attachments: [{ id: 'pending-file', name: 'brief.txt', kind: 'file', uploadStatus }] })
      primary = element.querySelector('[data-testid="composer-primary-action"]')
      assert.ok(primary.querySelector('.lucide-send'), 'a pending attachment must not turn send into pause')
      assert.equal(primary.disabled, true, 'unavailable attachments cannot be sent as steering')
      await act(async () => primary.click())
    }
    assert.equal(sent, 1)
    assert.equal(paused, 0)

    await render({ input: 'Correct the current task' })
    primary = element.querySelector('[data-testid="composer-primary-action"]')
    assert.ok(primary.querySelector('.lucide-send'))
    await act(async () => primary.click())
    assert.equal(sent, 2)

    await render({ input: '  ' })
    primary = element.querySelector('[data-testid="composer-primary-action"]')
    assert.ok(primary.querySelector('.lucide-pause'))
    assert.match(primary.getAttribute('aria-label'), /暂停|Pause/u)
    await act(async () => primary.click())
    assert.equal(paused, 1)
    assert.equal(sent, 2)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})
