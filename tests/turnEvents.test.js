import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  createTurnActivity,
  createTurnEvent,
  parseTurnActivity,
  parseTurnEvent,
} from '../shared/turnEvents.js'
import { INLINE_SKILL_DEFINITION_LIMITS } from '../shared/inlineSkillDefinitions.js'

test('turn event protocol accepts known events and rejects protocol drift', () => {
  const event = createTurnEvent({
    id: 'e1', sessionId: 's1', turnId: 't1', sequence: 0, type: 'turn.started', createdAt: 1,
    payload: {
      model: 'test',
      skillIds: ['local-writer'],
      skillDefinitions: [{
        id: 'local-writer',
        name: 'Local writer',
        description: 'Custom workflow',
        permissions: ['read'],
        systemPrompt: 'Use the custom workflow.',
      }],
    },
  })
  assert.equal(event.type, 'turn.started')
  assert.equal(event.payload.skillDefinitions[0].id, 'local-writer')
  assert.throws(() => parseTurnEvent({ ...event, type: 'text' }))
  assert.throws(() => parseTurnEvent({ ...event, sequence: -1 }))
})

test('approval events accept declared metadata sources while remaining compatible with legacy events', () => {
  const base = {
    sessionId: 's1', turnId: 't1', sequence: 1, type: 'approval.required', createdAt: 2,
    payload: { approvalId: 'approval-1', toolName: 'write_file', risk: 'medium' },
  }
  const declared = createTurnEvent({
    ...base,
    id: 'approval-declared',
    payload: { ...base.payload, metadataSource: 'declared' },
  })
  assert.equal(declared.payload.metadataSource, 'declared')
  assert.equal(createTurnEvent({ ...base, id: 'approval-legacy' }).payload.metadataSource, undefined)
  assert.throws(() => createTurnEvent({
    ...base,
    id: 'approval-invalid-source',
    payload: { ...base.payload, metadataSource: 'guessed' },
  }))
})

test('turn.started enforces inline prompts by UTF-8 bytes, not JavaScript string length', () => {
  const maxBytes = INLINE_SKILL_DEFINITION_LIMITS.systemPrompt.maxUtf8Bytes
  assert.throws(() => createTurnEvent({
    id: 'inline-byte-overflow', sessionId: 's1', turnId: 't1', sequence: 0,
    type: 'turn.started', createdAt: 1,
    payload: {
      skillIds: ['local-writer'],
      skillDefinitions: [{
        id: 'local-writer',
        name: 'Local writer',
        description: '',
        permissions: [],
        // Fewer JavaScript characters than the old limit, but three UTF-8
        // bytes per character make this payload exceed the durable budget.
        systemPrompt: '技'.repeat(Math.floor(maxBytes / 3) + 1),
      }],
    },
  }))
})

test('model tool readiness is a strict non-durable activity', () => {
  const activity = createTurnActivity({
    sessionId: 's1',
    turnId: 't1',
    kind: 'tool_call_ready',
    toolName: 'write_file',
    modelName: 'test-model',
    createdAt: 2,
  })
  assert.equal(activity.toolName, 'write_file')
  assert.equal('sequence' in activity, false)
  assert.equal('id' in activity, false)
  assert.throws(() => parseTurnActivity({ ...activity, args: { path: 'secret.txt' } }))
  assert.throws(() => parseTurnActivity({ ...activity, sequence: 1 }))
  assert.throws(() => createTurnEvent({
    id: 'model-tool-ready', sessionId: 's1', turnId: 't1', sequence: 1,
    type: 'model.activity', payload: activity, createdAt: 2,
  }))
  assert.throws(() => createTurnEvent({
    id: 'model-phase-with-tool', sessionId: 's1', turnId: 't1', sequence: 1,
    type: 'model.phase',
    payload: { phase: 'completed', modelName: 'test-model', toolName: 'write_file' },
    createdAt: 2,
  }))
})

test('model failover events surface a bounded provider/retry fallback', () => {
  const failover = createTurnEvent({
    id: 'failover-1', sessionId: 's1', turnId: 't1', sequence: 1,
    type: 'model.failover',
    payload: { kind: 'failover', from: 'primary', to: 'backup', modelName: 'm1', attempt: 1, delayMs: 0 },
    createdAt: 2,
  })
  assert.equal(failover.payload.to, 'backup')
  assert.equal(failover.payload.modelName, 'm1')
  assert.throws(() => createTurnEvent({
    ...failover, id: 'failover-bad-kind', payload: { ...failover.payload, kind: 'recover' },
  }))
  assert.throws(() => createTurnEvent({
    ...failover, id: 'failover-drift', payload: { ...failover.payload, stack: 'private' },
  }))
})

