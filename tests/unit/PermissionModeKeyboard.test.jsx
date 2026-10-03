import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM, VirtualConsole } from 'jsdom'
import { act } from 'react'
import PermissionModeSwitcher from '../../src/components/PermissionModeSwitcher.jsx'
import { I18nProvider } from '../../src/i18n/I18nProvider.jsx'

async function harness(context, { disabled = false, mode = 'normal' } = {}) {
  const domErrors = []
  const virtualConsole = new VirtualConsole()
  virtualConsole.on('jsdomError', (error) => domErrors.push(error))
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/',
    virtualConsole,
  })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  // React DOM detects input/focus support when the module initializes. Loading
  // it before a document exists selects an obsolete attachEvent polyfill.
  const { createRoot } = await import('react-dom/client')
  const changes = []
  const root = createRoot(document.getElementById('root'))
  await act(async () => root.render(<I18nProvider>
    <aside><button data-sidebar>History</button></aside>
    <div role="dialog"><button data-dialog>Close</button></div>
    <textarea data-editor />
    <div className="chat-composer">
      <textarea className="chat-composer-input" />
      <button data-attachment>Attach</button>
      <PermissionModeSwitcher mode={mode} disabled={disabled} onChange={(value) => changes.push(value)} />
    </div>
    <div className="chat-composer"><textarea className="chat-composer-input" data-other-composer /></div>
  </I18nProvider>))
  context.after(async () => {
    await act(async () => root.unmount())
    dom.window.close()
    assert.deepEqual(domErrors, [], 'real focus/keyboard interactions must not throw hidden DOM errors')
  })
  async function press(target, options = {}, consumed = false) {
    target.focus()
    assert.strictEqual(dom.window.document.activeElement, target, 'exercise real focus, not a stubbed focus call')
    const event = new dom.window.KeyboardEvent('keydown', {
      bubbles: true, cancelable: true, key: 'Tab', shiftKey: true, ...options,
    })
    if (consumed) event.preventDefault()
    await act(async () => target.dispatchEvent(event))
    return event
  }
  return { changes, press, input: document.querySelector('.chat-composer-input') }
}

test('permission shortcut leaves sidebar, dialogs, controls and unrelated editors to native focus navigation', async (context) => {
  const { changes, press } = await harness(context)
  for (const selector of ['[data-sidebar]', '[data-dialog]', '[data-editor]', '[data-attachment]', '[data-other-composer]']) {
    const event = await press(document.querySelector(selector))
    assert.equal(event.defaultPrevented, false, selector)
    assert.deepEqual(changes, [], selector)
  }
})

test('Shift+Tab cycles permission only from its own focused chat input', async (context) => {
  const { changes, press, input } = await harness(context)
  const event = await press(input)
  assert.equal(event.defaultPrevented, true)
  assert.deepEqual(changes, ['acceptEdits'])
})

test('permission shortcut ignores composing, repeated, modified and already handled events', async (context) => {
  const { changes, press, input } = await harness(context)
  for (const options of [
    { shiftKey: false }, { ctrlKey: true }, { altKey: true }, { metaKey: true },
    { isComposing: true }, { keyCode: 229 }, { which: 229 }, { repeat: true },
  ]) {
    const event = await press(input, options)
    assert.equal(event.defaultPrevented, false)
    assert.deepEqual(changes, [])
  }
  await press(input, {}, true)
  assert.deepEqual(changes, [])
})

test('inert composer and disabled generation state cannot change permissions', async (context) => {
  const { changes, press, input } = await harness(context)
  input.parentElement.setAttribute('inert', '')
  await press(input)
  assert.deepEqual(changes, [])
})

test('disabled mode switcher never handles the composer shortcut', async (context) => {
  const { changes, press, input } = await harness(context, { disabled: true })
  const event = await press(input)
  assert.equal(event.defaultPrevented, false)
  assert.deepEqual(changes, [])
})
