import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { createTurnStartRuntime } from '../server/services/turnStartRuntime.js'

function createEmitterFactory({ calls, fail = null } = {}) {
  const emitters = []
  const createEmitter = (scope) => {
    const emit = async (type, payload, options = {}) => {
      calls?.push(`emit:${type}`)
      if (fail) throw fail
      const event = {
        ...scope,
        id: `${scope.turnId}:event:0`,
        sequence: 0,
        type,
        payload,
        createdAt: 1700000000000,
      }
      if (typeof options.commitEvent === 'function') {
        await options.commitEvent({ event })
      }
      return event
    }
    emit.closed = false
    emit.close = async () => {
      emit.closed = true
      calls?.push('emitter:close')
    }
    emitters.push(emit)
    return emit
  }
  return { createEmitter, emitters }
}

function createPorts(overrides = {}) {
  const calls = overrides.calls || []
  const emitterFactory = overrides.emitterFactory || createEmitterFactory({ calls })
  return {
    calls,
    emitterFactory,
    ports: {
      readSession: async () => ({ id: 'session-1', userId: 'user-1' }),
      sessionIdOccupied: async () => false,
      claimLegacySession: async () => null,
      lastEvent: async () => null,
      resolveModelBinding: async () => ({
        modelName: 'model-1',
        modelProviderId: 'provider-1',
        modelConfigRevision: 7,
        env: { MODEL_NAME: 'model-1' },
      }),
      now: () => 1700000000000,
      writeSession: async (session) => session,
      readMessages: async () => [],
      writeMessage: async () => {},
      removeMessage: async () => {},
      validateAttachments: async () => [],
      bindAttachments: async () => {},
      createEmitter: emitterFactory.createEmitter,
      ...overrides.ports,
    },
  }
}

const BASE_INPUT = Object.freeze({
  userId: 'user-1',
  sessionId: 'session-1',
  turnId: 'turn-1',
  content: 'hello',
})

test('turn start rejects a foreign occupied session before model readiness or durable writes', async () => {
  let modelReads = 0
  let durableWrites = 0
  const { ports, emitterFactory } = createPorts({
    ports: {
      readSession: async () => null,
      sessionIdOccupied: async () => true,
      resolveModelBinding: async () => {
        modelReads += 1
        throw new Error('must not run')
      },
      writeSession: async () => { durableWrites += 1 },
      writeMessage: async () => { durableWrites += 1 },
      commitTurnStart: async () => { durableWrites += 1 },
    },
  })
  const runtime = createTurnStartRuntime(ports)

  await assert.rejects(
    runtime.initialize(BASE_INPUT),
    (error) => error?.code === 'SESSION_NOT_FOUND' && error?.status === 404,
  )
  assert.equal(modelReads, 0)
  assert.equal(durableWrites, 0)
  assert.equal(emitterFactory.emitters.length, 0)
})

test('turn start leaves no durable state when model readiness fails', async () => {
  let durableWrites = 0
  const readinessError = Object.assign(new Error('Provider is not configured'), {
    code: 'MODEL_PROVIDER_NOT_CONFIGURED',
  })
  const { ports, emitterFactory } = createPorts({
    ports: {
      readSession: async () => null,
      resolveModelBinding: async () => { throw readinessError },
      writeSession: async () => { durableWrites += 1 },
      writeMessage: async () => { durableWrites += 1 },
      commitTurnStart: async () => { durableWrites += 1 },
    },
  })

  await assert.rejects(createTurnStartRuntime(ports).initialize(BASE_INPUT), readinessError)
  assert.equal(durableWrites, 0)
  assert.equal(emitterFactory.emitters.length, 0)
})

test('turn start validates and persists its effective project directory before durable writes', async () => {
  let aggregate = null
  const { ports } = createPorts({
    ports: {
      resolveProjectDirectory: async ({ userId, workspacePath }) => {
        assert.equal(userId, 'user-1')
        assert.equal(workspacePath, 'C:\\Selected')
        return {
          workspacePath: 'C:\\Canonical',
          projectDirectory: 'C:\\Canonical',
          defaultOutputDirectory: 'C:\\Canonical',
        }
      },
      commitTurnStart: async (command) => { aggregate = command },
    },
  })

  const result = await createTurnStartRuntime(ports).initialize({
    ...BASE_INPUT,
    workspacePath: 'C:\\Selected',
  })

  assert.equal(aggregate.event.payload.workspacePath, 'C:\\Canonical')
  assert.equal(aggregate.event.payload.projectDirectory, 'C:\\Canonical')
  assert.equal(result.execution.projectDirectory, 'C:\\Canonical')
  assert.equal(result.execution.defaultOutputDirectory, 'C:\\Canonical')
  await result.emitter.close()
})

