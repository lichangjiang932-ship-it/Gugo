import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act, createElement, useEffect, useRef } from 'react'
import { createRoot } from 'react-dom/client'

import { getAuthToken, setAuthToken } from '../src/lib/accountClient.js'
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

function Harness({
  activateWorkspaceForTurn,
  dispatch,
  draftWorkspacePath = '',
  onAuthenticationRequired,
  onModelCatalogChanged = () => {},
  onModelUnavailable = () => {},
  onReady,
  onSendRejected = () => {},
  onTurnStart,
  refreshAuth,
  preflightModelSelection = async () => ({
    ok: true,
    selection: {
      modelName: 'model-a',
      modelProviderId: 'provider-a',
      modelConfigRevision: 7,
      modelMode: 'agent',
    },
  }),
  runChatTurn = async ({ onTurnAccepted }) => {
    onTurnAccepted?.({ turnId: 'turn-a' })
    return { completed: true }
  },
  state: stateOverride,
}) {
  const abortCtrlRef = useRef(null)
  const abortSessionIdRef = useRef(null)
  const directoryApprovalResolveRef = useRef(null)
  const triggerSend = useChatSendFlow({
    activateWorkspaceForTurn,
    abortCtrlRef,
    abortSessionIdRef,
    attachments: [],
    approvalMode: 'normal',
    changeApprovalMode: async () => 'normal',
    clearToolApprovalForOwner: () => {},
    directoryApprovalResolveRef,
    dispatch,
    draftWorkspacePath,
    effectiveAgentId: null,
    ensureLocalPathAccess: async () => ({ proceed: true, paths: [] }),
    isGenerating: false,
    modelOptions: [{ name: 'model-a', provider: 'provider-a', configRevision: 7 }],
    modelReadiness: { kind: 'ready', canSend: true, configRevision: 7 },
    onAuthenticationRequired,
    onModelCatalogChanged,
    onModelUnavailable,
    onSendRejected,
    onTurnStart,
    probeLocalPathAccess: async () => ({ proceed: true }),
    refreshAuth,
    requestServerToolApproval: async () => ({ approved: false }),
    resolveToolApprovalForOwner: () => {},
    runtimeSkills: [],
    selectedModel: 'model-a',
    selectedModelProviderId: 'provider-a',
    setContextSystemPrompts: () => {},
    preflightModelSelection,
    runChatTurn,
    state: stateOverride || {
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

function BlockedModelHarness({ dispatch, onAuthenticationRequired, onModelUnavailable, onReady, onTurnStart }) {
  const abortCtrlRef = useRef(null)
  const abortSessionIdRef = useRef(null)
  const directoryApprovalResolveRef = useRef(null)
  const triggerSend = useChatSendFlow({
    abortCtrlRef,
    abortSessionIdRef,
    attachments: [{ id: 'draft-attachment', uploadStatus: 'ready' }],
    directoryApprovalResolveRef,
    dispatch,
    ensureLocalPathAccess: async () => assert.fail('model readiness must run before path preflight'),
    isGenerating: false,
    modelOptions: [],
    modelReadiness: { kind: 'unconfigured', canSend: false },
    onAuthenticationRequired,
    onModelUnavailable,
    onTurnStart,
    runtimeSkills: [],
    selectedModel: '',
    selectedModelProviderId: '',
    state: {
      activeSessionId: null,
      agentMode: 'chat',
      sessions: [],
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
      assert.equal(await first, true)
    })

    assert.equal(actions.filter((action) => action.type === 'SEND_MESSAGE').length, 1)
    assert.deepEqual(turnStarts, [{ sessionId: 'session-a' }])
  } finally {
    setAuthToken('')
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('chat send flow blocks an unconfigured model before any session, message, turn, or timer state is created', async () => {
  const dom = setupDom()
  const actions = []
  const unavailable = []
  const turnStarts = []
  const root = createRoot(document.getElementById('root'))
  let triggerSend = null
  setAuthToken('local-test-token')

  try {
    await act(async () => {
      root.render(createElement(BlockedModelHarness, {
        dispatch: (action) => actions.push(action),
        onModelUnavailable: (readiness) => unavailable.push(readiness),
        onReady: (value) => { triggerSend = value },
        onTurnStart: (value) => turnStarts.push(value),
      }))
    })

    let accepted
    await act(async () => { accepted = await triggerSend('keep this draft') })

    assert.equal(accepted, false)
    assert.deepEqual(actions, [])
    assert.deepEqual(turnStarts, [])
    assert.deepEqual(unavailable, [{ kind: 'unconfigured', canSend: false }])
  } finally {
    setAuthToken('')
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('a normal draft becomes a sidebar session only after the first Turn is accepted', async () => {
  const dom = setupDom()
  const actions = []
  const root = createRoot(document.getElementById('root'))
  let triggerSend = null
  let acceptTurn = null
  let finishTurn = null
  setAuthToken('local-test-token')

  try {
    await act(async () => {
      root.render(createElement(Harness, {
        dispatch: (action) => actions.push(action),
        onReady: (value) => { triggerSend = value },
        state: {
          activeSessionId: null,
          agentMode: 'chat',
          sessions: [],
          skillConfigs: {},
          toolsConfig: {},
        },
        runChatTurn: ({ onTurnAccepted }) => new Promise((resolve) => {
          acceptTurn = () => onTurnAccepted?.({ turnId: 'turn-draft' })
          finishTurn = () => resolve({ completed: true })
        }),
      }))
    })

    let sendPromise
    await act(async () => { sendPromise = triggerSend('first accepted message') })
    assert.deepEqual(actions, [], 'opening and submitting a draft must not create a session before ACK')

    await act(async () => { acceptTurn() })
    assert.equal(actions[0].type, 'NEW_SESSION')
    assert.equal(actions[1].type, 'SET_SESSION_MODEL')
    assert.equal(actions[2].type, 'SEND_MESSAGE')
    assert.equal(actions[0].payload.id, actions[2].payload.sessionId)
    assert.equal(Object.hasOwn(actions[0].payload, 'workspacePath'), false)

    let accepted
    await act(async () => {
      finishTurn()
      accepted = await sendPromise
    })
    assert.equal(accepted, true)
    assert.equal(actions.filter((action) => action.type === 'NEW_SESSION').length, 1)
  } finally {
    setAuthToken('')
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('a persisted TURN_INCOMPLETE recovery card does not block a new message', async () => {
  const dom = setupDom()
  const actions = []
  const root = createRoot(document.getElementById('root'))
  let triggerSend = null
  let turnCalls = 0
  setAuthToken('local-test-token')

  try {
    await act(async () => {
      root.render(createElement(Harness, {
        dispatch: (action) => actions.push(action),
        onReady: (value) => { triggerSend = value },
        state: {
          activeSessionId: 'session-incomplete',
          agentMode: 'chat',
          sessions: [{
            id: 'session-incomplete',
            title: 'Interrupted task',
            modelName: 'model-a',
            modelProviderId: 'provider-a',
            messages: [{
              id: 'assistant-incomplete',
              role: 'assistant',
              content: 'partial output',
              meta: {
                failed: true,
                streaming: false,
                serverTurnId: 'old-turn',
                serverFailure: { code: 'TURN_INCOMPLETE', retryable: true },
              },
            }],
          }],
          skillConfigs: {},
          toolsConfig: {},
        },
        runChatTurn: async ({ onTurnAccepted }) => {
          turnCalls += 1
          onTurnAccepted?.({ turnId: 'new-turn' })
          return { completed: true }
        },
      }))
    })

    let accepted
    await act(async () => { accepted = await triggerSend('start a new message') })
    assert.equal(accepted, true)
    assert.equal(turnCalls, 1)
    assert.equal(actions.filter((action) => action.type === 'SEND_MESSAGE').length, 1)
  } finally {
    setAuthToken('')
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('a project draft stays out of the sidebar until ACK and commits its workspace with the first message', async () => {
  const dom = setupDom()
  const actions = []
  const activations = []
  const turnRequests = []
  const root = createRoot(document.getElementById('root'))
  let triggerSend = null
  let acceptTurn = null
  let finishTurn = null
  setAuthToken('local-test-token')

  try {
    await act(async () => {
      root.render(createElement(Harness, {
        activateWorkspaceForTurn: async (path) => {
          activations.push(path)
          return { path }
        },
        dispatch: (action) => actions.push(action),
        draftWorkspacePath: ' D:\\Projects\\gugo ',
        onReady: (value) => { triggerSend = value },
        state: {
          activeSessionId: null,
          agentMode: 'chat',
          sessions: [],
          skillConfigs: {},
          toolsConfig: {},
        },
        runChatTurn: (request) => new Promise((resolve) => {
          turnRequests.push(request)
          acceptTurn = () => request.onTurnAccepted?.({ turnId: 'turn-project-draft' })
          finishTurn = () => resolve({ completed: true })
        }),
      }))
    })

    let sendPromise
    await act(async () => { sendPromise = triggerSend('first project message') })
    assert.deepEqual(activations, ['D:\\Projects\\gugo'])
    assert.equal(turnRequests[0].workspacePath, 'D:\\Projects\\gugo')
    assert.deepEqual(actions, [], 'project selection must remain draft-only before ACK')

    await act(async () => { acceptTurn() })
    const created = actions.find((action) => action.type === 'NEW_SESSION')
    const sent = actions.find((action) => action.type === 'SEND_MESSAGE')
    assert.ok(created)
    assert.equal(created.payload.workspacePath, 'D:\\Projects\\gugo')
    assert.equal(created.payload.id, sent.payload.sessionId)

    let accepted
    await act(async () => {
      finishTurn()
      accepted = await sendPromise
    })
    assert.equal(accepted, true)
    assert.equal(actions.filter((action) => action.type === 'NEW_SESSION').length, 1)
  } finally {
    setAuthToken('')
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('an attachment draft reuses its hidden upload session id only when the first Turn is accepted', async () => {
  const dom = setupDom()
  const actions = []
  const turnRequests = []
  const root = createRoot(document.getElementById('root'))
  let triggerSend = null
  let acceptTurn = null
  let finishTurn = null
  setAuthToken('local-test-token')

  try {
    await act(async () => {
      root.render(createElement(Harness, {
        dispatch: (action) => actions.push(action),
        onReady: (value) => { triggerSend = value },
        state: {
          activeSessionId: null,
          agentMode: 'chat',
          draftSessionId: 'attachment-draft-session',
          sessions: [],
          skillConfigs: {},
          toolsConfig: {},
        },
        runChatTurn: (request) => new Promise((resolve) => {
          turnRequests.push(request)
          acceptTurn = () => request.onTurnAccepted?.({ turnId: 'turn-attachment-draft' })
          finishTurn = () => resolve({ completed: true })
        }),
      }))
    })

    let sendPromise
    await act(async () => { sendPromise = triggerSend('message with uploaded attachment') })
    assert.equal(turnRequests[0].sessionId, 'attachment-draft-session')
    assert.deepEqual(actions, [])

    await act(async () => { acceptTurn() })
    const created = actions.find((action) => action.type === 'NEW_SESSION')
    const sent = actions.find((action) => action.type === 'SEND_MESSAGE')
    assert.equal(created.payload.id, 'attachment-draft-session')
    assert.equal(sent.payload.sessionId, 'attachment-draft-session')

    await act(async () => {
      finishTurn()
      assert.equal(await sendPromise, true)
    })
  } finally {
    setAuthToken('')
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('chat send flow requests authentication without dispatching a message or starting a turn', async () => {
  const dom = setupDom()
  const actions = []
  const authenticationRequests = []
  const turnStarts = []
  const root = createRoot(document.getElementById('root'))
  let triggerSend = null
  setAuthToken('')

  try {
    await act(async () => {
      root.render(createElement(Harness, {
        dispatch: (action) => actions.push(action),
        onAuthenticationRequired: () => authenticationRequests.push(true),
        onReady: (value) => { triggerSend = value },
        onTurnStart: (value) => turnStarts.push(value),
      }))
    })

    let accepted
    await act(async () => { accepted = await triggerSend('keep this until login') })

    assert.equal(accepted, false)
    assert.deepEqual(authenticationRequests, [true])
    assert.deepEqual(actions, [])
    assert.deepEqual(turnStarts, [])
  } finally {
    setAuthToken('')
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('authentication takes precedence over model setup when both are unavailable', async () => {
  const dom = setupDom()
  const actions = []
  const authenticationRequests = []
  const unavailable = []
  const root = createRoot(document.getElementById('root'))
  let triggerSend = null
  setAuthToken('')

  try {
    await act(async () => {
      root.render(createElement(BlockedModelHarness, {
        dispatch: (action) => actions.push(action),
        onAuthenticationRequired: () => authenticationRequests.push(true),
        onModelUnavailable: (readiness) => unavailable.push(readiness),
        onReady: (value) => { triggerSend = value },
        onTurnStart: () => assert.fail('an unauthenticated send must not start a turn'),
      }))
    })

    let accepted
    await act(async () => { accepted = await triggerSend('keep this draft') })

    assert.equal(accepted, false)
    assert.deepEqual(authenticationRequests, [true])
    assert.deepEqual(unavailable, [])
    assert.deepEqual(actions, [])
  } finally {
    setAuthToken('')
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('an authoritative preflight 401 refreshes local auth and retries only the read-only preflight', async () => {
  const dom = setupDom()
  const actions = []
  const authenticationRequests = []
  const catalogReloads = []
  const unavailable = []
  const turnStarts = []
  let preflightCalls = 0
  let turnCalls = 0
  const root = createRoot(document.getElementById('root'))
  let triggerSend = null
  setAuthToken('expired-local-token')

  try {
    await act(async () => {
      root.render(createElement(Harness, {
        dispatch: (action) => actions.push(action),
        onAuthenticationRequired: () => authenticationRequests.push(true),
        onModelCatalogChanged: () => catalogReloads.push(true),
        onModelUnavailable: (readiness) => unavailable.push(readiness),
        onReady: (value) => { triggerSend = value },
        onTurnStart: (value) => turnStarts.push(value),
        preflightModelSelection: async () => {
          preflightCalls += 1
          if (preflightCalls === 1) return { ok: false, authenticationRequired: true }
          return {
            ok: true,
            selection: {
              modelName: 'model-a',
              modelProviderId: 'provider-a',
              modelConfigRevision: 7,
              modelMode: 'agent',
            },
          }
        },
        refreshAuth: async () => {
          setAuthToken('fresh-local-token')
          return { mode: 'local', authenticated: true, user: { email: 'local@gugo' } }
        },
        runChatTurn: async ({ onTurnAccepted }) => {
          turnCalls += 1
          onTurnAccepted?.({ turnId: 'turn-a' })
          return { completed: true }
        },
      }))
    })

    let accepted
    await act(async () => { accepted = await triggerSend('keep this draft until login') })

    assert.equal(accepted, true)
    assert.equal(getAuthToken(), 'fresh-local-token')
    assert.equal(preflightCalls, 2)
    assert.equal(turnCalls, 1)
    assert.deepEqual(authenticationRequests, [])
    assert.deepEqual(catalogReloads, [])
    assert.deepEqual(unavailable, [])
    assert.deepEqual(turnStarts, [{ sessionId: 'session-a' }])
    assert.equal(actions.some((action) => action.type === 'LOGOUT'), false)
  } finally {
    setAuthToken('')
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('a pre-start Turn 401 refreshes local auth but never replays the create request', async () => {
  const dom = setupDom()
  const actions = []
  const rejected = []
  const root = createRoot(document.getElementById('root'))
  let triggerSend = null
  let turnCalls = 0
  setAuthToken('expired-local-token')

  try {
    await act(async () => {
      root.render(createElement(Harness, {
        dispatch: (action) => actions.push(action),
        onReady: (value) => { triggerSend = value },
        onSendRejected: (error, options) => rejected.push({ error, options }),
        refreshAuth: async () => {
          setAuthToken('fresh-local-token')
          return { mode: 'local', authenticated: true, user: { email: 'local@gugo' } }
        },
        runChatTurn: async () => {
          turnCalls += 1
          return {
            failed: true,
            rejectedBeforeStart: true,
            error: Object.assign(new Error('expired login'), { status: 401 }),
          }
        },
      }))
    })

    let accepted
    await act(async () => { accepted = await triggerSend('keep this draft for explicit retry') })

    assert.equal(accepted, false)
    assert.equal(turnCalls, 1)
    assert.equal(getAuthToken(), 'fresh-local-token')
    assert.equal(rejected.length, 1)
    assert.deepEqual(rejected[0].options, { authenticationRefreshed: true })
    assert.deepEqual(actions, [])
  } finally {
    setAuthToken('')
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('a non-model rejection before server acceptance reports failure without creating chat state', async () => {
  const dom = setupDom()
  const actions = []
  const rejected = []
  const turnStarts = []
  const root = createRoot(document.getElementById('root'))
  let triggerSend = null
  const failure = Object.assign(new Error('network unavailable'), { code: 'TURN_REQUEST_FAILED' })
  setAuthToken('local-test-token')

  try {
    await act(async () => {
      root.render(createElement(Harness, {
        dispatch: (action) => actions.push(action),
        onReady: (value) => { triggerSend = value },
        onSendRejected: (error) => rejected.push(error),
        onTurnStart: (value) => turnStarts.push(value),
        runChatTurn: async () => ({ failed: true, error: failure, rejectedBeforeStart: true }),
      }))
    })

    let accepted
    await act(async () => { accepted = await triggerSend('keep this unsent draft') })

    assert.equal(accepted, false)
    assert.deepEqual(rejected, [failure])
    assert.deepEqual(actions, [])
    assert.deepEqual(turnStarts, [])
  } finally {
    setAuthToken('')
    await act(async () => root.unmount())
    dom.window.close()
  }
})
