import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import RightPreviewPane from '../../src/pages/ChatSplit/RightPreviewPane.jsx'
import { DirectFileToolbar } from '../../src/pages/ChatSplit/preview/PreviewChrome.jsx'
import MarkdownRenderer from '../../src/components/MarkdownRenderer.jsx'

const artifact = { messageId: 'layout-fixture', content: 'Original content', preview: {
  type: 'docx', filename: 'A long original presentation filename for the layout regression.docx', blocks: [],
} }

function harness(initialWidth = 1000, preferred = 900) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' })
  for (const name of ['window', 'document', 'HTMLElement', 'SVGElement', 'MouseEvent', 'KeyboardEvent', 'localStorage']) {
    globalThis[name] = name === 'window' ? dom.window : dom.window[name]
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  // React DOM was imported before JSDOM; its input fallback expects these IE
  // hooks when a real textarea receives focus in this synthetic environment.
  dom.window.HTMLElement.prototype.attachEvent = () => {}
  dom.window.HTMLElement.prototype.detachEvent = () => {}
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
  Object.defineProperty(dom.window, 'innerWidth', { configurable: true, value: 1600 })
  globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0)
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id)
  let width = initialWidth
  const observers = new Set()
  dom.window.ResizeObserver = class {
    constructor(callback) { this.callback = callback; observers.add(this) }
    observe(target) { this.target = target }
    disconnect() { observers.delete(this) }
  }
  const originalRect = dom.window.HTMLElement.prototype.getBoundingClientRect
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.hasAttribute('data-chat-main-area')) return { width, height: 800, top: 0, left: 280, right: 280 + width, bottom: 800 }
    return originalRect.call(this)
  }
  dom.window.localStorage.setItem('preview-pane-width', String(preferred))
  dom.window.localStorage.setItem('gugo:left-rail-collapsed', '0')
  const rootEl = dom.window.document.getElementById('root')
  const root = createRoot(rootEl)
  function Scene() {
    const [open, setOpen] = useState(true)
    return <>
      <nav className="left-rail"><button type="button">Navigation</button></nav>
      <div data-chat-main-area>
        <div className="chat-main-pane"><div data-testid="chat-scroll"><button type="button" data-testid="chat-opener">Conversation</button></div><div data-testid="chat-composer-surface"><textarea aria-label="Chat input" /></div></div>
        {open && <RightPreviewPane artifact={artifact} onClose={() => setOpen(false)} />}
      </div>
    </>
  }
  return {
    dom, rootEl,
    render: async (element = <Scene />) => act(async () => root.render(element)),
    resize: async (nextWidth) => act(async () => {
      width = nextWidth
      for (const observer of observers) observer.callback([{ target: observer.target, contentRect: { width } }])
    }),
    click: async (element) => act(async () => element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))),
    cleanup: async () => { await act(async () => root.unmount()); dom.window.close() },
  }
}

test('preview observes the main container and preserves a saved wide preference across layout changes', async () => {
  const h = harness(1000)
  try {
    await h.render()
    const pane = h.rootEl.querySelector('[data-testid="preview-pane"]')
    assert.equal(pane.style.width, '520px')
    assert.equal(pane.dataset.previewLayout, 'split')
    assert.equal(h.rootEl.querySelector('[role="separator"]').getAttribute('aria-valuemax'), '520')
    await h.resize(900)
    assert.equal(pane.style.width, '420px')
    assert.equal(h.dom.window.localStorage.getItem('preview-pane-width'), '900')
    await h.resize(1440)
    assert.equal(pane.style.width, '900px')
    assert.equal(h.dom.window.localStorage.getItem('gugo:left-rail-collapsed'), '0')
  } finally { await h.cleanup() }
})

