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
