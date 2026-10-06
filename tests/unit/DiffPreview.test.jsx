import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'

import { getArtifactToolbarActions } from '../../src/pages/ChatSplit/preview/artifactToolbar.js'

const COPY = {
  'chat.changes.currentUnavailable': 'Current content unavailable.',
}

const t = (key) => String(COPY[key] || key)

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/chat' })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.SVGElement = dom.window.SVGElement
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  return dom
}

/**
 * react-dom/client has to be imported after setupDom: a module that captured the
 * previous document renders controlled elements that silently stop updating.
 */
async function render(props) {
  const { createRoot } = await import('react-dom/client')
  const DiffPreview = (await import('../../src/pages/ChatSplit/preview/DiffPreview.jsx')).default
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => { root.render(<DiffPreview {...props} />) })
  return { container, root }
}

test('the diff shows the recorded lines with their signs and their colours', async () => {
  setupDom()
  const preview = {
    type: 'diff',
    filename: 'src/app.js',
    path: 'D:/work/src/app.js',
    summary: '+2 −1',
    hunks: [
      { toolName: 'edit_file', kind: 'replace', removed: ['const one = 1'], added: ['const one = 2', 'const two = 2'] },
      { toolName: 'apply_patch', kind: 'patch', removed: [], added: ['fresh'] },
    ],
  }
  const { container, root } = await render({ preview, t })
  try {
    assert.equal(container.querySelector('[data-testid="diff-preview"]') !== null, true)
    assert.equal(container.querySelector('span[title="D:/work/src/app.js"]').textContent, 'D:/work/src/app.js')
    assert.match(container.textContent, /\+2 −1/)
    assert.equal(container.querySelectorAll('[data-testid="diff-preview-hunk"]').length, 2)
    assert.match(container.textContent, /edit_file/)
    assert.match(container.textContent, /apply_patch/)

    const lines = [...container.querySelectorAll('[data-sign]')]
    assert.deepEqual(lines.map((line) => line.textContent), ['-const one = 1', '+const one = 2', '+const two = 2', '+fresh'])
    assert.equal(lines[0].getAttribute('data-sign'), '-')
    assert.match(lines[0].className, /text-danger/)
    assert.match(lines[1].className, /text-success/)
  } finally {
    await act(async () => root.unmount())
  }
})

test('a file with no recorded edit falls back to its current content and says when that is unreadable', async () => {
  setupDom()
  const oldFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: false, code: 'PATH_NOT_FOUND', error: 'gone' }), { status: 404 })
  const { container, root } = await render({ preview: { type: 'diff', filename: 'out.html', path: 'D:/work/out.html', hunks: [] }, t })
  try {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    assert.equal(container.querySelector('[data-testid="diff-preview-hunk"]'), null)
    assert.equal(
      container.querySelector('[data-testid="diff-preview-empty"]').textContent,
      'Current content unavailable.',
    )
  } finally {
    globalThis.fetch = oldFetch
    await act(async () => root.unmount())
  }
})

test('a diff offers neither an export nor a source view', () => {
  assert.deepEqual(getArtifactToolbarActions({ type: 'diff' }), {
    canCopy: false,
    canDownload: false,
    canExportEditablePptx: false,
    canConvertToPptx: false,
    canToggleView: false,
    downloadLabelKey: 'chatPreview.downloadFile',
  })
  // Every other artifact keeps the full toolbar.
  const docx = getArtifactToolbarActions({ type: 'docx' })
  assert.equal(docx.canCopy, true)
  assert.equal(docx.canDownload, true)
  assert.equal(docx.canToggleView, true)
})
