import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import ApprovalsInbox, { ApprovalCard } from '../../src/pages/ApprovalsInbox.jsx'
import useChatApprovals from '../../src/pages/ChatSplit/useChatApprovals.js'
import useLeftRailController from '../../src/components/leftRail/useLeftRailController.js'
import { I18nProvider, useT } from '../../src/i18n/I18nProvider.jsx'
import { translateKey } from '../../src/i18n/translations.js'
import { HashRouter } from '../../src/lib/router.jsx'
import { AppProvider } from '../../src/store/AppContext.jsx'
import { ToastProvider } from '../../src/components/Toast.jsx'
import { setAuthToken } from '../../src/lib/accountClient.js'

const PRIVATE_MESSAGE = 'PRIVATE-APPROVAL-DIAGNOSTIC: token=offline-fixture-do-not-render'
const APPROVAL = { id: 'approval-i18n', toolName: 'write_file', args: { path: 'demo.txt' },
  status: 'pending', risk: 'medium', origin: 'job', createdAt: 1 }

function response(body, status = 200) {
  return Response.json(body, { status })
}

function installRest({ listFailure, decisionFailure, decisionResult, decisionResponse, modeFailure, mailFailure } = {}) {
  const original = globalThis.fetch
  const requests = []
  const failed = (failure) => response({ error: { code: failure.code, message: PRIVATE_MESSAGE } }, failure.status)
  globalThis.fetch = async (url, init = {}) => {
    const route = String(url)
    requests.push({ route, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null })
    if (route.startsWith('/api/approvals?')) return listFailure ? failed(listFailure) : response({ approvals: [APPROVAL] })
    if (route.endsWith('/decide')) {
      if (decisionResponse) return decisionResponse()
      return decisionFailure ? failed(decisionFailure) : response(decisionResult || { ok: true })
    }
    if (route === '/api/approvals/settings') {
      if (init.method === 'POST' && modeFailure) return failed(modeFailure)
      return response({ mode: 'normal', rememberedTools: [], rememberedGrants: [] })
    }
    if (route === '/api/auth/send-code' && mailFailure) return failed(mailFailure)
    if (route === '/api/auth/bootstrap') return response({ ok: true, mode: 'multi_user', authenticated: false })
    if (route === '/api/approvals/stream-ticket') return response({}, 401)
    if (route === '/api/approvals/pending-count') return response({ count: 0 })
    return response({ ok: true, sessions: [], providers: [], tools: [], data: {} })
  }
  return { requests, restore: () => { globalThis.fetch = original } }
}

function setupDom(locale) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/#/approvals',
  })
  for (const key of ['window', 'document', 'HTMLElement', 'SVGElement', 'MouseEvent', 'KeyboardEvent', 'CustomEvent', 'localStorage']) {
    globalThis[key] = key === 'window' ? dom.window : dom.window[key]
  }
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0)
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id)
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  dom.window.confirm = () => true
  dom.window.HTMLElement.prototype.attachEvent = () => {}
  dom.window.HTMLElement.prototype.detachEvent = () => {}
  dom.window.localStorage.setItem('lang', locale)
  setAuthToken('')
  return dom
}

async function renderView(context, locale, node, rest = {}) {
  const dom = setupDom(locale)
  const api = installRest(rest)
  const element = dom.window.document.getElementById('root')
  const root = createRoot(element)
  context.after(async () => {
    await act(async () => root.unmount())
    setAuthToken('')
    api.restore()
    dom.window.close()
  })
  await act(async () => root.render(<I18nProvider>{node}</I18nProvider>))
  return { dom, element, root, requests: api.requests }
}

function inbox() {
  return <HashRouter><ToastProvider><AppProvider><ApprovalsInbox /></AppProvider></ToastProvider></HashRouter>
}

function assertLocalized(element, key, locale) {
  const expected = translateKey(key, locale)
  assert.notEqual(expected, key.split('.').at(-1), `missing translation: ${locale}/${key}`)
  assert.ok(element.textContent.includes(expected), `missing localized ${locale}/${key}`)
  assert.equal(element.textContent.includes(PRIVATE_MESSAGE), false)
}

