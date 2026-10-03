import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createTurnEvent } from '../../shared/turnEvents.js'

const root = mkdtempSync(join(tmpdir(), 'gugo-workspace-binding-'))
process.env.APP_DATA_DIR = root
process.env.APP_DB_PATH = join(root, 'app.db')
const { closeDb, createUser } = await import('../../server/db.js')
const { getSession, setSessionWorkspace, upsertSession } = await import('../../server/services/sessionStore.js')
const { listTurnEvents } = await import('../../server/services/turnEventStore.js')
const { createSqliteTurnPersistenceTransactions } = await import('../../server/services/sqliteTurnPersistenceTransactions.js')
const transactions = createSqliteTurnPersistenceTransactions()
const userId = 'workspace-transaction-owner'
createUser({ id: userId, email: 'workspace-transaction-owner@example.invalid' })
test.after(() => { closeDb(); rmSync(root, { recursive: true, force: true }) })

function command(sessionId, turnId, workspacePath, { newSession = false, mode = 'create-only' } = {}) {
  return {
    userId,
    session: newSession ? { id: sessionId, userId, title: 'workspace binding', workspacePath } : null,
    event: createTurnEvent({ id: `${turnId}:started`, sessionId, turnId, type: 'turn.started', sequence: 0,
      createdAt: 100, payload: { content: 'hello', workspacePath, projectDirectory: workspacePath,
        sessionWorkspaceMode: mode } }),
  }
}

test('creation-only workspace binding preserves both existing project and Recent sessions', async () => {
  for (const original of [null, 'C:\\Original']) {
    const sessionId = original ? 'workspace-existing-project' : 'workspace-existing-recent'
    upsertSession({ id: sessionId, userId, title: 'existing', workspacePath: original })
    const request = command(sessionId, `${sessionId}-turn`, 'C:\\Execution')
    await transactions.commitTurnStart(request)
    assert.equal(getSession({ userId, sessionId }).workspacePath, original)
    const stored = listTurnEvents({ userId, sessionId, turnId: request.event.turnId })[0]
    assert.equal(stored.payload.workspacePath, 'C:\\Execution')
    assert.equal(stored.payload.projectDirectory, 'C:\\Execution')
    assert.equal(stored.payload.sessionWorkspaceMode, 'create-only')
  }
})

test('competing creation receipts only bind the session created inside the winning transaction', async () => {
  const sessionId = 'workspace-concurrent-creation'
  const first = command(sessionId, 'workspace-creation-first', 'C:\\First', { newSession: true })
  const second = command(sessionId, 'workspace-creation-second', 'C:\\Second', { newSession: true })
  await Promise.all([transactions.commitTurnStart(first), transactions.commitTurnStart(second)])
  assert.equal(getSession({ userId, sessionId }).workspacePath, 'C:\\First')
  assert.deepEqual([first, second].flatMap(({ event }) => listTurnEvents({ userId, sessionId, turnId: event.turnId }))
    .map((event) => event.payload.projectDirectory),
    ['C:\\First', 'C:\\Second'])
})

test('creation-only retries preserve newer manual selection and the mode participates in event identity', async () => {
  const sessionId = 'workspace-binding-retry'
  const request = command(sessionId, 'workspace-binding-retry-turn', 'C:\\First', { newSession: true })
  await transactions.commitTurnStart(request)
  assert.equal(getSession({ userId, sessionId }).workspacePath, 'C:\\First')
  setSessionWorkspace({ userId, sessionId, workspacePath: 'C:\\ManuallyMoved' })
  await transactions.commitTurnStart(request)
  assert.equal(getSession({ userId, sessionId }).workspacePath, 'C:\\ManuallyMoved')
  assert.equal(listTurnEvents({ userId, sessionId, turnId: request.event.turnId }).length, 1)
  const changed = structuredClone(request)
  changed.event.payload.sessionWorkspaceMode = 'follow-turn'
  await assert.rejects(transactions.commitTurnStart(changed), (error) => error.code === 'TURN_EVENT_SEQUENCE_CONFLICT')
  assert.equal(getSession({ userId, sessionId }).workspacePath, 'C:\\ManuallyMoved')
})

test('ordinary explicit workspace updates still follow each web turn selection', async () => {
  const sessionId = 'workspace-web-selection'
  upsertSession({ id: sessionId, userId, title: 'web session', workspacePath: 'C:\\Before' })
  const request = command(sessionId, 'workspace-web-selection-turn', 'C:\\After')
  delete request.event.payload.sessionWorkspaceMode
  await transactions.commitTurnStart(request)
  assert.equal(getSession({ userId, sessionId }).workspacePath, 'C:\\After')
})
