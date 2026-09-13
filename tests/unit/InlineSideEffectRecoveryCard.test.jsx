import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import InlineSideEffectRecoveryCard from '../../src/pages/ChatSplit/chatMessages/messageRow/InlineSideEffectRecoveryCard.jsx'
import { translateKey } from '../../src/i18n/translations.js'
import { setupDom } from './helpers/messageRowActivityTestUtils.js'

const ownerScope = '["backend-a","user-a"]'
const message = {
  id: 'message-a', role: 'assistant', content: '', meta: {
    serverTurnId: 'turn-a', serverRecoveryToolCallId: 'call-a', serverLastSequence: 12,
    serverRecoveryBlocked: true, serverRecoveryKind: 'side_effect_outcome_unknown',
    serverConnectionState: 'blocked', serverRecoveryActionPath: '/settings?tab=recovery',
  },
}
const t = (key, values) => translateKey(key, 'zh', values)
function interaction({ sessionId = 'session-a', turnId = 'turn-a', toolCallId = 'call-a' } = {}) {
  return {
    record: {
      scopeKind: 'turn', sessionId, turnId, toolCallId, toolName: 'create_pptx',
      scopeKey: JSON.stringify(['turn', sessionId, turnId]),
      argsDigest: 'a'.repeat(64), status: 'unknown',
      intentSummary: { command: 'safe operation summary', targets: [{ value: 'example.pptx' }] },
      failure: { code: 'PPTX_CONTENT_INVALID', message: 'slides[7].bullets or body is required', hint: 'Check the exact slide.' },
    },
    boundary: { id: 'blocked-a', sequence: 12, type: 'turn.blocked' },
  }
}
function resolved(input) {
  return { record: { ...input.record, status: input.resolution }, resume: {
    kind: 'turn', sessionId: input.record.sessionId, turnId: input.record.turnId, toolCallId: input.record.toolCallId,
  } }
}
function deferred() {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function mount(context, overrides = {}) {
  const dom = setupDom()
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  const loads = []
  const decisions = []
  const resumes = []
  let mounted = true
  let props = { sessionId: 'session-a', ownerScope, msg: structuredClone(message), t,
    loadInteraction: async (scope) => { loads.push(scope); return interaction(scope) },
    resolveInteraction: async (input) => { decisions.push(input); return resolved(input) },
    onResolved: (value) => { resumes.push(value); return true }, ...overrides }
  const render = async (updates = {}) => {
    props = { ...props, ...updates }
    await act(async () => root.render(<InlineSideEffectRecoveryCard {...props} />))
  }
  const click = async (id) => act(async () => {
    const button = rootElement.querySelector(`[data-testid="inline-side-effect-${id}"]`)
    assert.ok(button, id)
    button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  const unmount = async () => { if (mounted) { mounted = false; await act(async () => root.unmount()) } }
  context.after(async () => { await unmount(); dom.window.close() })
  await render()
  return { dom, rootElement, render, click, loads, decisions, resumes, unmount }
}

test('inline recovery loads only its scope, displays safe evidence and never auto-confirms or uses global Enter', async (context) => {
  const data = interaction()
  data.record.args = { secret: 'raw-argument-must-not-render' }
  data.record.stack = 'raw-stack-must-not-render'
  data.record.failure.message = '<img src="bad" onerror="bad()"> slides[7].bullets'
  const loads = []
  const view = await mount(context, { loadInteraction: async (scope) => { loads.push(scope); return data } })
  assert.equal(loads.length, 1)
  assert.deepEqual({ sessionId: loads[0].sessionId, turnId: loads[0].turnId, toolCallId: loads[0].toolCallId },
    { sessionId: 'session-a', turnId: 'turn-a', toolCallId: 'call-a' })
  assert.match(view.rootElement.textContent, /create_pptx|example\.pptx/u)
  assert.match(view.rootElement.textContent, /slides\[7\]\.bullets/u)
  assert.equal(view.rootElement.querySelector('img'), null)
  assert.equal(view.rootElement.querySelector('input,textarea,a[href*="settings"]'), null)
  assert.doesNotMatch(view.rootElement.textContent, /raw-argument-must-not-render|raw-stack-must-not-render/u)
  await act(async () => window.dispatchEvent(new view.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  assert.equal(view.decisions.length, 0)
  assert.equal(view.resumes.length, 0)
})

for (const resolution of ['failed', 'committed']) {
  test(`one explicit ${resolution} choice sends the exact snapshot and resumes only that task`, async (context) => {
    const pending = deferred()
    const decisions = []
    const view = await mount(context, { resolveInteraction: (input) => { decisions.push(input); return pending.promise } })
    const button = view.rootElement.querySelector(`[data-testid="inline-side-effect-${resolution}"]`)
    await act(async () => {
      button.dispatchEvent(new view.dom.window.MouseEvent('click', { bubbles: true }))
      button.dispatchEvent(new view.dom.window.MouseEvent('click', { bubbles: true }))
    })
    assert.equal(decisions.length, 1)
    assert.equal(decisions[0].resolution, resolution)
    assert.equal(decisions[0].verificationConfirmed, true)
    assert.equal(decisions[0].confirmToolCallId, 'call-a')
    assert.deepEqual(decisions[0].record, interaction().record)
    assert.deepEqual(decisions[0].boundary, interaction().boundary)
    assert.equal(view.rootElement.querySelector('[data-testid="inline-side-effect-defer"]').disabled, true)
    assert.equal(view.resumes.length, 0)
    await act(async () => pending.resolve(resolved(decisions[0])))
    assert.equal(view.resumes.length, 1)
    assert.deepEqual(view.resumes[0].resume, { kind: 'turn', sessionId: 'session-a', turnId: 'turn-a', toolCallId: 'call-a' })
    assert.equal(view.resumes[0].ownerScope, ownerScope)
    assert.equal(view.resumes[0].message.meta.serverRecoveryBlocked, true, 'the existing resume guard consumes the blocked metadata')
    assert.equal(view.rootElement.querySelector('[data-testid="inline-side-effect-failed"]'), null)
  })
}

test('defer cancels a pending read and a late response cannot reopen confirmation', async (context) => {
  const pending = deferred()
  const loads = []
  const view = await mount(context, { loadInteraction: (scope) => {
    loads.push(scope)
    return loads.length === 1 ? pending.promise : Promise.resolve(interaction(scope))
  } })
  await view.click('defer')
  assert.equal(loads[0].signal.aborted, true)
  await act(async () => pending.resolve(interaction()))
  assert.equal(view.rootElement.querySelector('[data-testid="inline-side-effect-failed"]'), null)
  assert.equal(view.decisions.length, 0)
  assert.equal(view.resumes.length, 0)
  await view.click('refresh')
  assert.equal(loads.length, 2)
  assert.equal(view.rootElement.querySelector('[data-testid="inline-side-effect-failed"]').disabled, false)
})

for (const response of [null, 'foreign']) {
  test(`${response} lookup cannot authorize a confirmation or imply completion`, async (context) => {
    const view = await mount(context, { loadInteraction: async () => response === null
      ? { record: null, boundary: null } : interaction({ toolCallId: 'another-operation' }) })
    assert.equal(view.rootElement.querySelector('[data-testid="inline-side-effect-committed"]').disabled, true)
    await view.click('committed')
    assert.equal(view.decisions.length, 0)
    assert.equal(view.resumes.length, 0)
    assert.equal(view.rootElement.querySelector('a[href*="settings"]'), null)
  })
}

test('a 409 revokes the old snapshot and requires explicit refresh before another choice', async (context) => {
  const calls = []
  const view = await mount(context, { resolveInteraction: async (input) => {
    calls.push(input)
    if (calls.length === 1) throw Object.assign(new Error('stale'), { status: 409 })
    return resolved(input)
  } })
  await view.click('failed')
  assert.equal(view.loads.length, 1, 'no automatic refresh or POST retry')
  assert.equal(view.resumes.length, 0)
  await view.click('committed')
  assert.equal(calls.length, 1)
  await view.click('refresh')
  assert.equal(view.loads.length, 2)
  await view.click('committed')
  assert.equal(calls.length, 2)
  assert.equal(view.resumes.length, 1)
})

for (const change of ['owner', 'session', 'turn', 'tool', 'sequence', 'cancel']) {
  test(`a late POST after ${change} changes cannot continue or alter the new scope`, async (context) => {
    const pending = deferred()
    const requests = []
    const view = await mount(context, { resolveInteraction: (input) => { requests.push(input); return pending.promise } })
    await view.click('failed')
    const nextMessage = structuredClone(message)
    const updates = { msg: nextMessage }
    if (change === 'owner') updates.ownerScope = '["backend-b","user-b"]'
    if (change === 'session') updates.sessionId = 'session-b'
    if (change === 'turn') nextMessage.meta.serverTurnId = 'turn-b'
    if (change === 'tool') nextMessage.meta.serverRecoveryToolCallId = 'call-b'
    if (change === 'sequence') nextMessage.meta.serverLastSequence += 1
    if (change === 'cancel') nextMessage.meta.cancelled = true
    await view.render(updates)
    assert.equal(requests[0].signal.aborted, true)
    await act(async () => pending.resolve(resolved(requests[0])))
    assert.equal(view.resumes.length, 0)
    assert.equal(view.rootElement.querySelector('[data-testid="inline-side-effect-continue"]'), null)
  })
}

test('unmount aborts pending confirmation and ignores its late accepted response', async (context) => {
  const pending = deferred()
  let request
  const view = await mount(context, { resolveInteraction: (input) => { request = input; return pending.promise } })
  await view.click('committed')
  await view.unmount()
  assert.equal(request.signal.aborted, true)
  await act(async () => pending.resolve(resolved(request)))
  assert.equal(view.resumes.length, 0)
})

test('a rejected continuation can be retried without repeating the saved confirmation', async (context) => {
  let attempts = 0
  const view = await mount(context, { onResolved: () => ++attempts > 1 })
  await view.click('failed')
  assert.equal(view.decisions.length, 1)
  assert.equal(attempts, 1)
  await view.click('continue')
  assert.equal(view.decisions.length, 1)
  assert.equal(attempts, 2)
})

test('a mismatched success descriptor never starts another task', async (context) => {
  const view = await mount(context, { resolveInteraction: async (input) => ({
    ...resolved(input), resume: { kind: 'turn', sessionId: 'session-b', turnId: 'turn-b', toolCallId: 'call-b' },
  }) })
  await view.click('failed')
  assert.equal(view.resumes.length, 0)
  assert.equal(view.rootElement.querySelector('[data-testid="inline-side-effect-failed"]').disabled, true)
})

test('production loading uses only the exact turn endpoint and retains long tool identifiers', async (context) => {
  const calls = []
  const toolCallId = `call-${'x'.repeat(220)}`
  context.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    calls.push({ url: String(url), options })
    const parsed = new URL(String(url), 'http://localhost')
    assert.equal(parsed.pathname, '/api/side-effects/unknown/turn')
    return new Response(JSON.stringify(interaction(Object.fromEntries(parsed.searchParams))), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })
  })
  const view = await mount(context, { loadInteraction: undefined,
    msg: { ...message, meta: { ...message.meta, serverRecoveryToolCallId: toolCallId } } })
  assert.equal(calls.length, 1)
  const requested = new URL(calls[0].url, 'http://localhost')
  assert.deepEqual(Object.fromEntries(requested.searchParams), { sessionId: 'session-a', turnId: 'turn-a', toolCallId })
  assert.equal(view.rootElement.querySelector('[data-testid="inline-side-effect-failed"]').disabled, false)
  assert.equal(view.decisions.length, 0)
})

test('a late GET from another owner cannot replace the current operation', async (context) => {
  const pending = deferred()
  const requests = []
  const view = await mount(context, { loadInteraction: (scope) => {
    requests.push(scope)
    if (requests.length === 1) return pending.promise
    const fresh = interaction(scope)
    fresh.record.intentSummary.command = 'fresh operation only'
    return Promise.resolve(fresh)
  } })
  await view.render({ ownerScope: '["backend-b","user-b"]', sessionId: 'session-b' })
  assert.equal(requests[0].signal.aborted, true)
  const stale = interaction()
  stale.record.intentSummary.command = 'stale owner operation'
  await act(async () => pending.resolve(stale))
  assert.match(view.rootElement.textContent, /fresh operation only/u)
  assert.doesNotMatch(view.rootElement.textContent, /stale owner operation/u)
})

test('a lost POST response followed by an empty refresh never implies success or triggers resume', async (context) => {
  let loads = 0
  const view = await mount(context, {
    loadInteraction: async () => ++loads === 1 ? interaction() : { record: null, boundary: null },
    resolveInteraction: async () => { throw new TypeError('connection closed') },
  })
  await view.click('committed')
  assert.equal(loads, 1)
  assert.equal(view.resumes.length, 0)
  await view.click('refresh')
  assert.equal(loads, 2)
  assert.equal(view.resumes.length, 0)
  assert.equal(view.rootElement.querySelector('[data-testid="inline-side-effect-failed"]').disabled, true)
})

for (const invalid of ['scopeKey', 'recordArray', 'boundaryArray']) {
  test(`malformed ${invalid} lookup fails closed even through an injected client`, async (context) => {
    const data = interaction()
    if (invalid === 'scopeKey') data.record.scopeKey = '["turn","session-b","turn-a"]'
    if (invalid === 'recordArray') data.record = Object.assign([], data.record)
    if (invalid === 'boundaryArray') data.boundary = Object.assign([], data.boundary)
    const view = await mount(context, { loadInteraction: async () => data })
    await view.click('failed')
    assert.equal(view.decisions.length, 0)
    assert.equal(view.resumes.length, 0)
  })
}

for (const invalid of ['scopeKey', 'argsDigest', 'recordArray']) {
  test(`a malformed confirmed ${invalid} never authorizes continuation`, async (context) => {
    let posts = 0
    const view = await mount(context, { resolveInteraction: async (input) => {
      posts += 1
      const response = resolved(input)
      if (invalid === 'scopeKey') response.record.scopeKey = '["turn","session-b","turn-a"]'
      if (invalid === 'argsDigest') response.record.argsDigest = 'b'.repeat(64)
      if (invalid === 'recordArray') response.record = Object.assign([], response.record)
      return response
    } })
    await view.click('committed')
    assert.equal(posts, 1)
    assert.equal(view.resumes.length, 0)
    await view.click('failed')
    assert.equal(posts, 1, 'an invalid response does not make the old CAS reusable')
  })
}

for (const [label, overrides] of [
  ['missing owner', { ownerScope: null }],
  ['array owner', { ownerScope: [] }],
  ['array session', { sessionId: [] }],
  ['array turn', { msg: { ...message, meta: { ...message.meta, serverTurnId: [] } } }],
  ['missing tool', { msg: { ...message, meta: { ...message.meta, serverRecoveryToolCallId: '' } } }],
]) {
  test(`${label} cannot load an unscoped operation or submit a decision`, async (context) => {
    const view = await mount(context, overrides)
    assert.equal(view.loads.length, 0)
    await view.click('committed')
    assert.equal(view.decisions.length, 0)
    assert.equal(view.resumes.length, 0)
  })
}

function confirmedReceipt(resolution = 'committed') {
  const snapshot = interaction()
  const response = resolved({ record: snapshot.record, resolution })
  return { ...snapshot, ...response, confirmation: { resolution, confirmedAt: 1000 } }
}

for (const resolution of ['committed', 'failed']) {
  test(`reload restores an audited ${resolution} decision but waits for an explicit continue`, async (context) => {
    const view = await mount(context, { loadInteraction: async () => confirmedReceipt(resolution) })
    assert.equal(view.decisions.length, 0)
    assert.equal(view.resumes.length, 0)
    assert.equal(view.rootElement.querySelector('[data-testid="inline-side-effect-committed"]'), null)
    assert.ok(view.rootElement.querySelector('[data-testid="inline-side-effect-continue"]'))
    await view.click('continue')
    assert.equal(view.decisions.length, 0)
    assert.equal(view.resumes.length, 1)
  })
}

test('a lost confirmation response recovers through its audited GET without a second POST', async (context) => {
  let reads = 0
  let posts = 0
  const view = await mount(context, {
    loadInteraction: async () => ++reads === 1 ? interaction() : confirmedReceipt('failed'),
    resolveInteraction: async () => { posts += 1; throw new TypeError('response lost after confirmation') },
  })
  await view.click('failed')
  assert.equal(posts, 1)
  assert.equal(view.resumes.length, 0)
  await view.click('refresh')
  assert.equal(posts, 1)
  assert.equal(view.resumes.length, 0)
  await view.click('continue')
  assert.equal(posts, 1)
  assert.equal(view.resumes.length, 1)
})

test('a resolved-looking record without manual audit cannot provide continuation', async (context) => {
  const data = confirmedReceipt()
  delete data.confirmation
  const view = await mount(context, { loadInteraction: async () => data })
  assert.equal(view.rootElement.querySelector('[data-testid="inline-side-effect-continue"]'), null)
  assert.equal(view.resumes.length, 0)
  assert.equal(view.decisions.length, 0)
})