test('narrow main area focuses preview, offers maximize and returns focus to an unchanged chat', async () => {
  const h = harness(1000)
  try {
    await h.render()
    const opener = h.rootEl.querySelector('[data-testid="chat-opener"]')
    const scrollRegion = h.rootEl.querySelector('[data-testid="chat-scroll"]')
    scrollRegion.scrollTop = 320
    opener.focus()
    await h.resize(800)
    const pane = h.rootEl.querySelector('[data-testid="preview-pane"]')
    const chat = h.rootEl.querySelector('.chat-main-pane')
    const navigation = h.rootEl.querySelector('.left-rail')
    assert.equal(pane.dataset.previewLayout, 'focused')
    assert.equal(pane.style.width, '')
    assert.equal(h.rootEl.querySelector('[role="separator"]'), null)
    assert.equal(chat.hasAttribute('inert'), true)
    assert.equal(navigation.hasAttribute('inert'), false, 'focused mode leaves the visible navigation available')
    const back = h.rootEl.querySelector('[data-testid="preview-back-to-chat"]')
    assert.equal(h.dom.window.document.activeElement, back)
    await h.click(h.rootEl.querySelector('button[aria-label="最大化"]'))
    assert.equal(pane.dataset.previewLayout, 'maximized')
    assert.equal(navigation.hasAttribute('inert'), true)
    assert.equal(navigation.getAttribute('aria-hidden'), 'true')
    await h.click(h.rootEl.querySelector('button[aria-label="还原"]'))
    assert.equal(pane.dataset.previewLayout, 'focused')
    assert.equal(navigation.hasAttribute('inert'), false)
    assert.equal(navigation.hasAttribute('aria-hidden'), false)
    await h.click(back)
    assert.equal(h.rootEl.querySelector('[data-testid="preview-pane"]'), null)
    assert.equal(chat.hasAttribute('inert'), false)
    assert.equal(chat.hasAttribute('aria-hidden'), false)
    assert.equal(h.dom.window.document.activeElement, opener)
    assert.strictEqual(h.rootEl.querySelector('[data-testid="chat-scroll"]'), scrollRegion)
    assert.equal(scrollRegion.scrollTop, 320)
    assert.equal(h.dom.window.localStorage.getItem('gugo:left-rail-collapsed'), '0')
  } finally { await h.cleanup() }
})

test('a removed workbench opener falls back to the chat composer without moving the transcript', async () => {
  const h = harness(1000)
  const obsoleteOpener = h.dom.window.document.createElement('a')
  obsoleteOpener.href = '#open-file'
  obsoleteOpener.textContent = 'Workbench file'
  h.dom.window.document.body.append(obsoleteOpener)
  obsoleteOpener.focus()
  try {
    await h.render()
    obsoleteOpener.remove()
    const scrollRegion = h.rootEl.querySelector('[data-testid="chat-scroll"]')
    scrollRegion.scrollTop = 640
    const composer = h.rootEl.querySelector('textarea')
    const originalFocus = composer.focus
    let focusOptions
    composer.focus = function (options) { focusOptions = options; return originalFocus.call(this, options) }
    await h.resize(800)
    await h.click(h.rootEl.querySelector('[data-testid="preview-back-to-chat"]'))
    assert.equal(h.dom.window.document.activeElement, composer)
    assert.deepEqual(focusOptions, { preventScroll: true })
    assert.equal(scrollRegion.scrollTop, 640)
    assert.strictEqual(h.rootEl.querySelector('[data-testid="chat-scroll"]'), scrollRegion)
    assert.equal(h.dom.window.localStorage.getItem('gugo:left-rail-collapsed'), '0')
  } finally { await h.cleanup() }
})

test('keyboard resizing uses displayed width and clamps both pointer and stored preferences to the main area', async () => {
  const h = harness(1100, 520)
  try {
    await h.render()
    const separator = h.rootEl.querySelector('[role="separator"]')
    const key = async (value) => act(async () => separator.dispatchEvent(new h.dom.window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true })))
    await key('ArrowLeft')
    assert.equal(separator.getAttribute('aria-valuenow'), '544')
    await key('End')
    assert.equal(separator.getAttribute('aria-valuenow'), '620')
    await key('ArrowLeft')
    assert.equal(separator.getAttribute('aria-valuenow'), '620')
    await act(async () => {
      separator.dispatchEvent(new h.dom.window.MouseEvent('pointerdown', { button: 0, clientX: 600, bubbles: true }))
    })
    await act(async () => {
      h.dom.window.dispatchEvent(new h.dom.window.MouseEvent('pointermove', { clientX: 1200, bubbles: true }))
      h.dom.window.dispatchEvent(new h.dom.window.MouseEvent('pointerup', { bubbles: true }))
    })
    assert.equal(separator.getAttribute('aria-valuenow'), '360')
    assert.equal(h.dom.window.localStorage.getItem('preview-pane-width'), '360')
    await key('Home')
    assert.equal(separator.getAttribute('aria-valuenow'), '520')
    await act(async () => separator.dispatchEvent(new h.dom.window.MouseEvent('pointerdown', { button: 0, clientX: 600, bubbles: true })))
    assert.ok(h.rootEl.querySelector('[data-testid="preview-resize-shield"]'))
    await h.resize(800)
    assert.equal(h.rootEl.querySelector('[data-testid="preview-resize-shield"]'), null)
    assert.equal(h.dom.window.document.body.style.cursor, '')
    await h.resize(1100)
    assert.equal(h.rootEl.querySelector('[data-testid="preview-resize-shield"]'), null)
    assert.equal(h.dom.window.localStorage.getItem('preview-pane-width'), '520')
  } finally { await h.cleanup() }
})

