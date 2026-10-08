import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import DirectFilePreview from '../../src/pages/ChatSplit/preview/DirectFilePreview.jsx'
import { createDocxPreviewFixture } from '../helpers/docxPreviewFixture.js'

async function withDocxPreview(run) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/chat' })
  const old = Object.fromEntries(['window', 'document', 'HTMLElement', 'SVGElement', 'Node', 'DOMParser', 'XMLSerializer', 'FileReader', 'Blob', 'fetch', 'IS_REACT_ACT_ENVIRONMENT']
    .map((name) => [name, globalThis[name]]))
  for (const name of ['window', 'document', 'HTMLElement', 'SVGElement', 'Node', 'DOMParser', 'XMLSerializer', 'FileReader', 'Blob']) {
    globalThis[name] = name === 'window' ? dom.window : dom.window[name]
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const element = document.getElementById('root')
  const root = createRoot(element)
  try {
    return await run({ dom, root, element })
  } finally {
    await act(async () => root.unmount())
    for (const [name, value] of Object.entries(old)) {
      if (value === undefined) delete globalThis[name]
      else globalThis[name] = value
    }
    dom.window.close()
  }
}

async function settlePreview(element) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline && /chatPreview\.(?:loadingFile|docxRendering)/u.test(element.textContent)) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) })
  }
}

test('DOCX layout preserves tables, merged cells, borders, embedded images, styles and explicit pages', async () => {
  const bytes = await createDocxPreviewFixture()
  await withDocxPreview(async ({ root, element }) => {
    globalThis.fetch = async () => new Response(bytes)
    await act(async () => root.render(<DirectFilePreview file={{ filename: 'layout-fixture.docx' }} url="/api/artifacts/layout-fixture.docx" t={(key) => key} />))
    await settlePreview(element)
    const frame = element.querySelector('[data-testid="docx-layout-frame"]')
    const rendered = frame ? new JSDOM(frame.getAttribute('srcdoc')).window.document : element
    // `rendered` is a Document when the frame exists: Document.textContent is
    // null, so read the body (or the element's) text instead.
    const renderedText = rendered.body?.textContent ?? rendered.textContent ?? ''
    const table = rendered.querySelector('table')
    assert.ok(table, 'Word tables must remain tables, not flattened paragraphs')
    assert.equal(table.querySelector('td[colspan="2"]')?.textContent.trim(), 'Merged heading')
    assert.equal(table.querySelector('td[rowspan="2"]')?.textContent.trim(), 'Vertical cell')
    // docx-preview applies Word's table borders at cell level (a table's
    // w:tblBorders become per-cell borders), which is how Word itself resolves
    // them. The requirement is that the document's own border colour survives;
    // it lives on the cells, not on the <table> element.
    const borderedCell = [...table.querySelectorAll('td')]
      .find((cell) => /border.*(?:204060|32, 64, 96)/u.test(cell.getAttribute('style') || ''))
    assert.ok(borderedCell, 'table borders must keep the document colour')
    assert.equal(borderedCell.getAttribute('style')?.includes('solid'), true)
    assert.match(rendered.querySelector('img')?.getAttribute('src') || '', /^data:image\/png;base64,/u)
    assert.ok(rendered.querySelectorAll('section.docx').length >= 2, 'explicit page breaks must remain page boundaries')
    assert.match(renderedText, /Fixture page header/u)
    assert.match(renderedText, /Fixture page footer/u)
    assert.match(rendered.querySelector('style')?.textContent || '', /(?:204060|32, 64, 96)/u)
    assert.equal(frame.getAttribute('sandbox'), '')
    assert.match(frame.getAttribute('srcdoc'), /default-src 'none'/u)
  })
})

test('the DOCX desk follows the app theme on the parent document', async () => {
  const bytes = await createDocxPreviewFixture()
  await withDocxPreview(async ({ dom, root, element }) => {
    globalThis.fetch = async () => new Response(bytes)
    dom.window.document.documentElement.dataset.theme = 'dark'
    await act(async () => root.render(<DirectFilePreview file={{ filename: 'layout-fixture.docx' }} url="/api/artifacts/layout-fixture.docx" t={(key) => key} />))
    await settlePreview(element)
    const srcdoc = element.querySelector('[data-testid="docx-layout-frame"]')?.getAttribute('srcdoc') || ''
    assert.match(srcdoc, /html\{background:#26282c\}/u, 'dark app theme, dark desk')
    assert.doesNotMatch(srcdoc, /prefers-color-scheme/u)
  })
})
