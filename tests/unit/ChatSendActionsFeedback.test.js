import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act, createElement, useEffect } from 'react'
import { createRoot } from 'react-dom/client'

import { setAuthToken } from '../../src/lib/accountClient.js'
import { useChatSendActions } from '../../src/pages/ChatSplit/chatSendActions.js'

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/chat',
  })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.localStorage = dom.window.localStorage
  globalThis.sessionStorage = dom.window.sessionStorage
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  setAuthToken('test-token')
  return dom
}

function ActionsHarness({ options, actionsRef }) {
  const actions = useChatSendActions(options)
  useEffect(() => { actionsRef.current = actions }, [actions, actionsRef])
  return null
}

async function mountActions(overrides = {}) {
  const dom = setupDom()
  const root = createRoot(document.getElementById('root'))
  const actionsRef = { current: null }
  const toasts = []
  const workbenchMessages = []
  const counters = { sends: 0, steers: 0 }
  const attachments = overrides.attachments || []
  const options = {
    attachments,
    attachmentsRef: { current: attachments },
    directoryApprovalOpen: false,
    dispatch: () => {},
    executeSlashEntry: () => {},
    input: 'hello',
    inputRef: { current: 'hello' },
    isGenerating: false,
    lang: 'en',
    modelReadiness: { kind: 'ready', canSend: true },
    navigateInputHistory: () => false,
    setAttachments: () => {},
    setInput: () => {},
    setWorkbenchMessage: (message) => { workbenchMessages.push(message) },
    showAuthenticationRequired: () => {},
    showModelUnavailable: () => {},
    showPendingDirectoryGuidance: () => false,
    slashRegistry: null,
    state: { activeSessionId: null },
    stateRef: { current: { activeSessionId: null } },
    steerActiveTurn: async () => { counters.steers += 1 },
    t: (key) => key,
    toast: { info: (message) => { toasts.push(message) } },
    triggerSendFlow: async () => { counters.sends += 1 },
    ...overrides,
  }
  await act(async () => root.render(createElement(ActionsHarness, { options, actionsRef })))
  return {
    actionsRef,
    counters,
    toasts,
    workbenchMessages,
    async unmount() {
      await act(async () => root.unmount())
      dom.window.close()
    },
  }
}

test('directory authorization blocks a send with visible feedback instead of returning silently', async () => {
  const harness = await mountActions({ directoryApprovalOpen: true })
  try {
    await act(async () => { await harness.actionsRef.current.handleSend() })
    assert.equal(harness.counters.sends, 0)
    assert.deepEqual(harness.toasts, ['chatSteering.directoryAuthorizationRequired'])
    assert.deepEqual(harness.workbenchMessages, ['chatSteering.directoryAuthorizationRequired'])
  } finally {
    await harness.unmount()
  }
})

test('an attachment-only draft explains that a running task accepts text guidance only', async () => {
  const attachment = { id: 'ready-file', name: 'brief.txt', uploadStatus: 'ready' }
  const harness = await mountActions({
    attachments: [attachment],
    input: '',
    inputRef: { current: '' },
    isGenerating: true,
  })
  try {
    await act(async () => { await harness.actionsRef.current.handleSend() })
    assert.equal(harness.counters.sends, 0)
    assert.equal(harness.counters.steers, 0)
    assert.deepEqual(harness.toasts, ['chatSteering.textOnly'])
    assert.deepEqual(harness.workbenchMessages, ['chatSteering.textOnly'])
  } finally {
    await harness.unmount()
  }
})

test('an uploading attachment blocks the send with a visible reason', async () => {
  const harness = await mountActions({
    attachments: [{ id: 'pending-file', uploadStatus: 'uploading' }],
  })
  try {
    await act(async () => { await harness.actionsRef.current.handleSend() })
    assert.equal(harness.counters.sends, 0)
    assert.deepEqual(harness.toasts, ['chatAttachments.waitingForUploads'])
    assert.deepEqual(harness.workbenchMessages, ['chatAttachments.waitingForUploads'])
  } finally {
    await harness.unmount()
  }
})
