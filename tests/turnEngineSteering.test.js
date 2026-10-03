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
const { SERVER_TOOL_SPECS } = await import('../server/services/toolLoopRuntime.js')
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

test('TurnEngine consumes steering arriving at the iteration limit before emitting completion', async () => {
  const userId = 'turn-engine-limit-steering-user'
  const sessionId = 'turn-engine-limit-steering-session'
  const turnId = 'turn-engine-limit-steering-turn'
  const steeringContent = 'Revise the conclusion using the existing notes.'
  createUser({ id: userId, email: 'turn-engine-limit-steering@example.com' })
  upsertSession({ id: sessionId, userId, title: 'Iteration-limit steering' })
  const readFile = SERVER_TOOL_SPECS.find((spec) => spec.function?.name === 'read_file')
  let notifyWrapUp
  let releaseWrapUp
  const wrapUpStarted = new Promise((resolve) => { notifyWrapUp = resolve })
  const wrapUpGate = new Promise((resolve) => { releaseWrapUp = resolve })
  let toolExecutions = 0
  let modelCalls = 0
  const engine = new TurnEngine({
    runLoop: (options) => runToolLoop({ ...options, maxIters: 1, enableToolHooks: false }),
    toolSpecs: [readFile],
    resolveToolSpecs: async () => [readFile],
    readApprovalMode: () => 'off',
    getContextWindow: () => 8_192,
    scheduleMemoryExtraction: () => {},
    executeTool: async () => {
      toolExecutions += 1
      return { ok: true, path: 'README.md', content: 'Existing project notes.' }
    },
    runModel: async ({ messages, toolChoice }) => {
      modelCalls += 1
      if (toolChoice === 'none') {
        notifyWrapUp()
        await wrapUpGate
        return { content: 'The notes were read, but the task is incomplete.', toolCalls: [] }
      }
      if (messages.some((message) => message.role === 'user' && message.content === steeringContent)) {
        return { content: 'Revised conclusion using the existing notes.', toolCalls: [] }
      }
      return {
        content: '',
        toolCalls: [{
          id: 'iteration-limit-read',
          type: 'function',
          function: { name: 'read_file', arguments: '{"path":"README.md"}' },
        }],
      }
    },
  })
  await engine.startTurn({
    userId, sessionId, turnId,
    content: 'Read the project notes.',
    intentMode: 'answer',
    locale: 'en',
  })
  await wrapUpStarted
  await engine.steerTurn({
    userId, sessionId, turnId,
    content: steeringContent,
    clientRequestId: 'limit-steering-request',
  })
  releaseWrapUp()
  await engine.waitForTurn({ userId, sessionId, turnId })

  const events = listTurnEvents({ userId, sessionId, turnId, limit: 2_000 })
  const completed = events.filter((event) => event.type === 'turn.completed')
  assert.equal(completed.length, 1)
  assert.equal(completed[0].payload.text, 'Revised conclusion using the existing notes.')
  assert.equal(events.some((event) => event.type === 'turn.failed'), false)
  assert.equal(listTurnSteering({ userId, sessionId, turnId })[0].status, 'consumed')
  const assistant = listMessages({ userId, sessionId, limit: 100 })
    .find((message) => message.id === `${turnId}:assistant`)
  assert.equal(assistant.content, completed[0].payload.text)
  assert.equal(toolExecutions, 1)
  assert.equal(modelCalls, 3)
})
