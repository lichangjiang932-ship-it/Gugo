import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-turn-engine-'))
process.env.APP_DATA_DIR = tempDir

const { closeDb, createUser, getDb } = await import('../server/db.js')
const { decideApproval } = await import('../server/services/approvalStore.js')
const { releaseApproval } = await import('../server/services/approvalGate.js')
const { TurnEngine } = await import('../server/services/TurnEngine.js')
const { resolveChatCapabilityMode } = await import('../server/services/chatToolSelection.js')
const { createTurnExecutionLeaseCoordinator } = await import('../server/services/turnExecutionLeaseRuntime.js')
const { listMessages, upsertMessage, upsertSession } = await import('../server/services/sessionStore.js')
const { createCompactionArchive } = await import('../server/services/compactionService.js')
const { prepareTurnPromptContext } = await import('../server/services/turnPromptContext.js')
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

function createTestEngine(options = {}) {
  return new TurnEngine({ scheduleMemoryExtraction: () => {}, ...options })
}

test('TurnEngine emits every artifact produced by one completed local tool call', async () => {
  const localArtifacts = [
    { id: 'local-pdf-1', filename: '填写后 答题卡.pdf', type: 'pdf', url: '/api/artifacts/local-pdf-1' },
    { id: 'local-png-1', filename: '第 1 页.png', type: 'png', url: '/api/artifacts/local-png-1' },
  ]
  const engine = createTestEngine({
    runLoop: async ({ onToolCompleted }) => {
      await onToolCompleted({
        call: { id: 'local-shell-call', name: 'bash_exec', args: { command: 'python fill.py' } },
        result: { ok: true, artifacts: localArtifacts },
        artifactId: localArtifacts[0].id,
        artifacts: localArtifacts,
      })
      return { text: '文件已生成。', artifactIds: localArtifacts.map((artifact) => artifact.id), iterations: 1 }
    },
  })

  await engine.startTurn({
    userId,
    sessionId: 'turn-engine-session',
    turnId: 'turn-local-multi-artifact',
    content: '生成填写后的 PDF 和 PNG。',
  })
  await engine.waitForTurn({
    userId, sessionId: 'turn-engine-session', turnId: 'turn-local-multi-artifact',
  })

  const completed = events('turn-local-multi-artifact')
    .find((event) => event.type === 'tool.completed')
  assert.deepEqual(completed.payload.artifacts, localArtifacts)
  assert.equal(completed.payload.artifactId, 'local-pdf-1')
})

test('TurnEngine rejects more than 32 attachments instead of silently dropping files', async () => {
  const engine = createTestEngine({ runLoop: async () => ({ text: 'must not run' }) })
  await assert.rejects(
    engine.startTurn({
      userId,
      sessionId: 'turn-engine-session',
      turnId: 'turn-too-many-attachments',
      content: 'inspect every attachment',
      attachments: Array.from({ length: 33 }, (_, index) => ({ id: `attachment-${index}` })),
    }),
    (error) => error?.code === 'ATTACHMENT_COUNT_EXCEEDED' && error?.status === 400,
  )
})

test('TurnEngine restores a persisted compaction archive on the next chat turn', async () => {
  const sessionId = 'turn-engine-compaction-session'
  const summaryText = 'Persisted archive summary for the next chat turn.'
  upsertSession({ id: sessionId, userId, title: 'Compaction continuity' })
  const preparedContexts = []
  let loopCalls = 0
  let archiveId = null
  const engine = createTestEngine({
    preparePromptContext: async (request) => {
      const prepared = prepareTurnPromptContext(request)
      preparedContexts.push(prepared)
      return prepared
    },
    runLoop: async () => {
      loopCalls += 1
      if (loopCalls === 1) {
        const archive = createCompactionArchive({
          userId,
          sessionId,
          archivedMessages: [{ role: 'user', content: 'Earlier context' }],
          summaryText,
        })
        archiveId = archive.id
        return { text: 'First reply', artifactIds: [], iterations: 1, recovery: { archiveId } }
      }
      return { text: 'Second reply', artifactIds: [], iterations: 1 }
    },
  })

  await engine.startTurn({ userId, sessionId, turnId: 'turn-compaction-first', content: 'First turn' })
  await engine.waitForTurn({ userId, sessionId, turnId: 'turn-compaction-first' })
  const firstAssistant = listMessages({ userId, sessionId, limit: 100 })
    .find((message) => message.id === 'turn-compaction-first:assistant')
  assert.equal(firstAssistant.modelContext.compactionArchiveId, archiveId)

  await engine.startTurn({ userId, sessionId, turnId: 'turn-compaction-second', content: 'Second turn' })
  await engine.waitForTurn({ userId, sessionId, turnId: 'turn-compaction-second' })
  assert.match(
    preparedContexts[1].messages.map((message) => message.content).join('\n'),
    /Persisted archive summary for the next chat turn\./,
  )
})

async function waitUntil(predicate, timeoutMs = 3000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const value = predicate()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('timed out waiting for turn state')
}

test('TurnEngine reports a session active while startTurn is awaiting turn.started persistence', async () => {
  const sessionId = 'turn-engine-active-session'
  upsertSession({ id: sessionId, userId, title: 'Active session' })
  let releaseStarted
  let startedObserved
  let releaseLoop
  const startedGate = new Promise((resolve) => { releaseStarted = resolve })
  const observed = new Promise((resolve) => { startedObserved = resolve })
  const loopGate = new Promise((resolve) => { releaseLoop = resolve })
  const engine = createTestEngine({
    appendEvent: async (args) => {
      if (args.event.type === 'turn.started') {
        startedObserved()
        await startedGate
      }
      return appendTurnEvent(args)
    },
    runLoop: () => loopGate,
    scheduleMemoryExtraction: () => {},
  })

  const starting = engine.startTurn({
    userId,
    sessionId,
    turnId: 'turn-active-window',
    content: 'keep the session reserved',
  })
  await observed
  assert.equal(engine.hasActiveSession({ userId, sessionId }), true)
  assert.equal(engine.hasActiveSession({ userId: 'another-user', sessionId }), false)

  releaseStarted()
  await starting
  assert.equal(engine.hasActiveSession({ userId, sessionId }), true)
  releaseLoop({ text: 'done', artifactIds: [], iterations: 0 })
  await engine.waitForTurn({ userId, sessionId, turnId: 'turn-active-window' })
  assert.equal(engine.hasActiveSession({ userId, sessionId }), false)
})

test('TurnEngine releases the starting-session reservation when turn.started persistence fails', async () => {
  const sessionId = 'turn-engine-start-failure'
  upsertSession({ id: sessionId, userId, title: 'Start failure' })
  const engine = createTestEngine({
    appendEvent: async () => { throw new Error('event store unavailable') },
    runLoop: async () => ({ text: 'must not run' }),
  })

  await assert.rejects(
    engine.startTurn({ userId, sessionId, turnId: 'turn-start-failure', content: 'start' }),
    /event store unavailable/,
  )
  assert.equal(engine.hasActiveSession({ userId, sessionId }), false)
})