test('closing the final focused tab restores chat focus without also dispatching pane-close', async () => {
  const h = harness(1000)
  let tabCloses = 0
  let paneCloses = 0
  function LastTabScene() {
    const [open, setOpen] = useState(true)
    return <div data-chat-main-area>
      <div className="chat-main-pane"><button type="button" data-testid="last-tab-opener">Conversation</button></div>
      {open && <RightPreviewPane artifact={artifact} onClose={() => { paneCloses += 1 }} onCloseTab={() => { tabCloses += 1; setOpen(false) }} />}
    </div>
  }
  try {
    await h.render(<LastTabScene />)
    const opener = h.rootEl.querySelector('[data-testid="last-tab-opener"]')
    opener.focus()
    await h.resize(800)
    await h.click(h.rootEl.querySelector('[data-testid="preview-tab-close"]'))
    assert.equal(tabCloses, 1)
    assert.equal(paneCloses, 0)
    assert.equal(h.rootEl.querySelector('[data-testid="preview-pane"]'), null)
    assert.equal(h.rootEl.querySelector('.chat-main-pane').hasAttribute('inert'), false)
    assert.equal(h.dom.window.document.activeElement, opener)
  } finally { await h.cleanup() }
})

test('download control is compact while its accessible label and destination keep the complete filename', async () => {
  const h = harness()
  const filename = 'Very long original name with spaces and a literal ` character.pptx'
  const url = '/api/local-files/verified/exact-receipt?turnId=original-turn'
  const t = (key, values = {}) => key === 'chatPreview.download' ? `Download ${values.filename}` : 'Download'
  try {
    await h.render(<DirectFileToolbar filename={filename} type="pptx" url={url} t={t} />)
    const download = h.rootEl.querySelector('a[download]')
    assert.equal(download.textContent, 'Download')
    assert.equal(download.getAttribute('aria-label'), `Download ${filename}`)
    assert.equal(download.getAttribute('title'), `Download ${filename}`)
    assert.equal(download.getAttribute('download'), filename)
    assert.equal(download.getAttribute('href'), url)
    assert.equal(h.rootEl.querySelector('.chat-preview-file-identity [title]').getAttribute('title'), filename)
  } finally { await h.cleanup() }
})

test('verified inline-code filenames keep source text and exact href while gaining a full tooltip', async () => {
  const h = harness()
  const filename = 'Original presentation.pptx'
  const url = '/api/artifacts/exact-original-id'
  const markdown = 'Ordinary code: `compute()`. Download `Original presentation.pptx`.'
  try {
    await h.render(<MarkdownRenderer artifactReferences={[{ id: 'exact-original-id', filename, type: 'pptx', url }]}>{markdown}</MarkdownRenderer>)
    const link = h.rootEl.querySelector('[data-testid="inline-artifact-link"]')
    assert.equal(link.textContent, filename)
    assert.equal(link.getAttribute('title'), filename)
    assert.equal(link.getAttribute('href'), url)
    assert.equal(link.querySelector('code').textContent, filename)
    assert.ok([...h.rootEl.querySelectorAll('code')].some((code) => code.textContent === 'compute()' && !link.contains(code)))
    assert.equal(markdown, 'Ordinary code: `compute()`. Download `Original presentation.pptx`.')
  } finally { await h.cleanup() }
})