test('turn start leaves no durable state when workspace validation fails', async () => {
  let durableWrites = 0
  const workspaceError = Object.assign(new Error('workspace authorization expired'), {
    code: 'TURN_WORKSPACE_NOT_AUTHORIZED',
    statusCode: 403,
  })
  const { ports, emitterFactory } = createPorts({
    ports: {
      resolveProjectDirectory: async () => { throw workspaceError },
      writeSession: async () => { durableWrites += 1 },
      writeMessage: async () => { durableWrites += 1 },
      commitTurnStart: async () => { durableWrites += 1 },
    },
  })

  await assert.rejects(
    createTurnStartRuntime(ports).initialize({ ...BASE_INPUT, workspacePath: 'C:\\Denied' }),
    workspaceError,
  )
  assert.equal(durableWrites, 0)
  assert.equal(emitterFactory.emitters.length, 0)
})

for (const [label, code] of [
  ['stale model configuration revision', 'MODEL_CONFIG_REVISION_STALE'],
  ['unconfigured model provider', 'MODEL_PROVIDER_NOT_CONFIGURED'],
  ['model provider drift', 'TURN_MODEL_BINDING_DRIFT'],
]) {
  test(`local legacy turn start leaves ownership and outbox untouched for ${label}`, async () => {
    const calls = []
    const preflightError = Object.assign(new Error(label), { code })
    const { ports, emitterFactory } = createPorts({
      calls,
      ports: {
        readSession: async () => {
          calls.push('session:read')
          return null
        },
        sessionIdOccupied: async () => {
          calls.push('session:occupied')
          return true
        },
        claimLegacySession: async () => {
          calls.push('session:claim')
          return { id: 'session-1', userId: 'user-1' }
        },
        lastEvent: async () => {
          calls.push('event:read')
          return null
        },
        resolveModelBinding: async () => {
          calls.push('model:resolve')
          throw preflightError
        },
        writeSession: async () => calls.push('session:write'),
        writeMessage: async () => calls.push('message:write'),
        bindAttachments: async () => calls.push('attachments:bind'),
        commitTurnStart: async () => calls.push('aggregate:commit'),
      },
    })

    await assert.rejects(
      createTurnStartRuntime(ports).initialize({ ...BASE_INPUT, authMode: 'local' }),
      preflightError,
    )
    assert.deepEqual(calls, [
      'session:read',
      'session:occupied',
      'model:resolve',
    ])
    assert.equal(emitterFactory.emitters.length, 0)
  })
}

test('local occupied session is claimed only after model preflight and remains fail-closed', async () => {
  const calls = []
  const { ports, emitterFactory } = createPorts({
    calls,
    ports: {
      readSession: async () => {
        calls.push('session:read')
        return null
      },
      sessionIdOccupied: async () => {
        calls.push('session:occupied')
        return true
      },
      resolveModelBinding: async () => {
        calls.push('model:resolve')
        return {
          modelName: 'model-1',
          modelProviderId: 'provider-1',
          modelConfigRevision: 7,
          env: { MODEL_NAME: 'model-1' },
        }
      },
      claimLegacySession: async () => {
        calls.push('session:claim')
        return null
      },
      lastEvent: async () => {
        calls.push('event:read')
        return null
      },
      writeSession: async () => calls.push('session:write'),
      writeMessage: async () => calls.push('message:write'),
      commitTurnStart: async () => calls.push('aggregate:commit'),
    },
  })

  await assert.rejects(
    createTurnStartRuntime(ports).initialize({ ...BASE_INPUT, authMode: 'local' }),
    (error) => error?.code === 'SESSION_NOT_FOUND' && error?.status === 404,
  )
  assert.deepEqual(calls, [
    'session:read',
    'session:occupied',
    'model:resolve',
    'session:claim',
  ])
  assert.equal(emitterFactory.emitters.length, 0)
})

