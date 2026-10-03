import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act, createElement, useCallback, useLayoutEffect, useReducer } from 'react'
import { createRoot } from 'react-dom/client'

import useChatWorkspaceState from '../src/pages/ChatSplit/useChatWorkspaceState.js'
import { reduceSessionLifecycleState } from '../src/store/reducers/sessionLifecycleReducer.js'
import { reduceServerSessionState } from '../src/store/reducers/serverSessionReducer.js'

const translate = (key) => key
const baseState = (overrides = {}) => ({
  activeSessionId: null,
  draftWorkspacePath: '',
  newDraftVersion: 10,
  sessions: [
    { id: 'session-a', title: 'A', messages: [], workspacePath: '/existing/a' },
    { id: 'session-b', title: 'B', messages: [], workspacePath: '/existing/b' },
  ],
  ...overrides,
})

function reduceState(state, action) {
  return reduceSessionLifecycleState(state, action)
    ?? reduceServerSessionState(state, action)
    ?? state
}

function Harness({ initialState, onAction, onReady }) {
  const [state, rawDispatch] = useReducer(reduceState, initialState)
  const dispatch = useCallback((action) => {
    onAction(action)
    rawDispatch(action)
  }, [onAction])
  const workspace = useChatWorkspaceState({
    activeSession: state.sessions.find((session) => session.id === state.activeSessionId),
    activeSessionId: state.activeSessionId,
    dispatch,
    state,
    t: translate,
  })
  useLayoutEffect(() => onReady({ state, dispatch, workspace }))
  return createElement('output', { 'data-busy': workspace.workspaceBusy }, workspace.workspaceError)
}

function mockWorkspaceNetwork(context) {
  const requests = []
  context.mock.method(globalThis, 'fetch', (url, init = {}) => {
    const body = JSON.parse(init.body || '{}')
    if (url === '/api/local-files/workspace-trust') {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ trusted: true }) })
    }
    assert.ok(url === '/api/local-files/grants' || /^\/api\/sessions\/[^/]+\/workspace$/u.test(url), url)
    return new Promise((resolve, reject) => {
      const request = {
        url, body, settled: false,
        complete(data) {
          request.settled = true
          resolve({ ok: true, status: 200, json: async () => data })
        },
        fail(error = new Error('workspace failed')) {
          request.settled = true
          reject(error)
        },
      }
      requests.push(request)
    })
  })
  return {
    requests,
    grant: (path) => requests.find((request) => (
      request.url === '/api/local-files/grants' && request.body.path === path && !request.settled
    )),
    puts: (sessionId) => requests.filter((request) => (
      request.url === `/api/sessions/${sessionId}/workspace`
    )),
  }
}

async function mountWorkspace(context, initialState = baseState()) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/chat' })
  const globals = {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    localStorage: dom.window.localStorage,
    sessionStorage: dom.window.sessionStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
  }
  const previous = new Map(Object.keys(globals).map((key) => (
    [key, Object.getOwnPropertyDescriptor(globalThis, key)]
  )))
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  const network = mockWorkspaceNetwork(context)
  const root = createRoot(document.getElementById('root'))
  const actions = []
  let current
  context.after(async () => {
    await act(async () => {
      root.unmount()
      for (const request of network.requests) {
        if (!request.settled) request.fail(new Error('test cleanup'))
      }
    })
    dom.window.close()
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
  })
  await act(async () => root.render(createElement(Harness, {
    initialState,
    onAction: (action) => actions.push(action),
    onReady: (value) => { current = value },
  })))
  return {
    network,
    actions,
    get state() { return current.state },
    get workspace() { return current.workspace },
    async dispatch(action) { await act(async () => current.dispatch(action)) },
    async start(method, ...args) {
      let done
      await act(async () => {
        done = Promise.resolve(current.workspace[method](...args)).then(
          (value) => ({ value }),
          (error) => ({ error }),
        )
      })
      return { done }
    },
  }
}

