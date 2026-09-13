import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act, useEffect } from 'react'
import { createRoot } from 'react-dom/client'

import { HashRouter } from '../../src/lib/router.jsx'
import useManualRecoveryRouteResume, {
  manualRecoveryResumeFromLocation,
} from '../../src/pages/ChatSplit/useManualRecoveryRouteResume.js'

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/#/chat',
  })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  return dom
}

test('manual recovery route state is validated and consumed exactly once with replace', async () => {
  const dom = setupDom()
  const descriptor = {
    kind: 'turn', sessionId: 'session-1', turnId: 'turn-1', toolCallId: 'call-1', ignored: true,
  }
  window.history.replaceState({ manualRecoveryResume: descriptor }, '', '#/chat')
  const initialHistoryLength = window.history.length
  const observed = []

  function Harness() {
    const { manualRecoveryResume, onManualRecoveryConsumed } = useManualRecoveryRouteResume()
    useEffect(() => {
      if (!manualRecoveryResume) return
      observed.push(manualRecoveryResume)
      onManualRecoveryConsumed()
    }, [manualRecoveryResume, onManualRecoveryConsumed])
    return <span data-testid="route-state">{manualRecoveryResume ? 'pending' : 'consumed'}</span>
  }

  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  try {
    await act(async () => {
      root.render(<HashRouter><Harness /></HashRouter>)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    assert.deepEqual(observed, [{
      kind: 'turn', sessionId: 'session-1', turnId: 'turn-1', toolCallId: 'call-1',
    }])
    assert.equal(rootElement.textContent, 'consumed')
    assert.equal(window.history.state, null)
    assert.equal(window.history.length, initialHistoryLength)

    await act(async () => window.dispatchEvent(new dom.window.PopStateEvent('popstate')))
    assert.equal(observed.length, 1)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('manual recovery route state rejects incomplete or non-turn descriptors', () => {
  assert.equal(manualRecoveryResumeFromLocation({ state: {
    manualRecoveryResume: { kind: 'turn', sessionId: 'session-1', turnId: '', toolCallId: 'call-1' },
  } }), null)
  assert.equal(manualRecoveryResumeFromLocation({ state: {
    manualRecoveryResume: { kind: 'turn', sessionId: 'session-1', turnId: 'turn-1', toolCallId: '' },
  } }), null)
  assert.equal(manualRecoveryResumeFromLocation({ state: {
    manualRecoveryResume: { kind: 'job', jobId: 'job-1', stepId: 'step-1' },
  } }), null)
  assert.equal(manualRecoveryResumeFromLocation({ state: null }), null)
})

test('inline confirmation requests and consumes recovery on the same route without settings or a new history entry', async () => {
  const dom = setupDom()
  const route = '#/chat?view=conversation#message-a'
  window.history.replaceState({ preserved: 'route-data' }, '', route)
  const initialHistoryLength = window.history.length
  const descriptor = { kind: 'turn', sessionId: 'session-a', turnId: 'turn-a', toolCallId: 'call-a' }
  const observed = []
  let request
  function Harness() {
    const { manualRecoveryResume, onManualRecoveryConsumed, requestManualRecoveryResume } = useManualRecoveryRouteResume()
    request = requestManualRecoveryResume
    useEffect(() => {
      if (!manualRecoveryResume) return
      observed.push(manualRecoveryResume)
      onManualRecoveryConsumed()
    }, [manualRecoveryResume, onManualRecoveryConsumed])
    return null
  }
  const root = createRoot(document.getElementById('root'))
  try {
    await act(async () => root.render(<HashRouter><Harness /></HashRouter>))
    await act(async () => assert.equal(request({ ...descriptor, ignored: true }), true))
    assert.deepEqual(observed, [descriptor])
    assert.equal(window.location.hash, route)
    assert.equal(window.history.length, initialHistoryLength)
    assert.deepEqual(window.history.state, { preserved: 'route-data' })
    await act(async () => assert.equal(request({ ...descriptor, toolCallId: ' ' }), false))
    assert.equal(observed.length, 1)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('an inline continuation cannot navigate from a different page', async () => {
  const dom = setupDom()
  window.history.replaceState(null, '', '#/settings')
  let request
  function Harness() {
    request = useManualRecoveryRouteResume().requestManualRecoveryResume
    return null
  }
  const root = createRoot(document.getElementById('root'))
  try {
    await act(async () => root.render(<HashRouter><Harness /></HashRouter>))
    assert.equal(request({ kind: 'turn', sessionId: 'session-a', turnId: 'turn-a', toolCallId: 'call-a' }), false)
    assert.equal(window.location.hash, '#/settings')
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('inline guards survive route storage and an old consumer cannot clear a newer marker', async () => {
  const dom = setupDom()
  const root = createRoot(document.getElementById('root'))
  let recovery
  function Harness() {
    recovery = useManualRecoveryRouteResume()
    return null
  }
  const first = { kind: 'turn', sessionId: 'session-a', turnId: 'turn-a', toolCallId: 'call-a',
    inlineGuard: { ownerScope: '["backend-a","user-a"]', messageId: 'message-a', sequence: 12 } }
  const second = { ...first, inlineGuard: { ...first.inlineGuard, sequence: 13 } }
  try {
    await act(async () => root.render(<HashRouter><Harness /></HashRouter>))
    await act(async () => assert.equal(recovery.requestManualRecoveryResume(first), true))
    assert.deepEqual(recovery.manualRecoveryResume, first)
    const staleConsume = recovery.onManualRecoveryConsumed
    await act(async () => assert.equal(recovery.requestManualRecoveryResume(second), true))
    await act(async () => assert.equal(staleConsume(), false))
    assert.deepEqual(window.history.state.manualRecoveryResume, second)
    await act(async () => assert.equal(recovery.onManualRecoveryConsumed(second), true))
    assert.equal(window.history.state, null)
    assert.equal(manualRecoveryResumeFromLocation({ state: { manualRecoveryResume: {
      ...first, inlineGuard: { ...first.inlineGuard, sequence: undefined },
    } } }), null)
    const staleRequest = recovery.requestManualRecoveryResume
    window.history.replaceState(null, '', '#/settings')
    assert.equal(staleRequest(first), false, 'a delayed action must not navigate back from another page')
    assert.equal(window.location.hash, '#/settings')
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})
