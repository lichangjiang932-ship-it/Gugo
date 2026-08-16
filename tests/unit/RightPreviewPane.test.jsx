import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { act, useEffect, useReducer, useState } from 'react'
import { createRoot } from 'react-dom/client'

import RightPreviewPane from '../../src/pages/ChatSplit/RightPreviewPane.jsx'
import { createInitialState } from '../../src/store/appStateBootstrap.js'
import { reduceTaskSettingsState } from '../../src/store/reducers/taskSettingsReducer.js'

const artifact = {
  messageId: 'msg-1',
  content: '# Preview document',
  preview: {
    type: 'docx',
    title: 'Preview document',
    label: 'DOCX',
    summary: 'Document preview',
    filename: 'preview.docx',
    blocks: [{ type: 'heading', text: 'Preview document' }],
  },
}

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/',
  })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.SVGElement = dom.window.SVGElement
  globalThis.KeyboardEvent = dom.window.KeyboardEvent
  globalThis.MouseEvent = dom.window.MouseEvent
  globalThis.localStorage = dom.window.localStorage
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: dom.window.navigator,
  })
  globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0)
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id)
  return dom
}

async function renderPane(onClose, artifactOverride = artifact, prepareDocument) {
  const dom = setupDom()
  const rootEl = dom.window.document.getElementById('root')
  prepareDocument?.(dom.window.document)
  const root = createRoot(rootEl)

  function ControlledPreviewPane({ nextArtifact }) {
    const [visible, setVisible] = useState(true)
    const [state, dispatch] = useReducer(
      reduceTaskSettingsState,
      nextArtifact,
      (initialArtifact) => reduceTaskSettingsState(createInitialState(), {
        type: 'OPEN_PREVIEW_ARTIFACT',
        payload: initialArtifact,
      }),
    )

    useEffect(() => {
      dispatch({ type: 'OPEN_PREVIEW_ARTIFACT', payload: nextArtifact })
      setVisible(true)
    }, [nextArtifact])

    return (
      <>
        <button type="button" data-testid="test-preview-toggle" onClick={() => setVisible((current) => !current)}>
          Toggle preview
        </button>
        <output
          data-testid="test-preview-state"
          data-tab-count={state.previewTabs.length}
          data-active-id={state.previewActiveId}
        />
        {visible && state.previewArtifact ? (
          <RightPreviewPane
            artifact={state.previewArtifact}
            previewTabs={state.previewTabs}
            activePreviewId={state.previewActiveId}
            onActivateTab={(tabId) => dispatch({ type: 'ACTIVATE_PREVIEW_TAB', payload: tabId })}
            onCloseTab={(tabId) => dispatch({ type: 'CLOSE_PREVIEW_TAB', payload: tabId })}
            onClose={() => {
              setVisible(false)
              onClose()
            }}
            onMessage={() => {}}
          />
        ) : null}
      </>
    )
  }

  const renderArtifact = async (nextArtifact) => {
    await act(async () => {
      root.render(<ControlledPreviewPane nextArtifact={nextArtifact} />)
    })
  }

  await renderArtifact(artifactOverride)

  return {
    dom,
    rootEl,
    rerender: renderArtifact,
    cleanup: async () => {
      await act(async () => {
        root.unmount()
      })
    },
  }
}