async function finishGrant(harness, path, task = null, { error = null, canonicalPath = path } = {}) {
  const request = harness.network.grant(path)
  assert.ok(request, `missing pending grant for ${path}`)
  await act(async () => {
    if (error) request.fail(error)
    else request.complete({ grant: { id: `grant:${path}`, path: canonicalPath } })
    if (task) await task.done
  })
}

async function finishPut(request, task, workspacePath, revision = 4) {
  assert.ok(request, 'missing session workspace update')
  await act(async () => {
    request.complete({ session: {
      id: request.url.split('/')[3], title: 'Updated', workspacePath, revision,
    } })
    if (task) await task.done
  })
}

test('guarded draft workspace actions reject changed drafts and active sessions but keep synchronous compatibility', () => {
  const initial = baseState()
  const action = { type: 'SET_DRAFT_WORKSPACE', payload: { workspacePath: ' /chosen ', expectedDraftVersion: 10 } }
  assert.equal(reduceState(initial, action).draftWorkspacePath, '/chosen')
  const newerDraft = reduceState(initial, { type: 'START_NEW_DRAFT' })
  assert.strictEqual(reduceState(newerDraft, action), newerDraft)
  const session = reduceState(initial, { type: 'SWITCH_SESSION', payload: 'session-a' })
  assert.strictEqual(reduceState(session, action), session)
  assert.equal(reduceState(newerDraft, {
    type: 'SET_DRAFT_WORKSPACE', payload: { workspacePath: '/synchronous' },
  }).draftWorkspacePath, '/synchronous')
})

for (const outcome of ['success', 'failure']) {
  test(`an old draft ${outcome} cannot replace a new draft selection or its busy/error state`, async (context) => {
    const harness = await mountWorkspace(context)
    const old = await harness.start('handleWorkspaceSelect', '/old')
    assert.equal(harness.workspace.workspaceBusy, true)
    await harness.dispatch({ type: 'START_NEW_DRAFT' })
    assert.equal(harness.state.newDraftVersion, 11)
    assert.equal(harness.workspace.workspaceBusy, false)
    const current = await harness.start('handleWorkspaceSelect', '/new')
    await finishGrant(harness, '/old', old, {
      error: outcome === 'failure' ? new Error('stale draft error') : null,
    })
    assert.equal(harness.state.draftWorkspacePath, '')
    assert.equal(harness.workspace.workspaceBusy, true)
    assert.equal(harness.workspace.workspaceError, '')
    await finishGrant(harness, '/new', current, { canonicalPath: '/new/canonical' })
    assert.equal(harness.state.draftWorkspacePath, '/new/canonical')
    assert.equal(harness.workspace.workspaceBusy, false)
    assert.equal(harness.workspace.workspaceError, '')
    assert.equal(harness.actions.at(-1).payload.expectedDraftVersion, 11)
  })

  test(`an old draft ${outcome} cannot affect a selected session`, async (context) => {
    const harness = await mountWorkspace(context)
    const old = await harness.start('handleWorkspaceSelect', '/old-draft')
    await harness.dispatch({ type: 'SWITCH_SESSION', payload: 'session-a' })
    assert.equal(harness.workspace.workspaceBusy, false)
    const current = await harness.start('handleWorkspaceSelect', '/session-workspace')
    await finishGrant(harness, '/old-draft', old, {
      error: outcome === 'failure' ? new Error('stale session error') : null,
    })
    assert.equal(harness.state.draftWorkspacePath, '')
    assert.equal(harness.workspace.workspaceBusy, true)
    assert.equal(harness.workspace.workspaceError, '')
    await finishGrant(harness, '/session-workspace', current)
    assert.equal(harness.workspace.selectedWorkspacePath, '/session-workspace')
    assert.equal(harness.state.sessions[1].workspacePath, '/existing/b')
  })
}

