import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-turn-engine-'))
process.env.APP_DATA_DIR = tempDir

const { closeDb, createUser } = await import('../server/db.js')
const { decideApproval } = await import('../server/services/approvalStore.js')
const { releaseApproval } = await import('../server/services/approvalGate.js')
const { TurnEngine } = await import('../server/services/TurnEngine.js')
const { listMessages, upsertSession } = await import('../server/services/sessionStore.js')
const { appendTurnEvent, listTurnEvents } = await import('../server/services/turnEventStore.js')
const { createTurnEvent } = await import('../shared/turnEvents.js')

const userId = 'turn-engine-user'
createUser({ id: userId, email: 'turn-engine@example.com' })
upsertSession({ id: 'turn-engine-session', userId, title: 'Turn engine' })

test.after(() => {
  closeDb()
  fs.rmSync(tempDir, { recursive: true, force: true })
})

function events(turnId, requestedUser = userId) {
  return listTurnEvents({ requestedUser, userId: requestedUser, sessionId: 'turn-engine-session', turnId, limit: 2000 })
}

async function waitUntil(predicate, timeoutMs = 3000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const value = predicate()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('timed out waiting for turn state')
}

test('TurnEngine owns a text turn and persists the final assistant message', async () => {
  const engine = new TurnEngine({
    runModel: async () => ({ content: '服务端完成。', toolCalls: [], modelName: 'stub' }),
  })
  await engine.startTurn({
    userId, sessionId: 'turn-engine-session', turnId: 'turn-text', content: '你好', modelName: 'stub',
  })
  await engine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId: 'turn-text' })

  assert.equal(engine.getTurn({ userId, sessionId: 'turn-engine-session', turnId: 'turn-text' }).status, 'completed')
  assert.deepEqual(events('turn-text').map((event) => event.type), [
    'turn.started', 'model.phase', 'model.phase', 'assistant.delta', 'turn.checkpoint', 'turn.completed',
  ])
  assert.equal(listMessages({ userId, sessionId: 'turn-engine-session' }).at(-1).content, '服务端完成。')
})

test('TurnEngine uses the runtime approval mode while preserving chat origin', async () => {
  let loopOptions = null
  const engine = new TurnEngine({
    readApprovalMode: () => 'unattended',
    runLoop: async (options) => {
      loopOptions = options
      return { text: 'ok', artifactIds: [], iterations: 0 }
    },
  })
  await engine.startTurn({
    userId,
    sessionId: 'turn-engine-session',
    turnId: 'turn-runtime-approval-mode',
    content: 'respect runtime config',
  })
  await engine.waitForTurn({
    userId,
    sessionId: 'turn-engine-session',
    turnId: 'turn-runtime-approval-mode',
  })

  assert.equal(loopOptions.approvalMode, 'unattended')
  assert.equal(loopOptions.approvalOrigin, 'chat')
  assert.equal(loopOptions.job.origin, 'chat')
})

test('TurnEngine runs a multi-round tool call and records its lifecycle', async () => {
  let modelCalls = 0
  let executions = 0
  const engine = new TurnEngine({
    runModel: async () => {
      modelCalls += 1
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [{ id: 'read-1', function: { name: 'read_file', arguments: '{"path":"README.md"}' } }],
        }
      }
      return { content: '已经读取并回答。', toolCalls: [] }
    },
    executeTool: async () => {
      executions += 1
      return { ok: true, content: 'README content' }
    },
  })
  await engine.startTurn({
    userId, sessionId: 'turn-engine-session', turnId: 'turn-tools', content: '读取 README 后回答',
  })
  await engine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId: 'turn-tools' })

  assert.equal(modelCalls, 2)
  assert.equal(executions, 1)
  const types = events('turn-tools').map((event) => event.type)
  for (const type of ['tool.call', 'tool.started', 'tool.completed', 'turn.completed']) assert.ok(types.includes(type))
})