test('turn attempt events require an explicit recovery cursor and confirmed stream prefix', () => {
  const attempt = createTurnEvent({
    id: 'attempt-2',
    sessionId: 's1',
    turnId: 't1',
    sequence: 4,
    type: 'turn.attempt',
    payload: {
      attempt: 2,
      reason: 'turn_resume',
      resetStreaming: true,
      checkpointSequence: null,
      previousStreamSequence: 3,
      assistantText: '',
      reasoningText: '',
    },
    createdAt: 5,
  })
  assert.equal(attempt.payload.checkpointSequence, null)
  assert.throws(() => createTurnEvent({
    ...attempt,
    id: 'invalid-attempt',
    payload: { ...attempt.payload, assistantText: undefined },
  }))
  assert.throws(() => createTurnEvent({
    ...attempt,
    id: 'negative-checkpoint',
    payload: { ...attempt.payload, checkpointSequence: -1 },
  }))
  assert.throws(() => createTurnEvent({
    ...attempt,
    id: 'drifted-attempt',
    payload: { ...attempt.payload, unexpected: true },
  }))
})

test('turn interrupted events are strict resumable attempt boundaries', () => {
  const interrupted = createTurnEvent({
    id: 'interrupted-1',
    sessionId: 's1',
    turnId: 't1',
    sequence: 5,
    type: 'turn.interrupted',
    payload: {
      code: 'MODEL_HTTP_503',
      message: 'upstream unavailable',
      retryable: true,
      text: 'The completed tool results were preserved.',
      artifactIds: [],
      iterations: 2,
    },
    createdAt: 6,
  })
  assert.equal(interrupted.payload.retryable, true)
  assert.throws(() => createTurnEvent({
    ...interrupted,
    id: 'interrupted-drift',
    payload: { ...interrupted.payload, completed: true },
  }))
})

test('turn paused and resumed events preserve a strict non-terminal resolution protocol', () => {
  const paused = createTurnEvent({
    id: 'paused-1',
    sessionId: 's1',
    turnId: 't1',
    sequence: 6,
    type: 'turn.paused',
    payload: {
      text: '请选择输出目录',
      clarification: {
        request_type: 'directory',
        suggested_path: 'D:\\output',
        access_mode: 'read_write',
      },
      artifactIds: [],
      iterations: 2,
    },
    createdAt: 7,
  })
  const resumed = createTurnEvent({
    id: 'resumed-1',
    sessionId: 's1',
    turnId: 't1',
    sequence: 7,
    type: 'turn.resumed',
    payload: {
      pausedSequence: paused.sequence,
      resolution: {
        type: 'directory_authorization',
        approved: true,
        path: 'D:\\output',
        access_mode: 'read_write',
        resource_type: 'directory',
        paused_sequence: paused.sequence,
      },
    },
    createdAt: 8,
  })
  assert.equal(paused.type, 'turn.paused')
  assert.equal(resumed.payload.pausedSequence, paused.sequence)
  assert.throws(() => createTurnEvent({
    ...paused,
    id: 'paused-drift',
    payload: { ...paused.payload, terminal: true },
  }))
  assert.throws(() => createTurnEvent({
    ...resumed,
    id: 'resumed-empty-resolution',
    payload: { pausedSequence: paused.sequence, resolution: {} },
  }))
  assert.throws(() => createTurnEvent({
    ...resumed,
    id: 'resumed-stale-resolution',
    payload: {
      ...resumed.payload,
      resolution: { ...resumed.payload.resolution, paused_sequence: paused.sequence - 1 },
    },
  }))
  assert.throws(() => createTurnEvent({
    ...resumed,
    id: 'resumed-invalid-mode',
    payload: {
      ...resumed.payload,
      resolution: { ...resumed.payload.resolution, access_mode: 'execute' },
    },
  }))
})

test('tool completed events use a strict structured failure payload', () => {
  const event = createTurnEvent({
    id: 'tool-failed', sessionId: 's1', turnId: 't1', sequence: 6,
    type: 'tool.completed',
    payload: {
      toolCallId: 'call-1', name: 'read_file', result: { ok: false }, artifactId: null,
      error: { code: 'UPSTREAM_503', message: 'temporarily unavailable', status: 503, retryable: true, hint: 'try later', attempts: 3 },
    },
    createdAt: 7,
  })
  assert.equal(event.payload.error.status, 503)
  assert.throws(() => createTurnEvent({
    ...event,
    id: 'tool-failed-drift',
    payload: { ...event.payload, error: { ...event.payload.error, stack: 'private stack' } },
  }))
})