for (const startOrder of ['selection-first', 'authorization-first']) {
  for (const finishOrder of ['selection-first', 'authorization-first']) {
    for (const authorizationOutcome of ['success', 'failure']) {
      test(`turn authorization cannot compete with selection: ${startOrder}, ${finishOrder}, ${authorizationOutcome}`, async (context) => {
        const harness = await mountWorkspace(context, baseState({ draftWorkspacePath: '/turn-a' }))
        let selection
        let authorization
        if (startOrder === 'selection-first') {
          selection = await harness.start('handleWorkspaceSelect', '/selected-b')
          authorization = await harness.start('activateWorkspaceForTurn', '/turn-a')
        } else {
          authorization = await harness.start('activateWorkspaceForTurn', '/turn-a')
          selection = await harness.start('handleWorkspaceSelect', '/selected-b')
        }
        const error = authorizationOutcome === 'failure' ? new Error('turn-a authorization failed') : null
        if (finishOrder === 'authorization-first') {
          await finishGrant(harness, '/turn-a', authorization, { error })
          assert.equal(harness.workspace.workspaceBusy, true)
          assert.equal(harness.workspace.workspaceError, '')
          await finishGrant(harness, '/selected-b', selection)
        } else {
          await finishGrant(harness, '/selected-b', selection)
          assert.equal(harness.workspace.workspaceBusy, false)
          await finishGrant(harness, '/turn-a', authorization, { error })
        }
        assert.equal(harness.state.draftWorkspacePath, '/selected-b')
        assert.equal(harness.workspace.workspaceBusy, false)
        assert.equal(harness.workspace.workspaceError, '')
        if (error) assert.strictEqual((await authorization.done).error, error)
        else assert.equal((await authorization.done).value.path, '/turn-a')
      })
    }
  }
}

for (const startOrder of ['clear-first', 'authorization-first']) {
  test(`turn authorization cannot compete with a draft clear: ${startOrder}`, async (context) => {
    const harness = await mountWorkspace(context, baseState({ draftWorkspacePath: '/turn-a' }))
    let authorization
    if (startOrder === 'authorization-first') {
      authorization = await harness.start('activateWorkspaceForTurn', '/turn-a')
    }
    const clearing = await harness.start('handleWorkspaceClear')
    await clearing.done
    if (startOrder === 'clear-first') {
      authorization = await harness.start('activateWorkspaceForTurn', '/turn-a')
    }
    assert.equal(harness.state.draftWorkspacePath, '')
    assert.equal(harness.workspace.workspaceBusy, false)
    await finishGrant(harness, '/turn-a', authorization, { error: new Error('old turn failed') })
    assert.equal(harness.state.draftWorkspacePath, '')
    assert.equal(harness.workspace.workspaceBusy, false)
    assert.equal(harness.workspace.workspaceError, '')
  })
}

test('turn authorization cannot compete with a pending durable session clear', async (context) => {
  const harness = await mountWorkspace(context, baseState({
    activeSessionId: 'session-a',
    sessions: baseState().sessions.map((session) => ({ ...session, serverRevision: 3 })),
  }))
  const clearing = await harness.start('handleWorkspaceClear')
  const authorization = await harness.start('activateWorkspaceForTurn', '/existing/a')
  await finishGrant(harness, '/existing/a', authorization, { error: new Error('authorization failed') })
  assert.equal(harness.workspace.workspaceBusy, true)
  assert.equal(harness.workspace.workspaceError, '')
  await finishPut(harness.network.puts('session-a')[0], clearing, null)
  assert.equal(harness.workspace.selectedWorkspacePath, '')
  assert.equal(harness.workspace.workspaceBusy, false)
})

test('standalone turn authorization still reports bounded busy and error state', async (context) => {
  const harness = await mountWorkspace(context)
  const authorization = await harness.start('activateWorkspaceForTurn', '/turn')
  assert.equal(harness.workspace.workspaceBusy, true)
  await finishGrant(harness, '/turn', authorization, { error: new Error('authorization failed') })
  assert.equal(harness.workspace.workspaceBusy, false)
  assert.equal(harness.workspace.workspaceError, 'authorization failed')
})

