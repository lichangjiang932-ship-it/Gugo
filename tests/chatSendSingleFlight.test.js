import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act, createElement, useEffect, useRef } from 'react'
import { createRoot } from 'react-dom/client'

import { setAuthToken } from '../src/lib/accountClient.js'
import useChatSendFlow from '../src/pages/ChatSplit/useChatSendFlow.js'

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
  return dom
}

function Harness({ dispatch, onReady, onTurnStart }) {
  const abortCtrlRef = useRef(null)
  const abortSessionIdRef = useRef(null)
  const directoryApprovalResolveRef = useRef(null)
  const triggerSend = useChatSendFlow({
    abortCtrlRef,
    abortSessionIdRef,
    attachments: [],
    approvalMode: 'normal',
    changeApprovalMode: async () => 'normal',
    clearToolApprovalForOwner: () => {},
    directoryApprovalResolveRef,
    dispatch,
    effectiveAgentId: null,
    ensureLocalPathAccess: async () => ({ proceed: false }),
    isGenerating: false,
    modelOptions: [{ name: 'model-a', provider: 'provider-a' }],
    modelReadiness: { kind: 'ready', canSend: true },
    onModelUnavailable: () => {},
    onTurnStart,
    probeLocalPathAccess: async () => ({ proceed: true }),
    requestServerToolApproval: async () => ({ approved: false }),
    resolveToolApprovalForOwner: () => {},
    runtimeSkills: [],
    selectedModel: 'model-a',
    selectedModelProviderId: 'provider-a',
    setContextSystemPrompts: () => {},
    state: {
      activeSessionId: 'session-a',
      agentMode: 'chat',
      sessions: [{
        id: 'session-a',
        title: 'Existing session',
        messages: [],
        modelName: 'model-a',
        modelProviderId: 'provider-a',
      }],
      skillConfigs: {},
      toolsConfig: {},
    },
    t: (key) => key,
  })
  useEffect(() => onReady(triggerSend), [onReady, triggerSend])
  return createElement('output')
}

test('chat send flow rejects a same-tick duplicate before React generation state updates', async () => {
  const dom = setupDom()
  const actions = []
  const turnStarts = []
  const root = createRoot(document.getElementById('root'))
  let triggerSend = null
  const captureTrigger = (value) => { triggerSend = value }
  setAuthToken('local-test-token')
  try {
    await act(async () => {
      root.render(createElement(Harness, {
        dispatch: (action) => actions.push(action),
        onReady: captureTrigger,
        onTurnStart: (value) => turnStarts.push(value),
      }))
    })

    let first
    let duplicate
    await act(async () => {
      first = triggerSend('retry the original message')
      duplicate = triggerSend('retry the original message')
      assert.equal(await duplicate, false)
      assert.equal(await first, false)
    })

    assert.equal(actions.filter((action) => action.type === 'SEND_MESSAGE').length, 1)
    assert.deepEqual(turnStarts, [{ sessionId: 'session-a' }])
  } finally {
    setAuthToken('')
    await act(async () => root.unmount())
    dom.window.close()
  }
})
