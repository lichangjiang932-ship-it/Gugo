import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/chat' })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.Element = dom.window.Element
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.SVGElement = dom.window.SVGElement
  globalThis.KeyboardEvent = dom.window.KeyboardEvent
  globalThis.MouseEvent = dom.window.MouseEvent
  globalThis.localStorage = dom.window.localStorage
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
  globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0)
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id)
  return dom
}

/** react-dom/client must load after setupDom (see the JSX test bootstrap note). */
async function mount(element) {
  const { createRoot } = await import('react-dom/client')
  const container = document.getElementById('root')
  const root = createRoot(container)
  await act(async () => root.render(element))
  return { container, root, unmount: () => act(async () => root.unmount()) }
}

/** The boundary logs what it caught; keep the test output readable. */
async function quietly(run) {
  const original = console.error
  console.error = () => {}
  try {
    return await run()
  } finally {
    console.error = original
  }
}

test('a renderer that throws fails inside the pane; the chat beside it and the pane chrome stay', async () => {
  const dom = setupDom()
  const { default: RightPreviewPane } = await import('../../src/pages/ChatSplit/RightPreviewPane.jsx')
  const { BUILTIN_PREVIEW_RENDERER_OWNER, previewRendererRegistry } = await import('../../src/pages/ChatSplit/preview/previewRendererRegistry.js')
  const builtIn = previewRendererRegistry.resolve('image')
  let crash = true
  let renders = 0
  function ExplodingRenderer() {
    renders += 1
    if (crash) throw new Error('malformed package')
    return <p data-testid="renderer-ok">drawn</p>
  }
  previewRendererRegistry.registerOwned(BUILTIN_PREVIEW_RENDERER_OWNER, 'image', { component: ExplodingRenderer })
  const artifact = { directFile: { id: 'hostile', filename: 'hostile.png', type: 'png', url: '/api/artifacts/hostile.png' } }
  try {
    const h = await quietly(() => mount(
      <div>
        <p data-testid="chat-sibling">conversation</p>
        <RightPreviewPane artifact={artifact} onClose={() => {}} />
      </div>,
    ))
    try {
      const fallback = h.container.querySelector('[data-testid="preview-renderer-crashed"]')
      assert.ok(fallback, 'the pane shows a contained failure state')
      assert.match(fallback.textContent, /hostile\.png/u, 'it names the file')
      assert.ok(h.container.querySelector('[data-testid="chat-sibling"]'), 'the rest of the tree stays mounted')
      assert.ok(h.container.querySelector('[data-testid="direct-file-pane"]'), 'the pane itself stays')
      assert.ok(h.container.querySelector('[data-testid="preview-open-menu"]'), 'the toolbar stays usable')
      assert.equal(h.container.querySelectorAll('[role="tab"]').length, 1, 'the tabs stay')

      crash = false
      const before = renders
      await act(async () => fallback.querySelector('button').click())
      assert.ok(renders > before, 'retry remounts the renderer')
      assert.equal(h.container.querySelector('[data-testid="preview-renderer-crashed"]'), null)
      assert.equal(h.container.querySelector('[data-testid="renderer-ok"]').textContent, 'drawn')
    } finally {
      await h.unmount()
    }
  } finally {
    previewRendererRegistry.registerOwned(BUILTIN_PREVIEW_RENDERER_OWNER, 'image', builtIn)
    dom.window.close()
  }
})

test('an artifact preview body that throws is contained, and another tab starts fresh', async () => {
  const dom = setupDom()
  const { default: RightPreviewPane } = await import('../../src/pages/ChatSplit/RightPreviewPane.jsx')
  const { createPreviewTab } = await import('../../src/pages/ChatSplit/preview/previewTabs.js')
  // A workbook preview without rows: XlsxPreview reads rows[0] and throws.
  const broken = { messageId: 'm-broken', content: '', preview: { type: 'xlsx', filename: 'broken.xlsx', title: 'broken.xlsx' } }
  const healthy = { messageId: 'm-healthy', content: 'plain text body', preview: { type: 'text', filename: 'notes.txt', title: 'notes.txt' } }
  const tabs = [createPreviewTab(broken), createPreviewTab(healthy)]
  const [brokenId, healthyId] = tabs.map((entry) => entry.id)
  const pane = (activeId) => (
    <div>
      <p data-testid="chat-sibling">conversation</p>
      <RightPreviewPane artifact={activeId === brokenId ? broken : healthy} previewTabs={tabs} activePreviewId={activeId} onClose={() => {}} />
    </div>
  )
  const h = await quietly(() => mount(pane(brokenId)))
  try {
    const fallback = h.container.querySelector('[data-testid="preview-renderer-crashed"]')
    assert.ok(fallback, 'the body failed in place')
    assert.match(fallback.textContent, /broken\.xlsx/u)
    assert.ok(h.container.querySelector('[data-testid="chat-sibling"]'))
    assert.equal(h.container.querySelectorAll('[role="tab"]').length, 2)

    await quietly(() => act(async () => h.root.render(pane(healthyId))))
    assert.equal(h.container.querySelector('[data-testid="preview-renderer-crashed"]'), null, 'the boundary resets per tab')
    assert.match(h.container.querySelector('[data-testid="preview-scroll-region"]').textContent, /plain text body/u)
  } finally {
    await h.unmount()
    dom.window.close()
  }
})