test('the latest selection in one draft wins without stale completion clearing its busy state', async (context) => {
  const harness = await mountWorkspace(context)
  const first = await harness.start('handleWorkspaceSelect', '/first')
  const second = await harness.start('handleWorkspaceSelect', '/second')
  await finishGrant(harness, '/first', first)
  assert.equal(harness.state.draftWorkspacePath, '')
  assert.equal(harness.workspace.workspaceBusy, true)
  await finishGrant(harness, '/second', second)
  assert.equal(harness.state.draftWorkspacePath, '/second')
  assert.equal(harness.workspace.workspaceBusy, false)
})

test('a successful newer selection is not overwritten when the older request finishes last', async (context) => {
  const harness = await mountWorkspace(context)
  const first = await harness.start('handleWorkspaceSelect', '/first')
  const second = await harness.start('handleWorkspaceSelect', '/second')
  await finishGrant(harness, '/second', second)
  await finishGrant(harness, '/first', first)
  assert.equal(harness.state.draftWorkspacePath, '/second')
  assert.equal(harness.workspace.workspaceBusy, false)
  assert.equal(harness.workspace.workspaceError, '')
})

test('leaving a draft revokes its selection even when navigation returns to the same draft version', async (context) => {
  const harness = await mountWorkspace(context)
  const selection = await harness.start('handleWorkspaceSelect', '/departed-draft')
  await harness.dispatch({ type: 'SWITCH_SESSION', payload: 'session-a' })
  await harness.dispatch({ type: 'DELETE_SESSION', payload: 'session-a' })
  assert.equal(harness.state.activeSessionId, null)
  assert.equal(harness.state.newDraftVersion, 10)
  await finishGrant(harness, '/departed-draft', selection)
  assert.equal(harness.state.draftWorkspacePath, '')
  assert.equal(harness.workspace.workspaceBusy, false)
})

test('a late successful selection cannot erase the newer selection failure', async (context) => {
  const harness = await mountWorkspace(context)
  const first = await harness.start('handleWorkspaceSelect', '/first')
  const second = await harness.start('handleWorkspaceSelect', '/second')
  await finishGrant(harness, '/second', second, { error: new Error('latest selection failed') })
  await finishGrant(harness, '/first', first)
  assert.equal(harness.state.draftWorkspacePath, '')
  assert.equal(harness.workspace.workspaceError, 'latest selection failed')
  assert.equal(harness.workspace.workspaceBusy, false)
})

test('clearing a draft supersedes pending selection and leaves it unscoped', async (context) => {
  const harness = await mountWorkspace(context, baseState({ draftWorkspacePath: '/existing' }))
  const selection = await harness.start('handleWorkspaceSelect', '/pending')
  const cleared = await harness.start('handleWorkspaceClear')
  await cleared.done
  assert.equal(harness.state.draftWorkspacePath, '')
  assert.equal(harness.workspace.workspaceBusy, false)
  assert.equal(harness.actions.at(-1).payload.expectedDraftVersion, 10)
  await finishGrant(harness, '/pending', selection)
  assert.equal(harness.state.draftWorkspacePath, '')
})

test('existing session metadata is applied only to its captured session after navigation', async (context) => {
  const harness = await mountWorkspace(context, baseState({
    activeSessionId: 'session-a',
    sessions: baseState().sessions.map((session) => ({ ...session, serverRevision: 3 })),
  }))
  const selection = await harness.start('handleWorkspaceSelect', '/chosen-a')
  await harness.dispatch({ type: 'SWITCH_SESSION', payload: 'session-b' })
  assert.equal(harness.workspace.workspaceBusy, false)
  await finishGrant(harness, '/chosen-a')
  assert.equal(harness.network.puts('session-a').length, 1)
  assert.equal(harness.network.puts('session-b').length, 0)
  await finishPut(harness.network.puts('session-a')[0], selection, '/chosen-a')
  assert.equal(harness.state.sessions[0].workspacePath, '/chosen-a')
  assert.equal(harness.workspace.selectedWorkspacePath, '/existing/b')
  assert.equal(harness.workspace.workspaceBusy, false)
  assert.equal(harness.workspace.workspaceError, '')
})

