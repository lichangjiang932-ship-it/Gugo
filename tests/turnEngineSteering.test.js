import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-turn-engine-steering-'))
process.env.APP_DATA_DIR = tempDir
process.env.APPROVAL_MODE = 'off'

const { closeDb, createUser } = await import('../server/db.js')
const { TurnEngine } = await import('../server/services/TurnEngine.js')
const { runToolLoop } = await import('../server/services/loop/index.js')
const { createTurnExecutionLeaseCoordinator } = await import(
  '../server/services/turnExecutionLeaseRuntime.js'
)
const { listMessages, upsertSession } = await import('../server/services/sessionStore.js')
const { listTurnEvents } = await import('../server/services/turnEventStore.js')
const { listTurnSteering } = await import('../server/services/turnSteeringStore.js')

test.after(() => {
  closeDb()
  fs.rmSync(tempDir, { recursive: true, force: true })
})

test('TurnEngine applies live steering once before completing the active model turn', async () => {
  const userId = 'turn-engine-steering-user'
  const sessionId = 'turn-engine-steering-session'
  const turnId = 'turn-engine-steering-turn'
  const clientRequestId = 'turn-engine-steering-request'
  const steeringContent = 'Use the revised direction before finishing.'
  createUser({ id: userId, email: 'turn-engine-steering@example.com' })
  upsertSession({ id: sessionId, userId, title: 'Live steering' })

  let releaseFirstModel
  let releaseSecondModel
  let notifyFirstModel
  let notifySecondModel
  const firstModelStarted = new Promise((resolve) => { notifyFirstModel = resolve })
  const secondModelStarted = new Promise((resolve) => { notifySecondModel = resolve })
  const firstModelGate = new Promise((resolve) => { releaseFirstModel = resolve })
  const secondModelGate = new Promise((resolve) => { releaseSecondModel = resolve })
  const modelRequests = []
  let toolExecutions = 0
  let cancellationRequests = 0

  const durableLeases = createTurnExecutionLeaseCoordinator({
    ownerId: 'turn-engine-steering-owner',
    leaseMs: 10_000,
  })
  const executionLeases = {
    ...durableLeases,
    requestCancellation(scope) {
      cancellationRequests += 1
      return durableLeases.requestCancellation(scope)
    },
  }
  const engine = new TurnEngine({
    runLoop: runToolLoop,
    executionLeases,
    toolSpecs: [],
    resolveToolSpecs: async () => [],
    readApprovalMode: () => 'off',
    getContextWindow: () => 8_192,
    scheduleMemoryExtraction: () => {},
    executeTool: async () => {
      toolExecutions += 1
      return { ok: true }
    },
    runModel: async ({ messages }) => {
      modelRequests.push(structuredClone(messages))
      if (modelRequests.length === 1) {
        notifyFirstModel()
        await firstModelGate
        return { content: 'Draft prepared before steering.', toolCalls: [] }
      }
      if (modelRequests.length === 2) {
        notifySecondModel()
        await secondModelGate
        return { content: 'Final answer with steering applied.', toolCalls: [] }
      }
      return { content: 'Unexpected duplicate model round.', toolCalls: [] }
    },
  })

  await engine.startTurn({
    userId,
    sessionId,
    turnId,
    content: 'Prepare the answer.',
    intentMode: 'answer',
  })
  await firstModelStarted

  const accepted = await engine.steerTurn({
    userId,
    sessionId,
    turnId,
    content: steeringContent,
    clientRequestId,
  })
  const replayed = await engine.steerTurn({
    userId,
    sessionId,
    turnId,
    content: steeringContent,
    clientRequestId,
  })
  assert.equal(replayed.id, accepted.id)
  assert.equal(replayed.messageId, accepted.messageId)

  releaseFirstModel()
  await secondModelStarted
  assert.ok(modelRequests[1].some((message) => (
    message.role === 'user' && message.content === steeringContent
  )))
  assert.equal(
    listTurnEvents({ userId, sessionId, turnId, limit: 2_000 })
      .some((event) => event.type === 'turn.completed'),
    false,
  )

  releaseSecondModel()
  await engine.waitForTurn({ userId, sessionId, turnId })

  const replayedAfterCompletion = await engine.steerTurn({
    userId,
    sessionId,
    turnId,
    content: steeringContent,
    clientRequestId,
  })
  assert.equal(replayedAfterCompletion.id, accepted.id)

  const steeringRows = listTurnSteering({ userId, sessionId, turnId })
  assert.equal(steeringRows.length, 1)
  assert.equal(steeringRows[0].status, 'consumed')

  const messages = listMessages({ userId, sessionId, limit: 100 })
  const canonicalSteering = messages.filter((message) => (
    message.modelContext?.liveSteering === true
      && message.modelContext?.steeringClientRequestId === clientRequestId
  ))
  assert.equal(canonicalSteering.length, 1)
  assert.equal(canonicalSteering[0].id, accepted.messageId)
  const assistantMessages = messages.filter((message) => message.id === `${turnId}:assistant`)
  assert.equal(assistantMessages.length, 1)
  assert.equal(assistantMessages[0].content, 'Final answer with steering applied.')

  const events = listTurnEvents({ userId, sessionId, turnId, limit: 2_000 })
  assert.equal(events.filter((event) => event.type === 'turn.completed').length, 1)
  assert.equal(events.filter((event) => event.type === 'turn.cancelled').length, 0)
  assert.equal(events.filter((event) => event.type.startsWith('tool.')).length, 0)
  assert.equal(cancellationRequests, 0)
  assert.equal(toolExecutions, 0)
  assert.equal(modelRequests.length, 2, 'steering must not force a redundant third model round')
})