test('local legacy session claim completes before turn event lookup and persistence', async () => {
  const calls = []
  const claimedSession = { id: 'session-1', userId: 'user-1' }
  const { ports } = createPorts({
    calls,
    ports: {
      readSession: async () => {
        calls.push('session:read')
        return claimedSession
      },
      sessionIdOccupied: async () => {
        calls.push('session:occupied')
        return true
      },
      resolveModelBinding: async () => {
        calls.push('model:resolve')
        return {
          modelName: 'model-1',
          modelProviderId: 'provider-1',
          modelConfigRevision: 7,
          env: { MODEL_NAME: 'model-1' },
        }
      },
      claimLegacySession: async () => {
        calls.push('session:claim')
        return claimedSession
      },
      lastEvent: async () => {
        calls.push('event:read')
        return null
      },
      readMessages: async () => {
        calls.push('messages:read')
        return []
      },
      commitTurnStart: async () => calls.push('aggregate:commit'),
    },
  })
  let firstRead = true
  ports.readSession = async () => {
    calls.push('session:read')
    if (firstRead) {
      firstRead = false
      return null
    }
    return claimedSession
  }

  const result = await createTurnStartRuntime(ports).initialize({
    ...BASE_INPUT,
    authMode: 'local',
  })

  assert.deepEqual(calls, [
    'session:read',
    'session:occupied',
    'model:resolve',
    'session:claim',
    'event:read',
    'messages:read',
    'emit:turn.started',
    'aggregate:commit',
    'session:read',
  ])
  await result.emitter.close()
})

test('turn start commits the complete atomic aggregate before returning execution context', async () => {
  const calls = []
  let session = null
  let aggregate = null
  let directWrites = 0
  const { ports, emitterFactory } = createPorts({
    calls,
    ports: {
      readSession: async () => {
        calls.push('session:read')
        return session
      },
      sessionIdOccupied: async () => {
        calls.push('session:occupied')
        return false
      },
      lastEvent: async () => {
        calls.push('event:read')
        return null
      },
      resolveModelBinding: async () => {
        calls.push('model:resolve')
        return {
          modelName: 'resolved-model',
          modelProviderId: 'resolved-provider',
          modelConfigRevision: 9,
          env: { MODEL_NAME: 'resolved-model' },
        }
      },
      validateAttachments: async ({ attachmentIds }) => {
        calls.push('attachments:validate')
        return attachmentIds.map((id) => ({ id, name: `${id}.txt` }))
      },
      readMessages: async () => {
        calls.push('messages:read')
        return []
      },
      writeSession: async () => { directWrites += 1 },
      writeMessage: async () => { directWrites += 1 },
      bindAttachments: async () => { directWrites += 1 },
      commitTurnStart: async (command) => {
        calls.push('aggregate:commit')
        aggregate = command
        session = command.session
      },
    },
  })
  const runtime = createTurnStartRuntime(ports)
  const result = await runtime.initialize({
    ...BASE_INPUT,
    content: 'inspect this',
    attachments: [{ id: 'attachment-1' }],
    approvalMode: 'acceptEdits',
  })

  assert.equal(directWrites, 0)
  assert.deepEqual(calls, [
    'session:read',
    'session:occupied',
    'event:read',
    'model:resolve',
    'attachments:validate',
    'messages:read',
    'emit:turn.started',
    'aggregate:commit',
    'session:read',
  ])
  assert.deepEqual(aggregate.session, {
    id: 'session-1',
    userId: 'user-1',
    title: 'inspect this',
    createdAt: 1700000000000,
  })
  assert.equal(aggregate.messages.length, 1)
  assert.equal(aggregate.messages[0].id, 'turn-1:user')
  assert.deepEqual(aggregate.attachmentBinding.attachmentIds, ['attachment-1'])
  assert.equal(aggregate.event.type, 'turn.started')
  assert.equal(result.execution.modelName, 'resolved-model')
  assert.equal(result.execution.approvalMode, 'acceptEdits')
  assert.deepEqual(result.scope, {
    userId: 'user-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
  })
  assert.equal(Object.hasOwn(result.execution, 'adapter'), false)
  assert.equal(Object.hasOwn(result.execution, 'store'), false)
  await result.emitter.close()
  assert.equal(emitterFactory.emitters[0].closed, true)
})

for (const [locale, expectedPrompt] of [
  ['zh', '请分析附件内容。'],
  ['en-US', 'Please analyze the attached content.'],
]) {
  test(`attachment-only turn start persists its ${locale} prompt consistently`, async () => {
    let aggregate = null
    const { ports } = createPorts({
      ports: {
        validateAttachments: async ({ attachmentIds }) => (
          attachmentIds.map((id) => ({ id, name: `${id}.txt` }))
        ),
        commitTurnStart: async (command) => { aggregate = command },
      },
    })

    const result = await createTurnStartRuntime(ports).initialize({
      ...BASE_INPUT,
      content: '',
      locale,
      attachments: [{ id: 'attachment-1' }],
    })

    assert.equal(aggregate.event.payload.content, expectedPrompt)
    assert.equal(aggregate.event.payload.displayContent, expectedPrompt)
    assert.equal(aggregate.event.payload.locale, locale === 'zh' ? 'zh' : 'en')
    assert.equal(aggregate.messages[0].content, expectedPrompt)
    assert.equal(aggregate.messages[0].modelContext.modelContent, expectedPrompt)
    assert.equal(result.execution.content, expectedPrompt)
    await result.emitter.close()
  })
}