test('TurnEngine rolls back staged messages when attachment binding fails', async () => {
  const sessionId = 'turn-engine-attachment-bind-failure'
  upsertSession({ id: sessionId, userId, title: 'Attachment bind failure' })
  const engine = createTestEngine({
    validateAttachments: () => [{ id: 'attachment-ready', name: 'ready.txt' }],
    bindAttachments: () => {
      throw Object.assign(new Error('attachment binding failed'), { code: 'ATTACHMENT_BIND_FAILED' })
    },
    runLoop: async () => ({ text: 'must not run' }),
  })

  await assert.rejects(
    engine.startTurn({
      userId,
      sessionId,
      turnId: 'turn-bind-failure',
      content: 'inspect attachment',
      attachments: [{ id: 'attachment-ready' }],
      history: [{ role: 'user', content: 'imported browser history' }],
    }),
    (error) => error?.code === 'ATTACHMENT_BIND_FAILED',
  )
  assert.deepEqual(listMessages({ userId, sessionId, limit: 100 }), [])
})

test('TurnEngine imports every browser history message with structured tool context', async () => {
  const sessionId = 'turn-engine-full-history'
  const turnId = 'turn-full-history'
  upsertSession({ id: sessionId, userId, title: 'Full history' })
  const history = Array.from({ length: 205 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `history-${index}`,
  }))
  history.push({
    role: 'assistant',
    content: 'I read the file.',
    tool_calls: [{
      id: 'imported-read-1',
      type: 'function',
      function: { name: 'read_file', arguments: '{"path":"README.md"}' },
    }],
  })
  history.push({
    role: 'tool',
    tool_call_id: 'imported-read-1',
    name: 'read_file',
    content: '{"ok":true,"content":"README"}',
  })
  let loopMessages = null
  const engine = createTestEngine({
    preparePromptContext: async () => ({ messages: [], effectiveAgentId: null, skillIds: [], memoryIds: [] }),
    runLoop: async (options) => {
      loopMessages = options.messages
      return { text: 'history imported', artifactIds: [], iterations: 0 }
    },
    scheduleMemoryExtraction: () => {},
  })

  await engine.startTurn({ userId, sessionId, turnId, content: 'continue', history })
  await engine.waitForTurn({ userId, sessionId, turnId })

  const stored = listMessages({ userId, sessionId, limit: 500 })
  assert.equal(stored.length, history.length + 2)
  assert.equal(stored[0].content, 'history-0')
  const importedAssistant = stored.find((message) => message.content === 'I read the file.')
  assert.equal(importedAssistant.modelContext.toolCalls[0].id, 'imported-read-1')
  const loopAssistant = loopMessages.find((message) => message.tool_calls?.[0]?.id === 'imported-read-1')
  const loopTool = loopMessages.find((message) => message.tool_call_id === 'imported-read-1')
  assert.equal(loopAssistant.tool_calls[0].function.name, 'read_file')
  assert.match(loopTool.content, /README/)
  const started = listTurnEvents({
    requestedUser: userId,
    userId,
    sessionId,
    turnId,
    limit: 2000,
  }).find((event) => event.type === 'turn.started')
  assert.equal(started.payload.importedHistoryCount, history.length)
})

test('TurnEngine schedules automatic memory extraction after completion without making it blocking', async () => {
  const sessionId = 'turn-engine-auto-memory'
  const turnId = 'turn-auto-memory'
  upsertSession({ id: sessionId, userId, title: 'Auto memory' })
  let scheduled = null
  let memoryModelRequest = null
  const engine = createTestEngine({
    preparePromptContext: async () => ({
      messages: [], effectiveAgentId: 'resolved-agent', skillIds: [], memoryIds: [],
    }),
    runLoop: async () => ({ text: 'I will remember that.', artifactIds: [], iterations: 0 }),
    scheduleMemoryExtraction: (options) => {
      scheduled = options
      throw new Error('scheduler unavailable')
    },
    runMemoryModel: async (request) => {
      memoryModelRequest = request
      return '{"memories":[]}'
    },
  })

  await engine.startTurn({
    userId,
    sessionId,
    turnId,
    content: 'Remember that this project uses SQLite.',
    agentId: 'requested-agent',
  })
  await engine.waitForTurn({ userId, sessionId, turnId })

  assert.equal(engine.getTurn({ userId, sessionId, turnId }).status, 'completed')
  assert.equal(scheduled.userId, userId)
  assert.equal(scheduled.sessionId, sessionId)
  assert.equal(scheduled.agentId, 'resolved-agent')
  assert.equal(scheduled.assistantText, 'I will remember that.')
  assert.equal(scheduled.messages.at(-1).content, 'Remember that this project uses SQLite.')
  assert.equal(await scheduled.callModel({ messages: [{ role: 'user', content: 'extract' }] }), '{"memories":[]}')
  assert.equal(memoryModelRequest.userId, userId)
})

