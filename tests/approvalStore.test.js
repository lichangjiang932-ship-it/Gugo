import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-approval-store-'))
process.env.APP_DATA_DIR = tempDir

const {
  createPendingApproval,
  getPendingApproval,
  getApprovalById,
  listPendingApprovals,
  countPendingApprovals,
  decideApproval,
  expireStaleApprovals,
  cancelApprovalsForJob,
} = await import('../server/services/approvalStore.js')
const { createJob } = await import('../server/services/jobStore.js')
const { closeDb } = await import('../server/db.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

test.after(() => {
  closeDb()
  fs.rmSync(tempDir, { recursive: true, force: true })
})

function userFor(email) {
  return issueTestSession({ email }).userId
}

/** pending_approvals.job_id 有 FK → jobs(id),测试里得先落一行真 job。 */
function jobFor(userId, id) {
  createJob({ id, userId, title: id, prompt: id })
  return id
}

test('createPendingApproval returns mapped pending row with parsed args', () => {
  const userId = userFor('approval-create@example.com')
  const args = { path: 'C:/tmp/a.txt', content: 'hi' }
  const approval = createPendingApproval({
    userId,
    origin: 'job',
    jobId: jobFor(userId, 'job-create-1'),
    stepId: 'step-1',
    toolName: 'write_file',
    args,
    risk: 'high',
    reason: 'writes outside workspace',
  })

  assert.equal(approval.status, 'pending')
  assert.equal(approval.userId, userId)
  assert.equal(approval.toolName, 'write_file')
  assert.equal(approval.origin, 'job')
  assert.equal(approval.jobId, 'job-create-1')
  assert.equal(approval.stepId, 'step-1')
  assert.equal(approval.risk, 'high')
  assert.equal(approval.reason, 'writes outside workspace')
  assert.deepEqual(approval.args, args)
  assert.deepEqual(approval.effectiveArgs, args)
  assert.equal(approval.decidedArgs, null)
  assert.equal(approval.decidedAt, null)
  assert.ok(approval.expiresAt > Date.now(), 'default expiry should be in the future')

  // getApprovalById 是内部读取,不带 userId
  assert.equal(getApprovalById(approval.id).id, approval.id)
})

test('approvals are isolated per user', () => {
  const alice = userFor('approval-iso-alice@example.com')
  const bob = userFor('approval-iso-bob@example.com')

  const aliceApproval = createPendingApproval({
    userId: alice, toolName: 'run_command', args: { cmd: 'rm -rf /' }, jobId: jobFor(alice, 'job-iso-a'),
  })
  createPendingApproval({ userId: bob, toolName: 'read_file', args: { path: 'b.txt' }, jobId: jobFor(bob, 'job-iso-b') })

  assert.equal(getPendingApproval({ userId: bob, id: aliceApproval.id }), null)
  assert.ok(getPendingApproval({ userId: alice, id: aliceApproval.id }))

  const aliceList = listPendingApprovals({ userId: alice })
  assert.equal(aliceList.length, 1)
  assert.equal(aliceList[0].toolName, 'run_command')
  const bobList = listPendingApprovals({ userId: bob })
  assert.equal(bobList.length, 1)
  assert.equal(bobList[0].toolName, 'read_file')

  assert.equal(countPendingApprovals({ userId: alice }), 1)
  assert.equal(countPendingApprovals({ userId: bob }), 1)
  assert.equal(countPendingApprovals({}), 0)
  assert.deepEqual(listPendingApprovals({}), [])
})

test("decideApproval 'approve' keeps original args as effectiveArgs", () => {
  const userId = userFor('approval-approve@example.com')
  const args = { path: 'a.txt', mode: 'append' }
  const created = createPendingApproval({ userId, toolName: 'write_file', args })

  const { ok, approval, alreadyDecided } = decideApproval({ userId, id: created.id, decision: 'approve' })
  assert.equal(ok, true)
  assert.equal(alreadyDecided, false)
  assert.equal(approval.status, 'approved')
  assert.equal(approval.decidedArgs, null)
  assert.deepEqual(approval.effectiveArgs, args)
  assert.equal(approval.decidedBy, userId)
  assert.ok(approval.decidedAt > 0)
  assert.equal(countPendingApprovals({ userId }), 0)
})

test("decideApproval 'edit' makes effectiveArgs the edited args", () => {
  const userId = userFor('approval-edit@example.com')
  const original = { path: 'C:/danger.txt', content: 'boom' }
  const edited = { path: 'C:/safe.txt', content: 'ok' }
  const created = createPendingApproval({ userId, toolName: 'write_file', args: original })

  const { ok, approval } = decideApproval({
    userId, id: created.id, decision: 'edit', editedArgs: edited,
  })
  assert.equal(ok, true)
  assert.equal(approval.status, 'edited')
  assert.deepEqual(approval.args, original, 'original args preserved')
  assert.deepEqual(approval.decidedArgs, edited)
  assert.deepEqual(approval.effectiveArgs, edited, 'effectiveArgs must be the EDITED args')

  // 重新读取仍然是 edited 参数
  assert.deepEqual(getPendingApproval({ userId, id: created.id }).effectiveArgs, edited)
})

test("decideApproval 'deny' sets status denied", () => {
  const userId = userFor('approval-deny@example.com')
  const created = createPendingApproval({ userId, toolName: 'run_command', args: { cmd: 'ls' } })
  const { ok, approval } = decideApproval({ userId, id: created.id, decision: 'deny' })
  assert.equal(ok, true)
  assert.equal(approval.status, 'denied')
  assert.equal(approval.decidedArgs, null)
})

test('deciding twice is idempotent and preserves the first decision', () => {
  const userId = userFor('approval-race@example.com')
  const created = createPendingApproval({ userId, toolName: 'write_file', args: { path: 'r.txt' } })

  const first = decideApproval({ userId, id: created.id, decision: 'approve' })
  assert.equal(first.ok, true)
  assert.equal(first.approval.status, 'approved')

  const second = decideApproval({ userId, id: created.id, decision: 'deny' })
  assert.equal(second.ok, false)
  assert.equal(second.alreadyDecided, true)
  assert.equal(second.approval.status, 'approved', 'first decision must win')

  assert.equal(getPendingApproval({ userId, id: created.id }).status, 'approved')
})

test('cross-user decide fails and does not mutate the row', () => {
  const alice = userFor('approval-xdecide-alice@example.com')
  const mallory = userFor('approval-xdecide-mallory@example.com')
  const created = createPendingApproval({ userId: alice, toolName: 'write_file', args: { path: 'x.txt' } })

  const res = decideApproval({ userId: mallory, id: created.id, decision: 'approve' })
  assert.equal(res.ok, false)
  assert.equal(res.approval, null)
  assert.equal(res.alreadyDecided, false)

  const still = getPendingApproval({ userId: alice, id: created.id })
  assert.equal(still.status, 'pending')
  assert.equal(still.decidedAt, null)
})

test('validation errors', () => {
  const userId = userFor('approval-validate@example.com')
  assert.throws(() => createPendingApproval({ toolName: 'write_file' }), /userId/)
  assert.throws(() => createPendingApproval({ userId }), /toolName/)
  assert.throws(() => createPendingApproval({ userId, toolName: 't', origin: 'nope' }), /origin/)
  assert.throws(() => createPendingApproval({ userId, toolName: 't', risk: 'nuclear' }), /risk/)

  const created = createPendingApproval({ userId, toolName: 'write_file', args: {} })
  assert.throws(() => decideApproval({ id: created.id, decision: 'approve' }), /userId/)
  assert.throws(() => decideApproval({ userId, decision: 'approve' }), /id/)
  assert.throws(() => decideApproval({ userId, id: created.id, decision: 'maybe' }), /decision/)
  assert.throws(() => decideApproval({ userId, id: created.id, decision: 'edit' }), /args/)
  assert.throws(
    () => decideApproval({ userId, id: created.id, decision: 'edit', editedArgs: 'not-an-object' }),
    /args/,
  )
  // 校验失败不应改动行状态
  assert.equal(getPendingApproval({ userId, id: created.id }).status, 'pending')
})

test('expireStaleApprovals expires only past-due pending rows', () => {
  const userId = userFor('approval-expire@example.com')
  const stale = createPendingApproval({
    userId, toolName: 'write_file', args: { path: 'old.txt' }, expiresAt: Date.now() - 60_000,
  })
  const fresh = createPendingApproval({
    userId, toolName: 'write_file', args: { path: 'new.txt' }, expiresAt: Date.now() + 600_000,
  })

  const changed = expireStaleApprovals()
  assert.ok(changed >= 1, 'should report the number of expired rows')
  assert.equal(getPendingApproval({ userId, id: stale.id }).status, 'expired')
  assert.equal(getPendingApproval({ userId, id: fresh.id }).status, 'pending')
  assert.equal(countPendingApprovals({ userId }), 1)

  // 再跑一次没有新的过期行
  assert.equal(expireStaleApprovals(), 0)
})

test('cancelApprovalsForJob cancels only that job\'s pending rows', () => {
  const userId = userFor('approval-cancel@example.com')
  const jobId = jobFor(userId, 'job-cancel-target')
  const a = createPendingApproval({ userId, toolName: 'write_file', args: {}, jobId })
  const b = createPendingApproval({ userId, toolName: 'run_command', args: {}, jobId })
  const other = createPendingApproval({ userId, toolName: 'write_file', args: {}, jobId: jobFor(userId, 'job-cancel-other') })
  const decided = createPendingApproval({ userId, toolName: 'write_file', args: {}, jobId })
  decideApproval({ userId, id: decided.id, decision: 'approve' })

  const changed = cancelApprovalsForJob({ jobId })
  assert.equal(changed, 2)
  assert.equal(getPendingApproval({ userId, id: a.id }).status, 'cancelled')
  assert.equal(getPendingApproval({ userId, id: b.id }).status, 'cancelled')
  assert.equal(getPendingApproval({ userId, id: other.id }).status, 'pending')
  assert.equal(getPendingApproval({ userId, id: decided.id }).status, 'approved')

  assert.equal(cancelApprovalsForJob({}), 0)
  assert.equal(cancelApprovalsForJob({ jobId }), 0)
})

test("listPendingApprovals status 'all' includes decided rows and limit is capped", () => {
  const userId = userFor('approval-list@example.com')
  const created = []
  for (let i = 0; i < 5; i += 1) {
    created.push(createPendingApproval({ userId, toolName: 'write_file', args: { i } }))
  }
  decideApproval({ userId, id: created[0].id, decision: 'deny' })

  assert.equal(listPendingApprovals({ userId }).length, 4)
  assert.equal(listPendingApprovals({ userId, status: 'all' }).length, 5)
  assert.equal(listPendingApprovals({ userId, status: 'denied' }).length, 1)

  assert.equal(listPendingApprovals({ userId, status: 'all', limit: 2 }).length, 2)
  // 非法/超界 limit 被夹到合法范围,而不是报错
  assert.equal(listPendingApprovals({ userId, status: 'all', limit: 0 }).length, 5)
  assert.equal(listPendingApprovals({ userId, status: 'all', limit: -3 }).length, 1)
  assert.equal(listPendingApprovals({ userId, status: 'all', limit: 99999 }).length, 5)
})