test('turn start preserves skill-prefix and imported tool protocol in the atomic command', async () => {
  let aggregate = null
  const { ports } = createPorts({
    ports: {
      commitTurnStart: async (command) => { aggregate = command },
    },
  })
  const result = await createTurnStartRuntime(ports).initialize({
    ...BASE_INPUT,
    content: '/review inspect this',
    history: [
      { role: 'assistant', content: 'calling', tool_calls: [{ id: 'call-1' }] },
      { role: 'tool', content: 'done', tool_call_id: 'call-1', name: 'read_file' },
      { role: 'tool', content: 'legacy tool output' },
    ],
  })

  assert.equal(aggregate.event.payload.content, 'inspect this')
  assert.equal(aggregate.event.payload.displayContent, '/review inspect this')
  assert.deepEqual(aggregate.event.payload.skillIds, ['review'])
  assert.equal(aggregate.event.payload.importedHistoryCount, 3)
  assert.deepEqual(aggregate.messages[0].modelContext, {
    version: 1,
    toolCalls: [{ id: 'call-1' }],
  })
  assert.deepEqual(aggregate.messages[1].modelContext, {
    version: 1,
    toolCallId: 'call-1',
    name: 'read_file',
  })
  assert.equal(aggregate.messages[1].content, '[历史工具结果]\ndone')
  assert.equal(aggregate.messages[2].role, 'system')
  assert.equal(result.execution.content, 'inspect this')
  await result.emitter.close()
})

test('turn start awaits attachment binding and compensates staged messages in reverse order', async () => {
  const calls = []
  const bindError = Object.assign(new Error('attachment binding failed'), {
    code: 'ATTACHMENT_BIND_FAILED',
    statusCode: 409,
  })
  const { ports, emitterFactory } = createPorts({
    calls,
    ports: {
      writeMessage: async (message) => calls.push(`write:${message.id}`),
      removeMessage: async ({ messageId }) => calls.push(`remove:${messageId}`),
      bindAttachments: async () => {
        await Promise.resolve()
        throw bindError
      },
    },
  })

  await assert.rejects(
    createTurnStartRuntime(ports).initialize({
      ...BASE_INPUT,
      history: [{ role: 'user', content: 'old request' }],
    }),
    (error) => error?.code === 'ATTACHMENT_BIND_FAILED'
      && error?.status === 409
      && error?.cause === bindError,
  )
  assert.deepEqual(calls, [
    'write:turn-1:history:0',
    'write:turn-1:user',
    'remove:turn-1:user',
    'remove:turn-1:history:0',
  ])
  assert.equal(emitterFactory.emitters.length, 0)
})

test('turn start closes the emitter and compensates legacy messages when event append fails', async () => {
  const calls = []
  const appendError = new Error('event append failed')
  const emitterFactory = createEmitterFactory({ calls, fail: appendError })
  const { ports } = createPorts({
    calls,
    emitterFactory,
    ports: {
      writeMessage: async (message) => calls.push(`write:${message.id}`),
      removeMessage: async ({ messageId }) => calls.push(`remove:${messageId}`),
    },
  })

  await assert.rejects(createTurnStartRuntime(ports).initialize(BASE_INPUT), appendError)
  assert.equal(emitterFactory.emitters[0].closed, true)
  assert.deepEqual(calls, [
    'write:turn-1:user',
    'emit:turn.started',
    'emitter:close',
    'remove:turn-1:user',
  ])
})

test('turn start runtime has no database, store, adapter, or persistence imports', () => {
  const source = readFileSync(fileURLToPath(
    new URL('../server/services/turnStartRuntime.js', import.meta.url),
  ), 'utf8')
  const imports = [...source.matchAll(/^import\s.+?from\s+['"](.+?)['"]/gm)]
    .map((match) => match[1])
    .join('\n')

  assert.doesNotMatch(
    imports,
    /(?:^|\/)(?:adapters|sqlite|database|sessionStore|turnEventStore|turnPersistenceAdapter)(?:\/|\.|$)/i,
  )
})
