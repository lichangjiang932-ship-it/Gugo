import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act, useEffect, useReducer } from 'react'
import { createRoot } from 'react-dom/client'
import PptxGenJS from 'pptxgenjs'
import JSZip from 'jszip'
import DirectFilePreview from '../../src/pages/ChatSplit/preview/DirectFilePreview.jsx'
import { DirectFileToolbar } from '../../src/pages/ChatSplit/preview/PreviewChrome.jsx'
import { artifactReferenceOpenPayload } from '../../src/lib/artifactReferences.js'
import { appendServerArtifact } from '../../src/lib/serverArtifactRevisions.js'
import { dispatchTurnEvent } from '../../src/lib/turnClient/turnEventDispatch.js'
import { createTurnEvent } from '../../shared/turnEvents.js'
import { reducer } from '../../src/store/appReducer.js'
import usePreviewPaneState from '../../src/pages/ChatSplit/preview/usePreviewPaneState.js'

async function bytes({ background = '113355', font = 'Georgia', x = 1, text = 'Same content', unsupported = false } = {}) {
  const pptx = new PptxGenJS()
  pptx.layout = 'LAYOUT_WIDE'
  const slide = pptx.addSlide()
  slide.background = { color: background }
  slide.addText(text, { x, y: 1, w: 8, h: 1, fontFace: font, fontSize: 32, color: 'FFFFDD', margin: 0 })
  if (unsupported) slide.addChart(pptx.ChartType.bar, [{ name: 'Original chart', labels: ['A', 'B'], values: [5, 12] }],
    { x: 1, y: 3, w: 4, h: 2 })
  return pptx.write({ outputType: 'nodebuffer' })
}

function harness() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/chat' })
  const previous = Object.fromEntries(['window', 'document', 'HTMLElement', 'SVGElement', 'IS_REACT_ACT_ENVIRONMENT', 'fetch']
    .map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    SVGElement: dom.window.SVGElement, IS_REACT_ACT_ENVIRONMENT: true,
  })
  const container = dom.window.document.getElementById('root')
  const root = createRoot(container)
  return { dom, container, root,
    async settle(predicate = () => !!container.querySelector('[data-testid="pptx-file-preview"]')) {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
        if (predicate()) return
      }
      assert.fail(`PPTX preview did not settle: ${container.textContent}`)
    },
    async close() {
      await act(async () => root.unmount())
      dom.window.close()
      for (const [key, descriptor] of Object.entries(previous)) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor)
        else delete globalThis[key]
      }
    },
  }
}

const file = { id: 'same-deck', filename: 'deck.pptx', type: 'pptx' }
const url = '/api/artifacts/deck.pptx?preview=1'
const t = (key) => key

function LiveArtifactPreview({ initialState, exposeDispatch }) {
  const [state, dispatch] = useReducer(reducer, initialState)
  useEffect(() => exposeDispatch(dispatch), [dispatch, exposeDispatch])
  return <>
    <output data-testid="live-preview-tabs" data-active-id={state.previewActiveId} data-count={state.previewTabs.length} />
    <DirectFilePreview file={state.previewArtifact.directFile} url={url} t={t} />
  </>
}

function PaneStateProbe({ artifact }) {
  const pane = usePreviewPaneState({ artifact })
  return <>
    <button type="button" onClick={() => pane.setMaximized(true)}>Maximize</button>
    <output data-testid="pane-state" data-maximized={String(pane.maximized)} />
  </>
}

test('PPTX original-file preview displays parsed drawing, never the Markdown HTML template', async () => {
  const original = await bytes()
  const h = harness()
  const requests = []
  globalThis.fetch = async (input, init) => { requests.push({ input, init }); return new Response(original) }
  try {
    await act(async () => h.root.render(<DirectFilePreview file={file} url={url} t={t} />))
    await h.settle()
    const canvas = h.container.querySelector('[data-testid="pptx-original-layout"]')
    assert.ok(canvas)
    assert.equal(canvas.getAttribute('viewBox'), '0 0 1280 720')
    assert.equal(canvas.firstElementChild.getAttribute('fill'), 'rgba(17,51,85,1)')
    assert.match(canvas.querySelector('g').getAttribute('transform'), /^translate\(96 96\)/)
    assert.equal(canvas.querySelector('foreignObject span').style.fontFamily, 'Georgia')
    assert.match(canvas.textContent, /Same content/)
    assert.equal(h.container.querySelector('iframe'), null)
    assert.match(h.container.textContent, /chatPreview\.pptxLayoutNotice/)
    assert.deepEqual(requests.map((request) => request.input), [url])
    assert.equal(requests[0].init.cache, 'no-store')
  } finally { await h.close() }
})

