import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-approval-routes-'))
process.env.APP_DATA_DIR = tempDir

const { createAppServer } = await import('../server/appServer.js')
const { closeDb, getDb } = await import('../server/db.js')
const { createPendingApproval } = await import('../server/services/approvalStore.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

const server = createAppServer({ getEnv: () => ({}) })
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

test.after(async () => {
  await new Promise((resolve) => server.close(resolve))
  closeDb()
  fs.rmSync(tempDir, { recursive: true, force: true })
})

function headers(token) {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
}

function seed(userId, overrides = {}) {
  return createPendingApproval({
    userId,
    origin: 'job',
    // job_id 有 FK → jobs(id);这些路由测试不需要真实 job,留空即可
    jobId: null,
    toolName: 'fs_write',
    args: { path: 'C:/tmp/a.txt', content: 'hello' },
    risk: 'high',
    reason: 'writes outside workspace',
    ...overrides,
  })
}

test('all approval endpoints reject unauthenticated requests', async () => {
  const list = await fetch(`${origin}/api/approvals`)
  assert.equal(list.status, 401)
  const listBody = await list.json()
  assert.equal(listBody.error.code, 'unauthorized')
  assert.equal(typeof listBody.error.message, 'string')

  const count = await fetch(`${origin}/api/approvals/pending-count`)
  assert.equal(count.status, 401)
  assert.equal((await count.json()).error.code, 'unauthorized')

  const detail = await fetch(`${origin}/api/approvals/some-id`)
  assert.equal(detail.status, 401)
  assert.equal((await detail.json()).error.code, 'unauthorized')

  const decide = await fetch(`${origin}/api/approvals/some-id/decide`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision: 'approve' }),
  })
  assert.equal(decide.status, 401)
  assert.equal((await decide.json()).error.code, 'unauthorized')
})

test('approval settings persist isolated risk overrides and allow clearing them', async () => {
  const owner = issueTestSession({ email: 'approval-risk-owner@example.com' })
  const stranger = issueTestSession({ email: 'approval-risk-stranger@example.com' })
  const saved = await fetch(`${origin}/api/approvals/settings`, {
    method: 'POST',
    headers: headers(owner.token),
    body: JSON.stringify({ riskOverride: { toolName: 'custom_lookup', riskClass: 'read' } }),
  })
  assert.equal(saved.status, 200)
  assert.deepEqual((await saved.json()).riskOverrides, [{ toolName: 'custom_lookup', riskClass: 'read' }])

  const strangerSettings = await fetch(`${origin}/api/approvals/settings`, { headers: headers(stranger.token) })
  assert.deepEqual((await strangerSettings.json()).riskOverrides, [])

  const cleared = await fetch(`${origin}/api/approvals/settings`, {
    method: 'POST',
    headers: headers(owner.token),
    body: JSON.stringify({ riskOverride: { toolName: 'custom_lookup', riskClass: null } }),
  })
  assert.deepEqual((await cleared.json()).riskOverrides, [])
})

