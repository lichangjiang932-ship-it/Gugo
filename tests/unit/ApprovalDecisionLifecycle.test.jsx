import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import useChatApprovals from '../../src/pages/ChatSplit/useChatApprovals.js'
import ToolApprovalCard from '../../src/components/ToolApprovalCard.jsx'
import ApprovalDecisionNotice from '../../src/components/ApprovalDecisionNotice.jsx'
import { I18nProvider } from '../../src/i18n/I18nProvider.jsx'
const owner = { sessionId: 'session-a', turnId: 'turn-a' }
const request = { id: 'approval-a', name: 'write_file', risk: 'low', args: { path: 'fixture.txt' } }
const response = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })
async function setup(context) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
  for (const key of ['window', 'document', 'HTMLElement', 'SVGElement', 'localStorage']) globalThis[key] = key === 'window' ? dom.window : dom.window[key]
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  let latest, reply
  const posts = [], messages = []
  context.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    if (String(url).endsWith('/settings')) return response({ mode: 'normal', rememberedTools: [] })
    posts.push(JSON.parse(options.body)); return new Promise(resolve => { reply = resolve })
  })
  function Harness({ scope = 'owner-a/session-a' }) {
    latest = useChatApprovals({ presentationScope: scope, setWorkbenchMessage: m => messages.push(m), toast: {}, t: key => key })
    return <I18nProvider><ToolApprovalCard {...latest.toolApproval} onDecide={latest.resolveToolApproval} />
      <ApprovalDecisionNotice notice={latest.approvalNotice} onDismiss={latest.dismissApprovalNotice} /></I18nProvider>
  }
  const root = createRoot(document.getElementById('root'))
  const render = async scope => act(async () => root.render(<Harness scope={scope} />))
  await render()
  context.after(async () => { await act(async () => root.unmount()); dom.window.close() })
  return { root, render, latest: () => latest, posts, messages, reply: value => reply(response(value)), replyFailure: status => reply(new Response(JSON.stringify({ error: { code: 'APPROVAL_DECISION_FAILED', message: 'PRIVATE_CREDENTIAL_BODY' } }), { status, headers: { 'Content-Type': 'application/json' } })) }
}
for (const status of ['approved', 'denied']) test(`a confirmed ${status} receipt is visible without claiming tool execution or replaying`, async context => {
  const f = await setup(context); let pending
  await act(async () => { pending = f.latest().requestServerToolApproval(request, owner) })
  await act(async () => {
    assert.equal(f.latest().resolveToolApproval({ approved: status === 'approved' }), true)
    assert.equal(f.latest().resolveToolApproval({ approved: true }), false)
  })
  assert.equal(f.posts.length, 1)
  assert.equal(document.querySelector('[data-testid=approval-decision-notice]'), null)
  assert.equal(document.querySelector('[data-testid=tool-approval-card]').getAttribute('data-decision-state'), 'submitting')
  await act(async () => { f.reply({ ok: true, approval: { id: request.id, status, sessionId: owner.sessionId } }); await pending })
  const notice = document.querySelector('[data-testid=approval-decision-notice]')
  assert.equal(notice?.dataset.decisionOutcome, status)
  assert.match(notice.textContent, /不代表|not.*execution/i)
  assert.equal(document.querySelector('[data-testid=tool-approval-card]'), null)
  await act(async () => f.latest().clearToolApprovalForOwner(owner))
  assert.equal(!!document.querySelector('[data-testid=approval-decision-notice]'), true, 'normal turn cleanup does not erase the receipt')
  await act(async () => f.latest().dismissApprovalNotice())
  assert.equal(document.querySelector('[data-testid=approval-decision-notice]'), null)
  assert.equal(f.posts.length, 1)
})
test('a legacy acknowledgement without a receipt is unknown, not success, and has no replay action', async context => {
  const f = await setup(context); let pending
  await act(async () => { pending = f.latest().requestServerToolApproval(request, owner); f.latest().resolveToolApproval({ approved: true }) })
  await act(async () => { f.reply({ ok: true }); await pending })
  const notice = document.querySelector('[data-testid=approval-decision-notice]')
  assert.equal(notice?.dataset.decisionState, 'unknown')
  assert.equal(notice?.querySelectorAll('button').length, 1, 'dismiss only')
  assert.equal(f.posts.length, 1)
})
for (const [status, expected] of [[403, 'error'], [503, 'unknown']]) test(`HTTP ${status} preserves rejection but presents ${expected} without private text or replay`, async context => {
  const f = await setup(context); let pending
  await act(async () => { pending = f.latest().requestServerToolApproval(request, owner).catch(error => error); f.latest().resolveToolApproval({ approved: true }) })
  await act(async () => { f.replyFailure(status); await pending })
  assert.equal((await pending).status, status)
  const notice = document.querySelector('[data-testid=approval-decision-notice]')
  assert.equal(notice?.dataset.decisionState, expected)
  assert.equal(notice.textContent.includes('PRIVATE_CREDENTIAL_BODY'), false)
  assert.equal(f.posts.length, 1)
})

test('a recorded receipt is hidden immediately after the active presentation scope changes', async context => {
  const f = await setup(context); let pending
  await act(async () => { pending = f.latest().requestServerToolApproval(request, owner); f.latest().resolveToolApproval({ approved: true }) })
  await act(async () => { f.reply({ ok: true, approval: { id: request.id, status: 'approved' } }); await pending })
  assert.equal(!!document.querySelector('[data-testid=approval-decision-notice]'), true)
  await f.render('other-backend/other-user/session-a')
  assert.equal(document.querySelector('[data-testid=approval-decision-notice]'), null)
})

test('late receipt cannot show in another presentation scope, including backend/user changes', async context => {
  const f = await setup(context); let pending
  await act(async () => { pending = f.latest().requestServerToolApproval(request, owner); f.latest().resolveToolApproval({ approved: true }) })
  await f.render('other-backend/other-user/session-a')
  assert.equal(document.querySelector('[data-testid=tool-approval-card]'), null)
  await act(async () => { f.reply({ ok: true, approval: { id: request.id, status: 'approved' } }); await pending })
  assert.equal(document.querySelector('[data-testid=approval-decision-notice]'), null)
  assert.deepEqual(f.messages, [])
  assert.equal(f.posts.length, 1)
})
