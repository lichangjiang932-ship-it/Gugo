import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'

// react-dom/client is loaded after the DOM exists; loaded first it picks event
// shims under which a dispatched keydown never reaches React's handler.
function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/chat' })
  for (const key of ['HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'SVGElement', 'Event', 'KeyboardEvent', 'MouseEvent']) globalThis[key] = dom.window[key]
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.localStorage = dom.window.localStorage
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  return dom
}

test('Esc in the composer pauses a running turn, and does nothing when idle', async (context) => {
  const dom = setupDom()
  const [{ act }, { createRoot }, { default: ChatComposer }] = await Promise.all([
    import('react'), import('react-dom/client'), import('../../src/pages/ChatSplit/ChatComposer.jsx'),
  ])
  const element = document.getElementById('root')
  const root = createRoot(element)
  context.after(async () => { await act(async () => root.unmount()); dom.window.close() })
  let paused = 0
  let forwarded = 0
  const render = (isGenerating) => act(async () => root.render(
    <ChatComposer
      input="" attachments={[]} setInput={() => {}} setAttachments={() => {}}
      onSend={() => {}} onAbort={() => { paused += 1 }}
      isGenerating={isGenerating} modelPickerOpen={false} modelOptions={[]} selectedModel="local-model"
      onFileChange={() => {}} onOpenModelPicker={() => {}} onCloseModelPicker={() => {}}
      onModelChange={() => {}} onManageModels={() => {}}
      approvalMode="normal" onApprovalModeChange={() => {}} handleKeyDown={() => { forwarded += 1 }}
    />,
  ))
  const escape = (init = {}) => act(async () => {
    element.querySelector('textarea').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...init }))
  })
  await render(true)
  // The running placeholder says what Esc does.
  assert.match(element.querySelector('textarea').placeholder, /Esc/u)
  await escape()
  assert.equal(paused, 1)
  assert.equal(forwarded, 0, 'Esc is consumed, not passed on as an ordinary key')
  await escape({ ctrlKey: true })
  assert.equal(paused, 1, 'a modified Esc is left alone')
  assert.equal(forwarded, 1, 'and goes on to the ordinary key handling')
  await render(false)
  await escape()
  assert.equal(paused, 1, 'nothing to pause when idle')
  assert.equal(forwarded, 2)
})
