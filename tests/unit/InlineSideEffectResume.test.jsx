import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { inlineSideEffectResumeForCurrentMessage } from '../../src/pages/ChatSplit/useChatTurnRecovery.js'
import useManualRecoveryRouteResume from '../../src/pages/ChatSplit/useManualRecoveryRouteResume.js'
import useServerTurnResume from '../../src/pages/ChatSplit/useServerTurnResume.js'
import { hasTurnRun } from '../../src/pages/ChatSplit/turnRunRegistry.js'
import { HashRouter } from '../../src/lib/router.jsx'
import { setupDom } from './helpers/messageRowActivityTestUtils.js'

function fixture() {
  const ownerScope = '["backend-a","user-a"]'
  const message = { id: 'assistant-a', role: 'assistant', meta: {
    serverTurnId: 'turn-a', serverRecoveryToolCallId: 'call-a', serverLastSequence: 9,
    serverRecoveryBlocked: true, serverRecoveryKind: 'side_effect_outcome_unknown', serverConnectionState: 'blocked',
  } }
  return {
    state: { isLoggedIn: true, user: { id: 'user-a' }, sessionCatalogSource: { backendInstanceId: 'backend-a' },
      activeSessionId: 'session-a', sessions: [{ id: 'session-a', messages: [structuredClone(message)] }] },
    ownerScope, submittedOwnerScope: ownerScope, message,
    record: { scopeKind: 'turn', scopeKey: '["turn","session-a","turn-a"]', argsDigest: 'a'.repeat(64),
      sessionId: 'session-a', turnId: 'turn-a', toolCallId: 'call-a', status: 'committed' },
    resume: { kind: 'turn', sessionId: 'session-a', turnId: 'turn-a', toolCallId: 'call-a' },
  }
}

for (const status of ['committed', 'failed']) {
  test(`inline ${status} confirmation produces only the current blocked task descriptor`, () => {
    const input = fixture()
    input.record.status = status
    assert.deepEqual(inlineSideEffectResumeForCurrentMessage(input), { ...input.resume, inlineGuard: {
      ownerScope: input.ownerScope, messageId: input.message.id, sequence: input.message.meta.serverLastSequence,
    } })
    assert.equal(input.state.sessions[0].messages[0].meta.serverRecoveryBlocked, true)
  })
}

const changes = {
  owner: (input) => { input.state.user.id = 'user-b' },
  backend: (input) => { input.state.sessionCatalogSource.backendInstanceId = 'backend-b' },
  logout: (input) => { input.state.isLoggedIn = false },
  submittedOwner: (input) => { input.submittedOwnerScope = '["backend-a","user-b"]' },
  session: (input) => { input.state.activeSessionId = 'session-b' },
  message: (input) => { input.message.id = 'another-assistant' },
  sequence: (input) => { input.state.sessions[0].messages[0].meta.serverLastSequence = 10 },
  missingSequence: (input) => {
    delete input.state.sessions[0].messages[0].meta.serverLastSequence
    delete input.message.meta.serverLastSequence
  },
  cancellation: (input) => { input.state.sessions[0].messages[0].meta.cancelled = true },
  streaming: (input) => { input.state.sessions[0].messages[0].meta.streaming = true },
  resumed: (input) => { input.state.sessions[0].messages[0].meta.serverConnectionState = 'reconnecting' },
  unblocked: (input) => { input.state.sessions[0].messages[0].meta.serverRecoveryBlocked = false },
  modelUnknown: (input) => { input.state.sessions[0].messages[0].meta.serverRecoveryKind = 'model_request_outcome_unknown' },
  tool: (input) => { input.resume.toolCallId = 'another-call' },
  turn: (input) => { input.resume.turnId = 'another-turn' },
  scope: (input) => { input.record.scopeKey = '["turn","another-session","turn-a"]' },
  unresolved: (input) => { input.record.status = 'unknown' },
  running: (input) => { input.running = true },
}

function resumeOptions(input, refs, overrides = {}) {
  return {
    ...refs, clearToolApprovalForOwner: () => {}, requestServerToolApproval: () => {},
    resolveToolApprovalForOwner: () => {}, dispatch: () => {}, t: (key) => key,
    stateActiveSessionId: input.state.activeSessionId, stateResumeSignal: 0, stateTurnRunActive: false,
    ...overrides,
  }
}

for (const drift of ['owner', 'backend', 'session', 'sequence', 'cancellation', 'streaming']) {
  test(`a queued inline marker is discarded before transport after ${drift} changes`, async (context) => {
    const dom = setupDom()
    const input = fixture()
    const descriptor = inlineSideEffectResumeForCurrentMessage(input)
    window.history.replaceState({ manualRecoveryResume: descriptor }, '', '#/chat')
    const refs = { abortCtrlRef: { current: new AbortController() }, resumingTurnIdsRef: { current: new Set() }, stateRef: { current: input.state } }
    let requests = 0
    context.mock.method(globalThis, 'fetch', async () => { requests += 1; throw new Error('No stale transport is allowed') })
    const consumed = []
    function Harness({ tick }) {
      const recovery = useManualRecoveryRouteResume()
      useServerTurnResume(resumeOptions(input, refs, {
        stateResumeSignal: tick, stateTurnRunActive: tick === 0,
        manualRecoveryResume: recovery.manualRecoveryResume,
        onManualRecoveryConsumed: (expected) => { consumed.push(expected); return recovery.onManualRecoveryConsumed(expected) },
      }))
      return null
    }
    const root = createRoot(document.getElementById('root'))
    try {
      await act(async () => root.render(<HashRouter><Harness tick={0} /></HashRouter>))
      assert.equal(consumed.length, 0, 'a busy valid marker remains queued')
      assert.equal(requests, 0)
      changes[drift](input)
      refs.abortCtrlRef.current = null
      await act(async () => root.render(<HashRouter><Harness tick={1} /></HashRouter>))
      assert.deepEqual(consumed, [descriptor])
      assert.equal(window.history.state, null)
      assert.equal(requests, 0)
      assert.equal(refs.resumingTurnIdsRef.current.size, 0)
    } finally {
      await act(async () => root.unmount())
      dom.window.close()
    }
  })
}

test('a replaced marker releases a claimed resume without opening transport', async (context) => {
  const dom = setupDom()
  const input = fixture()
  const refs = { abortCtrlRef: { current: null }, resumingTurnIdsRef: { current: new Set() }, stateRef: { current: input.state } }
  let requests = 0
  context.mock.method(globalThis, 'fetch', async () => { requests += 1; throw new Error('No stale transport is allowed') })
  function Harness() {
    useServerTurnResume(resumeOptions(input, refs, {
      manualRecoveryResume: inlineSideEffectResumeForCurrentMessage(input),
      onManualRecoveryConsumed: () => false,
    }))
    return null
  }
  const root = createRoot(document.getElementById('root'))
  try {
    await act(async () => root.render(<Harness />))
    assert.equal(requests, 0)
    assert.equal(refs.abortCtrlRef.current, null)
    assert.equal(refs.resumingTurnIdsRef.current.size, 0)
    assert.equal(hasTurnRun('session-a'), false)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})
for (const [name, change] of Object.entries(changes)) {
  test(`inline recovery cannot resume after ${name} changes`, () => {
    const input = fixture()
    change(input)
    assert.equal(inlineSideEffectResumeForCurrentMessage(input), null)
  })
}