test('TurnEngine owns a text turn and persists the final assistant message', async () => {
  const engine = createTestEngine({
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

test('TurnEngine exposes early tool readiness without creating a durable tool call', async () => {
  const turnId = 'turn-tool-call-ready'
  let typesAtReady = []
  let modelResolved = false
  const activities = []
  const engine = createTestEngine({
    publishActivity: async ({ userId: activityUserId, activity }) => {
      assert.equal(activityUserId, userId)
      assert.equal(modelResolved, false, 'readiness must arrive before the canonical model response')
      activities.push(activity)
    },
    runModel: async (request) => {
      await request.onToolCallReady({
        id: 'call-ready-1',
        type: 'function',
        function: { name: 'write_file', arguments: '{"path":"result.txt"}' },
      }, { modelName: 'stub-model' })
      typesAtReady = events(turnId).map((event) => event.type)
      modelResolved = true
      return { content: '', toolCalls: [], modelName: 'stub-model' }
    },
    runLoop: async ({ runModel, onToolCall }) => {
      await runModel({ messages: [{ role: 'user', content: 'write it' }], tools: [] })
      await onToolCall({ id: 'call-ready-1', name: 'write_file', args: { path: 'result.txt' } })
      return { text: 'done', artifactIds: [], iterations: 1 }
    },
  })

  await engine.startTurn({
    userId,
    sessionId: 'turn-engine-session',
    turnId,
    content: 'write it',
  })
  await engine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId })

  assert.equal(typesAtReady.includes('tool.call'), false)
  const turnEvents = events(turnId)
  assert.equal(turnEvents.some((event) => event.payload?.phase === 'tool_call_ready'), false)
  assert.equal(activities.length, 1)
  assert.deepEqual({ ...activities[0], createdAt: 0 }, {
    sessionId: 'turn-engine-session',
    turnId,
    kind: 'tool_call_ready',
    toolName: 'write_file',
    modelName: 'stub-model',
    createdAt: 0,
  })
  assert.equal(turnEvents.filter((event) => event.type === 'tool.call').length, 1)
})

test('TurnEngine uses the runtime approval mode while preserving chat origin', async () => {
  let loopOptions = null
  const engine = createTestEngine({
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

test('TurnEngine persists and applies agent, skill, memory, and tools context', async () => {
  let promptRequest = null
  let toolRequest = null
  let loopOptions = null
  let contextWindowRequest = null
  const baseSpecs = [
    { type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } },
    { type: 'function', function: { name: 'bash_exec', parameters: { type: 'object' } } },
  ]
  const engine = createTestEngine({
    toolSpecs: baseSpecs,
    preparePromptContext: async (request) => {
      promptRequest = request
      return {
        messages: [
          { role: 'system', content: '# Skill\nreview carefully' },
          { role: 'system', content: '# Memory\nproject uses SQLite' },
        ],
        effectiveAgentId: 'agent-resolved',
        skillIds: ['skill-review'],
        memoryIds: ['memory-1'],
      }
    },
    resolveToolSpecs: async (request) => {
      toolRequest = request
      return baseSpecs.filter((spec) => spec.function.name !== 'bash_exec')
    },
    getContextWindow: (request) => {
      contextWindowRequest = request
      return 8192
    },
    runLoop: async (options) => {
      loopOptions = options
      return { text: 'context applied', artifactIds: [], iterations: 0 }
    },
  })

  await engine.startTurn({
    userId,
    sessionId: 'turn-engine-session',
    turnId: 'turn-context',
    content: 'use memory and review skill',
    modelName: 'context-model',
    agentId: ' agent-input ',
    skillIds: [' skill-review ', 'skill-review'],
    toolsConfig: { enabled: ['read_file'], disabled: ['bash_exec'] },
    intentMode: 'execute',
  })
  await engine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId: 'turn-context' })

  const started = events('turn-context').find((event) => event.type === 'turn.started')
  assert.equal(started.payload.agentId, 'agent-input')
  assert.deepEqual(started.payload.skillIds, ['skill-review'])
  assert.deepEqual(started.payload.toolsConfig, { enabled: ['read_file'], disabled: ['bash_exec'] })
  assert.equal(started.payload.intentMode, 'execute')
  assert.equal(promptRequest.agentId, 'agent-input')
  assert.deepEqual(promptRequest.skillIds, ['skill-review'])
  assert.equal(promptRequest.query, 'use memory and review skill')
  assert.equal(promptRequest.includeRecentTranscript, false)
  assert.deepEqual(toolRequest.toolsConfig, { enabled: ['read_file'], disabled: ['bash_exec'] })
  assert.equal(loopOptions.messages[0].content, '# Skill\nreview carefully')
  assert.equal(loopOptions.messages[1].content, '# Memory\nproject uses SQLite')
  assert.deepEqual(loopOptions.toolSpecs.map((spec) => spec.function.name), ['read_file'])
  assert.equal(loopOptions.skillId, 'skill-review')
  assert.equal(loopOptions.job.agentId, 'agent-resolved')
  assert.equal(loopOptions.job.modelName, 'context-model')
  assert.equal(loopOptions.contextWindow, 8192)
  assert.equal(loopOptions.intentMode, 'execute')
  assert.equal(contextWindowRequest.userId, userId)
  assert.equal(contextWindowRequest.modelName, 'context-model')
})

test('TurnEngine forwards the preceding user display text for continuation routing', async () => {
  const sessionId = 'turn-engine-continuation-session'
  upsertSession({ id: sessionId, userId, title: 'Continuation routing' })
  const loopJobs = []
  const engine = createTestEngine({
    runLoop: async (options) => {
      loopJobs.push(options.job)
      return { text: 'ok', artifactIds: [], iterations: 0 }
    },
  })

  const firstDisplay = '\u8bf7\u4fee\u590d D:\\demo\\app.js\uff0c\u5199\u5165\u6587\u4ef6\u5e76\u8fd0\u884c\u6d4b\u8bd5\u3002'
  await engine.startTurn({
    userId,
    sessionId,
    turnId: 'turn-continuation-first',
    content: '[LOCAL PATH ACCESS GRANTED] Access mode: read and write.\n' + firstDisplay,
    displayContent: firstDisplay,
  })
  await engine.waitForTurn({ userId, sessionId, turnId: 'turn-continuation-first' })

  await engine.startTurn({
    userId,
    sessionId,
    turnId: 'turn-continuation-second',
    content: '[LOCAL PATH ACCESS GRANTED] Access mode: read and write.\n\u7ee7\u7eed',
    displayContent: '\u7ee7\u7eed',
  })
  await engine.waitForTurn({ userId, sessionId, turnId: 'turn-continuation-second' })

  assert.equal(loopJobs[1].userPrompt, '\u7ee7\u7eed')
  assert.equal(loopJobs[1].previousUserPrompt, firstDisplay)
  assert.doesNotMatch(loopJobs[1].previousUserPrompt, /LOCAL PATH ACCESS GRANTED/)
})

test('TurnEngine continuation context cannot read a later concurrent user message', async () => {
  const sessionId = 'turn-engine-concurrent-continuation-session'
  const firstTurnId = 'turn-concurrent-continuation-first'
  const laterTurnId = 'turn-concurrent-continuation-later'
  const continuation = '\u7ee7\u7eed'
  const laterExecutionRequest = '\u8bf7\u4fee\u6539 app.js \u5e76\u8fd0\u884c\u6d4b\u8bd5\u3002'
  upsertSession({ id: sessionId, userId, title: 'Concurrent continuation routing' })

  let releaseFirstStarted
  let observeFirstStarted
  const firstStartedGate = new Promise((resolve) => { releaseFirstStarted = resolve })
  const firstStartedObserved = new Promise((resolve) => { observeFirstStarted = resolve })
  const loopJobs = new Map()
  const engine = createTestEngine({
    appendEvent: async (args) => {
      if (args.event.type === 'turn.started' && args.event.turnId === firstTurnId) {
        observeFirstStarted()
        await firstStartedGate
      }
      return appendTurnEvent(args)
    },
    runLoop: async ({ job }) => {
      loopJobs.set(job.id, job)
      return { text: 'ok', artifactIds: [], iterations: 0 }
    },
  })

  const firstStart = engine.startTurn({
    userId,
    sessionId,
    turnId: firstTurnId,
    content: continuation,
    displayContent: continuation,
  })
  await firstStartedObserved

  await engine.startTurn({
    userId,
    sessionId,
    turnId: laterTurnId,
    content: laterExecutionRequest,
    displayContent: laterExecutionRequest,
  })
  await engine.waitForTurn({ userId, sessionId, turnId: laterTurnId })

  releaseFirstStarted()
  await firstStart
  await engine.waitForTurn({ userId, sessionId, turnId: firstTurnId })

  const firstJob = loopJobs.get(firstTurnId)
  assert.equal(firstJob.previousUserPrompt, '')
  assert.notEqual(firstJob.previousUserPrompt, laterExecutionRequest)
  assert.equal(resolveChatCapabilityMode({
    userPrompt: firstJob.userPrompt,
    previousUserPrompt: firstJob.previousUserPrompt,
  }), 'answer')
  assert.equal(loopJobs.get(laterTurnId).previousUserPrompt, continuation)
})

test('TurnEngine resumes a paused directory request on the same turn after a verified grant', async () => {
  const turnId = 'turn-directory-resolution-resume'
  const clarification = {
    request_type: 'directory',
    blocker_kind: 'permission',
    question: '请选择输出目录',
    suggested_path: tempDir,
    access_mode: 'read_write',
  }
  let loopCalls = 0
  let grants = []
  let resumedCheckpoint = null
  let memoryExtractions = 0
  const engine = createTestEngine({
    readFileAccessStatus: () => ({ grants }),
    scheduleMemoryExtraction: () => { memoryExtractions += 1 },
    runLoop: async (options) => {
      loopCalls += 1
      if (loopCalls === 1) {
        await options.saveCheckpoint({
          messages: [{ role: 'user', content: '生成 PDF' }],
          toolCalls: [],
          artifactIds: [],
          iterations: 1,
          final: {
            text: clarification.question,
            paused: true,
            clarification,
            artifactIds: [],
            iterations: 1,
          },
        })
        return {
          text: clarification.question,
          paused: true,
          clarification,
          artifactIds: [],
          iterations: 1,
        }
      }
      resumedCheckpoint = await options.loadCheckpoint()
      return { text: 'PDF 已写入授权目录。', artifactIds: ['pdf-artifact'], iterations: 2 }
    },
  })

  await engine.startTurn({
    userId,
    sessionId: 'turn-engine-session',
    turnId,
    content: '生成 PDF 并保存到本地目录',
  })
  await engine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId })

  const pausedEvents = events(turnId)
  assert.equal(pausedEvents.at(-1).type, 'turn.paused')
  assert.equal(pausedEvents.some((event) => event.type === 'turn.completed'), false)
  assert.equal(engine.getTurn({ userId, sessionId: 'turn-engine-session', turnId }).status, 'paused')
  assert.equal(memoryExtractions, 0)
  const pausedMessage = listMessages({ userId, sessionId: 'turn-engine-session', limit: 100 })
    .find((message) => message.id === `${turnId}:assistant`)
  assert.equal(pausedMessage?.modelContext?.paused, true)
  assert.deepEqual(pausedMessage?.modelContext?.clarification, clarification)
  assert.equal(pausedMessage?.modelContext?.pausedSequence, pausedEvents.at(-1).sequence)

  const stillPaused = await engine.resumeTurn({
    userId,
    sessionId: 'turn-engine-session',
    turnId,
  })
  assert.equal(stillPaused.status, 'paused')
  assert.equal(loopCalls, 1)

  const resolution = {
    type: 'directory_authorization',
    approved: true,
    path: tempDir,
    access_mode: 'read_write',
    paused_sequence: pausedEvents.at(-1).sequence,
  }
  await assert.rejects(
    engine.resumeTurn({
      userId,
      sessionId: 'turn-engine-session',
      turnId,
      resolution: { ...resolution, paused_sequence: resolution.paused_sequence - 1 },
    }),
    (error) => error?.code === 'TURN_RESOLUTION_STALE' && error?.status === 409,
  )
  await assert.rejects(
    engine.resumeTurn({
      userId,
      sessionId: 'turn-engine-session',
      turnId,
      resolution: { response: '继续', paused_sequence: resolution.paused_sequence },
    }),
    (error) => error?.code === 'TURN_RESOLUTION_TYPE_MISMATCH' && error?.status === 409,
  )
  await assert.rejects(
    engine.resumeTurn({
      userId,
      sessionId: 'turn-engine-session',
      turnId,
      resolution: { ...resolution, access_mode: 'read_only' },
    }),
    (error) => error?.code === 'TURN_RESOLUTION_ACCESS_MODE_MISMATCH' && error?.status === 409,
  )
  await assert.rejects(
    engine.resumeTurn({ userId, sessionId: 'turn-engine-session', turnId, resolution }),
    (error) => error?.code === 'TURN_DIRECTORY_GRANT_NOT_FOUND' && error?.status === 403,
  )
  assert.equal(events(turnId).some((event) => event.type === 'turn.resumed'), false)

  grants = [{ path: tempDir, resourceType: 'directory', accessMode: 'read_write', available: true }]
  await engine.resumeTurn({ userId, sessionId: 'turn-engine-session', turnId, resolution })
  await engine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId })

  assert.equal(loopCalls, 2)
  assert.equal(resumedCheckpoint?.final, undefined)
  const resolutionPrompt = resumedCheckpoint?.messages?.at(-1)
  assert.equal(resolutionPrompt?.role, 'system')
  assert.match(resolutionPrompt?.content || '', /authorization is already persisted and verified/i)
  assert.match(resolutionPrompt?.content || '', /Do not call request_directory again/i)
  assert.equal((resolutionPrompt?.content || '').includes(JSON.stringify(tempDir)), true)
  const turnEvents = events(turnId)
  const resumed = turnEvents.find((event) => event.type === 'turn.resumed')
  assert.equal(resumed?.payload.pausedSequence, pausedEvents.at(-1).sequence)
  assert.deepEqual(resumed?.payload.resolution, {
    ...resolution,
    resource_type: 'directory',
  })
  assert.equal(turnEvents.at(-1).type, 'turn.completed')
  assert.equal(turnEvents.filter((event) => event.type === 'turn.paused').length, 1)
  assert.equal(memoryExtractions, 1)
  const completedMessage = listMessages({ userId, sessionId: 'turn-engine-session', limit: 100 })
    .find((message) => message.id === `${turnId}:assistant`)
  assert.equal(completedMessage?.modelContext?.paused, false)
  assert.equal(completedMessage?.modelContext?.clarification, undefined)
})