test('an existing session error cannot show up in another session or a new draft', async (context) => {
  const harness = await mountWorkspace(context, baseState({ activeSessionId: 'session-a' }))
  const selection = await harness.start('handleWorkspaceSelect', '/chosen-a')
  await harness.dispatch({ type: 'SWITCH_SESSION', payload: 'session-b' })
  await finishGrant(harness, '/chosen-a', selection, { error: new Error('session-a failed') })
  assert.equal(harness.workspace.workspaceError, '')
  await harness.dispatch({ type: 'START_NEW_DRAFT' })
  assert.equal(harness.workspace.workspaceError, '')
  assert.equal(harness.workspace.workspaceBusy, false)
})

test('an existing session update cannot replace a new draft workspace or end its selection', async (context) => {
  const harness = await mountWorkspace(context, baseState({
    activeSessionId: 'session-a',
    sessions: baseState().sessions.map((session) => ({ ...session, serverRevision: 3 })),
  }))
  const sessionSelection = await harness.start('handleWorkspaceSelect', '/chosen-session')
  await harness.dispatch({ type: 'START_NEW_DRAFT' })
  const draftSelection = await harness.start('handleWorkspaceSelect', '/chosen-draft')
  await finishGrant(harness, '/chosen-session')
  await finishPut(harness.network.puts('session-a')[0], sessionSelection, '/chosen-session')
  assert.equal(harness.state.sessions[0].workspacePath, '/chosen-session')
  assert.equal(harness.state.draftWorkspacePath, '')
  assert.equal(harness.workspace.workspaceBusy, true)
  assert.equal(harness.workspace.workspaceError, '')
  await finishGrant(harness, '/chosen-draft', draftSelection)
  assert.equal(harness.state.draftWorkspacePath, '/chosen-draft')
})

test('an old session clear failure cannot affect a new draft selection', async (context) => {
  const harness = await mountWorkspace(context, baseState({
    activeSessionId: 'session-a',
    sessions: baseState().sessions.map((session) => ({ ...session, serverRevision: 3 })),
  }))
  const clearing = await harness.start('handleWorkspaceClear')
  await harness.dispatch({ type: 'START_NEW_DRAFT' })
  const selection = await harness.start('handleWorkspaceSelect', '/new-draft')
  await act(async () => {
    harness.network.puts('session-a')[0].fail(new Error('old session clear failed'))
    await clearing.done
  })
  assert.equal(harness.workspace.workspaceBusy, true)
  assert.equal(harness.workspace.workspaceError, '')
  await finishGrant(harness, '/new-draft', selection)
  assert.equal(harness.state.draftWorkspacePath, '/new-draft')
})

test('a later clear serializes behind an in-flight session update and wins', async (context) => {
  const harness = await mountWorkspace(context, baseState({
    activeSessionId: 'session-a',
    sessions: baseState().sessions.map((session) => ({ ...session, serverRevision: 3 })),
  }))
  const selection = await harness.start('handleWorkspaceSelect', '/selected')
  await finishGrant(harness, '/selected')
  const clearing = await harness.start('handleWorkspaceClear')
  assert.equal(harness.network.puts('session-a').length, 1)
  await finishPut(harness.network.puts('session-a')[0], selection, '/selected')
  assert.equal(harness.workspace.workspaceBusy, true)
  const clearRequest = harness.network.puts('session-a')[1]
  assert.equal(clearRequest.body.workspacePath, null)
  await finishPut(clearRequest, clearing, null, 5)
  assert.equal(harness.workspace.selectedWorkspacePath, '')
  assert.equal(harness.workspace.workspaceBusy, false)
})