test('unsupported binary slides are explicitly text-only and preserve the independent original download', async () => {
  const original = await bytes({ unsupported: true })
  const h = harness()
  globalThis.fetch = async () => new Response(original)
  try {
    await act(async () => h.root.render(<>
      <DirectFileToolbar filename={file.filename} type="pptx" url="/api/artifacts/deck.pptx" t={t} />
      <DirectFilePreview file={file} url={url} t={t} />
    </>))
    await h.settle()
    assert.equal(h.container.querySelector('[data-testid="pptx-original-layout"]'), null)
    assert.ok(h.container.querySelector('[data-testid="pptx-text-outline"]'))
    assert.ok(h.container.querySelector('[data-testid="pptx-layout-unavailable"]'))
    assert.equal(h.container.querySelector('details').open, false, 'an outline does not masquerade as the rendered slide')
    assert.match(h.container.textContent, /chatPreview\.pptxOutlineNotice/)
    assert.match(h.container.textContent, /Same content/)
    assert.equal(h.container.querySelector('iframe'), null)
    assert.equal(h.container.querySelector('a[download="deck.pptx"]').getAttribute('href'), '/api/artifacts/deck.pptx')
  } finally { await h.close() }
})

test('same id and URL with a new preview revision refetches and redraws changed style', async () => {
  const originals = [await bytes(), await bytes({ background: 'FFEEDD', font: 'Arial', x: 2 })]
  const h = harness()
  const requests = []
  globalThis.fetch = async (input, init) => {
    requests.push({ input, init })
    return new Response(originals[Math.min(requests.length - 1, 1)])
  }
  try {
    await act(async () => h.root.render(<DirectFilePreview file={{ ...file, previewRevision: 'v1' }} url={url} t={t} />))
    await h.settle()
    const first = h.container.querySelector('[data-testid="pptx-original-layout"]')
    await act(async () => h.root.render(<DirectFilePreview file={{ ...file, previewRevision: 'v1' }} url={url} t={t} />))
    assert.equal(requests.length, 1, 'ordinary React rerenders do not refetch stable revisions')
    await act(async () => h.root.render(<DirectFilePreview file={{ ...file, previewRevision: 'v2' }} url={url} t={t} />))
    await h.settle()
    const current = h.container.querySelector('[data-testid="pptx-original-layout"]')
    assert.notEqual(current, first)
    assert.equal(current.firstElementChild.getAttribute('fill'), 'rgba(255,238,221,1)')
    assert.equal(current.querySelector('foreignObject span').style.fontFamily, 'Arial')
    assert.match(current.querySelector('g').getAttribute('transform'), /^translate\(192 96\)/)
    assert.deepEqual(requests.map((request) => request.input), [url, url])
    assert.ok(requests.every((request) => request.init.cache === 'no-store'))
    assert.equal(requests[0].init.signal.aborted, true)
  } finally { await h.close() }
})

test('a late old-revision response cannot replace the newer PPTX preview', async () => {
  const first = await bytes({ text: 'Stale slide' })
  const second = await bytes({ text: 'Current slide', background: 'FFEEDD' })
  const h = harness()
  const requests = []
  let resolveFirst
  globalThis.fetch = (input, init) => {
    requests.push({ input, init })
    return requests.length === 1 ? new Promise((resolve) => { resolveFirst = resolve }) : Promise.resolve(new Response(second))
  }
  try {
    await act(async () => h.root.render(<DirectFilePreview file={{ ...file, previewRevision: 'v1' }} url={url} t={t} />))
    assert.equal(typeof resolveFirst, 'function')
    await act(async () => h.root.render(<DirectFilePreview file={{ ...file, previewRevision: 'v2' }} url={url} t={t} />))
    await h.settle()
    assert.equal(requests[0].init.signal.aborted, true)
    assert.match(h.container.textContent, /Current slide/)
    await act(async () => resolveFirst(new Response(first)))
    await h.settle()
    assert.match(h.container.textContent, /Current slide/)
    assert.doesNotMatch(h.container.textContent, /Stale slide/)
  } finally { await h.close() }
})

test('successful PPTX previews expose an in-place refresh for same-path local edits', async () => {
  const originals = [await bytes(), await bytes({ background: 'FFEEDD' })]
  const h = harness()
  const requests = []
  globalThis.fetch = async (input) => {
    requests.push(input)
    return new Response(originals[Math.min(requests.length - 1, 1)])
  }
  try {
    await act(async () => h.root.render(<DirectFilePreview file={file} url={url} t={t} />))
    await h.settle()
    const refresh = [...h.container.querySelectorAll('button')].find((button) => button.textContent.includes('chatPreview.refreshPreview'))
    assert.ok(refresh)
    await act(async () => refresh.click())
    await h.settle()
    assert.deepEqual(requests, [url, `${url}&previewRetry=1`])
    assert.equal(h.container.querySelector('[data-testid="pptx-original-layout"] rect').getAttribute('fill'), 'rgba(255,238,221,1)')
  } finally { await h.close() }
})