test('tool completed events accept strict multi-artifact output metadata', () => {
  const event = createTurnEvent({
    id: 'tool-multi-artifact', sessionId: 's1', turnId: 't1', sequence: 7,
    type: 'tool.completed',
    payload: {
      toolCallId: 'shell-1',
      name: 'bash_exec',
      artifactId: 'pdf-1',
      artifacts: [
        { id: 'pdf-1', filename: '填写后 答题卡.pdf', type: 'pdf', url: '/api/artifacts/pdf-1' },
        { id: 'png-1', filename: '第 1 页.png', type: 'png', url: '/api/artifacts/png-1', title: '第一页' },
      ],
    },
    createdAt: 8,
  })
  assert.deepEqual(event.payload.artifacts.map((artifact) => artifact.id), ['pdf-1', 'png-1'])
  assert.throws(() => createTurnEvent({
    ...event,
    id: 'tool-multi-artifact-drift',
    payload: {
      ...event.payload,
      artifacts: [{ ...event.payload.artifacts[0], localPath: 'D:\\private\\answer.pdf' }],
    },
  }))
})

test('turn progress events require bounded structured progress', () => {
  const event = createTurnEvent({
    id: 'progress-1', sessionId: 's1', turnId: 't1', sequence: 7,
    type: 'turn.progress',
    payload: {
      completed: 2, total: 4, iteration: 3, filesChanged: 2,
      additions: 12, deletions: 5, phase: 'verify',
    },
    createdAt: 8,
  })
  assert.deepEqual(event.payload, {
    completed: 2, total: 4, iteration: 3, filesChanged: 2,
    additions: 12, deletions: 5, phase: 'verify',
  })
  assert.throws(() => createTurnEvent({ ...event, id: 'empty-progress', payload: {} }))
  assert.throws(() => createTurnEvent({ ...event, id: 'negative-progress', payload: { additions: -1 } }))
  assert.throws(() => createTurnEvent({ ...event, id: 'over-complete-progress', payload: { completed: 5, total: 4 } }))
  assert.throws(() => createTurnEvent({ ...event, id: 'drifted-progress', payload: { phase: 'verify', percent: 50 } }))
})

test('turn failed events preserve legacy fields and structured recovery evidence', () => {
  const event = createTurnEvent({
    id: 'turn-failed-structured',
    sessionId: 's1',
    turnId: 't1',
    sequence: 7,
    type: 'turn.failed',
    payload: {
      code: 'MODEL_FIRST_TOKEN_TIMEOUT',
      message: 'model response timed out',
      error: {
        code: 'MODEL_FIRST_TOKEN_TIMEOUT',
        message: 'model response timed out',
        status: 504,
        retryable: true,
        hint: 'retry with a healthy endpoint',
        attempts: 2,
      },
      partialText: 'A durable partial answer',
      artifactIds: ['artifact-1'],
      iterations: 3,
    },
    createdAt: 8,
  })
  assert.equal(event.payload.code, 'MODEL_FIRST_TOKEN_TIMEOUT')
  assert.equal(event.payload.error.retryable, true)
  assert.deepEqual(event.payload.artifactIds, ['artifact-1'])
  assert.throws(() => createTurnEvent({
    ...event,
    id: 'turn-failed-drift',
    payload: { ...event.payload, stack: 'private stack' },
  }))
})

