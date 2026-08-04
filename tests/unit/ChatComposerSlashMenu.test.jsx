import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import ChatComposer from '../../src/pages/ChatSplit/ChatComposer.jsx'

const commands = [
  { name: 'context', description: '显示或隐藏上下文', source: 'core', kind: 'command', hint: '[show|hide|toggle]' },
  { name: 'new', description: '新建聊天', source: 'core', kind: 'command', hint: '[title]' },
  { name: 'slides', description: '制作幻灯片', source: 'core', kind: 'skill', hint: '<prompt>' },
]

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/chat',
  })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.SVGElement = dom.window.SVGElement
  globalThis.MouseEvent = dom.window.MouseEvent
  globalThis.KeyboardEvent = dom.window.KeyboardEvent
  globalThis.localStorage = dom.window.localStorage
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  dom.window.HTMLElement.prototype.attachEvent = () => {}
  dom.window.HTMLElement.prototype.detachEvent = () => {}
  globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0)
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id)
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: dom.window.navigator,
  })
  return dom
}

async function renderComposer(onSelect, handleKeyDown = () => {}) {
  const dom = setupDom()
  const rootElement = dom.window.document.getElementById('root')
  const root = createRoot(rootElement)
  await act(async () => {
    root.render(
      <ChatComposer
        input="/"
        setInput={() => {}}
        onSend={() => {}}
        attachments={[]}
        setAttachments={() => {}}
        voiceState="idle"
        modelPickerOpen={false}
        modelOptions={[]}
        selectedModel=""
        isGenerating={false}
        onAbort={() => {}}
        onFileChange={() => {}}
        onVoiceClick={() => {}}
        onOpenModelPicker={() => {}}
        onCloseModelPicker={() => {}}
        onModelChange={() => {}}
        onManageModels={() => {}}
        approvalMode="normal"
        onApprovalModeChange={() => {}}
        handleKeyDown={handleKeyDown}
        slashCommands={commands}
        onSlashCommandSelect={onSelect}
      />,
    )
  })
  return {
    dom,
    rootElement,
    root,
    cleanup: async () => {
      await act(async () => root.unmount())
      dom.window.close()
    },
  }
}

test('typing slash opens an inline action menu and click selection does not send', async () => {
  const selected = []
  let fallbackKeydowns = 0
  const { dom, rootElement, cleanup } = await renderComposer(
    (entry) => selected.push(entry.name),
    () => { fallbackKeydowns += 1 },
  )
  try {
    const menu = rootElement.querySelector('[data-testid="slash-command-menu"]')
    assert.ok(menu)
    assert.equal(menu.getAttribute('role'), 'listbox')
    assert.equal(menu.querySelectorAll('[role="option"]').length, 3)
    const coreOption = menu.querySelector('[role="option"]')
    const skillOption = [...menu.querySelectorAll('[role="option"]')]
      .find((option) => option.textContent.includes('slides'))
    assert.ok(coreOption.querySelector('svg'))
    assert.equal(skillOption.querySelector('svg'), null)
    assert.match(menu.textContent, /上下文/)
    assert.match(menu.textContent, /显示或隐藏上下文/)
    assert.equal(menu.querySelector('[aria-selected="true"]').textContent.includes('上下文'), true)

    const newCommand = [...menu.querySelectorAll('[role="option"]')]
      .find((option) => option.textContent.includes('新聊天'))
    await act(async () => {
      newCommand.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    assert.deepEqual(selected, ['new'])
    assert.equal(fallbackKeydowns, 0)
    assert.equal(rootElement.querySelector('[data-testid="slash-command-menu"]'), null)
  } finally {
    await cleanup()
  }
})
