import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import DiffReviewPanel from '../../src/pages/ChatSplit/rightWorkbench/diffReview/DiffReviewPanel.jsx'
import { PreviewHeader } from '../../src/pages/ChatSplit/preview/PreviewChrome.jsx'
import FileIdentity from '../../src/pages/ChatSplit/preview/FileIdentity.jsx'
import { DocxPreview, HtmlPreview, PptxPreview, SourceView, XlsxPreview } from '../../src/pages/ChatSplit/preview/ArtifactRenderers.jsx'
import DirectFilePreview from '../../src/pages/ChatSplit/preview/DirectFilePreview.jsx'
const t = key => key
async function mount(node) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/#/chat' })
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, SVGElement: dom.window.SVGElement, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true })
  const element = document.getElementById('root'), root = createRoot(element)
  await act(async () => root.render(node))
  return { dom, root, element, close: async () => { await act(async () => root.unmount()); dom.window.close() } }
}
test('resident review chrome and drawer avoid duplicate modes, with advanced comparison in More and Escape returning focus', async () => {
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
    assert.equal(Boolean(drawer.querySelector('[data-testid=diff-mode-file]')), false)
    assert.equal(Boolean(drawer.querySelector('[data-testid=diff-target-select]')), false)
    await act(async () => toolbar.querySelector('[data-testid=diff-more]').click())
    assert.ok(toolbar.querySelector('[data-testid=diff-view-menu] [data-testid=diff-target-select]'))
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
test('only the same-page DOCX fallback body and XLSX content root keep the original default font', async () => {
  const view = await mount(<div>
    <button data-host-chrome>Preview</button>
    <DocxPreview title="Document title" blocks={[
      { type: 'heading', text: 'Heading' },
      { type: 'paragraph', text: '正文 body' },
      { type: 'bullet', text: <span data-authored-font style={{ fontFamily: 'Georgia' }}>Authored font</span> },
    ]} />
    <XlsxPreview rows={[
      ['Name', 'Value'],
      ['正文 cell', <span data-authored-font style={{ fontFamily: 'Tahoma' }}>Authored cell</span>],
    ]} />
    <SourceView content="const exact = 1" />
  </div>)
  try {
    const body = [...view.element.querySelectorAll('.chat-document-page p')].find(node => node.textContent === '正文 body').parentElement
    const workbook = view.element.querySelector('table').parentElement
    assert.equal(body.style.fontFamily, 'var(--font-artifact-default)')
    assert.equal(workbook.style.fontFamily, 'var(--font-artifact-default)')
    assert.equal(view.element.querySelector('.chat-document-page').style.fontFamily, '')
    assert.equal(view.element.querySelector('.font-display').style.fontFamily, '', 'the document title retains its display face')
    assert.equal(view.element.querySelector('[data-host-chrome]').style.fontFamily, '')
    assert.equal(body.querySelector('p').style.fontFamily, '', 'do not stamp a font onto descendants')
    assert.equal(workbook.querySelector('td').style.fontFamily, '')
    assert.deepEqual([...view.element.querySelectorAll('[data-authored-font]')].map(node => node.style.fontFamily), ['Georgia', 'Tahoma'])
    assert.ok([...workbook.querySelectorAll('.font-mono')].every(node => node.style.fontFamily === ''), 'row numbers keep their mono utility')
    assert.ok(view.element.querySelector('pre.font-mono'))
    assert.equal(view.element.querySelector('pre').style.fontFamily, '')
  } finally { await view.close() }
})

test('HTML and presentation iframe documents do not inherit the host font or fallback boundary', async () => {
  const html = '<!doctype html><html><head><style>body{font-family:Georgia,serif}</style></head><body><p>Authored HTML</p></body></html>'
  const view = await mount(<div><HtmlPreview html={html} /><PptxPreview content="# Slide\n\nAuthored presentation" /></div>)
  try {
    const frames = [...view.element.querySelectorAll('iframe')]
    assert.equal(frames.length, 2)
    for (const frame of frames) {
      assert.equal(frame.style.fontFamily, '')
      assert.doesNotMatch(frame.getAttribute('srcdoc'), /Noto Sans SC Variable|--font-ui|--font-artifact-default|@fontsource/u)
    }
    assert.match(frames[0].getAttribute('srcdoc'), /font-family:Georgia,serif/u)
    assert.match(frames[1].getAttribute('srcdoc'), /font-family/u)
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
