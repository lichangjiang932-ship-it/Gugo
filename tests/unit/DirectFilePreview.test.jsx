import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import DirectFilePreview from '../../src/pages/ChatSplit/preview/DirectFilePreview.jsx'
import { DirectFileToolbar } from '../../src/pages/ChatSplit/preview/PreviewChrome.jsx'

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/chat',
  })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.SVGElement = dom.window.SVGElement
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  return dom
}

test('native image, audio, and video previews expose loading and failure states', async () => {
  const dom = setupDom()
  const rootElement = dom.window.document.getElementById('root')
  const root = createRoot(rootElement)
  const cases = [
    ['image', 'photo.avif', 'img'],
    ['audio', 'voice.opus', 'audio'],
    ['video', 'movie.ogv', 'video'],
  ]

  try {
    for (const [kind, filename, selector] of cases) {
      await act(async () => root.render(
        <DirectFilePreview
          file={{ filename, type: kind }}
          url={`/api/artifacts/${filename}?preview=1`}
          t={(key) => key}
        />,
      ))
      assert.match(rootElement.textContent, /chatPreview\.loadingFile/, `${kind} loading state`)
      const media = rootElement.querySelector(selector)
      assert.ok(media, kind)
      await act(async () => media.dispatchEvent(new dom.window.Event('error')))
      assert.match(rootElement.textContent, /chatPreview\.previewFailed/, `${kind} failure state`)
      assert.doesNotMatch(rootElement.textContent, /chatPreview\.loadingFile/, `${kind} loading cleared`)
    }
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('direct HTML files use the sandboxed artifact preview URL instead of srcdoc', async () => {
  const dom = setupDom()
  const rootElement = dom.window.document.getElementById('root')
  const root = createRoot(rootElement)
  try {
    await act(async () => root.render(
      <DirectFilePreview
        file={{ filename: 'interactive.html', type: 'html' }}
        url="/api/artifacts/interactive.html?token=test&preview=1"
        t={(key) => key}
      />,
    ))
    const frame = rootElement.querySelector('iframe')
    assert.ok(frame)
    assert.equal(frame.getAttribute('src'), '/api/artifacts/interactive.html?token=test&preview=1')
    assert.equal(frame.getAttribute('srcdoc'), null)
    assert.equal(frame.getAttribute('sandbox'), 'allow-scripts allow-forms')
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('direct-file toolbar always keeps the independent download fallback', async () => {
  const dom = setupDom()
  const rootElement = dom.window.document.getElementById('root')
  const root = createRoot(rootElement)
  try {
    await act(async () => root.render(
      <DirectFileToolbar
        filename="季度报告.docx"
        type="docx"
        summary="Word document"
        url="/api/artifacts/report.docx"
        t={(key) => key}
      />,
    ))
    const link = rootElement.querySelector('a[download="季度报告.docx"]')
    assert.ok(link)
    assert.match(link.href, /\/api\/artifacts\/report\.docx$/)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})