for (const locale of ['zh', 'en']) {
  for (const [status, code, expected] of [
    [401, 'unauthorized', 'unauthorized'],
    [404, 'APPROVAL_NOT_FOUND', 'notFound'],
    [410, 'approval_expired', 'expired'],
    [409, 'PERMISSION_APPROVAL_STALE', 'stalePermissions'],
    [400, 'bad_request', 'invalidRequest'],
    [503, 'PRIVATE_UNKNOWN_CODE', 'unavailable'],
  ]) {
    test(`approval inbox ${locale} localizes ${status}/${code} without displaying raw server messages`, async (context) => {
      const view = await renderView(context, locale, inbox(), { listFailure: { status, code } })
      assert.ok(view.requests.some((request) => request.route.startsWith('/api/approvals?')))
      assertLocalized(view.element, `approvals.errors.${expected}`, locale)
    })
  }

  test(`approval inbox ${locale} restores a rejected edit and localizes its REST error`, async (context) => {
    const view = await renderView(context, locale, inbox(), {
      decisionFailure: { status: 400, code: 'APPROVAL_EDIT_ARGS_REQUIRED' },
    })
    const button = (key) => [...view.element.querySelectorAll('button')]
      .find((entry) => entry.textContent === translateKey(key, locale))
    await act(async () => button('approvals.inbox.edit').click())
    await act(async () => button('approvals.inbox.approveEdited').click())
    assertLocalized(view.element, 'approvals.errors.invalidArguments', locale)
    assert.ok(view.element.textContent.includes(APPROVAL.toolName), 'failed submission must preserve the pending card')
    const decisions = view.requests.filter((request) => request.route.endsWith('/decide'))
    assert.deepEqual(decisions.map((request) => request.body), [{ decision: 'edit', args: APPROVAL.args }])
  })

  test(`approval card ${locale} does not reveal invalid JSON content in parser errors`, async (context) => {
    const decisions = []
    const invalid = { ...APPROVAL, args: PRIVATE_MESSAGE }
    const view = await renderView(context, locale, <ApprovalCard approval={invalid} busy={false}
      onDecide={(...args) => decisions.push(args)} t={(key) => translateKey(key, locale)} />)
    const button = (key) => [...view.element.querySelectorAll('button')]
      .find((entry) => entry.textContent === translateKey(key, locale))
    await act(async () => button('approvals.inbox.edit').click())
    const textarea = view.element.querySelector('textarea')
    const setter = Object.getOwnPropertyDescriptor(view.dom.window.HTMLTextAreaElement.prototype, 'value').set
    await act(async () => {
      textarea.focus()
      setter.call(textarea, `{"value": ${PRIVATE_MESSAGE}}`)
      textarea.dispatchEvent(new view.dom.window.InputEvent('input', { bubbles: true }))
      textarea.dispatchEvent(new view.dom.window.Event('change', { bubbles: true }))
      textarea.dispatchEvent(new view.dom.window.KeyboardEvent('keyup', { bubbles: true, key: 'x' }))
    })
    await act(async () => button('approvals.inbox.approveEdited').click())
    const error = [...view.element.querySelectorAll('p')].find((entry) => entry.classList.contains('text-danger'))
    assert.equal(error?.textContent, translateKey('approvals.errors.invalidArguments', locale))
    assert.equal(error?.textContent.includes(PRIVATE_MESSAGE), false)
    assert.deepEqual(decisions, [])
  })

  test(`chat ${locale} uses a localized escalation error and preserves its previous permission mode`, async (context) => {
    let latest
    const notifications = []
    function Harness() {
      const { t } = useT()
      latest = useChatApprovals({ setWorkbenchMessage() {}, toast: { info() {}, error: (value) => notifications.push(value) }, t })
      return null
    }
    const view = await renderView(context, locale, <Harness />, {
      modeFailure: { status: 409, code: 'PERMISSION_ESCALATION_REQUIRED' },
    })
    await act(async () => assert.equal(await latest.changeApprovalMode('acceptEdits'), false))
    assert.equal(latest.approvalSettings.mode, 'normal')
    assert.equal(notifications[0]?.body, translateKey('approvals.errors.escalationRequired', locale))
    assert.equal(JSON.stringify(notifications).includes(PRIVATE_MESSAGE), false)
    assert.deepEqual(view.requests.filter((request) => request.method === 'POST').map((request) => request.body),
      [{ mode: 'acceptEdits', approveEscalation: true }])
  })

  for (const [status, key] of [['expired', 'expired'], ['approved', 'conflict']]) {
    test(`approval inbox ${locale} displays the persisted ${status} HTTP 200 receipt without retrying`, async (context) => {
      const view = await renderView(context, locale, inbox(), { decisionResult: {
        ok: false, alreadyDecided: true, approval: { ...APPROVAL, status },
      } })
      const approve = [...view.element.querySelectorAll('button')]
        .find((entry) => entry.textContent === translateKey('approvals.inbox.approve', locale))
      await act(async () => approve.click())
      assertLocalized(view.element, `approvals.errors.${key}`, locale)
      assert.equal(view.element.textContent.includes(APPROVAL.toolName), false, 'the already-decided card stays removed')
      assert.deepEqual(view.requests.filter((request) => request.route.endsWith('/decide')).map((request) => request.body),
        [{ decision: 'approve' }])
    })
  }

  test(`chat ${locale} displays an expired HTTP 200 receipt while preserving waiter resolution`, async (context) => {
    let latest
    const messages = []
    function Harness() {
      const { t } = useT()
      latest = useChatApprovals({ setWorkbenchMessage: (message) => messages.push(message), toast: { info() {}, error() {} }, t })
      return null
    }
    const view = await renderView(context, locale, <Harness />, { decisionResult: {
      ok: false, alreadyDecided: true, approval: { ...APPROVAL, status: 'expired' },
    } })
    let pending
    await act(async () => {
      pending = latest.requestServerToolApproval({ id: APPROVAL.id, name: APPROVAL.toolName, args: APPROVAL.args },
        { sessionId: 'session-i18n', turnId: 'turn-i18n' })
    })
    await act(async () => {
      latest.resolveToolApproval({ approved: true })
      assert.equal(await pending, undefined)
    })
    assert.deepEqual(messages, [translateKey('approvals.errors.expired', locale)])
    assert.equal(latest.toolApproval.open, false)
    assert.equal(view.requests.filter((request) => request.route.endsWith('/decide')).length, 1)
  })

  test(`chat ${locale} localizes a failed decision without swallowing the original rejection or sending deny`, async (context) => {
    let latest
    const messages = []
    function Harness() {
      const { t } = useT()
      latest = useChatApprovals({ setWorkbenchMessage: (message) => messages.push(message), toast: { info() {}, error() {} }, t })
      return null
    }
    const view = await renderView(context, locale, <Harness />, {
      decisionFailure: { status: 409, code: 'PRIVATE_UNKNOWN_CODE' },
    })
    let settled
    await act(async () => {
      settled = latest.requestServerToolApproval({ id: APPROVAL.id, name: APPROVAL.toolName, args: APPROVAL.args },
        { sessionId: 'session-i18n', turnId: 'turn-i18n' }).then(() => null, (error) => error)
    })
    await act(async () => {
      assert.equal(latest.resolveToolApproval({ approved: true }), true)
      await settled
    })
    const error = await settled
    assert.equal(error.code, 'PRIVATE_UNKNOWN_CODE')
    assert.equal(error.status, 409)
    assert.equal(error.message, PRIVATE_MESSAGE, 'the transport error remains available to its recovery consumer')
    assert.deepEqual(messages, [translateKey('approvals.errors.conflict', locale)])
    assert.equal(latest.toolApproval.open, false)
    assert.deepEqual(view.requests.filter((request) => request.route.endsWith('/decide')).map((request) => request.body),
      [{ decision: 'approve' }])
  })

  test(`login ${locale} displays actionable mail configuration copy from the real send-code failure`, async (context) => {
    let latest
    const notifications = []
    function Harness() {
      const { t } = useT()
      latest = useLeftRailController({ authMode: 'multi_user', dispatch() {}, location: { pathname: '/chat' }, navigate() {},
        t, toast: { error: (value) => notifications.push(value) } })
      return null
    }
    const view = await renderView(context, locale, <Harness />, {
      mailFailure: { status: 503, code: 'AUTH_MAIL_NOT_CONFIGURED' },
    })
    await act(async () => latest.updateLogin({ email: 'fixture@example.invalid' }))
    await act(async () => latest.sendCode({ preventDefault() {} }))
    const expected = translateKey('leftRailLogin.mailNotConfigured', locale)
    assert.equal(latest.login.message, expected)
    assert.equal(notifications[0]?.body, expected)
    assert.equal(latest.login.countdown, 0)
    assert.equal(latest.login.loading, false)
    assert.equal(JSON.stringify(notifications).includes(PRIVATE_MESSAGE), false)
    assert.equal(view.requests.filter((request) => request.route === '/api/auth/send-code').length, 1)
  })
}