test('preview reducer opens, activates, and closes tabs without losing sibling files', () => {
  const first = {
    messageId: 'msg-reducer-alpha',
    content: 'alpha',
    preview: { type: 'text', filename: 'alpha.txt' },
  }
  const second = {
    messageId: 'msg-reducer-beta',
    content: 'beta',
    preview: { type: 'text', filename: 'beta.txt' },
  }
  const third = {
    messageId: 'msg-reducer-gamma',
    content: 'gamma',
    preview: { type: 'text', filename: 'gamma.txt' },
  }
  const dispatch = (state, type, payload) => reduceTaskSettingsState(state, { type, payload })

  let state = createInitialState()
  state = dispatch(state, 'OPEN_PREVIEW_ARTIFACT', first)
  const firstId = state.previewActiveId
  state = dispatch(state, 'OPEN_PREVIEW_ARTIFACT', second)
  const secondId = state.previewActiveId
  state = dispatch(state, 'OPEN_PREVIEW_ARTIFACT', third)
  const thirdId = state.previewActiveId

  assert.deepEqual(state.previewTabs.map((tab) => tab.preview.filename), ['alpha.txt', 'beta.txt', 'gamma.txt'])
  assert.equal(state.previewArtifact, third)

  state = dispatch(state, 'ACTIVATE_PREVIEW_TAB', firstId)
  assert.equal(state.previewArtifact, first)

  state = dispatch(state, 'CLOSE_PREVIEW_TAB', secondId)
  assert.deepEqual(state.previewTabs.map((tab) => tab.preview.filename), ['alpha.txt', 'gamma.txt'])
  assert.equal(state.previewActiveId, firstId)

  state = dispatch(state, 'CLOSE_PREVIEW_TAB', firstId)
  assert.equal(state.previewActiveId, thirdId)
  assert.equal(state.previewArtifact, third)

  state = dispatch(state, 'CLOSE_PREVIEW_TAB', thirdId)
  assert.deepEqual(state.previewTabs, [])
  assert.equal(state.previewArtifact, null)
})

test('preview reducer refreshes a revised direct file instead of duplicating its tab', () => {
  const original = {
    messageId: 'msg-original',
    artifactIdentity: 'msg-original:smoke.html',
    content: '',
    preview: null,
    directFile: {
      id: 'local-file-stable',
      filename: 'smoke.html',
      type: 'html',
      path: 'D:\\output\\smoke.html',
      url: '/api/local-files/verified/local-file-stable?turnId=turn-original',
    },
  }
  const revised = {
    messageId: 'msg-revised',
    artifactIdentity: 'msg-revised:smoke.html',
    content: '',
    preview: null,
    directFile: {
      ...original.directFile,
      url: '/api/local-files/verified/local-file-stable?turnId=turn-revised',
    },
  }
  const dispatch = (state, payload) => reduceTaskSettingsState(state, {
    type: 'OPEN_PREVIEW_ARTIFACT',
    payload,
  })

  let state = dispatch(createInitialState(), original)
  const originalTabId = state.previewActiveId
  state = dispatch(state, revised)

  assert.equal(state.previewTabs.length, 1)
  assert.equal(state.previewActiveId, originalTabId)
  assert.equal(state.previewArtifact, revised)
  assert.match(state.previewArtifact.directFile.url, /turn-revised/)
})

test('RightPreviewPane closes on Escape', async () => {
  let closeCount = 0
  const { dom, cleanup } = await renderPane(() => { closeCount += 1 })

  try {
    await act(async () => {
      dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      }))
    })

    assert.equal(closeCount, 1)
  } finally {
    await cleanup()
  }
})