test('TurnEngine never publishes turn.paused when the paused assistant message cannot be persisted', async () => {
  const turnId = 'turn-pause-message-write-failure'
  const clarification = { question: 'Choose a directory', request_type: 'directory' }
  const engine = createTestEngine({
    runLoop: async () => ({
      text: clarification.question,
      paused: true,
      clarification,
      artifactIds: [],
      iterations: 1,
    }),
    writeMessage: (message) => {
      if (message.id === `${turnId}:assistant` && message.modelContext?.paused === true) {
        throw new Error('paused message write failed')
      }
      return upsertMessage(message)
    },
  })

  await engine.startTurn({
    userId,
    sessionId: 'turn-engine-session',
    turnId,
    content: 'Pause safely',
  })
  await engine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId })

  const turnEvents = events(turnId)
  assert.equal(turnEvents.some((event) => event.type === 'turn.paused'), false)
  assert.equal(turnEvents.at(-1).type, 'turn.failed')
  assert.match(turnEvents.at(-1).payload.message, /paused message write failed/)
})

test('TurnEngine injects an ordinary clarification answer once when resuming', async () => {
  const turnId = 'turn-clarification-resolution-resume'
  let loopCalls = 0
  let resumedCheckpoint = null
  const engine = createTestEngine({
    runLoop: async (options) => {
      loopCalls += 1
      if (loopCalls === 1) {
        await options.saveCheckpoint({
          messages: [{ role: 'user', content: '导出结果' }],
          final: { text: 'CSV 还是 PDF？', paused: true },
        })
        return {
          text: 'CSV 还是 PDF？',
          paused: true,
          clarification: { blocker_kind: 'ambiguous_intent', question: 'CSV 还是 PDF？' },
          artifactIds: [],
          iterations: 1,
        }
      }
      resumedCheckpoint = await options.loadCheckpoint()
      return { text: '已导出 PDF。', artifactIds: [], iterations: 2 }
    },
  })

  await engine.startTurn({ userId, sessionId: 'turn-engine-session', turnId, content: '导出结果' })
  await engine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId })
  const pausedSequence = events(turnId).at(-1).sequence
  await engine.resumeTurn({
    userId,
    sessionId: 'turn-engine-session',
    turnId,
    resolution: { response: 'PDF', paused_sequence: pausedSequence },
  })
  await engine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId })

  assert.equal(resumedCheckpoint?.final, undefined)
  const prompts = resumedCheckpoint?.messages?.filter((message) => (
    String(message?.content || '').includes('[TURN_RESOLUTION:')
  )) || []
  assert.equal(prompts.length, 1)
  assert.equal(prompts[0].role, 'user')
  assert.match(prompts[0].content, /"PDF"/)
  assert.equal(events(turnId).at(-1).type, 'turn.completed')
})

