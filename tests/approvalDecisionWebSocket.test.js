import assert from 'node:assert/strict'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import WebSocket from 'ws'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-approval-ws-'))
process.env.APP_DATA_DIR = tempDir

const { createAppServer } = await import('../server/appServer.js')
const { closeDb } = await import('../server/db.js')
const { validateTurnWebSocketServerFrame } = await import('../shared/turnWebSocketProtocol.js')
const { createPendingApproval, getPendingApproval } = await import('../server/services/approvalStore.js')
const { decideApprovalRequest } = await import('../server/services/approvalDecisionService.js')
const { waitForDecision } = await import('../server/services/approvalGate.js')
const {
  changeApprovalMode,
  getApprovalMode,
  PERMISSION_MODE_CHANGE_TOOL,
} = await import('../server/services/approvalSettingsStore.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

function createInbox(socket) {
  const frames = []
  const waiters = []
  socket.on('message', (raw) => {
    const frame = JSON.parse(String(raw))
    const waiterIndex = waiters.findIndex(({ predicate }) => predicate(frame))
    if (waiterIndex >= 0) {
      const [{ resolve, timer }] = waiters.splice(waiterIndex, 1)
      clearTimeout(timer)
      resolve(frame)
      return
    }
    frames.push(frame)
  })
  return {
    next(predicate, timeoutMs = 5_000) {
      const frameIndex = frames.findIndex(predicate)
      if (frameIndex >= 0) return Promise.resolve(frames.splice(frameIndex, 1)[0])
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, timer: null }
        waiter.timer = setTimeout(() => {
          const index = waiters.indexOf(waiter)
          if (index >= 0) waiters.splice(index, 1)
          reject(new Error('Timed out waiting for WebSocket frame'))
        }, timeoutMs)
        waiters.push(waiter)
      })
    },
  }
}

function seedModeApproval(userId, fromMode, toMode, justification = '') {
  return createPendingApproval({
    userId,
    origin: 'chat',
    toolName: PERMISSION_MODE_CHANGE_TOOL,
    args: { fromMode, toMode, justification },
    risk: 'high',
    metadataSource: 'declared',
    reason: `permission mode: ${fromMode} -> ${toMode}`,
  })
}

test('forbidden permission decisions preserve the waiter for an immediate legal approval', async () => {
  const user = issueTestSession({ email: 'approval-waiter@example.com' })
  const approval = seedModeApproval(user.userId, 'normal', 'acceptEdits')
  const controller = new AbortController()
  const waiting = waitForDecision({
    approvalId: approval.id,
    signal: controller.signal,
    pollIntervalMs: 60_000,
  })

  assert.throws(() => decideApprovalRequest({
    userId: user.userId,
    id: approval.id,
    decision: 'edit',
    editedArgs: { fromMode: 'normal', toMode: 'bypass' },
  }), { code: 'PERMISSION_APPROVAL_EDIT_FORBIDDEN' })
  assert.throws(() => decideApprovalRequest({
    userId: user.userId,
    id: approval.id,
    decision: 'approve',
    remember: true,
  }), { code: 'PERMISSION_APPROVAL_REMEMBER_FORBIDDEN' })

  decideApprovalRequest({ userId: user.userId, id: approval.id, decision: 'approve' })
  const timeout = Symbol('timeout')
  const settled = await Promise.race([
    waiting,
    new Promise((resolve) => setTimeout(() => resolve(timeout), 500)),
  ])
  if (settled === timeout) controller.abort()
  assert.notEqual(settled, timeout)
  assert.equal(settled.proceed, true)
})

