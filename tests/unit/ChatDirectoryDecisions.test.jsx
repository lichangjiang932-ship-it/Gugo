import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { createTurnEvent } from '../../shared/turnEvents.js'
import { I18nProvider } from '../../src/i18n/I18nProvider.jsx'
import { translateKey } from '../../src/i18n/translations.js'
import { decideChatDirectory, isPausedDirectoryMessage } from '../../src/pages/ChatSplit/chatDirectoryDecisions.js'
import { InlineDirectoryRequestCard } from '../../src/pages/ChatSplit/chatMessages/messageRow/UserBubble.jsx'
import MessageRow from '../../src/pages/ChatSplit/chatMessages/MessageRow.jsx'
import { resolvePendingDirectorySend } from '../../src/pages/ChatSplit/pausedTurnResume.js'
import { setupDom } from './helpers/messageRowActivityTestUtils.js'

const ownerScope = '["backend-a","user-a"]'
const t = (key, values) => translateKey(key, 'zh', values)
function pending() {
  let resolve
  const promise = new Promise((yes) => { resolve = yes })
  return { promise, resolve }
}
function fixture() {
  const message = { id: 'message-a', role: 'assistant', content: 'Saved partial work.', meta: {
    serverTurnId: 'turn-a', serverLastSequence: 7, paused: true, streaming: false, serverConnectionState: 'paused',
    serverClarification: { request_type: 'directory', suggested_path: 'D:\\Example', access_mode: 'read_only', purpose: 'Read the selected example.' },
    retainedLocalFiles: [{ id: 'saved-file', filename: 'saved.pptx', path: 'D:\\Example\\saved.pptx' }],
  } }
  const stateRef = { current: { isLoggedIn: true, user: { id: 'user-a' },
    sessionCatalogSource: { backendInstanceId: 'backend-a' }, activeSessionId: 'session-a',
    sessions: [{ id: 'session-a', messages: [structuredClone(message)] }] } }
  const controller = new AbortController()
  const actions = []
  const dispatch = (action) => {
    actions.push(action)
    if (action.type === 'UPDATE_LAST_MESSAGE_META') {
      const session = stateRef.current.sessions.find((item) => item.id === action.sessionId)
      const target = session?.messages.find((item) => item.id === action.messageId)
      if (target) target.meta = { ...target.meta, ...action.payload, ...action.meta }
    }
  }
  const input = { message, ownerScope, sessionId: 'session-a', path: 'D:\\Example',
    accessMode: 'read_only', authorizationScope: 'session', signal: controller.signal }
  const options = { input, stateRef, ownerScope, dispatch, toast: { success() {} }, t }
  return { ...options, options, controller, actions, message,
    currentMessage: () => stateRef.current.sessions[0].messages[0] }
}
function grantResult() {
  return { path: 'D:\\Example', resolution: { type: 'directory_authorization', approved: true,
    path: 'D:\\Example', access_mode: 'read_only', authorization_scope: 'session', grant_id: 'grant-a', paused_sequence: 7 } }
}
function cancelledTurn() {
  return { sessionId: 'session-a', turnId: 'turn-a', status: 'cancelled', lastEvent: createTurnEvent({
    id: 'directory-cancelled-a', sessionId: 'session-a', turnId: 'turn-a', sequence: 8,
    type: 'turn.cancelled', createdAt: 8,
    payload: { code: 'TURN_CANCELLED', partialText: 'Saved partial work.' },
  }) }
}

test('directory grant forwards signal and exact pause, then resumes only that task in its requested read-only mode', async () => {
  const f = fixture()
  const requests = []
  await decideChatDirectory({ ...f.options, kind: 'grant' }, { authorize: async (input) => { requests.push(input); return grantResult() } })
  assert.equal(requests.length, 1)
  assert.equal(requests[0].sessionId, 'session-a')
  assert.equal(requests[0].turnId, 'turn-a')
  assert.equal(requests[0].pausedSequence, 7)
  assert.equal(requests[0].accessMode, 'read_only')
  assert.equal(requests[0].signal, f.controller.signal)
  assert.equal(f.actions.length, 1)
  assert.equal(f.actions[0].messageId, 'message-a')
  assert.equal(f.currentMessage().meta.serverResumeResolution.access_mode, 'read_only')
  assert.equal(f.currentMessage().meta.serverConnectionState, 'reconnecting')
})