test('TurnEngine restores persisted prompt and tool context on resume', async () => {
  const turnId = 'turn-context-resume'
  appendTurnEvent({
    userId,
    event: createTurnEvent({
      id: 'context-resume-start',
      sessionId: 'turn-engine-session',
      turnId,
      sequence: 0,
      type: 'turn.started',
      payload: {
        content: 'resume context',
        agentId: 'agent-resume',
        skillIds: ['skill-resume'],
        toolsConfig: { enabled: [], disabled: ['bash_exec'] },
        intentMode: 'answer',
      },
      createdAt: 1,
    }),
  })
  let promptRequest = null
  let toolRequest = null
  let loopOptions = null
  const engine = createTestEngine({
    preparePromptContext: (request) => {
      promptRequest = request
      return { messages: [], effectiveAgentId: request.agentId, skillIds: request.skillIds, memoryIds: [] }
    },
    resolveToolSpecs: (request) => {
      toolRequest = request
      return request.baseSpecs
    },
    runLoop: async (options) => {
      loopOptions = options
      return { text: 'resumed context', artifactIds: [], iterations: 0 }
    },
  })

  await engine.resumeTurn({ userId, sessionId: 'turn-engine-session', turnId })
  await engine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId })

  assert.equal(promptRequest.agentId, 'agent-resume')
  assert.deepEqual(promptRequest.skillIds, ['skill-resume'])
  assert.deepEqual(toolRequest.toolsConfig, { enabled: [], disabled: ['bash_exec'] })
  assert.equal(loopOptions.skillId, 'skill-resume')
  assert.equal(loopOptions.job.agentId, 'agent-resume')
  assert.equal(loopOptions.intentMode, 'answer')
})

test('TurnEngine resets only the unconfirmed streaming suffix before a recovered model call', async () => {
  const turnId = 'turn-stream-recovery'
  const persist = (sequence, type, payload = {}) => appendTurnEvent({
    userId,
    event: createTurnEvent({
      id: `${turnId}-${sequence}`,
      sessionId: 'turn-engine-session',
      turnId,
      sequence,
      type,
      payload,
      createdAt: sequence + 1,
    }),
  })
  persist(0, 'turn.started', { content: 'resume interrupted output' })
  persist(1, 'assistant.delta', { text: 'confirmed answer' })
  persist(2, 'reasoning.delta', { text: 'confirmed reasoning' })
  persist(3, 'turn.checkpoint', { state: { messages: [] } })
  persist(4, 'assistant.delta', { text: ' stale half sentence' })
  persist(5, 'reasoning.delta', { text: ' stale reasoning' })

  let eventAtModelCall = null
  const engine = createTestEngine({
    runLoop: async (options) => {
      await options.runModel({ messages: [] })
      return { text: 'fresh answer', artifactIds: [], iterations: 1 }
    },
    runModel: async () => {
      eventAtModelCall = events(turnId).at(-1)
      return { content: 'fresh answer', toolCalls: [] }
    },
  })

  await engine.resumeTurn({ userId, sessionId: 'turn-engine-session', turnId })
  await engine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId })

  const attempt = events(turnId).find((event) => event.type === 'turn.attempt')
  assert.equal(eventAtModelCall?.type, 'turn.attempt')
  assert.deepEqual(attempt?.payload, {
    attempt: 2,
    reason: 'checkpoint_resume',
    resetStreaming: true,
    checkpointSequence: 3,
    previousStreamSequence: 5,
    assistantText: 'confirmed answer',
    reasoningText: 'confirmed reasoning',
  })
  assert.equal(events(turnId).at(-1).type, 'turn.completed')
})

test('TurnEngine leaves checkpoint-confirmed streaming text intact on resume', async () => {
  const turnId = 'turn-confirmed-stream-resume'
  for (const [sequence, type, payload] of [
    [0, 'turn.started', { content: 'continue after checkpoint' }],
    [1, 'assistant.delta', { text: 'confirmed' }],
    [2, 'turn.checkpoint', { state: { messages: [] } }],
  ]) {
    appendTurnEvent({
      userId,
      event: createTurnEvent({
        id: `${turnId}-${sequence}`,
        sessionId: 'turn-engine-session',
        turnId,
        sequence,
        type,
        payload,
        createdAt: sequence + 1,
      }),
    })
  }
  const engine = createTestEngine({
    runLoop: async (options) => {
      await options.runModel({ messages: [] })
      return { text: 'continued', artifactIds: [], iterations: 1 }
    },
    runModel: async () => ({ content: 'continued', toolCalls: [] }),
  })

  await engine.resumeTurn({ userId, sessionId: 'turn-engine-session', turnId })
  await engine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId })

  assert.equal(events(turnId).some((event) => event.type === 'turn.attempt'), false)
})

test('TurnEngine advances recovery attempts across repeated crashes without a checkpoint', async () => {
  const turnId = 'turn-repeated-stream-recovery'
  const persisted = [
    [0, 'turn.started', { content: 'recover repeatedly' }],
    [1, 'assistant.delta', { text: 'first stale fragment' }],
    [2, 'turn.attempt', {
      attempt: 2,
      reason: 'turn_resume',
      resetStreaming: true,
      checkpointSequence: null,
      previousStreamSequence: 1,
      assistantText: '',
      reasoningText: '',
    }],
    [3, 'assistant.delta', { text: 'second stale fragment' }],
  ]
  for (const [sequence, type, payload] of persisted) {
    appendTurnEvent({
      userId,
      event: createTurnEvent({
        id: `${turnId}-${sequence}`,
        sessionId: 'turn-engine-session',
        turnId,
        sequence,
        type,
        payload,
        createdAt: sequence + 1,
      }),
    })
  }
  const engine = createTestEngine({
    runLoop: async (options) => {
      await options.runModel({ messages: [] })
      return { text: 'recovered', artifactIds: [], iterations: 1 }
    },
    runModel: async () => ({ content: 'recovered', toolCalls: [] }),
  })

  await engine.resumeTurn({ userId, sessionId: 'turn-engine-session', turnId })
  await engine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId })

  const attempts = events(turnId).filter((event) => event.type === 'turn.attempt')
  assert.equal(attempts.length, 2)
  assert.deepEqual(attempts.at(-1).payload, {
    attempt: 3,
    reason: 'turn_resume',
    resetStreaming: true,
    checkpointSequence: null,
    previousStreamSequence: 3,
    assistantText: '',
    reasoningText: '',
  })
})

test('TurnEngine runs a multi-round tool call and records its lifecycle', async () => {
  let modelCalls = 0
  let executions = 0
  const engine = createTestEngine({
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

test('TurnEngine serializes lifecycle events emitted by parallel tools', async () => {
  const turnId = 'turn-parallel-tool-events'
  const calls = Array.from({ length: 3 }, (_, index) => ({
    id: `parallel-read-${index + 1}`,
    name: 'read_file',
    args: { path: `file-${index + 1}.txt` },
  }))
  const engine = createTestEngine({
    runLoop: async ({ onToolCall, onToolStarted, onToolCompleted }) => {
      await Promise.all(calls.map((call) => onToolCall(call)))
      await Promise.all(calls.map((call) => onToolStarted(call)))
      await Promise.all(calls.map((call) => onToolCompleted({
        call,
        executionArgs: call.args,
        result: { ok: true, content: call.args.path },
      })))
      return { text: 'Parallel reads completed.', artifactIds: [], iterations: 1 }
    },
  })

  await engine.startTurn({
    userId,
    sessionId: 'turn-engine-session',
    turnId,
    content: 'Read three files in parallel.',
  })
  await engine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId })

  const turnEvents = events(turnId)
  assert.deepEqual(turnEvents.map((event) => event.sequence), turnEvents.map((_, index) => index))
  assert.equal(turnEvents.filter((event) => event.type === 'tool.call').length, 3)
  assert.equal(turnEvents.filter((event) => event.type === 'tool.started').length, 3)
  assert.equal(turnEvents.filter((event) => event.type === 'tool.completed').length, 3)
  assert.equal(turnEvents.at(-1).type, 'turn.completed')
})

test('TurnEngine maps loop progress into durable turn progress events', async () => {
  const turnId = 'turn-progress-callback'
  const engine = createTestEngine({
    runLoop: async ({ onProgress }) => {
      await onProgress({
        completed: 1,
        total: 3,
        iteration: 2,
        filesChanged: 2,
        additions: 8,
        deletions: 3,
        phase: 'editing',
        ignored: 'not part of the public event',
      })
      return { text: 'Progress recorded.', artifactIds: [], iterations: 2 }
    },
  })

  await engine.startTurn({
    userId, sessionId: 'turn-engine-session', turnId, content: 'record progress',
  })
  await engine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId })

  const progress = events(turnId).find((event) => event.type === 'turn.progress')
  assert.deepEqual(progress?.payload, {
    completed: 1,
    total: 3,
    iteration: 2,
    filesChanged: 2,
    additions: 8,
    deletions: 3,
    phase: 'editing',
  })
})

