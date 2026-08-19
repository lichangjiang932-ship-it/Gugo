import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import DirectFilePreview, { DirectHtmlUrlPreview } from '../../src/pages/ChatSplit/preview/DirectFilePreview.jsx'
import { listPreviewRenderers } from '../../src/pages/ChatSplit/preview/previewRendererRegistry.js'
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

test('direct-file preview registry preserves every built-in kind and fallback', () => {
  const entries = listPreviewRenderers()
  const byKind = new Map(entries.map(({ kind, descriptor }) => [kind, descriptor]))
  assert.deepEqual(
    [...byKind.keys()],
    ['image', 'pdf', 'audio', 'video', 'html', 'docx', 'pptx', 'xlsx', 'csv', 'markdown', 'json', 'xml', 'code', 'text', 'unsupported'],
  )
  for (const kind of ['image', 'pdf', 'audio', 'video', 'html', 'unsupported']) {
    assert.equal(byKind.get(kind)?.needsFetch, false, kind)
  }
  for (const kind of ['docx', 'pptx', 'xlsx', 'csv', 'markdown', 'json', 'xml', 'code', 'text']) {
    assert.equal(byKind.get(kind)?.needsFetch, true, kind)
  }
  for (const descriptor of byKind.values()) assert.equal(typeof descriptor.component, 'function')
})

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
      assert.ok(rootElement.querySelector('a[target="_blank"]'), `${kind} open-original fallback`)
      const retry = [...rootElement.querySelectorAll('button')]
        .find((button) => button.textContent.includes('chatPreview.retryPreview'))
      assert.ok(retry, `${kind} retry fallback`)
      const failedUrl = media.getAttribute('src')
      await act(async () => retry.click())
      const retriedMedia = rootElement.querySelector(selector)
      assert.notEqual(retriedMedia, media, `${kind} retry remount`)
      assert.notEqual(retriedMedia.getAttribute('src'), failedUrl, `${kind} retry URL`)
      assert.match(retriedMedia.getAttribute('src'), /previewRetry=1/, `${kind} retry cache buster`)
    }
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('fetched markdown preview retries in place and keeps the original-file fallback', async () => {
  const dom = setupDom()
  const rootElement = dom.window.document.getElementById('root')
  const root = createRoot(rootElement)
  const originalFetch = globalThis.fetch
  const requests = []
  let resolveRetry
  globalThis.fetch = (input) => {
    requests.push(String(input))
    if (requests.length === 1) return Promise.resolve({ ok: false, status: 503 })
    return new Promise((resolve) => { resolveRetry = resolve })
  }

  try {
    await act(async () => root.render(
      <DirectFilePreview
        file={{ filename: 'recover.md', type: 'text/markdown' }}
        url="/api/attachments/recover/content?preview=1"
        t={(key) => key}
      />,
    ))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })

    assert.match(rootElement.textContent, /chatPreview\.previewFailed/)
    const original = rootElement.querySelector('a[target="_blank"]')
    assert.ok(original)
    assert.match(original.getAttribute('href'), /\/api\/attachments\/recover\/content\?preview=1$/)
    const retry = [...rootElement.querySelectorAll('button')]
      .find((button) => button.textContent.includes('chatPreview.retryPreview'))
    assert.ok(retry)

    await act(async () => retry.click())
    assert.match(rootElement.textContent, /chatPreview\.loadingFile/)
    assert.equal(typeof resolveRetry, 'function')
    await act(async () => {
      resolveRetry({
        ok: true,
        status: 200,
        arrayBuffer: async () => new TextEncoder().encode('# Retry recovered').buffer,
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    assert.equal(requests.length, 2)
    assert.match(requests[1], /preview=1&previewRetry=1$/)
    assert.match(rootElement.textContent, /Retry recovered/)
    assert.doesNotMatch(rootElement.textContent, /chatPreview\.previewFailed/)
  } finally {
    await act(async () => root.unmount())
    globalThis.fetch = originalFetch
    dom.window.close()
  }
})

test('fetched data and blob previews retry even when their URL cannot take a cache buster', async () => {
  const originalFetch = globalThis.fetch
  const cases = [
    ['data', 'data:text/markdown,%23%20Inline'],
    ['blob', 'blob:http://localhost/preview-source'],
  ]

  try {
    for (const [label, url] of cases) {
      const dom = setupDom()
      const rootElement = dom.window.document.getElementById('root')
      const root = createRoot(rootElement)
      const requests = []
      globalThis.fetch = async (input) => {
        requests.push(String(input))
        if (requests.length === 1) return { ok: false, status: 503 }
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => new TextEncoder().encode(`# ${label} recovered`).buffer,
        }
      }

      try {
        await act(async () => root.render(
          <DirectFilePreview
            file={{ id: `${label}-file`, filename: `${label}.md`, type: 'text/markdown' }}
            url={url}
            t={(key) => key}
          />,
        ))
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
        assert.match(rootElement.textContent, /chatPreview\.previewFailed/, label)

        const retry = [...rootElement.querySelectorAll('button')]
          .find((button) => button.textContent.includes('chatPreview.retryPreview'))
        assert.ok(retry, label)
        await act(async () => retry.click())
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })

        assert.deepEqual(requests, [url, url], label)
        assert.match(rootElement.textContent, new RegExp(`${label} recovered`), label)
        assert.doesNotMatch(rootElement.textContent, /chatPreview\.previewFailed/, label)
      } finally {
        await act(async () => root.unmount())
        dom.window.close()
      }
    }
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('switching fetched artifacts resets retry state and ignores the previous request result', async () => {
  const dom = setupDom()
  const rootElement = dom.window.document.getElementById('root')
  const root = createRoot(rootElement)
  const originalFetch = globalThis.fetch
  const requests = []
  let resolveOldRetry
  globalThis.fetch = (input, init = {}) => {
    const request = { input: String(input), init }
    requests.push(request)
    if (requests.length === 1) return Promise.resolve({ ok: false, status: 503 })
    if (requests.length === 2) {
      return new Promise((resolve) => { resolveOldRetry = resolve })
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      arrayBuffer: async () => new TextEncoder().encode('# Fresh artifact B').buffer,
    })
  }

  try {
    await act(async () => root.render(
      <DirectFilePreview
        file={{ id: 'artifact-a', filename: 'a.md', type: 'text/markdown' }}
        url="/api/attachments/a/content?preview=1"
        t={(key) => key}
      />,
    ))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    const retry = [...rootElement.querySelectorAll('button')]
      .find((button) => button.textContent.includes('chatPreview.retryPreview'))
    assert.ok(retry)

    await act(async () => retry.click())
    assert.equal(typeof resolveOldRetry, 'function')
    assert.match(requests[1].input, /previewRetry=1$/)

    await act(async () => root.render(
      <DirectFilePreview
        file={{ id: 'artifact-b', filename: 'b.md', type: 'text/markdown' }}
        url="/api/attachments/b/content?preview=1"
        t={(key) => key}
      />,
    ))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })

    assert.equal(requests.length, 3)
    assert.equal(requests[2].input, '/api/attachments/b/content?preview=1')
    assert.equal(requests[1].init.signal?.aborted, true)
    assert.match(rootElement.textContent, /Fresh artifact B/)

    await act(async () => {
      resolveOldRetry({
        ok: true,
        status: 200,
        arrayBuffer: async () => new TextEncoder().encode('# Stale artifact A').buffer,
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    assert.match(rootElement.textContent, /Fresh artifact B/)
    assert.doesNotMatch(rootElement.textContent, /Stale artifact A/)
  } finally {
    await act(async () => root.unmount())
    globalThis.fetch = originalFetch
    dom.window.close()
  }
})

test('managed HTML artifacts exchange auth for a scoped ticket iframe', async () => {
  const dom = setupDom()
  const rootElement = dom.window.document.getElementById('root')
  const root = createRoot(rootElement)
  const originalFetch = globalThis.fetch
  const requests = []
  globalThis.fetch = async (input, init = {}) => {
    requests.push({ input: String(input), init })
    if (init.method === 'POST') {
      return {
        ok: true,
        status: 200,
        json: async () => ({ url: '/api/artifacts/previews/opaque-ticket/index.html' }),
      }
    }
    return { ok: true, status: 204 }
  }
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
    assert.equal(frame.getAttribute('src'), '/api/artifacts/previews/opaque-ticket/index.html')
    assert.equal(frame.getAttribute('srcdoc'), null)
    assert.equal(frame.getAttribute('sandbox'), 'allow-scripts')
    assert.equal(requests.length, 1)
    assert.equal(requests[0].input, '/api/artifacts/interactive.html/preview-session')
    assert.equal(requests[0].init.method, 'POST')
    assert.doesNotMatch(requests[0].input, /token=|test/)
  } finally {
    await act(async () => root.unmount())
    await new Promise((resolve) => setTimeout(resolve, 0))
    globalThis.fetch = originalFetch
    assert.equal(requests.length, 2)
    assert.equal(requests[1].input, '/api/artifacts/previews/opaque-ticket')
    assert.equal(requests[1].init.method, 'DELETE')
    dom.window.close()
  }
})

test('HTML iframe leaves loading after five seconds and retries in place', async () => {
  const dom = setupDom()
  const rootElement = dom.window.document.getElementById('root')
  const root = createRoot(rootElement)
  try {
    await act(async () => root.render(
      <DirectHtmlUrlPreview
        file={{ filename: 'slow.html', type: 'html' }}
        url="/slow.html"
        timeoutMs={5}
        t={(key) => key}
      />,
    ))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 15)) })
    assert.match(rootElement.textContent, /chatPreview\.previewFailed/)
    assert.doesNotMatch(rootElement.textContent, /chatPreview\.loadingFile/)
    const firstFrame = rootElement.querySelector('iframe')
    const retry = [...rootElement.querySelectorAll('button')]
      .find((button) => button.textContent.includes('chatPreview.retryPreview'))
    assert.ok(retry)
    await act(async () => retry.click())
    assert.match(rootElement.textContent, /chatPreview\.loadingFile/)
    const retriedFrame = rootElement.querySelector('iframe')
    assert.notEqual(retriedFrame, firstFrame)
    assert.equal(retriedFrame.getAttribute('src'), '/slow.html?previewRetry=1')
  } finally {
    await act(async () => root.unmount())
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
    assert.equal(frame.getAttribute('sandbox'), '')
    assert.equal(fetchCalls, 0)
  } finally {
    await act(async () => root.unmount())
    globalThis.fetch = originalFetch
    dom.window.close()
  }
})

