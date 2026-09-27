import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'

import { I18nProvider } from '../../src/i18n/I18nProvider.jsx'
import RightWorkbench from '../../src/pages/ChatSplit/RightWorkbench.jsx'

/**
 * The workbench console keeps a failure separable from ordinary output, and keeps
 * its transcript bounded. Both are properties of the panel as mounted, not just of
 * the reducer, so they are asserted through the DOM.
 */
function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/#/chat' })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.HTMLInputElement = dom.window.HTMLInputElement
  globalThis.SVGElement = dom.window.SVGElement
  globalThis.Event = dom.window.Event
  globalThis.InputEvent = dom.window.InputEvent
  globalThis.MouseEvent = dom.window.MouseEvent
  globalThis.localStorage = dom.window.localStorage
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
  Object.defineProperty(dom.window, 'innerWidth', { configurable: true, writable: true, value: 1400 })
  return dom
}

// react-dom decides at load whether it can use the real `input` event; it must be
// imported after the jsdom globals exist or every controlled input goes silent.
async function mount(panel) {
  const dom = setupDom()
  const { createRoot } = await import('react-dom/client')
  const rootElement = dom.window.document.getElementById('root')
  const root = createRoot(rootElement)
  await act(async () => { root.render(<I18nProvider>{panel}</I18nProvider>) })
  return { dom, root, rootElement }
}

function setInputValue(dom, input, value) {
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new dom.window.InputEvent('input', { bubbles: true, cancelable: true, data: value, inputType: 'insertText' }))
  input.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
}

test('a failing command keeps its streams apart in the transcript', async (t2) => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({
    ok: false, stdout: 'wrote 3 files', stderr: 'boom: cannot continue', exitCode: 1, error: '命令退出码 1', cwd: 'C:\\ws',
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })

  const { dom, root, rootElement } = await mount(
    <RightWorkbench activeTab="terminal" onClose={() => {}} onTabChange={() => {}} onOpenArtifact={() => {}} onSendMessage={() => {}} isGenerating={false} />,
  )
  t2.after(async () => { await act(async () => root.unmount()); dom.window.close(); globalThis.fetch = originalFetch })

  const inputs = [...rootElement.querySelectorAll('input')]
  const commandInput = inputs.at(-1)
  await act(async () => { setInputValue(dom, commandInput, 'npm run build') })
  await act(async () => {
    commandInput.closest('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

  const entries = [...rootElement.querySelectorAll('[data-testid="workbench-terminal-entry"]')]
  // The command, its output and its failure are three distinguishable pieces —
  // previously they were one string, so a failure read as more output.
  assert.deepEqual(entries.map((node) => node.getAttribute('data-stream')), ['command', 'stdout', 'stderr'])
  assert.match(entries[0].textContent, /> npm run build/u)
  assert.match(entries[1].textContent, /wrote 3 files/u)
  assert.match(entries[2].textContent, /\[stderr\] boom: cannot continue/u)
  // The empty-state hint is replaced by real content rather than sitting alongside it.
  assert.doesNotMatch(rootElement.textContent, /在下方输入命令查看输出/u)
})

test('a command that fails without stderr still reports why', async (t2) => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({
    ok: false, stdout: '', stderr: '', exitCode: 2, error: '命令退出码 2', cwd: 'C:\\ws',
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })

  const { dom, root, rootElement } = await mount(
    <RightWorkbench activeTab="terminal" onClose={() => {}} onTabChange={() => {}} onOpenArtifact={() => {}} onSendMessage={() => {}} isGenerating={false} />,
  )
  t2.after(async () => { await act(async () => root.unmount()); dom.window.close(); globalThis.fetch = originalFetch })

  const commandInput = [...rootElement.querySelectorAll('input')].at(-1)
  await act(async () => { setInputValue(dom, commandInput, 'exit 2') })
  await act(async () => {
    commandInput.closest('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

  const entries = [...rootElement.querySelectorAll('[data-testid="workbench-terminal-entry"]')]
  assert.deepEqual(entries.map((node) => node.getAttribute('data-stream')), ['command', 'error'])
  assert.match(entries[1].textContent, /命令退出码 2/u)
})

test('clearing the console empties the transcript rather than leaving its history', async (t2) => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, stdout: 'hi', stderr: '', cwd: 'C:\\ws' }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  })

  const { dom, root, rootElement } = await mount(
    <RightWorkbench activeTab="terminal" onClose={() => {}} onTabChange={() => {}} onOpenArtifact={() => {}} onSendMessage={() => {}} isGenerating={false} />,
  )
  t2.after(async () => { await act(async () => root.unmount()); dom.window.close(); globalThis.fetch = originalFetch })

  const commandInput = [...rootElement.querySelectorAll('input')].at(-1)
  await act(async () => { setInputValue(dom, commandInput, 'echo hi') })
  await act(async () => {
    commandInput.closest('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  assert.ok(rootElement.querySelectorAll('[data-testid="workbench-terminal-entry"]').length > 0)

  const clear = [...rootElement.querySelectorAll('button')].find((button) => button.getAttribute('aria-label') === '清空终端')
  await act(async () => { clear.click() })
  assert.equal(rootElement.querySelectorAll('[data-testid="workbench-terminal-entry"]').length, 0)
  assert.equal(rootElement.querySelector('[data-testid="workbench-terminal-elided"]'), null)
})
