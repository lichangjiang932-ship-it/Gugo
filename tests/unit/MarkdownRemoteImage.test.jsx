import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import MarkdownRenderer from '../../src/components/MarkdownRenderer.jsx'
import MarkdownImage from '../../src/components/markdown/MarkdownImage.jsx'
import { remoteMarkdownImageUrl } from '../../src/lib/remoteMarkdownImage.js'
import { setAuthToken } from '../../src/lib/accountClient.js'

async function mountImage(context, fetchImpl) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/chat' })
  const values = {
    window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, SVGElement: dom.window.SVGElement,
    localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true,
  }
  const previous = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  context.mock.method(globalThis, 'fetch', fetchImpl)
  const revoked = []
  let nextId = 0
  context.mock.method(URL, 'createObjectURL', () => `blob:http://localhost/image-${++nextId}`)
  context.mock.method(URL, 'revokeObjectURL', (url) => revoked.push(url))
  const root = createRoot(document.getElementById('root'))
  setAuthToken('isolated-image-viewer')
  context.after(async () => {
    await act(async () => root.unmount())
    setAuthToken('')
    dom.window.close()
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
  })
  return {
    dom, revoked,
    async render(element) { await act(async () => root.render(element)) },
  }
}

test('Markdown SSR never emits remote image src or preload, including protocol-relative URLs', () => {
  for (const url of ['https://public.example.test/a.png', '//public.example.test/a.png', 'https://markdown.invalid/a.png']) {
    const html = renderToStaticMarkup(<MarkdownRenderer>{`![audit image](${url})`}</MarkdownRenderer>)
    assert.doesNotMatch(html, /<img|rel="preload"|public\.example/)
    assert.match(html, /remote-markdown-image-placeholder/)
  }
  assert.match(renderToStaticMarkup(<MarkdownRenderer>{'![local](/assets/report.png)'}</MarkdownRenderer>), /src="\/assets\/report\.png"/)
  assert.equal(remoteMarkdownImageUrl('\\\\public.example.test\\a.png', 'https://local.test'), 'https://public.example.test/a.png')
})

test('remote Markdown image loads through authenticated same-origin POST and fullscreen receives only the blob', async (context) => {
  const requests = []
  let complete
  const view = await mountImage(context, (url, options) => {
    requests.push({ url, options })
    return new Promise((resolve) => { complete = resolve })
  })
  const opened = []
  await view.render(<MarkdownImage src="https://public.example.test/a.png" alt="report" onOpen={(src) => opened.push(src)} />)
  assert.equal(document.querySelector('img'), null)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, '/api/media/remote-image')
  assert.equal(requests[0].options.headers.Authorization, 'Bearer isolated-image-viewer')
  assert.deepEqual(JSON.parse(requests[0].options.body), { url: 'https://public.example.test/a.png' })
  await act(async () => complete(new Response('fixture bytes', { headers: { 'Content-Type': 'image/png' } })))
  const img = document.querySelector('img')
  assert.equal(img.getAttribute('src'), 'blob:http://localhost/image-1')
  await act(async () => img.dispatchEvent(new view.dom.window.MouseEvent('click', { bubbles: true })))
  assert.deepEqual(opened, ['blob:http://localhost/image-1'])
  await view.render(<div />)
  assert.deepEqual(view.revoked, ['blob:http://localhost/image-1'])
  assert.equal(requests[0].options.signal.aborted, true)
})

test('server pure-local denial and streaming Markdown retain inert placeholders without direct fallback', async (context) => {
  let requests = 0
  const view = await mountImage(context, async (url) => {
    assert.equal(url, '/api/media/remote-image')
    requests += 1
    return new Response(JSON.stringify({ error: { code: 'OUTBOUND_PURE_LOCAL_DENIED', message: 'blocked' } }), {
      status: 403, headers: { 'Content-Type': 'application/json' },
    })
  })
  const markdown = '![remote](https://public.example.test/a.png)'
  await view.render(<MarkdownRenderer streaming>{markdown}</MarkdownRenderer>)
  assert.equal(requests, 0)
  assert.equal(document.querySelector('img'), null)
  await view.render(<MarkdownRenderer>{markdown}</MarkdownRenderer>)
  assert.equal(requests, 1)
  assert.equal(document.querySelector('img'), null)
  assert.equal(document.querySelector('[data-error-code]')?.getAttribute('data-error-code'), 'OUTBOUND_PURE_LOCAL_DENIED')
  assert.doesNotMatch(document.getElementById('root').innerHTML, /src=|public\.example/)
})

test('local images make no proxy request and a late remote response cannot overwrite a changed source', async (context) => {
  let complete
  const view = await mountImage(context, () => new Promise((resolve) => { complete = resolve }))
  await view.render(<MarkdownImage src="https://public.example.test/a.png" alt="remote" />)
  await view.render(<MarkdownImage src="/assets/local.png" alt="local" />)
  await act(async () => complete(new Response('fixture bytes', { headers: { 'Content-Type': 'image/png' } })))
  assert.equal(document.querySelector('img')?.getAttribute('src'), '/assets/local.png')
  assert.deepEqual(view.revoked, [])
})

test('opening the real Markdown fullscreen view does not refetch or revoke its displayed blob', async (context) => {
  let requests = 0
  const view = await mountImage(context, async () => {
    requests += 1
    return new Response('fixture bytes', { headers: { 'Content-Type': 'image/png' } })
  })
  await view.render(<MarkdownRenderer>{'![report](https://public.example.test/report.png)'}</MarkdownRenderer>)
  const thumbnail = document.querySelector('img')
  const src = thumbnail.getAttribute('src')
  await act(async () => thumbnail.dispatchEvent(new view.dom.window.MouseEvent('click', { bubbles: true })))
  assert.ok(document.querySelector('[role="dialog"]'))
  assert.equal(document.querySelector('[role="dialog"] img')?.getAttribute('src'), src)
  assert.equal(requests, 1)
  assert.deepEqual(view.revoked, [])
  await act(async () => document.querySelector('[role="dialog"] button').dispatchEvent(new view.dom.window.MouseEvent('click', { bubbles: true })))
  assert.equal(document.querySelector('[role="dialog"]'), null)
  assert.equal(requests, 1)
  assert.equal(document.querySelector('img')?.getAttribute('src'), src)
  assert.deepEqual(view.revoked, [])
})