test('permission widening uses the durable inbox while tightening remains immediate', async () => {
  const user = issueTestSession({ email: 'approval-mode-transition@example.com' })

  const rejected = await fetch(`${origin}/api/approvals/settings`, {
    method: 'POST',
    headers: headers(user.token),
    body: JSON.stringify({ mode: 'acceptEdits' }),
  })
  assert.equal(rejected.status, 409)
  assert.equal((await rejected.json()).error.code, 'PERMISSION_ESCALATION_REQUIRED')
  assert.equal((await (await fetch(`${origin}/api/approvals/settings`, { headers: headers(user.token) })).json()).mode, 'normal')

  const widenedRequest = await fetch(`${origin}/api/approvals/settings`, {
    method: 'POST',
    headers: headers(user.token),
    body: JSON.stringify({ mode: 'acceptEdits', approveEscalation: true }),
  })
  const widenedRequestBody = await widenedRequest.json()
  assert.equal(widenedRequest.status, 202)
  assert.equal(widenedRequestBody.mode, 'normal')
  assert.equal(widenedRequestBody.modeTransition.pending, true)
  assert.equal(widenedRequestBody.modeTransition.requestedMode, 'acceptEdits')

  const denied = await fetch(`${origin}/api/approvals/${widenedRequestBody.modeTransition.approvalId}/decide`, {
    method: 'POST', headers: headers(user.token), body: JSON.stringify({ decision: 'deny' }),
  })
  assert.equal(denied.status, 200)
  assert.equal((await denied.json()).approvalSettings.mode, 'normal')

  const approvedRequest = await fetch(`${origin}/api/approvals/settings`, {
    method: 'POST',
    headers: headers(user.token),
    body: JSON.stringify({ mode: 'acceptEdits', approveEscalation: true }),
  })
  const approvedRequestBody = await approvedRequest.json()
  const approved = await fetch(`${origin}/api/approvals/${approvedRequestBody.modeTransition.approvalId}/decide`, {
    method: 'POST', headers: headers(user.token), body: JSON.stringify({ decision: 'approve' }),
  })
  const approvedBody = await approved.json()
  assert.equal(approved.status, 200)
  assert.equal(approvedBody.approvalSettings.mode, 'acceptEdits')
  assert.equal(approvedBody.modeTransition.widened, true)

  const noReason = await fetch(`${origin}/api/approvals/settings`, {
    method: 'POST',
    headers: headers(user.token),
    body: JSON.stringify({ mode: 'bypass', approveEscalation: true }),
  })
  assert.equal(noReason.status, 400)
  assert.equal((await noReason.json()).error.code, 'PERMISSION_JUSTIFICATION_REQUIRED')

  const bypass = await fetch(`${origin}/api/approvals/settings`, {
    method: 'POST',
    headers: headers(user.token),
    body: JSON.stringify({ mode: 'bypass', approveEscalation: true, justification: 'trusted local release workspace' }),
  })
  const bypassBody = await bypass.json()
  assert.equal(bypass.status, 202)
  assert.equal(bypassBody.mode, 'acceptEdits')
  const bypassApproved = await fetch(`${origin}/api/approvals/${bypassBody.modeTransition.approvalId}/decide`, {
    method: 'POST', headers: headers(user.token), body: JSON.stringify({ decision: 'approve' }),
  })
  const bypassApprovedBody = await bypassApproved.json()
  assert.equal(bypassApprovedBody.approvalSettings.mode, 'bypass')
  assert.equal(bypassApprovedBody.approvalSettings.modeHistory[0].justification, 'trusted local release workspace')

  const bypassApprovedAgain = await fetch(`${origin}/api/approvals/${bypassBody.modeTransition.approvalId}/decide`, {
    method: 'POST', headers: headers(user.token), body: JSON.stringify({ decision: 'approve' }),
  })
  const bypassApprovedAgainBody = await bypassApprovedAgain.json()
  assert.equal(bypassApprovedAgain.status, 200)
  assert.equal(bypassApprovedAgainBody.ok, false)
  assert.equal(bypassApprovedAgainBody.alreadyDecided, true)
  assert.equal(bypassApprovedAgainBody.approvalSettings.mode, 'bypass')

  const tightened = await fetch(`${origin}/api/approvals/settings`, {
    method: 'POST',
    headers: headers(user.token),
    body: JSON.stringify({ mode: 'normal' }),
  })
  const tightenedBody = await tightened.json()
  assert.equal(tightened.status, 200)
  assert.equal(tightenedBody.mode, 'normal')
  assert.equal(tightenedBody.modeHistory[0].transitionKind, 'tightened')

  const history = await fetch(`${origin}/api/approvals?status=all`, { headers: headers(user.token) })
  const permissionApprovals = (await history.json()).approvals
    .filter((approval) => approval.toolName === 'permission_mode_change')
  assert.deepEqual(permissionApprovals.map((approval) => approval.status).sort(), ['approved', 'approved', 'denied'])
})