test('verified local HTML uses a scoped preview URL so relative sidecar assets keep their base path', async () => {
  const dom = setupDom()
  const rootElement = dom.window.document.getElementById('root')
  const root = createRoot(rootElement)
  const originalFetch = globalThis.fetch
  const requests = []
  globalThis.fetch = async (input, init = {}) => {
    requests.push({ input: String(input), init })
    return {
      ok: true,
      status: 200,
      json: async () => ({ url: '/api/local-files/previews/opaque-ticket/site.html' }),
    }
  }
  try {
    await act(async () => root.render(
      <DirectFilePreview
        file={{ filename: 'site.html', type: 'html' }}
        url="/api/local-files/verified/receipt-1?turnId=turn-1&preview=1&token=stale"
        t={(key) => key}
      />,
    ))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    const frame = rootElement.querySelector('iframe')
    assert.ok(frame)
    assert.equal(frame.getAttribute('src'), '/api/local-files/previews/opaque-ticket/site.html')
    assert.equal(frame.getAttribute('srcdoc'), null)
    assert.equal(frame.getAttribute('sandbox'), '')
    assert.equal(requests.length, 1)
    assert.equal(requests[0].input, '/api/local-files/verified/receipt-1/preview-session?turnId=turn-1')
    assert.equal(requests[0].init.method, 'POST')
    assert.doesNotMatch(requests[0].input, /token=|stale/)
  } finally {
    await act(async () => root.unmount())
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(requests.length, 2)
    assert.equal(requests[1].input, '/api/local-files/previews/opaque-ticket')
    assert.equal(requests[1].init.method, 'DELETE')
    globalThis.fetch = originalFetch
    dom.window.close()
  }
})