test('PPTX text is React-escaped and never interpreted as scripts, image URLs, or HTML', async () => {
  const text = '<script>window.pptxInjected = true</script><img src="https://attacker.invalid/x" onerror="alert(1)">'
  const original = await bytes({ text })
  const h = harness()
  const requests = []
  globalThis.fetch = async (input) => { requests.push(input); return new Response(original) }
  try {
    await act(async () => h.root.render(<DirectFilePreview file={file} url={url} t={t} />))
    await h.settle()
    assert.match(h.container.textContent, /window\.pptxInjected = true/)
    assert.equal(h.container.querySelector('script, img, iframe'), null)
    assert.equal(h.dom.window.pptxInjected, undefined)
    assert.deepEqual(requests, [url])
  } finally { await h.close() }
})

test('outline-only PPTX files do not regain a template when page metadata is absent', async () => {
  const zip = new JSZip()
  zip.file('ppt/slides/slide1.xml', '<p:sld xmlns:p="p" xmlns:a="a"><a:p><a:r><a:t>Outline only</a:t></a:r></a:p></p:sld>')
  const original = await zip.generateAsync({ type: 'nodebuffer' })
  const h = harness()
  globalThis.fetch = async () => new Response(original)
  try {
    await act(async () => h.root.render(<DirectFilePreview file={file} url={url} t={t} />))
    await h.settle()
    assert.match(h.container.textContent, /chatPreview\.pptxOutlineNotice/)
    assert.match(h.container.textContent, /Outline only/)
    assert.equal(h.container.querySelector('iframe, [data-testid="pptx-original-layout"]'), null)
  } finally { await h.close() }
})

test('completed style revision flows through the event, same-id stream collection, app reducer, and real PPTX redraw', async () => {
  const originals = [await bytes(), await bytes({ background: 'FFEEDD', font: 'Arial' })]
  const h = harness()
  const requests = []
  globalThis.fetch = async (input) => {
    requests.push(input)
    return new Response(originals[Math.min(requests.length - 1, 1)])
  }
  const originalFile = { ...file, url, previewRevision: 'a'.repeat(64) }
  const serverArtifacts = [originalFile]
  const initialState = reducer({
    sessions: [{ id: 'session', messages: [{ id: 'message', role: 'assistant', content: '', meta: {
      serverTurnId: 'turn', serverLastSequence: 0, serverArtifacts: [originalFile], streaming: true,
    } }] }], activeSessionId: 'session', previewArtifact: null, previewTabs: [], previewActiveId: '',
  }, { type: 'OPEN_PREVIEW_ARTIFACT', payload: artifactReferenceOpenPayload(originalFile, 'message') })
  let dispatch
  const exposeDispatch = (value) => { dispatch = value }
  try {
    await act(async () => h.root.render(<LiveArtifactPreview initialState={initialState} exposeDispatch={exposeDispatch} />))
    await h.settle()
    assert.equal(requests.length, 1)
    await act(async () => dispatchTurnEvent(createTurnEvent({
      id: 'revise-completed', sessionId: 'session', turnId: 'turn', type: 'tool.completed', sequence: 1, createdAt: 2,
      payload: { toolCallId: 'revision-call', name: 'create_pptx', artifactId: originalFile.id, result: {
        ok: true, artifactId: originalFile.id, filename: originalFile.filename, url, previewRevision: 'b'.repeat(64),
      } },
    }), {
      dispatch, taskId: 'task', messageTarget: { sessionId: 'session', messageId: 'message' },
      onArtifact: (artifact) => appendServerArtifact(artifact, serverArtifacts, (type, payload) => dispatch({
        type, payload, sessionId: 'session', messageId: 'message',
      })),
    }))
    await h.settle(() => h.container.querySelector('[data-testid="pptx-original-layout"] rect')?.getAttribute('fill') === 'rgba(255,238,221,1)')
    assert.deepEqual(requests, [url, url])
    assert.equal(h.container.querySelector('foreignObject span').style.fontFamily, 'Arial')
    const tabs = h.container.querySelector('[data-testid="live-preview-tabs"]')
    assert.equal(tabs.getAttribute('data-count'), '1')
    assert.equal(tabs.getAttribute('data-active-id'), initialState.previewActiveId)
    assert.equal(serverArtifacts.length, 1)
    assert.equal(serverArtifacts[0].previewRevision, 'b'.repeat(64))
  } finally { await h.close() }
})

test('same-file cache revisions preserve the user pane state while switching files still resets it', async () => {
  const h = harness()
  try {
    await act(async () => h.root.render(<PaneStateProbe artifact={{ directFile: { ...file, url, previewRevision: 'a' } }} />))
    await act(async () => h.container.querySelector('button').click())
    assert.equal(h.container.querySelector('output').getAttribute('data-maximized'), 'true')
    await act(async () => h.root.render(<PaneStateProbe artifact={{ directFile: { ...file, url, previewRevision: 'b' } }} />))
    assert.equal(h.container.querySelector('output').getAttribute('data-maximized'), 'true')
    await act(async () => h.root.render(<PaneStateProbe artifact={{ directFile: { ...file, id: 'other-file', url: '/api/artifacts/other.pptx' } }} />))
    assert.equal(h.container.querySelector('output').getAttribute('data-maximized'), 'false')
  } finally { await h.close() }
})