test('TurnEngine preserves completed tools across a retryable model interruption', async () => {
  const turnId = 'turn-model-interrupted-after-tool'
  let modelCalls = 0
  let executions = 0
  let resumedModelMessages = null
  const engine = createTestEngine({
    runModel: async ({ messages } = {}) => {
      modelCalls += 1
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [{ id: 'read-once', function: { name: 'read_file', arguments: '{"path":"README.md"}' } }],
        }
      }
      if (modelCalls === 2) {
        throw Object.assign(new Error('model provider returned HTTP 503'), {
          code: 'MODEL_HTTP_503',
          status: 503,
        })
      }
      resumedModelMessages = messages
      return { content: 'Recovered from the durable tool result.', toolCalls: [] }
    },
    executeTool: async () => {
      executions += 1
      return { ok: true, content: 'durable README content' }
    },
  })

  await engine.startTurn({
    userId,
    sessionId: 'turn-engine-session',
    turnId,
    content: 'Read README.md and answer from its contents.',
  })
  await engine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId })

  const interruptedEvents = events(turnId)
  const interrupted = interruptedEvents.at(-1)
  assert.equal(interrupted.type, 'turn.interrupted')
  assert.equal(interrupted.payload.code, 'MODEL_HTTP_503')
  assert.equal(interrupted.payload.message, 'model provider returned HTTP 503')
  assert.equal(interrupted.payload.retryable, true)
  assert.match(interrupted.payload.text, /durable README content/)
  assert.equal(interruptedEvents.some((event) => event.type === 'turn.completed'), false)
  assert.equal(engine.getTurn({ userId, sessionId: 'turn-engine-session', turnId }).status, 'interrupted')
  const interruptedEvidence = listMessages({ userId, sessionId: 'turn-engine-session', limit: 100 })
    .find((message) => message.id === `${turnId}:assistant`)
  assert.equal(interruptedEvidence?.modelContext?.turnEvidence, true)
  assert.equal(interruptedEvidence?.modelContext?.evidenceState, 'interrupted')
  assert.match(interruptedEvidence?.content || '', /durable README content/)
  assert.equal(executions, 1)

  await engine.resumeTurn({ userId, sessionId: 'turn-engine-session', turnId })
  await engine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId })

  assert.equal(modelCalls, 3)
  assert.equal(executions, 1)
  assert.equal(resumedModelMessages.at(-1)?.role, 'tool')
  assert.equal(resumedModelMessages.at(-1)?.tool_call_id, 'read-once')
  assert.match(resumedModelMessages.at(-1)?.content || '', /durable README content/)
  assert.equal(
    resumedModelMessages.some((message) => (
      message.role === 'assistant' && String(message.content || '').includes('任务中断')
    )),
    false,
  )
  assert.equal(events(turnId).at(-1).type, 'turn.completed')
  assert.equal(
    listMessages({ userId, sessionId: 'turn-engine-session', limit: 100 })
      .find((message) => message.id === `${turnId}:assistant`)?.content,
    'Recovered from the durable tool result.',
  )
  const completedAssistant = listMessages({ userId, sessionId: 'turn-engine-session', limit: 100 })
    .find((message) => message.id === `${turnId}:assistant`)
  assert.notEqual(completedAssistant?.modelContext?.turnEvidence, true)
  assert.equal(completedAssistant?.modelContext?.toolTrace?.length, 2)
})

test('TurnEngine pauses at approval and resumes after the persisted decision', async () => {
  let modelCalls = 0
  const executions = []
  const engine = createTestEngine({
    readApprovalMode: () => 'all',
    runModel: async () => {
      modelCalls += 1
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [{ id: 'write-1', function: { name: 'write_file', arguments: '{"path":"note.txt","content":"ok"}' } }],
        }
      }
      if (modelCalls === 2) {
        return {
          content: '',
          toolCalls: [{ id: 'read-1', function: { name: 'read_file', arguments: '{"path":"safe-note.txt"}' } }],
        }
      }
      return { content: '写入完成。', toolCalls: [] }
    },
    executeTool: async ({ name, args }) => {
      executions.push({ name, args })
      return name === 'write_file'
        ? { ok: true, path: args.path }
        : { ok: true, content: 'safe' }
    },
  })
  await engine.startTurn({
    userId, sessionId: 'turn-engine-session', turnId: 'turn-approval', content: '写入 note.txt',
  })
  const required = await waitUntil(() => events('turn-approval').find((event) => event.type === 'approval.required'))
  const editedArgs = { path: 'safe-note.txt', content: 'safe' }
  const decision = decideApproval({
    userId,
    id: required.payload.approvalId,
    decision: 'edit',
    editedArgs,
  })
  assert.equal(decision.ok, true)
  releaseApproval(required.payload.approvalId)
  await engine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId: 'turn-approval' })

  assert.deepEqual(executions, [
    { name: 'write_file', args: editedArgs },
    { name: 'read_file', args: { path: 'safe-note.txt', offset: 0, limit: 0 } },
  ])
  const turnEvents = events('turn-approval')
  assert.deepEqual(
    turnEvents.find((event) => event.type === 'approval.resolved')?.payload.args,
    editedArgs,
  )
  assert.deepEqual(
    turnEvents.find((event) => event.type === 'tool.completed' && event.payload.name === 'write_file')?.payload.args,
    editedArgs,
  )
  assert.equal(engine.getTurn({ userId, sessionId: 'turn-engine-session', turnId: 'turn-approval' }).status, 'completed')
})