test('RightPreviewPane keeps multiple files open and closes each tab independently', async () => {
  let closeCount = 0
  const first = {
    messageId: 'msg-alpha',
    content: 'alpha content',
    preview: { type: 'text', label: 'FILE', filename: 'alpha.txt', summary: 'Alpha' },
  }
  const second = {
    messageId: 'msg-beta',
    content: 'beta content',
    preview: { type: 'text', label: 'FILE', filename: 'beta.txt', summary: 'Beta' },
  }
  const third = {
    messageId: 'msg-gamma',
    content: 'gamma content',
    preview: { type: 'text', label: 'FILE', filename: 'gamma.txt', summary: 'Gamma' },
  }
  const { rootEl, rerender, cleanup } = await renderPane(() => { closeCount += 1 }, first)

  try {
    assert.equal(rootEl.querySelectorAll('.chat-preview-pane').length, 1)
    assert.equal(rootEl.querySelectorAll('[data-testid="preview-header"]').length, 1)
    assert.equal(rootEl.querySelectorAll('[role="tab"]').length, 1)
    assert.match(rootEl.querySelector('pre')?.textContent || '', /alpha content/)

    await rerender(second)
    await rerender(third)

    assert.equal(rootEl.querySelectorAll('.chat-preview-pane').length, 1)
    assert.equal(rootEl.querySelectorAll('[data-testid="preview-header"]').length, 1)
    assert.equal(rootEl.querySelectorAll('[role="tab"]').length, 3)
    assert.deepEqual(
      [...rootEl.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent.trim()),
      ['alpha.txt', 'beta.txt', 'gamma.txt'],
    )
    assert.equal(rootEl.querySelector('[role="tab"][aria-selected="true"]')?.textContent.trim(), 'gamma.txt')
    assert.match(rootEl.querySelector('pre')?.textContent || '', /gamma content/)

    const alphaTab = [...rootEl.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent.includes('alpha.txt'))
    await act(async () => alphaTab.dispatchEvent(new window.MouseEvent('click', { bubbles: true })))
    assert.equal(rootEl.querySelector('[role="tab"][aria-selected="true"]')?.textContent.trim(), 'alpha.txt')
    assert.match(rootEl.querySelector('pre')?.textContent || '', /alpha content/)

    const betaClose = rootEl.querySelectorAll('[data-testid="preview-tab-close"]')[1]
    await act(async () => betaClose.dispatchEvent(new window.MouseEvent('click', { bubbles: true })))
    assert.deepEqual(
      [...rootEl.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent.trim()),
      ['alpha.txt', 'gamma.txt'],
    )
    assert.equal(rootEl.querySelector('[role="tab"][aria-selected="true"]')?.textContent.trim(), 'alpha.txt')
    assert.equal(closeCount, 0)

    const alphaClose = rootEl.querySelectorAll('[data-testid="preview-tab-close"]')[0]
    await act(async () => alphaClose.dispatchEvent(new window.MouseEvent('click', { bubbles: true })))
    assert.equal(rootEl.querySelectorAll('[role="tab"]').length, 1)
    assert.equal(rootEl.querySelector('[role="tab"][aria-selected="true"]')?.textContent.trim(), 'gamma.txt')
    assert.match(rootEl.querySelector('pre')?.textContent || '', /gamma content/)
    assert.equal(closeCount, 0)

    const finalClose = rootEl.querySelector('[data-testid="preview-tab-close"]')
    await act(async () => finalClose.dispatchEvent(new window.MouseEvent('click', { bubbles: true })))
    assert.equal(closeCount, 0)
    assert.equal(rootEl.querySelector('[data-testid="preview-pane"]'), null)
    assert.equal(rootEl.querySelector('[data-testid="test-preview-state"]')?.dataset.tabCount, '0')
  } finally {
    await cleanup()
  }
})

test('RightPreviewPane hides without closing tabs, restores them, and reopens for a new file', async () => {
  let closeCount = 0
  const first = {
    messageId: 'msg-persist-alpha',
    content: 'alpha content',
    preview: { type: 'text', label: 'FILE', filename: 'alpha.txt' },
  }
  const second = {
    messageId: 'msg-persist-beta',
    content: 'beta content',
    preview: { type: 'text', label: 'FILE', filename: 'beta.txt' },
  }
  const third = {
    messageId: 'msg-persist-gamma',
    content: 'gamma content',
    preview: { type: 'text', label: 'FILE', filename: 'gamma.txt' },
  }
  const { rootEl, rerender, cleanup } = await renderPane(() => { closeCount += 1 }, first)
  const click = async (element) => {
    assert.ok(element)
    await act(async () => element.dispatchEvent(new window.MouseEvent('click', { bubbles: true })))
  }

  try {
    await rerender(second)
    const alphaTab = [...rootEl.querySelectorAll('[role="tab"]')]
      .find((tab) => tab.textContent.includes('alpha.txt'))
    await click(alphaTab)
    const activeId = rootEl.querySelector('[data-testid="test-preview-state"]')?.dataset.activeId

    await click(rootEl.querySelector('[data-testid="preview-close"]'))
    assert.equal(closeCount, 1)
    assert.equal(rootEl.querySelector('[data-testid="preview-pane"]'), null)
    assert.equal(rootEl.querySelector('[data-testid="test-preview-state"]')?.dataset.tabCount, '2')
    assert.equal(rootEl.querySelector('[data-testid="test-preview-state"]')?.dataset.activeId, activeId)

    await click(rootEl.querySelector('[data-testid="test-preview-toggle"]'))
    assert.equal(rootEl.querySelectorAll('[role="tab"]').length, 2)
    assert.equal(rootEl.querySelector('[role="tab"][aria-selected="true"]')?.textContent.trim(), 'alpha.txt')
    assert.match(rootEl.querySelector('pre')?.textContent || '', /alpha content/)

    await click(rootEl.querySelector('[data-testid="preview-close"]'))
    await rerender(third)
    assert.ok(rootEl.querySelector('[data-testid="preview-pane"]'))
    assert.equal(rootEl.querySelectorAll('[role="tab"]').length, 3)
    assert.equal(rootEl.querySelector('[role="tab"][aria-selected="true"]')?.textContent.trim(), 'gamma.txt')
    assert.match(rootEl.querySelector('pre')?.textContent || '', /gamma content/)
  } finally {
    await cleanup()
  }
})

