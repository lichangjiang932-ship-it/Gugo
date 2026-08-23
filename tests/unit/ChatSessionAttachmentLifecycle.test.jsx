import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act, useCallback, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'

import useChatSessionLifecycle from '../../src/pages/ChatSplit/useChatSessionLifecycle.js'
import { readSessionDraft } from '../../src/lib/chatDrafts.js'
import { reduceTaskSettingsState } from '../../src/store/reducers/taskSettingsReducer.js'

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
    attachments,
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

function DraftPage({ dispatch, draftInput, initialInput }) {
  const abortCtrlRef = useRef(null)
  const [input, setInput] = useState(initialInput)
  const [isGenerating, setIsGenerating] = useState(false)

  useChatSessionLifecycle({
    abortCtrlRef,
    attachments: [],
    desktopPetVisible: false,
    dispatch,
    input,
    isGenerating,
    messages: [],
    setAttachments: () => {},
    setDesktopPetVisible: () => {},
    setIsGenerating,
    setInput,
    setWorkbenchMessage: () => {},
    showContextUsage: false,
    state: {
      activeSessionId: null,
      draftInput,
      newDraftVersion: 0,
      sessionDrafts: {},
      tasks: [],
    },
    toolApproval: null,
    workbenchOpen: false,
  })

  return <textarea aria-label="draft" value={input} onChange={(event) => setInput(event.target.value)} />
}

function AttachmentDraftPage({ dispatch, initialAttachments, sessionDrafts }) {
  const restored = readSessionDraft(sessionDrafts?.['attachment-session'])
  const abortCtrlRef = useRef(null)
  const [attachments, setAttachments] = useState(() => (
    initialAttachments.length > 0 ? initialAttachments : restored.attachments
  ))
  const [input, setInput] = useState(() => restored.text)
  const [isGenerating, setIsGenerating] = useState(false)

  useChatSessionLifecycle({
    abortCtrlRef,
    attachments,
    desktopPetVisible: false,
    dispatch,
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
      activeSessionId: 'attachment-session',
      newDraftVersion: 0,
      sessionDrafts,
      tasks: [],
    },
    toolApproval: null,
    workbenchOpen: false,
  })

  return <output data-attachment-ids={attachments.map((item) => item.id).join(',')} />
}

function AttachmentRouteHarness() {
  const [route, setRoute] = useState('chat')
  const [visitedSettings, setVisitedSettings] = useState(false)
  const [draftState, setDraftState] = useState({ sessionDrafts: {} })
  const dispatch = useCallback((action) => {
    setDraftState((current) => reduceTaskSettingsState(current, action) || current)
  }, [])
  const initialAttachments = visitedSettings ? [] : [
    {
      id: 'ready-route-attachment',
      name: 'route.pdf',
      mimeType: 'application/pdf',
      uploadStatus: 'ready',
      downloadUrl: '/api/attachments/ready-route-attachment/content',
    },
    { id: 'uploading-route-attachment', name: 'pending.txt', uploadStatus: 'uploading' },
  ]

  if (route === 'settings') {
    const saved = readSessionDraft(draftState.sessionDrafts['attachment-session'])
    return <button
      type="button"
      data-attachment-ids={saved.attachments.map((item) => item.id).join(',')}
      onClick={() => setRoute('chat')}
    >Return to chat</button>
  }
  return <div>
    <AttachmentDraftPage
      dispatch={dispatch}
      initialAttachments={initialAttachments}
      sessionDrafts={draftState.sessionDrafts}
    />
    <button type="button" onClick={() => { setVisitedSettings(true); setRoute('settings') }}>Configure models</button>
  </div>
}

function DraftRouteHarness() {
  const [route, setRoute] = useState('chat')
  const [draftInput, setDraftInput] = useState('')
  const [hasVisitedSettings, setHasVisitedSettings] = useState(false)
  const dispatch = useCallback((action) => {
    if (action.type === 'SET_DRAFT_INPUT') setDraftInput(action.payload ?? '')
  }, [])

  if (route === 'settings') {
    return <button type="button" data-draft-input={draftInput} onClick={() => setRoute('chat')}>Return to chat</button>
  }
  return <div>
    <DraftPage
      dispatch={dispatch}
      draftInput={draftInput}
      initialInput={hasVisitedSettings ? '' : 'draft before model setup'}
    />
    <button type="button" onClick={() => { setHasVisitedSettings(true); setRoute('settings') }}>Configure models</button>
  </div>
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

test('text draft survives the chat-to-model-settings route round trip without a session', async () => {
  const dom = setupDom()
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)

  try {
    await act(async () => root.render(<DraftRouteHarness />))
    assert.equal(rootElement.querySelector('textarea').value, 'draft before model setup')

    await act(async () => {
      [...rootElement.querySelectorAll('button')].find((button) => button.textContent === 'Configure models').click()
    })
    assert.equal(rootElement.textContent, 'Return to chat')
    assert.equal(rootElement.querySelector('button').dataset.draftInput, 'draft before model setup')

    await act(async () => rootElement.querySelector('button').click())
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)))
    assert.equal(rootElement.querySelector('textarea').value, 'draft before model setup')
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('ready attachment draft survives the model-settings route round trip without reviving uploads', async () => {
  const dom = setupDom()
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)

  try {
    await act(async () => root.render(<AttachmentRouteHarness />))
    assert.equal(
      rootElement.querySelector('output').dataset.attachmentIds,
      'ready-route-attachment,uploading-route-attachment',
    )

    await act(async () => {
      [...rootElement.querySelectorAll('button')].find((button) => button.textContent === 'Configure models').click()
    })
    assert.equal(rootElement.querySelector('button').dataset.attachmentIds, 'ready-route-attachment')

    await act(async () => rootElement.querySelector('button').click())
    assert.equal(rootElement.querySelector('output').dataset.attachmentIds, 'ready-route-attachment')
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})