test('a late rejected POST cannot display its error after another owner has requested an approval', async (context) => {
  let latest
  let reply
  let markStarted
  const started = new Promise((resolve) => { markStarted = resolve })
  const messages = []
  function Harness() {
    const { t } = useT()
    latest = useChatApprovals({ setWorkbenchMessage: (message) => messages.push(message), toast: { info() {}, error() {} }, t })
    return null
  }
  const view = await renderView(context, 'en', <Harness />, {
    decisionResponse: () => new Promise((resolve) => { reply = resolve; markStarted() }),
  })
  const oldOwner = { sessionId: 'old-session', turnId: 'old-turn' }
  const newOwner = { sessionId: 'other-session', turnId: 'other-turn' }
  let oldResult
  let nextResult
  await act(async () => {
    oldResult = latest.requestServerToolApproval({ id: 'old-approval', name: APPROVAL.toolName }, oldOwner)
      .then(() => null, (error) => error)
    latest.resolveToolApproval({ approved: true })
    await started
    nextResult = latest.requestServerToolApproval({ id: 'new-approval', name: APPROVAL.toolName }, newOwner)
      .then(() => null, (error) => error)
  })
  await act(async () => {
    reply(response({ error: { code: 'APPROVAL_DECISION_FAILED', message: PRIVATE_MESSAGE } }, 503))
    await oldResult
  })
  assert.equal((await oldResult).code, 'APPROVAL_DECISION_FAILED')
  assert.deepEqual(messages, [], 'the previous owner must not overwrite the current workbench message')
  assert.equal(latest.toolApproval.request.id, 'new-approval')
  await act(async () => latest.clearToolApprovalForOwner(newOwner))
  assert.equal((await nextResult).code, 'APPROVAL_PRESENTATION_CLOSED')
  assert.equal(view.requests.filter((request) => request.route.endsWith('/decide')).length, 1)
})
