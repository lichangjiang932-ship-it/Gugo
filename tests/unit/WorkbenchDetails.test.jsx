import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import DiffReviewPanel from '../../src/pages/ChatSplit/rightWorkbench/diffReview/DiffReviewPanel.jsx'
import { PreviewHeader } from '../../src/pages/ChatSplit/preview/PreviewChrome.jsx'
import FileIdentity from '../../src/pages/ChatSplit/preview/FileIdentity.jsx'
import { SourceView } from '../../src/pages/ChatSplit/preview/ArtifactRenderers.jsx'
import DirectFilePreview from '../../src/pages/ChatSplit/preview/DirectFilePreview.jsx'
const t = key => key
async function mount(node) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/#/chat' })
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, SVGElement: dom.window.SVGElement, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true })
  const element = document.getElementById('root'), root = createRoot(element)
  await act(async () => root.render(node))
  return { dom, root, element, close: async () => { await act(async () => root.unmount()); dom.window.close() } }
}
test('resident review chrome has only the file-list entry, with modes inside its drawer and Escape returning focus', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ files: [{ path: '/w/src/a.js', additions: 1, deletions: 0 }] }), { headers: { 'Content-Type': 'application/json' } })
  const view = await mount(<DiffReviewPanel t={t} workspacePath="/w" />)
  try {
    const toolbar = view.element.querySelector('[data-testid=diff-toolbar]')
    assert.equal(Boolean(toolbar.querySelector('[data-testid=diff-mode-file]')), false)
    assert.equal(Boolean(toolbar.querySelector('[data-testid=diff-breadcrumb]')), false)
    const toggle = toolbar.querySelector('[data-testid=diff-toggle-files]')
    toggle.focus(); await act(async () => toggle.click())
    const drawer = view.element.querySelector('[data-testid=diff-file-list]')
    assert.ok(drawer.querySelector('[data-testid=diff-mode-file]'))
    assert.ok(drawer.querySelector('[data-testid=diff-target-select]'))
    await act(async () => drawer.querySelector('[data-testid=diff-mode-file]').click())
    assert.equal(drawer.querySelector('[data-testid=diff-mode-file]').getAttribute('aria-pressed'), 'true')
    await act(async () => drawer.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true, cancelable: true })))
    assert.equal(Boolean(view.element.querySelector('[data-testid=diff-file-list]')), true, 'IME Escape does not dismiss the drawer')
    await act(async () => drawer.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    assert.equal(Boolean(view.element.querySelector('[data-testid=diff-file-list]')), false)
    assert.equal(document.activeElement === toggle, true)
  } finally { globalThis.fetch = originalFetch; await view.close() }
})
test('file names retain a separate compound extension and full accessible name', async () => {
  const filename = 'artifactFormatPolicyStop.test.js'
  const view = await mount(<PreviewHeader tabs={[{ id: 'a', preview: { filename, type: 'code' } }]} activeId="a" setMaximized={() => {}} onSelectTab={() => {}} onCloseTab={() => {}} onClose={() => {}} t={t} />)
  try {
    assert.equal(view.element.querySelector('[data-filename-extension]').textContent, '.test.js')
    assert.equal(view.element.querySelector('[role=tab]').getAttribute('aria-label'), filename)
    assert.equal(view.element.querySelector('[data-file-name]').textContent, filename)
  } finally { await view.close() }
})
test('long paths keep the file name identifiable without changing the underlying path', async () => {
  const path = 'D:\\very-long-project-name\\nested\\directory\\artifactFormatPolicyStop.test.js'
  const view = await mount(<FileIdentity preview={{ path }} t={t} />)
  try {
    assert.equal(view.element.querySelector('[data-testid=preview-file-path]').title, path)
    assert.equal(view.element.querySelector('[data-file-name]').textContent, 'artifactFormatPolicyStop.test.js')
  } finally { await view.close() }
})
test('source defaults to unwrapped reading and retains exact whitespace and newlines', async () => {
  const content = '\tconst text = "<b>not markup</b>";\r\n' + 'long_value_'.repeat(40)
  const view = await mount(<SourceView content={content} />)
  try {
    const pre = view.element.querySelector('pre')
    assert.equal(pre.getAttribute('data-wrap'), 'false')
    assert.equal(pre.textContent, content)
    assert.equal(pre.querySelector('b'), null)
    await act(async () => view.root.render(<SourceView content={content} wrap />))
    assert.equal(view.element.querySelector('pre').getAttribute('data-wrap'), 'true')
  } finally { await view.close() }
})
test('Markdown file typography is scoped to the reader without changing authored content', async () => {
  const originalFetch = globalThis.fetch
  const markdown = '# Heading\n\n`LONG_FILE_NAME.md`\n\n| Name | Result |\n| --- | --- |\n| 示例 | PASS |'
  globalThis.fetch = async () => new Response(markdown, { headers: { 'Content-Type': 'text/markdown' } })
  const view = await mount(<DirectFilePreview file={{ filename: 'guide.md', type: 'markdown' }} url="/api/artifacts/guide.md" t={t} />)
  try {
    const reader = view.element.querySelector('[data-testid=workbench-markdown-reader]')
    assert.ok(reader)
    assert.equal(reader.querySelector('h1').textContent, 'Heading')
    assert.equal(reader.querySelector('code').textContent, 'LONG_FILE_NAME.md')
    assert.equal(reader.querySelector('td').textContent, '示例')
  } finally { globalThis.fetch = originalFetch; await view.close() }
})
