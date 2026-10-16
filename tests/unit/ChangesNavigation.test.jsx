import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
async function mount(context) {
  const d = new JSDOM('<div id="root"></div>', { url: 'http://localhost/#/chat' })
  for (const key of ['window', 'document', 'HTMLElement', 'SVGElement', 'CustomEvent', 'localStorage']) globalThis[key] = key === 'window' ? d.window : d.window[key]
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: d.window.navigator })
  const calls = []
  context.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : {}
    calls.push({ url: String(url), body })
    const data = String(url).endsWith('/status') ? { files: [{ path: 'src/a.js', additions: 1, deletions: 1 }, { path: 'tests/a.js', additions: 2, deletions: 1 }] }
      : { diff: '@@ -1 +1 @@\n-before\n+' + (body.path === 'tests/a.js' ? 'selected-test-change' : 'selected-source-change') + '\n' }
    return Response.json(data)
  })
  const [{ act }, { createRoot }, { default: Panel }, { I18nProvider }] = await Promise.all([
    import('react'), import('react-dom/client'), import('../../src/pages/ChatSplit/rightWorkbench/diffReview/DiffReviewPanel.jsx'), import('../../src/i18n/I18nProvider.jsx'),
  ])
  const root = createRoot(document.getElementById('root'))
  await act(async () => root.render(<I18nProvider><Panel workspacePath="/w" t={key => key} /></I18nProvider>))
  context.after(async () => { await act(async () => root.unmount()); d.window.close() })
  const click = async selector => act(async () => document.querySelector(selector).click())
  return { act, d, calls, click }
}
test('Changes opens directly to searchable changed files, not a second mode selector', async context => {
  const f = await mount(context)
  await f.click('[data-testid=diff-toggle-files]')
  const drawer = document.querySelector('[data-testid=diff-file-list]')
  assert.equal(drawer.querySelector('[data-testid=diff-mode-file]'), null)
  assert.equal(drawer.querySelector('[data-testid=diff-mode-diff]'), null)
  assert.equal(drawer.querySelector('[data-testid=diff-target-select]'), null)
  assert.equal(drawer.querySelectorAll('[data-testid=diff-file-list-row]').length, 2)
  await f.click('[data-testid=diff-more]')
  assert.ok(document.querySelector('[data-testid=diff-view-menu] [data-testid=diff-target-select]'))
})
test('same-named files keep exact identities and selecting one opens its diff, never full-file reading', async context => {
  const f = await mount(context)
  await f.click('[data-testid=diff-toggle-files]')
  const rows = document.querySelectorAll('[data-testid=diff-file-list-row]')
  assert.match(rows[0].textContent, /src/)
  assert.match(rows[1].textContent, /tests/)
  await f.act(async () => rows[1].click())
  assert.equal(document.querySelector('[data-testid=diff-file-list]'), null)
  assert.equal(document.querySelector('[data-testid=diff-file-content]'), null)
  assert.match(document.querySelector('[data-testid=diff-viewer-pane]').textContent, /selected-test-change/)
  assert.ok(f.calls.some(call => call.url.endsWith('/diff') && call.body.path === 'tests/a.js'))
  assert.equal(f.calls.some(call => call.url.includes('/api/tools/fs/')), false)
})
test('More closes only its own menu, preserves composition Escape and returns focus', async context => {
  const f = await mount(context)
  await f.click('[data-testid=diff-more]')
  const more = document.querySelector('[data-testid=diff-more]'), select = document.querySelector('[data-testid=diff-target-select]')
  select.focus()
  await f.act(async () => select.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true, cancelable: true })))
  assert.equal(more.closest('details').open, true)
  const event = new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  await f.act(async () => select.dispatchEvent(event))
  assert.equal(event.defaultPrevented, true)
  assert.equal(more.closest('details').open, false)
  assert.equal(document.activeElement === more, true)
})

test('file search includes parent paths and preserves IME Escape plus return focus', async context => {
  const f = await mount(context)
  const trigger = document.querySelector('[data-testid=diff-toggle-files]'); trigger.focus()
  await f.click('[data-testid=diff-toggle-files]')
  const input = document.querySelector('[data-testid=diff-file-list] input')
  await f.act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, 'tests/')
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
  assert.equal(document.querySelectorAll('[data-testid=diff-file-list-row]').length, 1)
  const drawer = document.querySelector('[data-testid=diff-file-list]')
  await f.act(async () => drawer.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true })))
  assert.equal(!!document.querySelector('[data-testid=diff-file-list]'), true)
  await f.act(async () => drawer.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  assert.equal(document.querySelector('[data-testid=diff-file-list]'), null)
  assert.equal(document.activeElement === trigger, true)
})
