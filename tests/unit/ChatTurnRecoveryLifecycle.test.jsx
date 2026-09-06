import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act, useLayoutEffect } from 'react'
import { createRoot } from 'react-dom/client'

import { HashRouter } from '../../src/lib/router.jsx'
import useChatTurnRecovery from '../../src/pages/ChatSplit/useChatTurnRecovery.js'

const noop = () => {}
const translate = (key) => key
const approvals = {
  requestServerToolApproval: noop,
  resolveToolApprovalForOwner: noop,
  clearToolApprovalForOwner: noop,
}

function failureMessage(turnId = 'turn-a', sequence = 7, meta = {}) {
  return {
    id: `${turnId}:assistant`,
    role: 'assistant',
    content: 'saved partial answer',
    meta: {
      serverTurnId: turnId,
      serverLastSequence: sequence,
      failed: true,
      serverFailure: { code: 'TURN_INCOMPLETE', retryable: true },
      ...meta,
    },
  }
}

function snapshot(messages, { sessionId = 'session-a', otherSessions = [] } = {}) {
  return {
    activeSessionId: sessionId,
    sessions: [{ id: sessionId, messages }, ...otherSessions],
  }
}

function Harness({ state, stateRef, abortCtrlRef, resumingTurnIdsRef, onReady }) {
  const messages = state.sessions.find((session) => session.id === state.activeSessionId)?.messages || []
  const recovery = useChatTurnRecovery({
    abortCtrlRef,
    activeSessionId: state.activeSessionId,
    approvals,
    dispatch: noop,
    isGenerating: false,
    messages,
    resumingTurnIdsRef,
    setInput: noop,
    setWorkbenchMessage: noop,
    state,
    stateRef,
    t: translate,
    toast: { success: noop },
  })
  useLayoutEffect(() => onReady(recovery))
  return <output data-resume={recovery.resumeAvailable}>{String(recovery.resumeAvailable)}</output>
}

async function mountRecovery(context, initialState) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/#/chat' })
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
  context.mock.method(globalThis, 'fetch', () => assert.fail('recovery presentation must not send a request'))
  const root = createRoot(document.getElementById('root'))
  const stateRef = { current: initialState }
  const abortCtrlRef = { current: null }
  const resumingTurnIdsRef = { current: new Set() }
  let recovery
  const onReady = (value) => { recovery = value }
  const render = async (state) => {
    stateRef.current = state
    await act(async () => root.render(
      <HashRouter>
        <Harness {...{ state, stateRef, abortCtrlRef, resumingTurnIdsRef, onReady }} />
      </HashRouter>,
    ))
  }
  context.after(async () => {
    await act(async () => root.unmount())
    dom.window.close()
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
  })
  await render(initialState)
  return {
    render,
    abortCtrlRef,
    get available() { return recovery.resumeAvailable },
    get manualRetryAvailable() { return recovery.manualRetryAvailable },
    async call(method, ...args) { await act(async () => recovery[method](...args)) },
  }
}

test('dismissal survives cloned messages and session switches but not a new failure boundary', async (context) => {
  const initial = snapshot([failureMessage()])
  const view = await mountRecovery(context, initial)
  assert.equal(view.available, true)
  await view.call('handleDismissResume')
  assert.equal(view.available, false)
  await view.render(structuredClone(initial))
  assert.equal(view.available, false)

  await view.render(snapshot([failureMessage()], { sessionId: 'session-b' }))
  assert.equal(view.available, true, 'the same turn identifier in another session is independent')
  await view.render(structuredClone(initial))
  assert.equal(view.available, false)
  await view.render(snapshot([failureMessage('turn-a', 7, { turnCompletedAt: 999 })]))
  assert.equal(view.available, false, 'display metadata does not create a new server failure')

  await view.render(snapshot([failureMessage('turn-a', 9)]))
  assert.equal(view.available, true, 'a later failure of the same resumed turn remains recoverable')
  await view.call('handleDismissResume')
  await view.render(snapshot([failureMessage('turn-new', 7)]))
  assert.equal(view.available, true, 'a new turn retains its own recovery entry')
})

test('an accepted new send retires the old prompt before messages arrive and after a greeting succeeds', async (context) => {
  const initial = snapshot([failureMessage()])
  const view = await mountRecovery(context, initial)
  await view.call('handleTurnStart', { sessionId: 'session-a' })
  assert.equal(view.available, false)
  await view.render(structuredClone(initial))
  assert.equal(view.available, false, 'an old snapshot cannot undo the accepted send boundary')

  const messages = [...initial.sessions[0].messages, { id: 'greeting', role: 'user', content: 'hi' }]
  await view.render(snapshot(messages))
  assert.equal(view.available, false)
  const completed = snapshot([...messages, { id: 'greeting-answer', role: 'assistant', content: 'Hello!' }])
  await view.render(completed)
  await view.call('handleTurnResult', {
    sessionId: 'session-a', turnId: 'turn-greeting', result: { terminal: { type: 'turn.completed' } },
  })
  await view.render(snapshot([], { sessionId: 'session-b' }))
  await view.render(structuredClone(completed))
  assert.equal(view.available, false)
})

test('late failures and successes from an older turn do not replace the latest recovery state', async (context) => {
  const original = failureMessage()
  const view = await mountRecovery(context, snapshot([
    original, { id: 'answer', role: 'assistant', content: 'Hello!' },
  ]))
  const lateFailure = {
    sessionId: 'session-a', turnId: 'turn-a',
    result: { failed: true, error: { code: 'TURN_INCOMPLETE', retryable: true, partialText: 'old output' } },
  }
  await view.call('handleTurnResult', lateFailure)
  assert.equal(view.available, false)

  await view.render(snapshot([original, failureMessage('turn-new')]))
  assert.equal(view.available, true)
  await view.call('handleTurnResult', { ...lateFailure, result: { terminal: { type: 'turn.completed' } } })
  assert.equal(view.available, true, 'an older success cannot clear a newer genuine failure')
  await view.call('handleDismissResume')
  await view.call('handleTurnResult', { ...lateFailure, turnId: 'turn-new' })
  assert.equal(view.available, false, 'a delayed result cannot undo an explicit dismissal')
})

test('starting a new send consumes a queued retry without hiding future same-turn recovery', async (context) => {
  const view = await mountRecovery(context, snapshot([failureMessage()]))
  // Keep the retry queued at the controller boundary so this test remains
  // entirely local and exercises the real recovery hook without a server.
  view.abortCtrlRef.current = new AbortController()
  await view.call('handleResume')
  assert.equal(view.available, false)
  await view.call('handleTurnStart', { sessionId: 'session-a' })
  await view.render(snapshot([failureMessage('turn-a', 10)]))
  assert.equal(view.available, true)
})

test('manual recovery without partial output remains visible for the latest failure', async (context) => {
  const message = failureMessage('turn-manual', 12, {
    serverFailure: {
      code: 'TASK_VERIFICATION_REPAIR_EXHAUSTED', retryable: false, manualRetryable: true,
    },
  })
  message.content = ''
  const view = await mountRecovery(context, snapshot([message]))
  assert.equal(view.available, true)
  assert.equal(view.manualRetryAvailable, true)
  await view.call('handleDismissResume')
  await view.render(snapshot([structuredClone(message)]))
  assert.equal(view.available, false)
  await view.render(snapshot([{ ...message, meta: { ...message.meta, serverLastSequence: 14 } }]))
  assert.equal(view.manualRetryAvailable, true)
})
