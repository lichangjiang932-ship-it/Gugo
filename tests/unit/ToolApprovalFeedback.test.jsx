import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'

// react-dom/client is loaded after the DOM exists: loaded first, React picks an
// input-event shim under which controlled textareas never fire onChange.
function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' })
  for (const key of ['window', 'document']) globalThis[key] = key === 'window' ? dom.window : dom.window.document
  for (const key of ['HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'SVGElement', 'Event', 'InputEvent',
    'KeyboardEvent', 'MouseEvent']) globalThis[key] = dom.window[key]
  globalThis.localStorage = dom.window.localStorage
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
  return dom
}

test('a refusal can carry a note telling the agent what to do instead', async (context) => {
  const dom = setupDom()
  const [{ act }, { createRoot }, { default: ToolApprovalCard }, { I18nProvider }] = await Promise.all([
    import('react'), import('react-dom/client'),
    import('../../src/components/ToolApprovalCard.jsx'), import('../../src/i18n/I18nProvider.jsx'),
  ])
  const decisions = []
  const root = createRoot(dom.window.document.getElementById('root'))
  context.after(async () => { await act(async () => root.unmount()); dom.window.close() })
  await act(async () => {
    root.render(<I18nProvider><ToolApprovalCard open busy={false} onDecide={(decision) => decisions.push(decision)}
      request={{ name: 'write_file', args: { path: 'demo.txt', content: 'x' }, risk: 'medium', reason: '写入文件' }} /></I18nProvider>)
  })
  const doc = dom.window.document
  await act(async () => { doc.querySelector('[data-testid="tool-approval-suggest"]').click() })
  const box = doc.querySelector('[data-testid="tool-approval-feedback"] textarea')
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value').set
  await act(async () => {
    setter.call(box, 'Write it to notes/demo.txt instead')
    box.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
  await act(async () => {
    box.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  })
  assert.deepEqual(decisions, [{ approved: false, feedback: 'Write it to notes/demo.txt instead' }])
})

test('busy feedback and composition Escape cannot submit or collapse a pending decision', async context => {
  const d = setupDom()
  const [{ act }, { createRoot }, { default: Card }, { I18nProvider }] = await Promise.all([
    import('react'), import('react-dom/client'), import('../../src/components/ToolApprovalCard.jsx'), import('../../src/i18n/I18nProvider.jsx'),
  ])
  const root = createRoot(document.getElementById('root')), decisions = []
  const request = { name: 'write_file', args: { path: 'fixture.txt' }, risk: 'low' }
  const render = busy => root.render(<I18nProvider><Card open request={request} busy={busy} onDecide={v => decisions.push(v)} /></I18nProvider>)
  context.after(async () => { await act(async () => root.unmount()); d.window.close() })
  await act(async () => render(false))
  await act(async () => document.querySelector('[data-testid=tool-approval-suggest]').click())
  const box = document.querySelector('textarea')
  await act(async () => {
    Object.getOwnPropertyDescriptor(d.window.HTMLTextAreaElement.prototype, 'value').set.call(box, 'Use the test fixture instead')
    box.dispatchEvent(new d.window.Event('input', { bubbles: true }))
  })
  await act(async () => box.dispatchEvent(new d.window.KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true })))
  assert.equal(!!document.querySelector('[data-testid=tool-approval-feedback]'), true)
  await act(async () => render(true))
  assert.equal(box.disabled, true)
  await act(async () => {
    box.dispatchEvent(new d.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    document.querySelector('[data-testid=tool-approval-feedback]').dispatchEvent(new d.window.Event('submit', { bubbles: true, cancelable: true }))
  })
  assert.deepEqual(decisions, [])
})
