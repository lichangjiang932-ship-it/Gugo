import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'

import useChatSessionLifecycle from '../src/pages/ChatSplit/useChatSessionLifecycle.js'
import {
  cancelTurnRun,
  registerTurnRun,
  unregisterTurnRun,
} from '../src/pages/ChatSplit/turnRunRegistry.js'

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/chat',
  })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.localStorage = dom.window.localStorage
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  return dom
}

function LifecycleHarness({ abortCtrlRef, onGenerating, sessionId }) {
  useChatSessionLifecycle({
    abortCtrlRef,
    desktopPetVisible: false,
    dispatch: () => {},
    input: '',
    isGenerating: false,
    messages: [],
    setAttachments: () => {},
    setDesktopPetVisible: () => {},
    setInput: () => {},
    setIsGenerating: onGenerating,
    setWorkbenchMessage: () => {},
    showContextUsage: false,
    state: {
      activeSessionId: sessionId,
      draftInput: '',
      newDraftVersion: 0,
      sessionDrafts: {},
      tasks: [],
    },
    toolApproval: { open: false },
    workbenchOpen: false,
  })
  return null
}

function renderHarness(abortCtrlRef, onGenerating, sessionId) {
  return createElement(LifecycleHarness, { abortCtrlRef, onGenerating, sessionId })
}

test('blur, session navigation, and view unmount keep the server turn alive until explicit stop', async () => {
  const dom = setupDom()
  const root = createRoot(document.getElementById('root'))
  const controller = new AbortController()
  const abortCtrlRef = { current: null }
  const generating = []
  const onGenerating = (value) => generating.push(value)
  const run = { sessionId: 'continuity-a', turnId: 'turn-a', controller }
  registerTurnRun(run)

  try {
    await act(async () => root.render(renderHarness(abortCtrlRef, onGenerating, 'continuity-a')))
    assert.equal(abortCtrlRef.current, controller)
    assert.equal(generating.at(-1), true)

    await act(async () => {
      window.dispatchEvent(new dom.window.Event('blur'))
      document.dispatchEvent(new dom.window.Event('visibilitychange'))
    })
    assert.equal(controller.signal.aborted, false)

    await act(async () => root.render(renderHarness(abortCtrlRef, onGenerating, 'continuity-b')))
    assert.equal(abortCtrlRef.current, null)
    assert.equal(generating.at(-1), false)
    assert.equal(controller.signal.aborted, false)

    await act(async () => root.unmount())
    assert.equal(controller.signal.aborted, false)

    assert.equal(cancelTurnRun('continuity-a'), true)
    assert.equal(controller.signal.aborted, true)
  } finally {
    unregisterTurnRun(run)
    try { await act(async () => root.unmount()) } catch { /* already unmounted */ }
    dom.window.close()
  }
})