test('TurnEngine aborts an active model request with an explicit cancelled event', async () => {
  const engine = createTestEngine({
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

test('TurnEngine treats an internal AbortError as a structured failure and persists evidence', async () => {
  const turnId = 'turn-internal-abort-timeout'
  const engine = createTestEngine({
    runLoop: async (options) => {
      await options.saveCheckpoint({
        messages: [
          {
            role: 'assistant',
            content: '',
            tool_calls: [{
              id: 'durable-tool',
              type: 'function',
              function: { name: 'read_file', arguments: '{"path":"README.md"}' },
            }],
          },
          {
            role: 'tool',
            tool_call_id: 'durable-tool',
            name: 'read_file',
            content: '{"ok":true,"content":"durable result"}',
          },
        ],
        artifactIds: ['artifact-timeout'],
        iterations: 2,
      })
      await options.onModelDelta({ text: 'Partial response', iteration: 2, modelName: 'local-model' })
      throw Object.assign(new Error('model first token timed out'), {
        name: 'AbortError',
        code: 'MODEL_FIRST_TOKEN_TIMEOUT',
        status: 504,
        retryable: true,
        hint: 'check the local model endpoint',
        attempts: 2,
      })
    },
  })

  await engine.startTurn({
    userId,
    sessionId: 'turn-engine-session',
    turnId,
    content: 'Keep the partial result if the provider times out.',
  })
  await engine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId })

  const turnEvents = events(turnId)
  const failed = turnEvents.at(-1)
  assert.equal(failed.type, 'turn.failed')
  assert.equal(turnEvents.some((event) => event.type === 'turn.cancelled'), false)
  assert.equal(failed.payload.code, 'MODEL_FIRST_TOKEN_TIMEOUT')
  assert.equal(failed.payload.error.status, 504)
  assert.equal(failed.payload.error.retryable, true)
  assert.equal(failed.payload.error.attempts, 2)
  assert.equal(failed.payload.partialText, 'Partial response')
  assert.deepEqual(failed.payload.artifactIds, ['artifact-timeout'])
  assert.equal(failed.payload.iterations, 2)
  const evidence = listMessages({ userId, sessionId: 'turn-engine-session', limit: 100 })
    .find((message) => message.id === `${turnId}:assistant`)
  assert.equal(evidence?.content, 'Partial response')
  assert.equal(evidence?.modelContext?.turnEvidence, true)
  assert.equal(evidence?.modelContext?.error?.code, 'MODEL_FIRST_TOKEN_TIMEOUT')
  assert.equal(evidence?.modelContext?.toolTrace?.length, 2)
  assert.deepEqual(evidence?.modelContext?.artifactIds, ['artifact-timeout'])
})

test('TurnEngine maps an incomplete loop result to failure instead of completion', async () => {
  const turnId = 'turn-incomplete-result'
  const engine = createTestEngine({
    runLoop: async () => ({
      text: 'The requested mutation could not be verified.',
      artifactIds: ['artifact-unverified'],
      iterations: 4,
      incomplete: true,
      reason: 'post_mutation_verification_missing',
    }),
  })

  await engine.startTurn({
    userId,
    sessionId: 'turn-engine-session',
    turnId,
    content: 'Make and verify a change.',
  })
  await engine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId })

  const turnEvents = events(turnId)
  const failed = turnEvents.at(-1)
  assert.equal(failed.type, 'turn.failed')
  assert.equal(turnEvents.some((event) => event.type === 'turn.completed'), false)
  assert.equal(failed.payload.code, 'TURN_INCOMPLETE')
  assert.equal(failed.payload.error.retryable, true)
  assert.equal(failed.payload.partialText, 'The requested mutation could not be verified.')
  assert.deepEqual(failed.payload.artifactIds, ['artifact-unverified'])
  assert.equal(engine.getTurn({ userId, sessionId: 'turn-engine-session', turnId }).status, 'failed')
  const evidence = listMessages({ userId, sessionId: 'turn-engine-session', limit: 100 })
    .find((message) => message.id === `${turnId}:assistant`)
  assert.equal(evidence?.modelContext?.evidenceState, 'failed')
  assert.equal(evidence?.content, 'The requested mutation could not be verified.')
})

