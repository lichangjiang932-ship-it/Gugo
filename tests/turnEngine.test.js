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
const { listMessages, upsertMessage, upsertSession } = await import('../server/services/sessionStore.js')
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
    agentId: ' agent-input ',
    skillIds: [' skill-review ', 'skill-review'],
    toolsConfig: { enabled: ['read_file'], disabled: ['bash_exec'] },
  })
  await engine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId: 'turn-context' })

  const started = events('turn-context').find((event) => event.type === 'turn.started')
  assert.equal(started.payload.agentId, 'agent-input')
  assert.deepEqual(started.payload.skillIds, ['skill-review'])
  assert.deepEqual(started.payload.toolsConfig, { enabled: ['read_file'], disabled: ['bash_exec'] })
  assert.equal(promptRequest.agentId, 'agent-input')
  assert.deepEqual(promptRequest.skillIds, ['skill-review'])
  assert.equal(promptRequest.query, 'use memory and review skill')
  assert.deepEqual(toolRequest.toolsConfig, { enabled: ['read_file'], disabled: ['bash_exec'] })
  assert.equal(loopOptions.messages[0].content, '# Skill\nreview carefully')
  assert.equal(loopOptions.messages[1].content, '# Memory\nproject uses SQLite')
  assert.deepEqual(loopOptions.toolSpecs.map((spec) => spec.function.name), ['read_file'])
  assert.equal(loopOptions.skillId, 'skill-review')
  assert.equal(loopOptions.job.agentId, 'agent-resolved')
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

test('TurnEngine pauses at approval and resumes after the persisted decision', async () => {
  let modelCalls = 0
  let executions = 0
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
  const engine = createTestEngine({ runModel: async () => ({ content: 'ok', toolCalls: [] }) })
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