test('a later selection serializes behind an in-flight session clear and wins', async (context) => {
  const harness = await mountWorkspace(context, baseState({
    activeSessionId: 'session-a',
    sessions: baseState().sessions.map((session) => ({ ...session, serverRevision: 3 })),
  }))
  const clearing = await harness.start('handleWorkspaceClear')
  const selection = await harness.start('handleWorkspaceSelect', '/selected-after-clear')
  await finishGrant(harness, '/selected-after-clear')
  assert.equal(harness.network.puts('session-a').length, 1)
  await finishPut(harness.network.puts('session-a')[0], clearing, null)
  assert.equal(harness.workspace.workspaceBusy, true)
  const selectionRequest = harness.network.puts('session-a')[1]
  assert.equal(selectionRequest.body.workspacePath, '/selected-after-clear')
  await finishPut(selectionRequest, selection, '/selected-after-clear', 5)
  assert.equal(harness.workspace.selectedWorkspacePath, '/selected-after-clear')
  assert.equal(harness.workspace.workspaceBusy, false)
})

test('a failed earlier session update does not block or taint a newer queued clear', async (context) => {
  const harness = await mountWorkspace(context, baseState({
    activeSessionId: 'session-a',
    sessions: baseState().sessions.map((session) => ({ ...session, serverRevision: 3 })),
  }))
  const selection = await harness.start('handleWorkspaceSelect', '/failed-selection')
  await finishGrant(harness, '/failed-selection')
  const clearing = await harness.start('handleWorkspaceClear')
  await act(async () => {
    harness.network.puts('session-a')[0].fail(new Error('earlier write failed'))
    await selection.done
  })
  assert.equal(harness.workspace.workspaceBusy, true)
  assert.equal(harness.workspace.workspaceError, '')
  await finishPut(harness.network.puts('session-a')[1], clearing, null)
  assert.equal(harness.workspace.selectedWorkspacePath, '')
  assert.equal(harness.workspace.workspaceBusy, false)
})

test('a stale turn activation failure cannot end a new draft selection', async (context) => {
  const harness = await mountWorkspace(context)
  const activation = await harness.start('activateWorkspaceForTurn', '/turn-workspace')
  await harness.dispatch({ type: 'START_NEW_DRAFT' })
  const selection = await harness.start('handleWorkspaceSelect', '/new-selection')
  await finishGrant(harness, '/turn-workspace', activation, { error: new Error('stale activation') })
  assert.equal(harness.workspace.workspaceBusy, true)
  assert.equal(harness.workspace.workspaceError, '')
  await finishGrant(harness, '/new-selection', selection)
  assert.equal(harness.state.draftWorkspacePath, '/new-selection')
})

for (const outcome of ['success', 'failure']) {
  test(`a delayed turn activation ${outcome} still authorizes its captured path without touching the new scope`, async (context) => {
    const harness = await mountWorkspace(context)
    const activateForOriginalTurn = harness.workspace.activateWorkspaceForTurn
    await harness.dispatch({ type: 'START_NEW_DRAFT' })
    const selection = await harness.start('handleWorkspaceSelect', '/current-selection')
    let done
    await act(async () => {
      done = activateForOriginalTurn('/original-turn').then(
        (value) => ({ value }),
        (error) => ({ error }),
      )
    })
    await finishGrant(harness, '/original-turn', { done }, {
      error: outcome === 'failure' ? new Error('original turn authorization failed') : null,
    })
    assert.equal(harness.workspace.workspaceBusy, true)
    assert.equal(harness.workspace.workspaceError, '')
    assert.equal(harness.state.draftWorkspacePath, '')
    if (outcome === 'success') assert.equal((await done).value.path, '/original-turn')
    else assert.equal((await done).error.message, 'original turn authorization failed')
    await finishGrant(harness, '/current-selection', selection)
    assert.equal(harness.state.draftWorkspacePath, '/current-selection')
  })
}