test('TurnEngine lease prevents duplicate resume and carries cancellation across instances', async () => {
  const sessionId = 'turn-engine-cross-instance-session'
  const turnId = 'turn-cross-instance'
  upsertSession({ id: sessionId, userId, title: 'Cross-instance turn' })
  const scopedEvents = () => listTurnEvents({ userId, sessionId, turnId, limit: 2000 })
  let primaryCalls = 0
  let secondaryCalls = 0
  const primary = createTestEngine({
    executionLeases: createTurnExecutionLeaseCoordinator({ ownerId: 'turn-worker-a', leaseMs: 1_000 }),
    runLoop: ({ signal }) => new Promise((resolve, reject) => {
      primaryCalls += 1
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    }),
  })
  const secondary = createTestEngine({
    executionLeases: createTurnExecutionLeaseCoordinator({ ownerId: 'turn-worker-b', leaseMs: 1_000 }),
    runLoop: async () => {
      secondaryCalls += 1
      return { text: 'must not run twice', artifactIds: [], iterations: 0 }
    },
  })

  await primary.startTurn({ userId, sessionId, turnId, content: 'run exactly once' })
  await waitUntil(() => primaryCalls === 1)
  const resumed = await secondary.resumeTurn({ userId, sessionId, turnId })
  assert.equal(resumed.status, 'running')
  assert.equal(secondaryCalls, 0)

  const cancelling = await secondary.cancelTurn({ userId, sessionId, turnId })
  assert.equal(cancelling.status, 'cancelling')
  await waitUntil(() => scopedEvents().at(-1)?.type === 'turn.cancelled')
  await primary.waitForTurn({ userId, sessionId, turnId })
  assert.equal(primaryCalls, 1)
  assert.equal(secondaryCalls, 0)
  assert.equal(scopedEvents().filter((event) => event.type === 'turn.cancelled').length, 1)
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
  const engine = createTestEngine({
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
  const engine = createTestEngine({
    runLoop: async () => ({ text: 'ok', artifactIds: [], iterations: 1 }),
  })
  await engine.startTurn({ userId, sessionId: 'created-by-engine', turnId: 'turn-created-session', content: 'create' })
  await engine.waitForTurn({ userId, sessionId: 'created-by-engine', turnId: 'turn-created-session' })
  assert.equal(engine.getTurn({ userId, sessionId: 'created-by-engine', turnId: 'turn-created-session' }).status, 'completed')
  await assert.rejects(
    engine.startTurn({ userId, sessionId: 'owned-by-other', turnId: 'turn-cross-user', content: 'claim' }),
    /session not found/,
  )
})

test('TurnEngine claims one legacy local chat and all session-scoped records atomically', async () => {
  const db = getDb()
  const legacyUserId = 'turn-engine-legacy-local'
  const sessionId = 'turn-engine-legacy-session'
  createUser({ id: legacyUserId, email: 'turn-engine-legacy-local@example.com' })
  upsertSession({ id: sessionId, userId: legacyUserId, title: 'Legacy local chat' })
  upsertMessage({
    id: 'legacy-message',
    userId: legacyUserId,
    sessionId,
    role: 'user',
    content: 'legacy history',
    createdAt: 1,
  })
  appendTurnEvent({
    userId: legacyUserId,
    event: createTurnEvent({
      id: 'legacy-event', sessionId, turnId: 'legacy-complete-turn', sequence: 0,
      type: 'turn.completed', payload: {}, createdAt: 2,
    }),
  })
  db.prepare(`
    INSERT INTO turn_artifacts
      (id, user_id, session_id, turn_id, type, title, url, filename, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('legacy-artifact', legacyUserId, sessionId, 'legacy-complete-turn', 'file', 'Legacy', '/legacy', 'legacy-claim.txt', 2)
  db.prepare(`
    INSERT INTO pending_approvals
      (id, user_id, origin, session_id, tool_name, args_json, risk, status, created_at, updated_at)
    VALUES (?, ?, 'chat', ?, 'write_file', '{}', 'medium', 'pending', ?, ?)
  `).run('legacy-approval', legacyUserId, sessionId, 2, 2)
  db.prepare(`
    INSERT INTO session_meters (session_id, user_id, updated_at)
    VALUES (?, ?, ?)
  `).run(sessionId, legacyUserId, 2)
  db.prepare(`
    INSERT INTO compaction_archive
      (id, user_id, session_id, replaced_message_count, archived_messages_json, summary_text, created_at)
    VALUES (?, ?, ?, 1, '[]', 'legacy summary', ?)
  `).run('legacy-archive', legacyUserId, sessionId, 2)
  db.prepare(`
    INSERT INTO memories
      (id, user_id, type, title, slug, body, frontmatter_json, pinned,
       source_session_id, source_message_id, created_at, updated_at)
    VALUES (?, ?, 'project', 'Legacy memory', 'legacy-memory', 'body', '{}', 0, ?, ?, ?, ?)
  `).run('legacy-memory', legacyUserId, sessionId, 'legacy-message', 2, 2)
  db.prepare(`
    INSERT INTO subagent_runs
      (id, user_id, parent_session_id, parent_message_id, agent_type, prompt, status, created_at)
    VALUES (?, ?, ?, ?, 'general', 'legacy prompt', 'completed', ?)
  `).run('legacy-subagent', legacyUserId, sessionId, 'legacy-message', 2)
  db.prepare(`
    INSERT INTO meta (key, value) VALUES ('local_auth_owner_user_id', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(userId)

  const engine = createTestEngine({
    runLoop: async () => ({ text: 'claimed', artifactIds: [], iterations: 0 }),
  })
  await engine.startTurn({
    userId,
    sessionId,
    turnId: 'turn-local-claim',
    content: 'continue legacy chat',
    authMode: 'local',
  })
  await engine.waitForTurn({ userId, sessionId, turnId: 'turn-local-claim' })

  assert.equal(db.prepare('SELECT user_id FROM sessions WHERE token = ?').get(sessionId).user_id, userId)
  for (const [table, id] of [
    ['messages', 'legacy-message'],
    ['turn_events', 'legacy-event'],
    ['turn_artifacts', 'legacy-artifact'],
    ['pending_approvals', 'legacy-approval'],
    ['compaction_archive', 'legacy-archive'],
    ['memories', 'legacy-memory'],
    ['subagent_runs', 'legacy-subagent'],
  ]) {
    assert.equal(db.prepare(`SELECT user_id FROM ${table} WHERE id = ?`).get(id).user_id, userId)
  }
  assert.equal(db.prepare('SELECT user_id FROM session_meters WHERE session_id = ?').get(sessionId).user_id, userId)
  assert.equal(db.prepare('SELECT status FROM pending_approvals WHERE id = ?').get('legacy-approval').status, 'cancelled')
  assert.equal(engine.getTurn({ userId, sessionId, turnId: 'turn-local-claim' }).status, 'completed')
})

test('TurnEngine never claims another user chat in multi-user mode', async () => {
  const db = getDb()
  const legacyUserId = 'turn-engine-multi-owner'
  const sessionId = 'turn-engine-multi-session'
  createUser({ id: legacyUserId, email: 'turn-engine-multi-owner@example.com' })
  upsertSession({ id: sessionId, userId: legacyUserId, title: 'Multi-user chat' })
  db.prepare(`
    INSERT INTO meta (key, value) VALUES ('local_auth_owner_user_id', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(userId)

  const engine = createTestEngine({ runLoop: async () => ({ text: 'must not run' }) })
  await assert.rejects(
    engine.startTurn({
      userId,
      sessionId,
      turnId: 'turn-multi-no-claim',
      content: 'do not claim',
      authMode: 'multi_user',
    }),
    (error) => error?.code === 'SESSION_NOT_FOUND' && error?.status === 404,
  )
  assert.equal(db.prepare('SELECT user_id FROM sessions WHERE token = ?').get(sessionId).user_id, legacyUserId)
})

test('TurnEngine claims a legacy local session before resuming an unfinished turn', async () => {
  const db = getDb()
  const legacyUserId = 'turn-engine-resume-owner'
  const sessionId = 'turn-engine-resume-session'
  const turnId = 'turn-engine-legacy-resume'
  createUser({ id: legacyUserId, email: 'turn-engine-resume-owner@example.com' })
  upsertSession({ id: sessionId, userId: legacyUserId, title: 'Resume legacy chat' })
  appendTurnEvent({
    userId: legacyUserId,
    event: createTurnEvent({
      id: 'legacy-resume-start', sessionId, turnId, sequence: 0,
      type: 'turn.started', payload: { content: 'resume me', modelName: null }, createdAt: 1,
    }),
  })
  db.prepare(`
    INSERT INTO meta (key, value) VALUES ('local_auth_owner_user_id', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(userId)

  const engine = createTestEngine({
    runLoop: async () => ({ text: 'resumed', artifactIds: [], iterations: 0 }),
  })
  await engine.resumeTurn({ userId, sessionId, turnId, authMode: 'local' })
  await engine.waitForTurn({ userId, sessionId, turnId })
  assert.equal(engine.getTurn({ userId, sessionId, turnId }).status, 'completed')
  assert.equal(db.prepare('SELECT user_id FROM sessions WHERE token = ?').get(sessionId).user_id, userId)
})

test('I1: startTurn resolves /skill-prefix when caller omits skillIds', async () => {
  let promptRequest = null
  const engine = createTestEngine({
    preparePromptContext: async (request) => {
      promptRequest = request
      return { messages: [], effectiveAgentId: null, skillIds: request.skillIds, memoryIds: [] }
    },
    runLoop: async () => ({ text: 'done', artifactIds: [], iterations: 0 }),
  })

  await engine.startTurn({
    userId,
    sessionId: 'turn-engine-session',
    turnId: 'turn-skill-prefix',
    content: '/connector-operator 帮我查 GitHub 仓库',
  })
  await engine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId: 'turn-skill-prefix' })

  const started = events('turn-skill-prefix').find((event) => event.type === 'turn.started')
  assert.deepEqual(started.payload.skillIds, ['connector-operator'])
  // 模型上下文应剥离前缀，展示层保留原话
  assert.equal(promptRequest.query, '帮我查 GitHub 仓库')
  assert.deepEqual(promptRequest.skillIds, ['connector-operator'])
  assert.equal(started.payload.displayContent, '/connector-operator 帮我查 GitHub 仓库')

  await engine.startTurn({
    userId,
    sessionId: 'turn-engine-session',
    turnId: 'turn-legacy-ppt-prefix',
    content: '/htmlppt 做一份产品演示',
  })
  await engine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId: 'turn-legacy-ppt-prefix' })
  const startedLegacyPpt = events('turn-legacy-ppt-prefix').find((event) => event.type === 'turn.started')
  assert.deepEqual(startedLegacyPpt.payload.skillIds, ['ppt'])
  assert.deepEqual(promptRequest.skillIds, ['ppt'])
  assert.equal(promptRequest.query, '做一份产品演示')

  // 显式传了 skillIds 时不覆盖
  await engine.startTurn({
    userId,
    sessionId: 'turn-engine-session',
    turnId: 'turn-skill-explicit',
    content: '/ppt-master 做演示',
    skillIds: ['skill-review'],
  })
  await engine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId: 'turn-skill-explicit' })
  const startedExplicit = events('turn-skill-explicit').find((event) => event.type === 'turn.started')
  assert.deepEqual(startedExplicit.payload.skillIds, ['skill-review'])

  // 无前缀的普通文本不误解析
  await engine.startTurn({
    userId,
    sessionId: 'turn-engine-session',
    turnId: 'turn-no-prefix',
    content: '帮我看看这个项目结构',
  })
  await engine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId: 'turn-no-prefix' })
  const startedPlain = events('turn-no-prefix').find((event) => event.type === 'turn.started')
  assert.deepEqual(startedPlain.payload.skillIds, [])
})
