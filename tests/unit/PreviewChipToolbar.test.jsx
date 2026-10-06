import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act, useState } from 'react'

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/chat' })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.SVGElement = dom.window.SVGElement
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  return dom
}

const t = (key, values = {}) => (values.value ? `${key}:${values.value}` : key)

/** react-dom/client must load after setupDom (see the JSX test bootstrap note). */
async function mount(element) {
  const { createRoot } = await import('react-dom/client')
  const container = document.getElementById('root')
  const root = createRoot(container)
  await act(async () => root.render(element))
  return { container, root, unmount: () => act(async () => root.unmount()) }
}

test('the file chip is the file itself, and the menu carries no redundant "preview here"', async () => {
  const dom = setupDom()
  const { DirectFileToolbar } = await import('../../src/pages/ChatSplit/preview/PreviewChrome.jsx')
  const file = { filename: '表2_已填写.docx', type: 'docx', path: 'D:\\docs\\表2_已填写.docx', url: '/api/artifacts/a.docx' }
  const requested = []
  const zoom = { zoom: 'fit', setZoom: () => {}, fitPercent: 70, setFitPercent: () => {} }
  const h = await mount(<DirectFileToolbar file={file} filename={file.filename} type="docx" zoom={zoom} onRequestChange={(preview) => requested.push(preview.path)} t={t} />)
  try {
    const chip = h.container.querySelector('[data-testid="preview-open-menu"]')
    assert.equal(chip.querySelector('[data-testid="preview-file-path"]').textContent, '表2_已填写')
    assert.ok(chip.querySelector('[data-file-family="word"]'), 'a Word file wears the Word glyph')
    assert.doesNotMatch(chip.closest('details').textContent, /openPreview/)
    // The zoom shows the scale fitting produced, like "70%" in the reference app.
    assert.equal(h.container.querySelector('[data-testid="preview-zoom"]').textContent.trim(), '70%')
    await act(async () => h.container.querySelector('[data-testid="preview-request-change"]').click())
    assert.deepEqual(requested, [file.path])
  } finally {
    await h.unmount()
    dom.window.close()
  }
})

test('zoom is offered only for laid-out pages, and choosing a level reports it', async () => {
  const dom = setupDom()
  const { DirectFileToolbar } = await import('../../src/pages/ChatSplit/preview/PreviewChrome.jsx')
  const { ZOOMABLE_KINDS } = await import('../../src/pages/ChatSplit/preview/previewZoomState.js')
  assert.deepEqual([...ZOOMABLE_KINDS].sort(), ['docx', 'image', 'pptx'])
  function Fixture({ filename, type }) {
    const [zoom, setZoom] = useState('fit')
    return <DirectFileToolbar file={{ filename, type }} filename={filename} type={type} zoom={{ zoom, setZoom, fitPercent: null, setFitPercent: () => {} }} t={t} />
  }
  const h = await mount(<Fixture filename="notes.md" type="md" />)
  try {
    assert.equal(h.container.querySelector('[data-testid="preview-zoom"]'), null, 'text reflows; it has no page to zoom')
    await act(async () => h.root.render(<Fixture filename="deck.pptx" type="pptx" />))
    assert.match(h.container.querySelector('[data-testid="preview-zoom"]').textContent, /chatPreview\.zoomFit/)
    await act(async () => h.container.querySelector('[data-testid="preview-zoom-150"]').click())
    assert.equal(h.container.querySelector('[data-testid="preview-zoom"]').textContent.trim(), '150%')
    assert.equal(h.container.querySelector('[data-testid="preview-zoom-150"]').getAttribute('aria-checked'), 'true')
  } finally {
    await h.unmount()
    dom.window.close()
  }
})

test('fit scales a page down to the pane but never up, and a chosen level is exact', async () => {
  const { previewScale } = await import('../../src/pages/ChatSplit/preview/previewZoomState.js')
  assert.equal(Math.round(previewScale('fit', 794, 519) * 100), 61)
  assert.equal(previewScale('fit', 400, 1200), 1)
  assert.equal(previewScale(125, 794, 519), 1.25)
  assert.equal(previewScale('fit', 0, 519), 1, 'an unknown page size is drawn as is')
})

test('a format the pane cannot draw offers its own app and folder in the desktop app', async () => {
  const dom = setupDom()
  const actions = []
  dom.window.localStorage.setItem('your-model-atelier:auth-token', 'synthetic-token')
  dom.window.gugoDesktop = { isDesktop: true, fileAction: async ({ action }) => { actions.push(action); return { ok: true, action } } }
  const { default: UnsupportedFilePreview } = await import('../../src/pages/ChatSplit/preview/UnsupportedFilePreview.jsx')
  const file = { filename: 'old.ppt', type: 'ppt', url: '/api/local-files/verified/receipt?turnId=turn' }
  const h = await mount(<UnsupportedFilePreview file={file} url={file.url} t={t} />)
  try {
    assert.match(h.container.textContent, /chatPreview\.unsupportedDesktopHint/)
    await act(async () => h.container.querySelector('[data-testid="unsupported-reveal"]').click())
    assert.deepEqual(actions, ['reveal'])
    assert.match(h.container.querySelector('[role="status"]').textContent, /fileRevealRequested/)
  } finally {
    await h.unmount()
    dom.window.close()
  }
})

test('opening a change from the review opens the side panel first, then the diff', async () => {
  const dom = setupDom()
  const { default: useChatOverlays } = await import('../../src/pages/ChatSplit/useChatOverlays.js')
  const order = []
  let review = null
  function Probe() {
    review = useChatOverlays({
      dispatch: (action) => order.push(action.type),
      setWorkbenchOpen: (open) => order.push(`open:${open}`),
      setWorkbenchTab: () => {},
      setPlanVisible: () => {},
    }).sessionChangesReview
    return null
  }
  const h = await mount(<Probe />)
  try {
    await act(async () => review.openDiff({ key: 'd:/a.js', path: 'D:/a.js', displayPath: 'a.js', reported: { additions: 1, deletions: 0 } }, []))
    // The preview pane only exists inside the open side panel; dispatching
    // alone used to leave the click with nothing on screen.
    assert.deepEqual(order, ['open:true', 'OPEN_PREVIEW_ARTIFACT'])
  } finally {
    await h.unmount()
    dom.window.close()
  }
})
