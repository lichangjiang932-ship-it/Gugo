import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-fork-recovery-'))
process.env.APP_DATA_DIR = dataDir
process.env.APP_DB_PATH = path.join(dataDir, 'app.db')

const { closeDb, createUser } = await import('../server/db.js')
const { forkSession, getSessionSnapshot, listMessages, upsertMessage, upsertSession } = await import(
  '../server/services/sessionStore.js'
)
const { normalizeServerSessionSnapshot } = await import('../src/lib/turnClient/sessionSnapshot.js')
const { expandStoredMessages } = await import('../server/services/turnMessageContext.js')

test.after(() => {
  closeDb()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

for (const state of ['interrupted', 'failed', 'incomplete', 'paused', 'blocked', 'cancelled', 'completed']) {
  test(`forking ${state} evidence preserves history without inheriting a resumable execution`, () => {
    const userId = `fork-owner-${state}`
    const sessionId = `fork-source-${state}`
    const turnId = `fork-turn-${state}`
    createUser({ id: userId, email: `${userId}@example.test` })
    upsertSession({ id: sessionId, userId, title: state })
    const attachment = {
      id: `attachment-${state}`, name: 'reference.txt', mimeType: 'text/plain',
      size: 4, sha256: 'a'.repeat(64), downloadUrl: `/api/attachments/attachment-${state}/content`,
    }
    const userContext = { turnId, version: 1, modelContent: 'keep working', attachments: [attachment] }
    const toolTrace = [{ role: 'tool', tool_call_id: `call-${state}`, name: 'read_file', content: 'historical data' }]
    const receipt = { id: `receipt-${state}`, path: 'D:/output/result.txt', filename: 'result.txt', verifiedAt: 200 }
    const error = { code: 'TURN_INCOMPLETE', retryable: true, manualRetryable: true, nextAction: 'continue' }
    const assistantContext = {
      version: 1,
      turnId,
      turnEvidence: true,
      evidenceState: state,
      error,
      recovery: {
        recoveryKind: 'side_effect_outcome_unknown', requiresUserVerification: true,
        toolCallId: 'tool-recovery', recoveryAction: { kind: 'open_settings', path: '/settings?tab=recovery' },
      },
      paused: state === 'paused',
      paused_sequence: 8,
      serverLastSequence: 8,
      serverConnectionState: state,
      serverResumeResolution: { confirmed: true },
      clarification: { question: 'Continue?' },
      failedRetryRejection: { failureSequence: 8, code: error.code },
      toolTrace,
      verifiedLocalFiles: [receipt],
      artifactIds: ['artifact-history'],
      deliveryArtifactIds: ['artifact-history'],
      turnStartedAt: 100,
      turnCompletedAt: 200,
    }
    upsertMessage({
      userId, sessionId, id: `${turnId}:user`, role: 'user', content: 'keep working',
      modelContext: userContext, createdAt: 100,
    })
    upsertMessage({
      userId, sessionId, id: `${turnId}:assistant`, role: 'assistant', content: 'historical answer',
      modelContext: assistantContext, createdAt: 200,
    })
    const result = forkSession({ userId, sessionId })
    const scope = { userId, sessionId: result.session.id }
    const copied = listMessages(scope)
    assert.deepEqual(copied.map((row) => row.content), ['keep working', 'historical answer'])
    assert.equal(copied.every((row) => row.modelContext.turnId === undefined), true)
    assert.deepEqual(copied[0].modelContext.attachments, [attachment])
    assert.deepEqual(copied[1].modelContext.toolTrace, toolTrace)
    assert.deepEqual(copied[1].modelContext.verifiedLocalFiles, [receipt])
    assert.deepEqual(copied[1].modelContext.artifactIds, ['artifact-history'])
    assert.deepEqual(copied[1].modelContext.forkSource, {
      sessionId,
      messageId: `${turnId}:assistant`,
      turnId,
      turnEvidence: true,
      evidenceState: state,
      error,
      recovery: assistantContext.recovery,
      failedRetryRejection: assistantContext.failedRetryRejection,
      clarification: assistantContext.clarification,
      serverLastSequence: 8,
    })
    const projected = normalizeServerSessionSnapshot(getSessionSnapshot(scope))
    assert.equal(projected.messages.length, 2)
    const meta = projected.messages[1].meta
    assert.equal(meta.serverTurnId, null)
    assert.equal(meta.streaming, false)
    for (const key of ['paused', 'interrupted', 'failed', 'serverRecoveryStub', 'serverRecoveryBlocked']) {
      assert.notEqual(meta[key], true, key)
    }
    assert.equal(meta.serverFailure, undefined)
    assert.equal(meta.serverLastSequence, undefined)
    assert.deepEqual(projected.messages[0].attachments, [attachment])
    assert.deepEqual(meta.verifiedLocalFiles, [receipt])
    const history = expandStoredMessages(copied)
    const priorOutcome = history.find((row) => row.role === 'system'
      && row.content.startsWith('[PRIOR TURN OUTCOME]'))
    assert.equal(Boolean(priorOutcome), ['blocked', 'failed', 'interrupted'].includes(state))
    if (priorOutcome) assert.match(priorOutcome.content, new RegExp(`"state":"${state}"`, 'u'))
    assert.deepEqual(listMessages({ userId, sessionId })[1].modelContext, assistantContext)
    const secondFork = forkSession(scope)
    const secondCopy = listMessages({ userId, sessionId: secondFork.session.id })
    assert.deepEqual(secondCopy[1].modelContext.forkSource, copied[1].modelContext.forkSource)
    assert.equal(secondCopy[1].modelContext.turnId, undefined)
  })
}

test('forked runtime fallback text stays historical status rather than assistant-authored output', () => {
  const userId = 'fork-fallback-owner'
  const sessionId = 'fork-fallback-source'
  createUser({ id: userId, email: `${userId}@example.test` })
  upsertSession({ id: sessionId, userId, title: 'fallback' })
  upsertMessage({
    userId, sessionId, id: 'fallback-source-message', role: 'assistant',
    content: 'Turn interrupted.',
    modelContext: {
      turnId: 'fallback-turn', turnEvidence: true, evidenceState: 'interrupted',
      error: { code: 'TURN_INTERRUPTED', message: 'Turn interrupted.', retryable: true },
    },
  })
  const fork = forkSession({ userId, sessionId })
  const copied = listMessages({ userId, sessionId: fork.session.id })
  const history = expandStoredMessages(copied)
  assert.equal(copied[0].content, 'Turn interrupted.')
  assert.equal(history.find((row) => row.role === 'assistant').content, '')
  assert.match(history.find((row) => row.role === 'system').content, /TURN_INTERRUPTED/u)
})