test('WebSocket permission decisions share approve, deny, forbidden, stale and idempotent semantics', async () => {
  const server = createAppServer({ getEnv: () => ({}) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const user = issueTestSession({ email: 'approval-ws@example.com' })
  const socket = new WebSocket(
    `ws://127.0.0.1:${server.address().port}/api/realtime`,
    ['gugo.realtime', `bearer.${user.token}`],
  )
  const inbox = createInbox(socket)
  await once(socket, 'open')
  await inbox.next((frame) => frame.type === 'ready')

  try {
    const approved = seedModeApproval(user.userId, 'normal', 'acceptEdits')
    const approveFrame = {
      v: 1,
      type: 'approval.decide',
      approvalId: approved.id,
      decision: 'approve',
    }
    socket.send(JSON.stringify(approveFrame))
    const approvedResult = await inbox.next((frame) => frame.approvalId === approved.id)
    assert.equal(approvedResult.type, 'approval.resolved')
    assert.equal(validateTurnWebSocketServerFrame(approvedResult).ok, true)
    assert.equal(approvedResult.result.ok, true)
    assert.equal(approvedResult.result.approval.status, 'approved')
    assert.equal(approvedResult.result.approvalSettings.mode, 'acceptEdits')
    assert.equal(getApprovalMode({ userId: user.userId }), 'acceptEdits')

    socket.send(JSON.stringify(approveFrame))
    const idempotent = await inbox.next((frame) => frame.approvalId === approved.id)
    assert.equal(validateTurnWebSocketServerFrame(idempotent).ok, true)
    assert.equal(idempotent.result.ok, false)
    assert.equal(idempotent.result.alreadyDecided, true)
    assert.equal(idempotent.result.approval.status, 'approved')

    const denied = seedModeApproval(user.userId, 'acceptEdits', 'bypass', 'deny regression')
    socket.send(JSON.stringify({
      v: 1,
      type: 'approval.decide',
      approvalId: denied.id,
      decision: 'deny',
    }))
    const deniedResult = await inbox.next((frame) => frame.approvalId === denied.id)
    assert.equal(validateTurnWebSocketServerFrame(deniedResult).ok, true)
    assert.equal(deniedResult.result.approval.status, 'denied')
    assert.equal(deniedResult.result.approvalSettings.mode, 'acceptEdits')

    const protectedApproval = seedModeApproval(user.userId, 'acceptEdits', 'bypass', 'protected args')
    socket.send(JSON.stringify({
      v: 1,
      type: 'approval.decide',
      approvalId: protectedApproval.id,
      decision: 'edit',
      args: { fromMode: 'acceptEdits', toMode: 'bypass' },
    }))
    const editError = await inbox.next((frame) => frame.code === 'PERMISSION_APPROVAL_EDIT_FORBIDDEN')
    assert.equal(editError.type, 'error')
    assert.equal(validateTurnWebSocketServerFrame(editError).ok, true)
    assert.equal(getPendingApproval({ userId: user.userId, id: protectedApproval.id }).status, 'pending')

    socket.send(JSON.stringify({
      v: 1,
      type: 'approval.decide',
      approvalId: protectedApproval.id,
      decision: 'approve',
      remember: true,
    }))
    const rememberError = await inbox.next((frame) => frame.code === 'INVALID_FRAME')
    assert.equal(rememberError.type, 'error')
    assert.equal(validateTurnWebSocketServerFrame(rememberError).ok, true)

    changeApprovalMode({ userId: user.userId, mode: 'normal' })
    socket.send(JSON.stringify({
      v: 1,
      type: 'approval.decide',
      approvalId: protectedApproval.id,
      decision: 'approve',
    }))
    const staleError = await inbox.next((frame) => frame.code === 'PERMISSION_APPROVAL_STALE')
    assert.equal(staleError.type, 'error')
    assert.equal(validateTurnWebSocketServerFrame(staleError).ok, true)
    assert.equal(getApprovalMode({ userId: user.userId }), 'normal')
    assert.equal(getPendingApproval({ userId: user.userId, id: protectedApproval.id }).status, 'cancelled')
  } finally {
    socket.close()
    await once(socket, 'close')
    await new Promise((resolve) => server.close(resolve))
  }
})

test.after(() => {
  closeDb()
  fs.rmSync(tempDir, { recursive: true, force: true })
})