test('plan mode widening requires inbox approval and a denied request leaves plan active', async () => {
  const user = issueTestSession({ email: 'approval-plan-transition@example.com' })
  const plan = await fetch(`${origin}/api/approvals/settings`, {
    method: 'POST', headers: headers(user.token), body: JSON.stringify({ mode: 'plan' }),
  })
  assert.equal(plan.status, 200)

  for (const mode of ['normal', 'bypass']) {
    const response = await fetch(`${origin}/api/approvals/settings`, {
      method: 'POST',
      headers: headers(user.token),
      body: JSON.stringify({
        mode,
        ...(mode === 'bypass' ? { justification: 'verify explicit escalation approval' } : {}),
      }),
    })
    assert.equal(response.status, 409, mode)
    assert.equal((await response.json()).error.code, 'PERMISSION_ESCALATION_REQUIRED')
  }
  const settings = await fetch(`${origin}/api/approvals/settings`, { headers: headers(user.token) })
  assert.equal((await settings.json()).mode, 'plan')

  const normalRequest = await fetch(`${origin}/api/approvals/settings`, {
    method: 'POST', headers: headers(user.token), body: JSON.stringify({ mode: 'normal', approveEscalation: true }),
  })
  const normalRequestBody = await normalRequest.json()
  assert.equal(normalRequest.status, 202)
  assert.equal(normalRequestBody.mode, 'plan')
  const normalApproval = await fetch(`${origin}/api/approvals/${normalRequestBody.modeTransition.approvalId}/decide`, {
    method: 'POST', headers: headers(user.token), body: JSON.stringify({ decision: 'approve' }),
  })
  assert.equal((await normalApproval.json()).approvalSettings.mode, 'normal')

  await fetch(`${origin}/api/approvals/settings`, {
    method: 'POST', headers: headers(user.token), body: JSON.stringify({ mode: 'plan' }),
  })
  const bypassRequest = await fetch(`${origin}/api/approvals/settings`, {
    method: 'POST',
    headers: headers(user.token),
    body: JSON.stringify({
      mode: 'bypass',
      approveEscalation: true,
      justification: 'temporary trusted plan escape',
    }),
  })
  const bypassRequestBody = await bypassRequest.json()
  assert.equal(bypassRequest.status, 202)
  const bypassDenied = await fetch(`${origin}/api/approvals/${bypassRequestBody.modeTransition.approvalId}/decide`, {
    method: 'POST', headers: headers(user.token), body: JSON.stringify({ decision: 'deny' }),
  })
  assert.equal((await bypassDenied.json()).approvalSettings.mode, 'plan')
})

test('permission escalation arguments cannot be edited and stale approvals fail closed', async () => {
  const user = issueTestSession({ email: 'approval-mode-stale@example.com' })
  const request = await fetch(`${origin}/api/approvals/settings`, {
    method: 'POST', headers: headers(user.token),
    body: JSON.stringify({ mode: 'acceptEdits', approveEscalation: true }),
  })
  const requestBody = await request.json()
  const approvalId = requestBody.modeTransition.approvalId

  const edited = await fetch(`${origin}/api/approvals/${approvalId}/decide`, {
    method: 'POST', headers: headers(user.token),
    body: JSON.stringify({ decision: 'edit', args: { fromMode: 'normal', toMode: 'bypass' } }),
  })
  assert.equal(edited.status, 400)
  assert.equal((await edited.json()).error.code, 'PERMISSION_APPROVAL_EDIT_FORBIDDEN')

  const remembered = await fetch(`${origin}/api/approvals/${approvalId}/decide`, {
    method: 'POST', headers: headers(user.token),
    body: JSON.stringify({ decision: 'approve', remember: true }),
  })
  assert.equal(remembered.status, 400)
  assert.equal((await remembered.json()).error.code, 'PERMISSION_APPROVAL_REMEMBER_FORBIDDEN')

  const tightened = await fetch(`${origin}/api/approvals/settings`, {
    method: 'POST', headers: headers(user.token), body: JSON.stringify({ mode: 'plan' }),
  })
  assert.equal((await tightened.json()).mode, 'plan')
  const stale = await fetch(`${origin}/api/approvals/${approvalId}/decide`, {
    method: 'POST', headers: headers(user.token), body: JSON.stringify({ decision: 'approve' }),
  })
  assert.equal(stale.status, 409)
  const staleBody = await stale.json()
  assert.equal(staleBody.error.code, 'PERMISSION_APPROVAL_STALE')
  assert.equal(staleBody.error.currentMode, 'plan')
  assert.equal(staleBody.approval.status, 'cancelled')

  const staleDetail = await fetch(`${origin}/api/approvals/${approvalId}`, { headers: headers(user.token) })
  assert.equal((await staleDetail.json()).approval.status, 'cancelled')
})

