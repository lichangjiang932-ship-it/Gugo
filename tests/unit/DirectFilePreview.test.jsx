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

test('managed HTML artifacts load private assets into a sandboxed srcdoc', async () => {
  const dom = setupDom()
  const rootElement = dom.window.document.getElementById('root')
  const root = createRoot(rootElement)
  const originalFetch = globalThis.fetch
  const originalCreateObjectURL = globalThis.URL.createObjectURL
  const originalRevokeObjectURL = globalThis.URL.revokeObjectURL
  const requests = []
  const revoked = []
  globalThis.fetch = async (input) => {
    requests.push(String(input))
    if (requests.length === 1) {
      return {
        ok: true,
        text: async () => '<!doctype html><html><body><img src="gugo-asset://portrait"></body></html>',
      }
    }
    return {
      ok: true,
      blob: async () => new Blob(['portrait'], { type: 'image/jpeg' }),
    }
  }
  globalThis.URL.createObjectURL = () => 'blob:managed-portrait'
  globalThis.URL.revokeObjectURL = (value) => revoked.push(value)
  try {
    await act(async () => root.render(
      <DirectFilePreview
        file={{ filename: 'interactive.html', type: 'html' }}
        url="/api/artifacts/interactive.html?token=test&preview=1"
        t={(key) => key}
      />,
    ))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    const frame = rootElement.querySelector('iframe')
    assert.ok(frame)
    assert.equal(frame.getAttribute('src'), null)
    assert.match(frame.getAttribute('srcdoc'), /blob:managed-portrait/)
    assert.doesNotMatch(frame.getAttribute('srcdoc'), /gugo-asset:\/\//)
    assert.equal(frame.getAttribute('sandbox'), 'allow-scripts allow-forms')
    assert.deepEqual(requests, [
      '/api/artifacts/interactive.html?preview=1',
      '/api/artifacts/interactive.html/assets/portrait',
    ])
  } finally {
    await act(async () => root.unmount())
    globalThis.fetch = originalFetch
    globalThis.URL.createObjectURL = originalCreateObjectURL
    globalThis.URL.revokeObjectURL = originalRevokeObjectURL
    assert.deepEqual(revoked, ['blob:managed-portrait'])
    dom.window.close()
  }
})

test('ordinary workspace HTML keeps the direct sandboxed preview path', async () => {
  const dom = setupDom()
  const rootElement = dom.window.document.getElementById('root')
  const root = createRoot(rootElement)
  const originalFetch = globalThis.fetch
  let fetchCalls = 0
  globalThis.fetch = async () => {
    fetchCalls += 1
    throw new Error('workspace HTML must not use the managed artifact loader')
  }
  try {
    await act(async () => root.render(
      <DirectFilePreview
        file={{ filename: 'workspace-page.html', type: 'html' }}
        url="/api/workspace/files/workspace-page.html?preview=1"
        t={(key) => key}
      />,
    ))
    const frame = rootElement.querySelector('iframe')
    assert.ok(frame)
    assert.equal(frame.getAttribute('src'), '/api/workspace/files/workspace-page.html?preview=1')
    assert.equal(frame.getAttribute('srcdoc'), null)
    assert.equal(frame.getAttribute('sandbox'), 'allow-scripts allow-forms')
    assert.equal(fetchCalls, 0)
  } finally {
    await act(async () => root.unmount())
    globalThis.fetch = originalFetch
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