test('TurnEngine pauses at approval and resumes after the persisted decision', async () => {
  let modelCalls = 0
  let executions = 0
  const engine = new TurnEngine({
    readApprovalMode: () => 'all',
    runModel: async () => {
      modelCalls += 1
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [{ id: 'write-1', function: { name: 'write_file', arguments: '{"path":"note.txt","content":"ok"}' } }],
        }
      }
      return { content: '写入完成。', toolCalls: [] }
    },
    executeTool: async () => {
      executions += 1
      return { ok: true }
    },
  })
  await engine.startTurn({
    userId, sessionId: 'turn-engine-session', turnId: 'turn-approval', content: '写入 note.txt',
  })
  const required = await waitUntil(() => events('turn-approval').find((event) => event.type === 'approval.required'))
  const decision = decideApproval({ userId, id: required.payload.approvalId, decision: 'approve' })
  assert.equal(decision.ok, true)
  releaseApproval(required.payload.approvalId)
  await engine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId: 'turn-approval' })

  assert.equal(executions, 1)
  assert.ok(events('turn-approval').some((event) => event.type === 'approval.resolved'))
  assert.equal(engine.getTurn({ userId, sessionId: 'turn-engine-session', turnId: 'turn-approval' }).status, 'completed')
})

test('TurnEngine aborts an active model request with an explicit cancelled event', async () => {
  const engine = new TurnEngine({
    runModel: ({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => {
        const error = new Error('aborted')
        error.name = 'AbortError'
        reject(error)
      }, { once: true })
    }),
  })
  await engine.startTurn({
    userId, sessionId: 'turn-engine-session', turnId: 'turn-cancel', content: '等待',
  })
  await waitUntil(() => events('turn-cancel').some((event) => event.type === 'model.phase'))
  await engine.cancelTurn({ userId, sessionId: 'turn-engine-session', turnId: 'turn-cancel' })
  await engine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId: 'turn-cancel' })
  assert.equal(events('turn-cancel').at(-1).type, 'turn.cancelled')
})

test('TurnEngine resumes a durable completed tool call without executing it twice', async () => {
  appendTurnEvent({
    userId,
    event: createTurnEvent({
      id: 'resume-start', sessionId: 'turn-engine-session', turnId: 'turn-resume', sequence: 0,
      type: 'turn.started', payload: { content: '继续', modelName: 'stub' }, createdAt: 1,
    }),
  })
  appendTurnEvent({
    userId,
    event: createTurnEvent({
      id: 'resume-checkpoint', sessionId: 'turn-engine-session', turnId: 'turn-resume', sequence: 1,
      type: 'turn.checkpoint', createdAt: 2,
      payload: {
        state: {
          messages: [
            { role: 'user', content: '读取 README' },
            { role: 'assistant', content: '', tool_calls: [{ id: 'durable-read', type: 'function', function: { name: 'read_file', arguments: '{"path":"README.md"}' } }] },
            { role: 'tool', tool_call_id: 'durable-read', name: 'read_file', content: '{"ok":true,"content":"done"}' },
          ],
          toolCalls: [{
            id: 'durable-read', name: 'read_file', args: { path: 'README.md' }, argumentsText: '{"path":"README.md"}',
            checkpointStatus: 'completed', checkpointResult: { ok: true, content: 'done' },
          }],
          artifactIds: [], iterations: 0,
        },
      },
    }),
  })
  let executions = 0
  const engine = new TurnEngine({
    runModel: async () => ({ content: '从断点完成。', toolCalls: [] }),
    executeTool: async () => { executions += 1; return { ok: true } },
  })
  await engine.resumeTurn({ userId, sessionId: 'turn-engine-session', turnId: 'turn-resume' })
  await engine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId: 'turn-resume' })
  assert.equal(executions, 0)
  assert.equal(events('turn-resume').at(-1).type, 'turn.completed')
  assert.equal(engine.getTurn({ userId: 'another-user', sessionId: 'turn-engine-session', turnId: 'turn-resume' }), null)
})

test('TurnEngine creates a missing owned session but cannot claim another user session id', async () => {
  createUser({ id: 'turn-engine-other', email: 'turn-engine-other@example.com' })
  upsertSession({ id: 'owned-by-other', userId: 'turn-engine-other', title: 'Other' })
  const engine = new TurnEngine({ runModel: async () => ({ content: 'ok', toolCalls: [] }) })
  await engine.startTurn({ userId, sessionId: 'created-by-engine', turnId: 'turn-created-session', content: 'create' })
  await engine.waitForTurn({ userId, sessionId: 'created-by-engine', turnId: 'turn-created-session' })
  assert.equal(engine.getTurn({ userId, sessionId: 'created-by-engine', turnId: 'turn-created-session' }).status, 'completed')
  await assert.rejects(
    engine.startTurn({ userId, sessionId: 'owned-by-other', turnId: 'turn-cross-user', content: 'claim' }),
    /session not found/,
  )
})