test('permission approval and mode migration roll back together when the event write fails', async () => {
  const user = issueTestSession({ email: 'approval-mode-atomic@example.com' })
  const request = await fetch(`${origin}/api/approvals/settings`, {
    method: 'POST', headers: headers(user.token),
    body: JSON.stringify({ mode: 'acceptEdits', approveEscalation: true }),
  })
  const requestBody = await request.json()
  const approvalId = requestBody.modeTransition.approvalId
  const db = getDb()
  db.exec(`
    CREATE TRIGGER fail_permission_mode_event
    BEFORE INSERT ON permission_mode_events
    BEGIN
      SELECT RAISE(ABORT, 'forced permission event failure');
    END;
  `)
  try {
    const response = await fetch(`${origin}/api/approvals/${approvalId}/decide`, {
      method: 'POST', headers: headers(user.token), body: JSON.stringify({ decision: 'approve' }),
    })
    assert.equal(response.status, 500)
    assert.equal((await response.json()).error.code, 'APPROVAL_DECISION_FAILED')
  } finally {
    db.exec('DROP TRIGGER IF EXISTS fail_permission_mode_event')
  }

  const detail = await fetch(`${origin}/api/approvals/${approvalId}`, { headers: headers(user.token) })
  assert.equal((await detail.json()).approval.status, 'pending')
  const settings = await fetch(`${origin}/api/approvals/settings`, { headers: headers(user.token) })
  const settingsBody = await settings.json()
  assert.equal(settingsBody.mode, 'normal')
  assert.deepEqual(settingsBody.modeHistory, [])
})

test('pending approval shows up in list, count and detail', async () => {
  const alice = issueTestSession({ email: 'approval-list-alice@example.com' })
  const created = seed(alice.userId, { metadataSource: 'declared' })

  const list = await fetch(`${origin}/api/approvals`, { headers: headers(alice.token) })
  assert.equal(list.status, 200)
  const { approvals } = await list.json()
  assert.equal(approvals.length, 1)
  assert.equal(approvals[0].id, created.id)
  assert.equal(approvals[0].toolName, 'fs_write')
  assert.equal(approvals[0].status, 'pending')
  assert.equal(approvals[0].metadataSource, 'declared')

  const count = await fetch(`${origin}/api/approvals/pending-count`, { headers: headers(alice.token) })
  assert.equal(count.status, 200)
  assert.equal((await count.json()).count, 1)

  const detail = await fetch(`${origin}/api/approvals/${created.id}`, { headers: headers(alice.token) })
  assert.equal(detail.status, 200)
  const { approval } = await detail.json()
  assert.equal(approval.id, created.id)
  assert.deepEqual(approval.args, { path: 'C:/tmp/a.txt', content: 'hello' })
  assert.deepEqual(approval.effectiveArgs, { path: 'C:/tmp/a.txt', content: 'hello' })
  assert.equal(approval.risk, 'high')
  assert.equal(approval.metadataSource, 'declared')
  assert.equal(approval.reason, 'writes outside workspace')
})

test('another user gets 404 (not 403) on detail and decide, leaking nothing', async () => {
  const owner = issueTestSession({ email: 'approval-owner@example.com' })
  const stranger = issueTestSession({ email: 'approval-stranger@example.com' })
  const created = seed(owner.userId)

  const detail = await fetch(`${origin}/api/approvals/${created.id}`, { headers: headers(stranger.token) })
  assert.equal(detail.status, 404)
  const detailBody = await detail.json()
  assert.equal(detailBody.error.code, 'not_found')
  assert.equal(typeof detailBody.error.message, 'string')

  const decide = await fetch(`${origin}/api/approvals/${created.id}/decide`, {
    method: 'POST',
    headers: headers(stranger.token),
    body: JSON.stringify({ decision: 'approve' }),
  })
  assert.equal(decide.status, 404)
  assert.equal((await decide.json()).error.code, 'APPROVAL_NOT_FOUND')

  // owner 的记录仍是 pending,没有被陌生人改动
  const ownerDetail = await fetch(`${origin}/api/approvals/${created.id}`, { headers: headers(owner.token) })
  assert.equal((await ownerDetail.json()).approval.status, 'pending')

  // 陌生人的列表里看不到它
  const strangerList = await fetch(`${origin}/api/approvals`, { headers: headers(stranger.token) })
  assert.deepEqual((await strangerList.json()).approvals, [])
})

