import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import { I18nProvider } from '../../src/i18n/I18nProvider.jsx'
import { ChatRightPanels } from '../../src/pages/ChatSplit/ChatSplitView.jsx'
import { resetDockForTests } from '../../src/pages/ChatSplit/dock/dockStore.js'

/**
 * The workbench and an open file are panes that live at the same time.
 *
 * They used to be the two branches of one ternary — opening a file took the
 * panel away from whatever tool was on screen — and this file used to assert
 * exactly that. The requirement changed: the reader keeps both, so what these
 * tests pin now is coexistence and the slots each pane is placed in.
 */
function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/chat' })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.SVGElement = dom.window.SVGElement
  globalThis.MouseEvent = dom.window.MouseEvent
  globalThis.KeyboardEvent = dom.window.KeyboardEvent
  globalThis.localStorage = dom.window.localStorage
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  resetDockForTests()
  return dom
}

const noop = () => {}
const PREVIEW_ARTIFACT = Object.freeze({
  messageId: 'final-message',
  content: '',
  preview: null,
  directFile: { id: 'final-pdf', filename: 'final-report.pdf', type: 'pdf', url: '/api/artifacts/final-pdf' },
})

function baseProps(overrides = {}) {
  return {
    workbenchOpen: true,
    messages: [],
    attachments: [],
    workbenchTab: 'files',
    onWorkbenchTabChange: noop,
    onCloseWorkbench: noop,
    onOpenArtifact: noop,
    onWorkbenchSend: noop,
    isGenerating: false,
    workbenchMessage: '',
    onClosePreview: noop,
    onPreviewMessage: noop,
    previewTabs: [],
    previewActiveId: '',
    onActivatePreviewTab: noop,
    onClosePreviewTab: noop,
    ...overrides,
  }
}

test('the workbench alone takes the top pane, with nothing below it', async () => {
  const dom = setupDom()
  const root = createRoot(dom.window.document.getElementById('root'))
  const el = () => dom.window.document
  try {
    await act(async () => root.render(<I18nProvider><ChatRightPanels {...baseProps()} /></I18nProvider>))
    assert.ok(el().querySelector('[data-testid="right-pane-grid"]'), 'the region lays its panes out')
    assert.ok(el().querySelector('[data-testid="right-pane-top"] [data-testid="right-workbench"]'))
    assert.equal(el().querySelector('[data-testid="right-pane-bottom"]'), null, 'nothing is below an empty bottom row')
    assert.equal(el().querySelector('[data-testid="direct-file-pane"]'), null)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('an open file joins the workbench in the bottom row instead of replacing it', async () => {
  const dom = setupDom()
  const root = createRoot(dom.window.document.getElementById('root'))
  const el = () => dom.window.document
  try {
    await act(async () => root.render(
      <I18nProvider><ChatRightPanels {...baseProps({ previewArtifact: PREVIEW_ARTIFACT })} /></I18nProvider>,
    ))
    assert.ok(el().querySelector('[data-testid="right-pane-top"] [data-testid="right-workbench"]'), 'the workbench keeps its pane')
    assert.ok(el().querySelector('[data-testid="right-pane-bottom-right"] [data-testid="direct-file-pane"]'), 'the file gets its own')
    assert.equal(
      el().querySelector('[data-testid="workbench-tool-switch"] [aria-current="page"]').getAttribute('data-tool'),
      'files',
    )
    assert.ok(el().querySelector('[data-testid="workbench-files"]'), 'the workspace files panel is still rendered')
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('a region with nothing to show renders nothing at all', async () => {
  const dom = setupDom()
  const root = createRoot(dom.window.document.getElementById('root'))
  try {
    await act(async () => root.render(
      <I18nProvider><ChatRightPanels {...baseProps({ workbenchOpen: false, previewArtifact: null, planVisible: false })} /></I18nProvider>,
    ))
    assert.equal(dom.window.document.querySelector('[data-testid="right-pane-grid"]'), null)
    assert.equal(dom.window.document.querySelector('[data-testid="direct-file-pane"]'), null)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('a file opens on its own without switching the tool panel on', async () => {
  const dom = setupDom()
  const root = createRoot(dom.window.document.getElementById('root'))
  const el = () => dom.window.document
  try {
    // The tool panel was never asked for. Opening a file used to switch it on so
    // the file had somewhere to appear, which also parked the tool list in the
    // pane above it — half the region showing a launcher nobody had opened.
    await act(async () => root.render(
      <I18nProvider><ChatRightPanels {...baseProps({ workbenchOpen: false, previewArtifact: PREVIEW_ARTIFACT })} /></I18nProvider>,
    ))
    assert.ok(el().querySelector('[data-testid="direct-file-pane"]'), 'the file is up')
    assert.equal(el().querySelector('[data-testid="right-pane-top"]'), null, 'and nothing shares the region with it')
    assert.equal(el().querySelector('[data-testid="right-workbench"]'), null)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('closing the file leaves the workbench where it was', async () => {
  const dom = setupDom()
  const root = createRoot(dom.window.document.getElementById('root'))
  const el = () => dom.window.document
  const render = (props) => act(async () => root.render(
    <I18nProvider><ChatRightPanels {...props} /></I18nProvider>,
  ))
  try {
    await render(baseProps({ previewArtifact: PREVIEW_ARTIFACT }))
    assert.ok(el().querySelector('[data-testid="direct-file-pane"]'))
    await render(baseProps({ previewArtifact: null }))
    assert.ok(el().querySelector('[data-testid="right-workbench"]'), 'the workbench is still there')
    assert.equal(el().querySelector('[data-testid="direct-file-pane"]'), null)
    assert.equal(el().querySelector('[data-testid="right-pane-bottom"]'), null, 'the bottom row goes with it')
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('the task list takes the bottom-left pane beside an open file', async () => {
  const dom = setupDom()
  const root = createRoot(dom.window.document.getElementById('root'))
  const el = () => dom.window.document
  try {
    await act(async () => root.render(
      <I18nProvider>
        <ChatRightPanels {...baseProps({ planVisible: true, previewArtifact: PREVIEW_ARTIFACT, todos: [] })} />
      </I18nProvider>,
    ))
    assert.ok(el().querySelector('[data-testid="right-pane-bottom-left"]'), 'the task list has its own pane')
    assert.ok(el().querySelector('[data-testid="right-pane-bottom-right"] [data-testid="direct-file-pane"]'))
    assert.ok(el().querySelector('[data-testid="right-pane-row-divider"]'), 'the two rows can be dragged apart')
    assert.ok(el().querySelector('[data-testid="right-pane-column-divider"]'), 'so can the two below')
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})
