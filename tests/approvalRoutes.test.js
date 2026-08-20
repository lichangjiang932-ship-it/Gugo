import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-approval-routes-'))
process.env.APP_DATA_DIR = tempDir

const { createAppServer } = await import('../server/appServer.js')
const { closeDb } = await import('../server/db.js')
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

test('permission widening applies immediately after the escalation confirmation', async () => {
  const user = issueTestSession({ email: 'approval-widening-immediate@example.com' })

  const tightening = await fetch(`${origin}/api/approvals/settings`, {
    method: 'POST',
    headers: headers(user.token),
    body: JSON.stringify({ mode: 'plan' }),
  })
  assert.equal(tightening.status, 200)
  assert.equal((await tightening.json()).mode, 'plan')

  const rejected = await fetch(`${origin}/api/approvals/settings`, {
    method: 'POST',
    headers: headers(user.token),
    body: JSON.stringify({ mode: 'normal' }),
  })
  assert.equal(rejected.status, 409)
  assert.equal((await rejected.json()).error.code, 'PERMISSION_ESCALATION_REQUIRED')
  assert.equal((await (await fetch(`${origin}/api/approvals/settings`, { headers: headers(user.token) })).json()).mode, 'plan')

  const widened = await fetch(`${origin}/api/approvals/settings`, {
    method: 'POST',
    headers: headers(user.token),
    body: JSON.stringify({ mode: 'acceptEdits', approveEscalation: true }),
  })
  const widenedBody = await widened.json()
  assert.equal(widened.status, 200)
  assert.equal(widenedBody.mode, 'acceptEdits')
  assert.equal(widenedBody.modeTransition.changed, true)
  assert.equal(widenedBody.modeTransition.widened, true)

  const bypass = await fetch(`${origin}/api/approvals/settings`, {
    method: 'POST',
    headers: headers(user.token),
    body: JSON.stringify({ mode: 'bypass', approveEscalation: true, justification: 'trusted local workspace' }),
  })
  const bypassBody = await bypass.json()
  assert.equal(bypass.status, 200)
  assert.equal(bypassBody.mode, 'bypass')
  assert.equal(bypassBody.modeHistory[0].justification, 'trusted local workspace')
})

test('plan mode widening applies immediately after the escalation confirmation', async () => {
  const user = issueTestSession({ email: 'approval-plan-widening@example.com' })
  await fetch(`${origin}/api/approvals/settings`, {
    method: 'POST', headers: headers(user.token), body: JSON.stringify({ mode: 'plan' }),
  })

  const normal = await fetch(`${origin}/api/approvals/settings`, {
    method: 'POST',
    headers: headers(user.token),
    body: JSON.stringify({ mode: 'normal', approveEscalation: true }),
  })
  const normalBody = await normal.json()
  assert.equal(normal.status, 200)
  assert.equal(normalBody.mode, 'normal')

  const bypass = await fetch(`${origin}/api/approvals/settings`, {
    method: 'POST',
    headers: headers(user.token),
    body: JSON.stringify({ mode: 'bypass', approveEscalation: true, justification: 'temporary trusted escape' }),
  })
  const bypassBody = await bypass.json()
  assert.equal(bypass.status, 200)
  assert.equal(bypassBody.mode, 'bypass')
})

test('bypass widening no longer requires a written justification', async () => {
  const user = issueTestSession({ email: 'approval-bypass-no-reason@example.com' })
  const request = await fetch(`${origin}/api/approvals/settings`, {
    method: 'POST',
    headers: headers(user.token),
    body: JSON.stringify({ mode: 'bypass', approveEscalation: true }),
  })
  const body = await request.json()
  assert.equal(request.status, 200)
  assert.equal(body.mode, 'bypass')
  assert.equal(body.modeHistory[0].justification, null)
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