test('decide approve marks the approval approved', async () => {
  const user = issueTestSession({ email: 'approval-approve@example.com' })
  const created = seed(user.userId)

  const response = await fetch(`${origin}/api/approvals/${created.id}/decide`, {
    method: 'POST',
    headers: headers(user.token),
    body: JSON.stringify({ decision: 'approve' }),
  })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.equal(body.approval.status, 'approved')
  assert.equal(body.approval.decidedBy, user.userId)

  const count = await fetch(`${origin}/api/approvals/pending-count`, { headers: headers(user.token) })
  assert.equal((await count.json()).count, 0)
})

test('decide edit stores edited args as effectiveArgs', async () => {
  const user = issueTestSession({ email: 'approval-edit@example.com' })
  const created = seed(user.userId)

  const response = await fetch(`${origin}/api/approvals/${created.id}/decide`, {
    method: 'POST',
    headers: headers(user.token),
    body: JSON.stringify({ decision: 'edit', args: { path: 'C:/tmp/safe.txt', content: 'edited' } }),
  })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.equal(body.approval.status, 'edited')
  assert.deepEqual(body.approval.effectiveArgs, { path: 'C:/tmp/safe.txt', content: 'edited' })
  // 原始 args 保留不变,便于审计
  assert.deepEqual(body.approval.args, { path: 'C:/tmp/a.txt', content: 'hello' })
})

test('invalid decision string is a 400 bad_request', async () => {
  const user = issueTestSession({ email: 'approval-baddecision@example.com' })
  const created = seed(user.userId)

  const response = await fetch(`${origin}/api/approvals/${created.id}/decide`, {
    method: 'POST',
    headers: headers(user.token),
    body: JSON.stringify({ decision: 'yolo' }),
  })
  assert.equal(response.status, 400)
  const body = await response.json()
  assert.equal(body.error.code, 'bad_request')
  assert.ok(body.error.message.length > 0)

  // 非法决策不应改动记录
  const detail = await fetch(`${origin}/api/approvals/${created.id}`, { headers: headers(user.token) })
  assert.equal((await detail.json()).approval.status, 'pending')
})

test('deciding twice is idempotent, not an error', async () => {
  const user = issueTestSession({ email: 'approval-twice@example.com' })
  const created = seed(user.userId)

  const first = await fetch(`${origin}/api/approvals/${created.id}/decide`, {
    method: 'POST',
    headers: headers(user.token),
    body: JSON.stringify({ decision: 'deny' }),
  })
  assert.equal(first.status, 200)
  assert.equal((await first.json()).ok, true)

  const second = await fetch(`${origin}/api/approvals/${created.id}/decide`, {
    method: 'POST',
    headers: headers(user.token),
    body: JSON.stringify({ decision: 'approve' }),
  })
  assert.equal(second.status, 200)
  const body = await second.json()
  assert.equal(body.alreadyDecided, true)
  assert.equal(body.ok, false)
  // 第一次的决策依然是权威结果
  assert.equal(body.approval.status, 'denied')
})

test('bogus status filter is rejected with 400', async () => {
  const user = issueTestSession({ email: 'approval-badstatus@example.com' })
  const response = await fetch(`${origin}/api/approvals?status=bogus`, { headers: headers(user.token) })
  assert.equal(response.status, 400)
  const body = await response.json()
  assert.equal(body.error.code, 'bad_request')
  assert.equal(typeof body.error.message, 'string')
})

test('wrong method and unknown subpath produce 405 / 404', async () => {
  const user = issueTestSession({ email: 'approval-methods@example.com' })
  const created = seed(user.userId)

  const wrongMethod = await fetch(`${origin}/api/approvals/${created.id}`, {
    method: 'DELETE',
    headers: headers(user.token),
  })
  assert.equal(wrongMethod.status, 405)
  assert.equal((await wrongMethod.json()).error.code, 'method_not_allowed')

  const wrongDecideMethod = await fetch(`${origin}/api/approvals/${created.id}/decide`, {
    method: 'GET',
    headers: headers(user.token),
  })
  assert.equal(wrongDecideMethod.status, 405)
  assert.equal((await wrongDecideMethod.json()).error.code, 'method_not_allowed')

  const unknown = await fetch(`${origin}/api/approvals/${created.id}/nope/deeper`, {
    headers: headers(user.token),
  })
  assert.equal(unknown.status, 404)
  const body = await unknown.json()
  assert.equal(body.error.code, 'not_found')
  assert.equal(typeof body.error.message, 'string')
})
