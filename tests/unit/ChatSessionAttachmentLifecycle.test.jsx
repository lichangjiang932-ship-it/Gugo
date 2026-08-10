import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'

import useChatSessionLifecycle from '../../src/pages/ChatSplit/useChatSessionLifecycle.js'

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

function Harness({ sessionId }) {
  const abortCtrlRef = useRef(null)
  const [attachments, setAttachments] = useState([
    { id: 'ready-attachment', uploadStatus: 'ready' },
    { id: 'uploading-attachment', uploadStatus: 'uploading' },
  ])
  const [input, setInput] = useState('draft')
  const [isGenerating, setIsGenerating] = useState(false)

  useChatSessionLifecycle({
    abortCtrlRef,
    desktopPetVisible: false,
    dispatch: () => {},
    input,
    isGenerating,
    messages: [],
    setAttachments,
    setDesktopPetVisible: () => {},
    setIsGenerating,
    setInput,
    setWorkbenchMessage: () => {},
    showContextUsage: false,
    state: {
      activeSessionId: sessionId,
      newDraftVersion: 0,
      sessionDrafts: {},
      tasks: [],
    },
    toolApproval: null,
    workbenchOpen: false,
  })

  return <output data-attachment-ids={attachments.map((item) => item.id).join(',')} />
}

test('switching sessions clears ready and in-progress attachment drafts', async () => {
  const dom = setupDom()
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)

  try {
    await act(async () => root.render(<Harness sessionId="session-a" />))
    assert.equal(
      rootElement.querySelector('output').dataset.attachmentIds,
      'ready-attachment,uploading-attachment',
    )

    await act(async () => root.render(<Harness sessionId="session-b" />))
    assert.equal(rootElement.querySelector('output').dataset.attachmentIds, '')
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})