test('RightPreviewPane keeps tab filenames without rendering the legacy type badge', async () => {
  const first = {
    messageId: 'msg-no-type-badge-alpha',
    content: 'alpha content',
    preview: {
      type: 'text',
      label: 'LEGACY_TYPE_BADGE',
      filename: 'alpha.txt',
    },
  }
  const second = {
    messageId: 'msg-no-type-badge-beta',
    content: 'beta content',
    preview: {
      type: 'text',
      label: 'LEGACY_TYPE_BADGE',
      filename: 'beta.txt',
    },
  }
  const { rootEl, rerender, cleanup } = await renderPane(() => {}, first)

  try {
    await rerender(second)

    assert.deepEqual(
      [...rootEl.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent.trim()),
      ['alpha.txt', 'beta.txt'],
    )
    const commandBar = rootEl.querySelector('[data-testid="preview-command-bar"]')
    assert.ok(commandBar)
    assert.match(commandBar.textContent, /beta\.txt/)
    assert.doesNotMatch(rootEl.textContent, /LEGACY_TYPE_BADGE/)
  } finally {
    await cleanup()
  }
})

test('RightPreviewPane switches between text and direct image tabs', async () => {
  const textArtifact = {
    messageId: 'msg-file-tab',
    content: 'notes content',
    preview: { type: 'text', label: 'FILE', filename: 'notes.txt' },
  }
  const imageArtifact = {
    messageId: 'msg-image-tab',
    content: '',
    preview: null,
    directFile: {
      id: 'image-file-1',
      filename: 'page1_check.png',
      type: 'png',
      mimeType: 'image/png',
      url: 'https://example.test/page1_check.png',
    },
  }
  const { rootEl, rerender, cleanup } = await renderPane(() => {}, textArtifact)

  try {
    assert.match(rootEl.querySelector('pre')?.textContent || '', /notes content/)
    await rerender(imageArtifact)

    assert.equal(rootEl.querySelectorAll('.chat-preview-pane').length, 1)
    assert.equal(rootEl.querySelectorAll('[role="tab"]').length, 2)
    assert.equal(rootEl.querySelector('[role="tab"][aria-selected="true"]')?.textContent.trim(), 'page1_check.png')
    const imageUrl = new URL(rootEl.querySelector('img[alt="page1_check.png"]')?.getAttribute('src'))
    assert.equal(imageUrl.origin + imageUrl.pathname, 'https://example.test/page1_check.png')
    assert.equal(imageUrl.searchParams.get('preview'), '1')
    assert.doesNotMatch(rootEl.querySelector('[data-testid="preview-command-bar"]')?.textContent || '', /image\/png/)
    assert.equal(rootEl.querySelector('pre'), null)

    const textTab = [...rootEl.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent.includes('notes.txt'))
    await act(async () => textTab.dispatchEvent(new window.MouseEvent('click', { bubbles: true })))
    assert.equal(rootEl.querySelectorAll('.chat-preview-pane').length, 1)
    assert.equal(rootEl.querySelectorAll('[role="tab"]').length, 2)
    assert.equal(rootEl.querySelector('[role="tab"][aria-selected="true"]')?.textContent.trim(), 'notes.txt')
    assert.match(rootEl.querySelector('pre')?.textContent || '', /notes content/)
    assert.equal(rootEl.querySelector('img[alt="page1_check.png"]'), null)
  } finally {
    await cleanup()
  }
})