test('retained local HTML uses the retained preview-session route without claiming verification', async () => {
  const dom = setupDom()
  const rootElement = dom.window.document.getElementById('root')
  const root = createRoot(rootElement)
  const originalFetch = globalThis.fetch
  const requests = []
  globalThis.fetch = async (input, init = {}) => {
    requests.push({ input: String(input), init })
    return {
      ok: true,
      status: 200,
      json: async () => ({ url: '/api/local-files/previews/retained-ticket/site.html' }),
    }
  }
  try {
    await act(async () => root.render(
      <DirectFilePreview
        file={{
          filename: 'site.html',
          type: 'html',
          retainedLocalFile: true,
          verificationPending: true,
        }}
        url="/api/local-files/retained/retained-receipt-1?turnId=retained-turn&preview=1&token=stale"
        t={(key) => key}
      />,
    ))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    const frame = rootElement.querySelector('iframe')
    assert.ok(frame)
    assert.equal(frame.getAttribute('src'), '/api/local-files/previews/retained-ticket/site.html')
    assert.equal(frame.getAttribute('sandbox'), '')
    assert.equal(requests[0].input, '/api/local-files/retained/retained-receipt-1/preview-session?turnId=retained-turn')
    assert.equal(requests[0].init.method, 'POST')
    assert.doesNotMatch(requests[0].input, /token=|stale/)
  } finally {
    await act(async () => root.unmount())
    await new Promise((resolve) => setTimeout(resolve, 0))
    globalThis.fetch = originalFetch
    dom.window.close()
  }
})