test('turn event store is append-only, idempotent, ordered, and user isolated', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'yma-turn-events-'))
  const oldPath = process.env.APP_DB_PATH
  process.env.APP_DB_PATH = path.join(dir, 'test.db')
  const { closeDb, createUser, getDb } = await import('../server/db.js')
  const { upsertSession } = await import('../server/services/sessionStore.js')
  const {
    appendTurnEvent,
    listTurnEvents,
    pruneTurnEvents,
    resolveTurnEventRetentionConfig,
  } = await import('../server/services/turnEventStore.js')
  try {
    createUser({ id: 'u1', email: 'turn-u1@example.com' }); createUser({ id: 'u2', email: 'turn-u2@example.com' })
    upsertSession({ id: 's1', userId: 'u1', title: 'Turn' })
    const event = createTurnEvent({ id: 'e1', sessionId: 's1', turnId: 't1', sequence: 0, type: 'turn.started', createdAt: 1 })
    appendTurnEvent({ userId: 'u1', event }); appendTurnEvent({ userId: 'u1', event })
    appendTurnEvent({ userId: 'u1', event: createTurnEvent({ id: 'e2', sessionId: 's1', turnId: 't1', sequence: 1, type: 'turn.completed', createdAt: 2 }) })
    assert.deepEqual(listTurnEvents({ userId: 'u1', sessionId: 's1', turnId: 't1' }).map((item) => item.id), ['e1', 'e2'])
    assert.deepEqual(listTurnEvents({ userId: 'u2', sessionId: 's1', turnId: 't1' }), [])
    assert.throws(() => appendTurnEvent({ userId: 'u1', event: { ...event, id: 'other', type: 'turn.failed' } }), /conflict/)

    assert.deepEqual(resolveTurnEventRetentionConfig({
      TURN_EVENT_RETENTION_DAYS: '7',
      TURN_EVENT_MAX_TERMINAL_TURNS_PER_USER: '25',
      TURN_EVENT_CLEANUP_INTERVAL_MS: '2000',
    }), {
      retentionMs: 7 * 86_400_000,
      maxTerminalTurnsPerUser: 25,
      cleanupIntervalMs: 2_000,
    })
    assert.equal(
      getDb().prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_turn_events_retention'").get()?.name,
      'idx_turn_events_retention',
    )

    // Sessions created by bridge/mobile flows may not have a display title yet.
    // Ownership, not presentation metadata, is the authorization boundary.
    getDb().prepare(`
      INSERT INTO sessions (token, id, user_id, title, expires_at, created_at, updated_at)
      VALUES (?, ?, ?, NULL, ?, ?, ?)
    `).run('untitled-session', 'untitled-session', 'u1', Number.MAX_SAFE_INTEGER, 1, 1)
    const untitledEvent = createTurnEvent({
      id: 'untitled-event', sessionId: 'untitled-session', turnId: 'untitled-turn',
      sequence: 0, type: 'turn.started', createdAt: 1,
    })
    assert.equal(appendTurnEvent({ userId: 'u1', event: untitledEvent }).id, 'untitled-event')
    assert.throws(() => appendTurnEvent({
      userId: 'u2',
      event: { ...untitledEvent, id: 'untitled-cross-user', turnId: 'cross-user-turn' },
    }), /session not found/)

    upsertSession({ id: 'retention-session', userId: 'u2', title: 'Retention' })
    const add = (turnId, sequence, type, createdAt) => appendTurnEvent({
      userId: 'u2',
      event: createTurnEvent({
        id: `${turnId}-${sequence}`,
        sessionId: 'retention-session',
        turnId,
        sequence,
        type,
        createdAt,
      }),
    })
    add('stale-active', 0, 'turn.started', 100)
    add('stale-terminal', 0, 'turn.started', 200)
    add('stale-terminal', 1, 'turn.completed', 201)
    for (const [turnId, createdAt] of [['recent-1', 850], ['recent-2', 900], ['recent-3', 950]]) {
      add(turnId, 0, 'turn.started', createdAt)
      add(turnId, 1, 'turn.completed', createdAt + 1)
    }
    add('recent-active', 0, 'turn.started', 975)

    const pruned = pruneTurnEvents({
      userId: 'u2',
      now: 1_000,
      retentionMs: 500,
      maxTerminalTurnsPerUser: 2,
    })
    assert.deepEqual(pruned, { turnsDeleted: 3, eventsDeleted: 5 })
    assert.deepEqual(listTurnEvents({ userId: 'u2', sessionId: 'retention-session', turnId: 'stale-active' }), [])
    assert.deepEqual(listTurnEvents({ userId: 'u2', sessionId: 'retention-session', turnId: 'stale-terminal' }), [])
    assert.deepEqual(listTurnEvents({ userId: 'u2', sessionId: 'retention-session', turnId: 'recent-1' }), [])
    assert.equal(listTurnEvents({ userId: 'u2', sessionId: 'retention-session', turnId: 'recent-2' }).length, 2)
    assert.equal(listTurnEvents({ userId: 'u2', sessionId: 'retention-session', turnId: 'recent-3' }).length, 2)
    assert.equal(listTurnEvents({ userId: 'u2', sessionId: 'retention-session', turnId: 'recent-active' }).length, 1)
  } finally { closeDb(); process.env.APP_DB_PATH = oldPath; rmSync(dir, { recursive: true, force: true }) }
})