test('RightPreviewPane restores focus to the opener when the single preview closes', async () => {
  let closeCount = 0
  let opener
  const { dom, rootEl, cleanup } = await renderPane(() => { closeCount += 1 }, artifact, (document) => {
    opener = document.createElement('button')
    opener.textContent = 'Open preview'
    document.body.insertBefore(opener, document.getElementById('root'))
    opener.focus()
  })

  try {
    const closeButton = rootEl.querySelector('[data-testid="preview-close"]')
    assert.ok(closeButton)
    closeButton.focus()
    assert.equal(dom.window.document.activeElement, closeButton)

    await act(async () => {
      closeButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
    })

    assert.equal(closeCount, 1)
    assert.equal(dom.window.document.activeElement, opener)
  } finally {
    await cleanup()
  }
})

test('RightPreviewPane closes when the backdrop is clicked', async () => {
  let closeCount = 0
  const { dom, rootEl, cleanup } = await renderPane(() => { closeCount += 1 })

  try {
    const backdrop = rootEl.querySelector('[data-testid="preview-backdrop"]')
    assert.ok(backdrop)

    await act(async () => {
      backdrop.dispatchEvent(new dom.window.MouseEvent('click', {
        bubbles: true,
        cancelable: true,
      }))
    })

    assert.equal(closeCount, 1)
  } finally {
    await cleanup()
  }
})

test('RightPreviewPane closes from the enlarged X button', async () => {
  let closeCount = 0
  const { dom, rootEl, cleanup } = await renderPane(() => { closeCount += 1 })

  try {
    const closeButton = rootEl.querySelector('button[aria-label="关闭预览"]')
    assert.ok(closeButton)
    assert.match(closeButton.className, /\bw-10\b/)
    assert.match(closeButton.className, /\bh-10\b/)

    await act(async () => {
      closeButton.dispatchEvent(new dom.window.MouseEvent('click', {
        bubbles: true,
        cancelable: true,
      }))
    })

    assert.equal(closeCount, 1)
  } finally {
    await cleanup()
  }
})

test('RightPreviewPane shows a clickable X when preview is unavailable', async () => {
  let closeCount = 0
  const { dom, rootEl, cleanup } = await renderPane(() => { closeCount += 1 }, {
    messageId: 'msg-null',
    content: '# Unsupported artifact',
    preview: null,
  })

  try {
    const closeButton = rootEl.querySelector('button[aria-label="关闭预览"]')
    assert.ok(closeButton)
    assert.equal(closeButton.textContent.trim(), '')

    await act(async () => {
      closeButton.dispatchEvent(new dom.window.MouseEvent('click', {
        bubbles: true,
        cancelable: true,
      }))
    })

    assert.equal(closeCount, 1)
  } finally {
    await cleanup()
  }
})

test('RightPreviewPane renders local text files in the single preview slot', async () => {
  const { rootEl, cleanup } = await renderPane(() => {}, {
    messageId: 'msg-file',
    content: 'alpha\nbeta',
    preview: {
      type: 'text',
      title: 'notes.txt',
      label: 'FILE',
      summary: '2 lines',
      filename: 'notes.txt',
    },
  })

  try {
    assert.match(rootEl.textContent, /notes\.txt/)
    assert.match(rootEl.querySelector('pre')?.textContent || '', /alpha\nbeta/)
  } finally {
    await cleanup()
  }
})

test('RightPreviewPane opens a direct generated file in the right pane', async () => {
  const { rootEl, cleanup } = await renderPane(() => {}, {
    messageId: 'msg-direct-file',
    content: '',
    preview: null,
    directFile: {
      id: 'file-1',
      filename: 'report.docx',
      type: 'docx',
      url: '',
    },
  })

  try {
    assert.ok(rootEl.querySelector('[data-testid="direct-file-pane"]'))
    assert.match(rootEl.textContent, /report\.docx/)
    assert.ok(rootEl.querySelector('[data-testid="direct-file-content"]'))
  } finally {
    await cleanup()
  }
})