test('directory rejection uses the normal guarded cancel endpoint and canonical event without granting or deleting data', async (context) => {
  const f = fixture()
  const requests = []
  context.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    requests.push({ url: String(url), options })
    return new Response(JSON.stringify({ turn: cancelledTurn() }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
  await decideChatDirectory({ ...f.options, kind: 'reject' })
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, '/api/turns/turn-a/cancel')
  assert.deepEqual(JSON.parse(requests[0].options.body), { sessionId: 'session-a', directoryPausedSequence: 7 })
  assert.equal(requests[0].options.signal, f.controller.signal)
  const message = f.currentMessage()
  assert.equal(message.meta.cancelled, true)
  assert.equal(message.meta.paused, false)
  assert.equal(message.meta.serverClarification, null)
  assert.equal(message.meta.serverResumeResolution, null)
  assert.equal(message.meta.directoryAuthorizationPending, false)
  assert.deepEqual(message.meta.retainedLocalFiles, f.message.meta.retainedLocalFiles)
  assert.equal(message.content, 'Saved partial work.')
  assert.equal(resolvePendingDirectorySend([message]), null)
  assert.ok(f.actions.every((action) => action.type === 'UPDATE_LAST_MESSAGE_META'))
})

for (const invalid of ['paused', 'cancelling', 'wrongTurn', 'wrongEvent', 'oldSequence']) {
  test(`an unproven cancellation (${invalid}) cannot fabricate a cancelled message`, async () => {
    const f = fixture()
    const result = cancelledTurn()
    if (['paused', 'cancelling'].includes(invalid)) result.status = invalid
    if (invalid === 'wrongTurn') result.turnId = 'turn-b'
    if (invalid === 'wrongEvent') result.lastEvent = { ...result.lastEvent, type: 'turn.paused' }
    if (invalid === 'oldSequence') result.lastEvent = { ...result.lastEvent, sequence: 7 }
    await assert.rejects(decideChatDirectory({ ...f.options, kind: 'reject' }, { cancel: async () => result }))
    assert.equal(f.actions.length, 0)
    assert.equal(f.currentMessage().meta.paused, true)
  })
}

for (const kind of ['grant', 'reject']) {
  for (const drift of ['owner', 'backend', 'session', 'sequence', 'cancelled', 'abort']) {
    test(`late ${kind} after ${drift} changes cannot update or resume the current message`, async () => {
      const f = fixture()
      const response = pending()
      const promise = decideChatDirectory({ ...f.options, kind }, {
        authorize: () => response.promise, cancel: () => response.promise,
      })
      if (drift === 'owner') f.stateRef.current.user.id = 'user-b'
      if (drift === 'backend') f.stateRef.current.sessionCatalogSource.backendInstanceId = 'backend-b'
      if (drift === 'session') f.stateRef.current.activeSessionId = 'session-b'
      if (drift === 'sequence') f.currentMessage().meta.serverLastSequence = 9
      if (drift === 'cancelled') f.currentMessage().meta.cancelled = true
      if (drift === 'abort') f.controller.abort()
      response.resolve(kind === 'grant' ? grantResult() : cancelledTurn())
      await assert.rejects(promise)
      assert.equal(f.actions.length, 0)
    })
  }
}

test('a read-only pause rejects an attempted mode escalation before any API request', async () => {
  const f = fixture()
  f.input.accessMode = 'read_write'
  let requests = 0
  await assert.rejects(decideChatDirectory({ ...f.options, kind: 'grant' }, {
    authorize: async () => { requests += 1; return grantResult() },
  }), (error) => error.code === 'TURN_DIRECTORY_PAUSE_STALE')
  assert.equal(requests, 0)
})

async function mount(context, f, handlers = {}, row = false) {
  const dom = setupDom()
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  let props = { msg: f.message, sessionId: 'session-a', ownerScope, t,
    onAuthorize: (input) => decideChatDirectory({ ...f.options, input, kind: 'grant' }, handlers),
    onReject: (input) => decideChatDirectory({ ...f.options, input, kind: 'reject' }, handlers) }
  const render = async (updates = {}) => {
    props = { ...props, ...updates }
    await act(async () => root.render(<I18nProvider>{row
      ? <MessageRow msg={props.msg} rowKey={props.msg.id} sessionId={props.sessionId} recoveryOwnerScope={props.ownerScope}
          generatingMessageId="" lang="zh" t={t} onAuthorizeDirectoryRequest={props.onAuthorize} onRejectDirectoryRequest={props.onReject} />
      : <InlineDirectoryRequestCard {...props} />}</I18nProvider>))
  }
  const button = (kind) => kind === 'reject' ? rootElement.querySelector('[data-testid="directory-reject-cancel"]')
    : rootElement.querySelector('[data-testid="directory-request-card"] button')
  const click = async (kind, twice = false) => act(async () => {
    const target = button(kind)
    assert.ok(target)
    target.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    if (twice) target.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  context.after(async () => { await act(async () => root.unmount()); dom.window.close() })
  await render()
  return { render, rootElement, button, click }
}

test('reject interrupts a single-flight grant; its late completion never resumes the cancelled task', async (context) => {
  const f = fixture()
  const grant = pending()
  const cancellation = pending()
  const grants = []
  const cancels = []
  const view = await mount(context, f, {
    authorize: (input) => { grants.push(input); return grant.promise },
    cancel: (input) => { cancels.push(input); return cancellation.promise },
  })
  assert.equal(view.rootElement.querySelector('select').disabled, true)
  await view.click('grant', true)
  assert.equal(grants.length, 1)
  assert.equal(view.button('reject').disabled, false)
  await view.click('reject', true)
  assert.equal(grants[0].signal.aborted, true)
  assert.equal(cancels.length, 1)
  await act(async () => grant.resolve(grantResult()))
  assert.equal(f.actions.length, 0)
  assert.equal(view.button('reject').disabled, true)
  await act(async () => cancellation.resolve(cancelledTurn()))
  assert.equal(f.currentMessage().meta.cancelled, true)
  assert.equal(f.actions.some((action) => action.payload?.serverResumeResolution), false)
})

for (const change of ['owner', 'sequence']) {
  test(`wrapper aborts a pending grant on ${change} replacement`, async (context) => {
    const f = fixture()
    const grant = pending()
    let request
    const view = await mount(context, f, { authorize: (input) => { request = input; return grant.promise } })
    await view.click('grant')
    const updates = change === 'owner' ? { ownerScope: '["backend-b","user-b"]' }
      : { msg: { ...f.message, meta: { ...f.message.meta, serverLastSequence: 9 } } }
    await view.render(updates)
    assert.equal(request.signal.aborted, true)
    await act(async () => grant.resolve(grantResult()))
    assert.equal(f.actions.length, 0)
  })
}

test('canonical cancellation hides the directory card while preserving file evidence in MessageRow', async (context) => {
  const f = fixture()
  const view = await mount(context, f, { cancel: async () => cancelledTurn() }, true)
  assert.ok(view.button('reject'))
  await view.click('reject')
  await view.render({ msg: structuredClone(f.currentMessage()) })
  assert.equal(view.rootElement.querySelector('[data-testid="directory-request-card"]'), null)
  assert.ok(view.rootElement.querySelector('[data-testid="artifact-open-card"]'))
  assert.match(view.rootElement.textContent, /saved\.pptx/u)
})

test('cancelled and already-resuming pauses never render as actionable directory requests', () => {
  const f = fixture()
  for (const meta of [{ cancelled: true }, { serverConnectionState: 'reconnecting' },
    { directoryAuthorizationPending: true }, { serverResumeResolution: {} }]) {
    assert.equal(isPausedDirectoryMessage({ ...f.message, meta: { ...f.message.meta, ...meta } }), false)
  }
})