test('verified local HTML offers an in-place retry after a persistent 405 and keeps the formal file URL', async () => {
  const dom = setupDom()
  const rootElement = dom.window.document.getElementById('root')
  const root = createRoot(rootElement)
  const originalFetch = globalThis.fetch
  const requests = []
  globalThis.fetch = async (input, init = {}) => {
    requests.push({ input: String(input), init })
    if (init.method === 'DELETE') return { ok: true, status: 204 }
    if (String(input) === '/api/health') {
      return {
        ok: true,
        status: 200,
        json: async () => ({ capabilities: { localHtmlPreviewSession: 1 } }),
      }
    }
    if (requests.filter((request) => request.init.method === 'POST').length === 1) {
      return { ok: false, status: 405 }
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ url: '/api/local-files/previews/recovered-ticket/gallery.html' }),
    }
  }
  try {
    await act(async () => root.render(
      <DirectFilePreview
        file={{ filename: 'gallery.html', type: 'html' }}
        url="/api/local-files/verified/formal-gallery?turnId=turn-gallery&preview=1"
        t={(key) => key}
      />,
    ))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    assert.match(rootElement.textContent, /chatPreview\.localHtmlServiceUnavailable/)
    const retry = [...rootElement.querySelectorAll('button')]
      .find((button) => button.textContent.includes('chatPreview.retryPreview'))
    assert.ok(retry)

    await act(async () => retry.click())
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    const frame = rootElement.querySelector('iframe')
    assert.ok(frame)
    assert.equal(frame.getAttribute('src'), '/api/local-files/previews/recovered-ticket/gallery.html')
    assert.equal(requests.filter((request) => request.init.method === 'POST').length, 2)
    assert.ok(requests
      .filter((request) => request.init.method === 'POST')
      .every((request) => request.input === '/api/local-files/verified/formal-gallery/preview-session?turnId=turn-gallery'))
  } finally {
    await act(async () => root.unmount())
    await new Promise((resolve) => setTimeout(resolve, 0))
    globalThis.fetch = originalFetch
    dom.window.close()
  }
})

test('verified local HTML displays structured preview-session failure details', async () => {
  const dom = setupDom()
  const rootElement = dom.window.document.getElementById('root')
  const root = createRoot(rootElement)
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: false,
    status: 422,
    json: async () => ({
      error: {
        code: 'HTML_DELIVERY_RESOURCE_MISSING',
        message: '图片 images/missing.png 不存在',
        hint: '检查 HTML 中的相对路径',
      },
    }),
  })
  try {
    await act(async () => root.render(
      <DirectFilePreview
        file={{ filename: 'gallery.html', type: 'html' }}
        url="/api/local-files/verified/formal-gallery?turnId=turn-gallery&preview=1"
        t={(key) => key}
      />,
    ))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    const status = rootElement.querySelector('[role="status"]')
    assert.ok(status)
    assert.equal(status.getAttribute('data-error-code'), 'HTML_DELIVERY_RESOURCE_MISSING')
    assert.match(status.textContent, /images\/missing\.png/)
    assert.match(status.textContent, /检查 HTML 中的相对路径/)
    assert.doesNotMatch(status.textContent, /chatPreview\.localHtmlServiceUnavailable/)
  } finally {
    await act(async () => root.unmount())
    globalThis.fetch = originalFetch
    dom.window.close()
  }
})

test('verified local HTML revokes a preview ticket that arrives after the sidebar closes', async () => {
  const dom = setupDom()
  const rootElement = dom.window.document.getElementById('root')
  const root = createRoot(rootElement)
  const originalFetch = globalThis.fetch
  const requests = []
  let resolveCreate
  let mounted = true
  globalThis.fetch = (input, init = {}) => {
    requests.push({ input: String(input), init })
    if (init.method === 'POST') {
      return new Promise((resolve) => { resolveCreate = resolve })
    }
    return Promise.resolve({ ok: true, status: 204 })
  }
  try {
    await act(async () => root.render(
      <DirectFilePreview
        file={{ filename: 'slow.html', type: 'html' }}
        url="/api/local-files/verified/receipt-slow?turnId=turn-slow&preview=1"
        t={(key) => key}
      />,
    ))
    assert.equal(typeof resolveCreate, 'function')
    await act(async () => root.unmount())
    mounted = false
    resolveCreate({
      ok: true,
      status: 200,
      json: async () => ({ url: '/api/local-files/previews/late-ticket/slow.html' }),
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(requests.length, 2)
    assert.equal(requests[1].input, '/api/local-files/previews/late-ticket')
    assert.equal(requests[1].init.method, 'DELETE')
  } finally {
    if (mounted) await act(async () => root.unmount())
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
