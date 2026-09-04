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
const { setApprovalMode } = await import('../server/services/approvalSettingsStore.js')
const { TurnEngine } = await import('../server/services/TurnEngine.js')
const { TURN_ENGINE_FLAT_PERSISTENCE_OPTIONS } = await import('../server/services/turnEnginePersistenceBundle.js')
const { createTurnExecutionEnvironmentSnapshot } = await import('../server/services/turnExecutionEnvironment.js')
const { SERVER_TOOL_SPECS } = await import('../server/services/toolLoopRuntime.js')
const { resolveChatCapabilityMode } = await import('../server/services/chatToolSelection.js')
const { createTurnExecutionLeaseCoordinator } = await import('../server/services/turnExecutionLeaseRuntime.js')
const { resolveAgentModelRuntimeBinding } = await import('../server/services/modelReadinessService.js')
const {
  recordModelProviderReadiness,
  upsertModelProvider,
} = await import('../server/services/modelProviderStore.js')
const { getMessage, getSession, listMessages, upsertMessage, upsertSession } = await import('../server/services/sessionStore.js')
const {
  buildCompaction,
  createCompactionArchive,
  validateCompactCheckpointSource,
  validateToolCallChain,
} = await import('../server/services/compactionService.js')
const { prepareTurnPromptContext } = await import('../server/services/turnPromptContext.js')
const { appendTurnEvent, appendTurnEvents, listTurnEvents } = await import('../server/services/turnEventStore.js')
const { createEventWriteBehind } = await import('../server/services/eventWriteBehind.js')
const { getTurnCheckpoint } = await import('../server/services/turnCheckpointStore.js')
const { getTurnRecoveryState } = await import('../server/services/turnRecoveryStateStore.js')
const { createTurnEvent } = await import('../shared/turnEvents.js')
const {
  INLINE_SKILL_DEFINITION_LIMITS,
  unicodeCharacterLength,
  utf8ByteLength,
} = await import('../shared/inlineSkillDefinitions.js')
const { createTestTurnEnginePersistence } = await import('./helpers/turnEnginePersistence.js')
const { activateTestCompactionArchivePort } = await import('./helpers/testCompactionArchivePort.js')

const compactionArchiveController = activateTestCompactionArchivePort({
  source: 'test.turn-engine',
})

const userId = 'turn-engine-user'
createUser({ id: userId, email: 'turn-engine@example.com' })
upsertSession({ id: 'turn-engine-session', userId, title: 'Turn engine' })

test.after(() => {
  compactionArchiveController.release()
  closeDb()
  fs.rmSync(tempDir, { recursive: true, force: true })
})

test('TurnEngine exposes only structured recovery metadata for unknown side effects', async () => {
  const turnId = `turn-side-effect-unknown-${Date.now()}`
  const toolCallId = `${turnId}-write`
  let loopCalls = 0
  const engine = createTestEngine({
    runLoop: async () => {
      loopCalls += 1
      throw Object.assign(new Error('internal side-effect detail'), {
        code: 'SIDE_EFFECT_OUTCOME_UNKNOWN',
        retryable: false,
        unsafeToReplay: true,
        requiresUserVerification: true,
        sideEffectExecution: {
          ownerId: 'private-owner',
          toolCallId,
          args: { content: 'private-args' },
          outcome: { receipt: 'private-outcome' },
          note: 'private-note',
        },
      })
    },
  })

  await engine.startTurn({
    userId,
    sessionId: 'turn-engine-session',
    turnId,
    content: 'perform one durable operation',
  })
  await engine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId })

  const blocked = events(turnId).at(-1)
  assert.equal(blocked.type, 'turn.blocked')
  assert.equal(blocked.payload.turnId, turnId)
  assert.equal(blocked.payload.toolCallId, toolCallId)
  assert.equal(blocked.payload.requiresUserVerification, true)
  assert.equal(blocked.payload.recoveryKind, 'side_effect_outcome_unknown')
  assert.equal(blocked.payload.retryable, false)
  assert.equal(events(turnId).some((event) => event.type === 'turn.failed'), false)
  assert.doesNotMatch(
    JSON.stringify(blocked.payload),
    /private-owner|private-args|private-outcome|private-note|sideEffectExecution/u,
  )
  const blockedEvidence = listMessages({ userId, sessionId: 'turn-engine-session', limit: 500 })
    .find((message) => message.id === `${turnId}:assistant`)
  assert.equal(blockedEvidence?.modelContext?.turnEvidence, true)
  assert.equal(blockedEvidence?.modelContext?.evidenceState, 'blocked')
  assert.equal(blockedEvidence?.modelContext?.serverLastSequence, blocked.sequence)
  assert.equal(blockedEvidence?.content, '')
  assert.equal(blocked.payload.partialText, '')
  assert.deepEqual(blockedEvidence?.modelContext?.recovery, {
    recoveryKind: 'side_effect_outcome_unknown',
    requiresUserVerification: true,
    toolCallId,
    recoveryAction: { kind: 'open_settings', path: '/settings?tab=recovery' },
  })
  assert.doesNotMatch(
    JSON.stringify(blockedEvidence?.modelContext),
    /private-owner|private-args|private-outcome|private-note|sideEffectExecution/u,
  )
  await assert.rejects(
    engine.resumeTurn({ userId, sessionId: 'turn-engine-session', turnId }),
    (error) => error?.code === 'TURN_RECOVERY_DEAD_LETTER',
  )
  assert.equal(loopCalls, 1)
})

test('TurnEngine does not reopen an ordinary failed turn for blocked-recovery retry', async () => {
  const turnId = `turn-ordinary-failed-${Date.now()}`
  let loopCalls = 0
  const engine = createTestEngine({
    runLoop: async () => {
      loopCalls += 1
      throw new Error('ordinary turn failure')
    },
  })

  await engine.startTurn({
    userId,
    sessionId: 'turn-engine-session',
    turnId,
    content: 'fail normally',
  })
  await engine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId })
  assert.equal(events(turnId).at(-1)?.type, 'turn.failed')

  const terminal = await engine.resumeTurn({
    userId,
    sessionId: 'turn-engine-session',
    turnId,
    retryRecovery: true,
  })
  assert.equal(terminal.status, 'failed')
  assert.equal(loopCalls, 1)
})

test('TurnEngine rejects failed retry mixed with recovery or resolution controls', async () => {
  const engine = createTestEngine()
  const base = {
    userId,
    sessionId: 'turn-engine-session',
    turnId: 'turn-failed-retry-invalid-controls',
    retryFailed: true,
  }
  await assert.rejects(
    engine.resumeTurn({ ...base, retryRecovery: true }),
    (error) => error?.code === 'TURN_FAILED_RETRY_REQUEST_INVALID' && error?.status === 400,
  )
  await assert.rejects(
    engine.resumeTurn({ ...base, resolution: { type: 'approval', decision: 'allow' } }),
    (error) => error?.code === 'TURN_FAILED_RETRY_REQUEST_INVALID' && error?.status === 400,
  )
})

function events(turnId, requestedUser = userId) {
  return listTurnEvents({ requestedUser, userId: requestedUser, sessionId: 'turn-engine-session', turnId, limit: 2000 })
}

function appendLegacyTurnEvent({ userId: eventUserId, event }) {
  getDb().prepare(`
    INSERT INTO turn_events
      (id, user_id, session_id, turn_id, sequence, type, payload_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.id,
    eventUserId,
    event.sessionId,
    event.turnId,
    event.sequence,
    event.type,
    JSON.stringify(event.payload),
    event.createdAt,
  )
  return event
}

function createTestEngine(options = {}, { legacyPersistence = false } = {}) {
  const usesLegacyPersistence = legacyPersistence
    || Object.hasOwn(options, 'persistence')
    || TURN_ENGINE_FLAT_PERSISTENCE_OPTIONS.some((key) => Object.hasOwn(options, key))
  const needsAtomicBatchFixture = Object.hasOwn(options, 'appendEvent')
    && !Object.hasOwn(options, 'appendEventBatch')
    && !Object.hasOwn(options, 'eventWriteBehindFactory')
  return new TurnEngine({
    scheduleMemoryExtraction: () => {},
    ...(usesLegacyPersistence ? {} : { persistence: createTestTurnEnginePersistence() }),
    ...(needsAtomicBatchFixture ? {
      eventWriteBehindFactory: () => createEventWriteBehind({
        writeBatch: appendTurnEvents,
        writeBatchSync: appendTurnEvents,
        maxDelayMs: 10_000,
      }),
    } : {}),
    ...options,
  })
}

const checkpointReadToolSpec = SERVER_TOOL_SPECS.find((spec) => spec?.function?.name === 'read_file')
const CHECKPOINT_TOOL_IMPLEMENTATIONS = Object.freeze({
  version: 1,
  builtinRevision: `sha256-${'a'.repeat(64)}`,
  connectorRevision: null,
  mcpTools: [],
})
const CHECKPOINT_POLICY_PROVENANCE = Object.freeze({
  id: 'builtin.harness-policy',
  owner: 'builtin',
  version: '0.11.31',
  revision: 1,
  releaseDigest: null,
  source: 'registry_default',
})

function checkpointEnvironment({
  modelName = null,
  toolSpecs = [],
  toolImplementations = CHECKPOINT_TOOL_IMPLEMENTATIONS,
  fileAccess = { grants: [] },
} = {}) {
  return createTurnExecutionEnvironmentSnapshot({
    modelName,
    approvalMode: 'normal',
    policy: CHECKPOINT_POLICY_PROVENANCE,
    toolsConfig: { enabled: [], disabled: [] },
    toolSpecs,
    toolImplementations,
    fileAccess,
    runtimePlugins: [],
    runtimePluginStates: [],
  })
}

function checkpointEnvironmentEngineOptions(toolSpecs = [], fileAccess = { grants: [] }) {
  return {
    toolSpecs,
    readApprovalMode: () => 'normal',
    readRuntimePolicyProvenance: () => CHECKPOINT_POLICY_PROVENANCE,
    readFileAccessStatus: () => fileAccess,
    readRuntimePlugins: () => [],
    readRuntimePluginStates: () => [],
    resolveToolSpecs: async () => toolSpecs,
    resolveToolImplementationRevisions: () => CHECKPOINT_TOOL_IMPLEMENTATIONS,
  }
}

function readOnlyDirectoryAccessStatus(id, rootPath = tempDir) {
  return {
    projectDirectory: rootPath,
    defaultOutputDirectory: rootPath,
    grants: [{
      id,
      path: rootPath,
      resourceType: 'directory',
      accessMode: 'read_only',
      scope: 'session',
      available: true,
    }],
    workspace: { enabled: false },
    runtime: { localCodeExecutionEnabled: false },
  }
}

test('TurnEngine rejects an ambiguous model name and accepts an explicit Provider UUID', async () => {
  const modelName = `turn-ambiguous-model-${Date.now()}`
  const providers = ['turn-ambiguous-a', 'turn-ambiguous-b'].map((key) => upsertModelProvider({
    userId,
    provider: {
      key,
      label: key,
      baseUrl: `https://${key}.example.test/v1`,
      models: [modelName],
      defaultModel: modelName,
      enabled: true,
    },
  }))
  for (const provider of providers) {
    recordModelProviderReadiness({
      userId,
      id: provider.id,
      readiness: { chat: true, tools: true, agent: true, mode: 'agent' },
    })
  }
  const engine = createTestEngine({
    resolveModelBinding: resolveAgentModelRuntimeBinding,
    runLoop: async () => ({ text: 'explicit UUID accepted', artifactIds: [], iterations: 0 }),
  })

  await assert.rejects(
    engine.startTurn({
      userId,
      sessionId: 'turn-engine-session',
      turnId: 'turn-ambiguous-provider',
      content: 'do not choose a provider silently',
      modelName,
    }),
    (error) => error?.code === 'MODEL_PROVIDER_AMBIGUOUS'
      && error?.statusCode === 409
      && error?.modelName === modelName,
  )
  assert.deepEqual(events('turn-ambiguous-provider'), [])
  assert.equal(
    listMessages({ userId, sessionId: 'turn-engine-session' })
      .some((message) => message.id?.startsWith('turn-ambiguous-provider:')),
    false,
  )

  await engine.startTurn({
    userId,
    sessionId: 'turn-engine-session',
    turnId: 'turn-explicit-provider-uuid',
    content: 'use the selected provider',
    modelName,
    modelProviderId: providers[1].id,
    locale: 'zh-CN',
  })
  await engine.waitForTurn({
    userId,
    sessionId: 'turn-engine-session',
    turnId: 'turn-explicit-provider-uuid',
  })
  const started = events('turn-explicit-provider-uuid').find((event) => event.type === 'turn.started')
  assert.equal(started.payload.modelProviderId, providers[1].id)
  assert.equal(started.payload.modelName, modelName)
  assert.equal(started.payload.locale, 'zh')
})

test('TurnEngine persists chat-only mode and never exposes tools to the loop', async () => {
  const turnId = `turn-chat-only-${Date.now()}`
  const bindingCalls = []
  let loopOptions = null
  let modelRequest = null
  let toolResolutionCalls = 0
  const engine = createTestEngine({
    toolSpecs: [checkpointReadToolSpec],
    resolveModelBinding: (options) => {
      bindingCalls.push(options)
      return {
        providerId: 'chat-only-provider',
        modelName: 'chat-only-model',
        configRevision: 7,
        env: { MODEL_NAME: 'chat-only-model' },
      }
    },
    resolveToolSpecs: async () => {
      toolResolutionCalls += 1
      return [checkpointReadToolSpec]
    },
    runModel: async (request) => {
      modelRequest = request
      return { content: 'chat response', toolCalls: [], finishReason: 'stop' }
    },
    runLoop: async (options) => {
      loopOptions = options
      await options.runModel({
        messages: [{ role: 'user', content: 'answer without tools' }],
        tools: [checkpointReadToolSpec],
        toolChoice: 'auto',
      })
      await assert.rejects(
        options.executeTool({ name: 'read_file', arguments: '{}' }),
        (error) => error?.code === 'CHAT_ONLY_TOOL_EXECUTION_FORBIDDEN'
          && error?.unsafeToReplay === true,
      )
      return { text: 'chat response', artifactIds: [], iterations: 0 }
    },
  })

  await engine.startTurn({
    userId,
    sessionId: 'turn-engine-session',
    turnId,
    content: 'answer without tools',
    modelName: 'chat-only-model',
    modelProviderId: 'chat-only-provider',
    modelMode: 'chat_only',
  })
  await engine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId })

  const started = events(turnId).find((event) => event.type === 'turn.started')
  assert.equal(started?.payload.modelMode, 'chat_only')
  assert.equal(bindingCalls[0]?.modelMode, 'chat_only')
  assert.equal(toolResolutionCalls, 0)
  assert.deepEqual(loopOptions?.toolSpecs, [])
  assert.deepEqual(loopOptions?.fallbackToolSpecs, [])
  assert.deepEqual(loopOptions?.toolsConfig, { enabled: [], disabled: [] })
  assert.equal(loopOptions?.intentMode, 'answer')
  assert.equal(loopOptions?.job?.modelMode, 'chat_only')
  assert.deepEqual(modelRequest?.tools, [])
  assert.equal(modelRequest?.toolChoice, 'none')
})

test('TurnEngine restores persisted chat-only mode without remounting tools', async () => {
  const turnId = `turn-chat-only-resume-${Date.now()}`
  appendTurnEvent({
    userId,
    event: createTurnEvent({
      id: `${turnId}:0`,
      sessionId: 'turn-engine-session',
      turnId,
      sequence: 0,
      type: 'turn.started',
      payload: {
        content: 'resume without tools',
        modelName: 'chat-only-model',
        modelProviderId: 'chat-only-provider',
        modelConfigRevision: 7,
        modelMode: 'chat_only',
      },
      createdAt: Date.now(),
    }),
  })
  const bindingCalls = []
  let loopOptions = null
  const engine = createTestEngine({
    toolSpecs: [checkpointReadToolSpec],
    resolveModelBinding: (options) => {
      bindingCalls.push(options)
      return {
        providerId: 'chat-only-provider',
        modelName: 'chat-only-model',
        configRevision: 7,
        env: { MODEL_NAME: 'chat-only-model' },
      }
    },
    resolveToolSpecs: async () => {
      throw new Error('chat-only recovery must not resolve tools')
    },
    runLoop: async (options) => {
      loopOptions = options
      return { text: 'resumed chat response', artifactIds: [], iterations: 0 }
    },
  })

  await engine.resumeTurn({ userId, sessionId: 'turn-engine-session', turnId })
  await engine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId })

  assert.equal(bindingCalls[0]?.modelMode, 'chat_only')
  assert.equal(bindingCalls[0]?.requirePersistedBinding, true)
  assert.deepEqual(loopOptions?.toolSpecs, [])
  assert.deepEqual(loopOptions?.fallbackToolSpecs, [])
  assert.equal(events(turnId).at(-1)?.type, 'turn.completed')
})

test('TurnEngine exposes recovery diagnostics and requires an explicit dead-letter retry', async () => {
  const scope = { userId, sessionId: 'turn-engine-session', turnId: 'turn-recovery-dead-letter' }
  const lastEvent = createTurnEvent({
    id: 'turn-recovery-dead-letter:0',
    sessionId: scope.sessionId,
    turnId: scope.turnId,
    sequence: 0,
    type: 'turn.started',
    payload: { content: 'recover me' },
    createdAt: 1,
  })
  let recoveryState = {
    ...scope,
    candidateVersion: '0:turn.started:1',
    status: 'dead_letter',
    attemptCount: 5,
    retryable: true,
    manualRetryable: false,
    firstFailedAt: 10,
    lastFailedAt: 20,
    nextRetryAt: null,
    errorCode: 'UPSTREAM_DOWN',
    errorMessage: 'provider remained unavailable',
  }
  let recoveries = 0
  let clears = 0
  const engine = createTestEngine({
    lastEvent: () => lastEvent,
    readRecoveryState: () => recoveryState,
    clearRecoveryState: () => {
      clears += 1
      recoveryState = null
      return true
    },
  })
  engine.recoverTurn = async () => {
    recoveries += 1
    return {
      turn: { sessionId: scope.sessionId, turnId: scope.turnId, status: 'running' },
      scheduled: true,
      locallyActive: true,
      terminal: false,
    }
  }

  assert.deepEqual((await engine.getTurn(scope)).recovery, {
    status: 'dead_letter',
    attemptCount: 5,
    retryable: true,
    manualRetryable: false,
    firstFailedAt: 10,
    lastFailedAt: 20,
    nextRetryAt: null,
    error: { code: 'UPSTREAM_DOWN', message: 'provider remained unavailable' },
  })
  await assert.rejects(
    engine.resumeTurn(scope),
    (error) => {
      assert.equal(error?.code, 'TURN_RECOVERY_DEAD_LETTER')
      assert.equal(error?.status, 409)
      assert.equal(error?.message, 'provider remained unavailable')
      assert.equal(error?.retryable, false)
      assert.equal(error?.manualRetryable, true)
      assert.equal(error?.incompleteReason, 'recovery_blocked')
      assert.deepEqual(error?.missingRequirements, [
        'execution_environment_repair',
        'explicit_recovery_retry',
      ])
      assert.equal(error?.recovery, recoveryState)
      return true
    },
  )
  assert.equal(recoveries, 0)
  assert.equal(clears, 0)

  const turn = await engine.resumeTurn({ ...scope, retryRecovery: true })
  assert.equal(turn.status, 'running')
  assert.equal(recoveries, 1)
  assert.ok(clears >= 1)
})

test('TurnEngine injects a resolved prompt canary and records its terminal outcome', async () => {
  const turnId = 'turn-prompt-canary'
  const outcomes = []
  const assignment = {
    id: 'canary-assignment-1',
    releaseId: 'canary-release-1',
    variant: 'candidate',
    decisionReason: 'traffic_candidate',
    eligible: true,
    bucket: 3,
    target: 'prompt:workspace-instructions',
    baselineSha256: 'a'.repeat(64),
    observedBaselineSha256: 'a'.repeat(64),
    candidateSha256: 'b'.repeat(64),
    releaseFingerprint: 'c'.repeat(64),
    promptContent: 'Scoped candidate workspace instructions.',
  }
  const modelProviderId = '11111111-1111-4111-8111-111111111111'
  const engine = createTestEngine({
    resolveModelBinding: () => ({
      providerId: modelProviderId,
      modelName: 'canary-model',
      configRevision: 7,
      env: null,
    }),
    resolveCanaryAssignment(input) {
      assert.equal(input.userId, userId)
      assert.equal(input.sessionId, 'turn-engine-session')
      assert.equal(input.turnId, turnId)
      return assignment
    },
    preparePromptContext(input) {
      assert.equal(input.canaryAssignment, assignment)
      return {
        messages: [{ role: 'system', content: assignment.promptContent }],
        effectiveAgentId: null,
        skillIds: [],
        memoryIds: [],
        compactionArchiveId: null,
        compactionBoundary: null,
        canaryAssignment: {
          id: assignment.id,
          releaseId: assignment.releaseId,
          variant: assignment.variant,
          target: assignment.target,
        },
      }
    },
    recordCanaryOutcome(input) { outcomes.push(input) },
    runLoop: async ({ messages }) => {
      assert.equal(messages.some(({ content }) => content === assignment.promptContent), true)
      return { text: 'Canary completed.', artifactIds: [], iterations: 1 }
    },
  })

  await engine.startTurn({
    userId,
    sessionId: 'turn-engine-session',
    turnId,
    content: 'Run the scoped canary.',
    modelProviderId,
    modelName: 'canary-model',
  })
  await engine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId })

  assert.equal(outcomes.length, 1)
  assert.equal(outcomes[0].terminalState, 'completed')
  assert.equal(outcomes[0].turnId, turnId)
  assert.equal(outcomes[0].modelProviderId, modelProviderId)
  assert.equal(outcomes[0].modelName, 'canary-model')
  assert.equal(outcomes[0].modelConfigRevision, 7)
  assert.equal(outcomes[0].evaluationInput, 'Run the scoped canary.')
  assert.equal(outcomes[0].evaluationOutput, 'Canary completed.')
  assert.equal(events(turnId).at(-1).type, 'turn.completed')
})

test('TurnEngine contains asynchronous canary outcome recorder failures', async () => {
  const turnId = 'turn-prompt-canary-recorder-rejection'
  let recorderCalls = 0
  const engine = createTestEngine({
    resolveCanaryAssignment: () => ({
      id: 'canary-assignment-recorder-rejection',
      releaseId: 'canary-release-recorder-rejection',
      variant: 'candidate',
      decisionReason: 'traffic_candidate',
      target: 'prompt:workspace-instructions',
      promptContent: 'Scoped candidate workspace instructions.',
    }),
    preparePromptContext: ({ canaryAssignment }) => ({
      messages: [{ role: 'system', content: canaryAssignment.promptContent }],
      canaryAssignment,
    }),
    recordCanaryOutcome: async () => {
      recorderCalls += 1
      await Promise.resolve()
      throw new Error('injected asynchronous canary recorder failure')
    },
    runLoop: async () => ({ text: 'Completed despite telemetry failure.', artifactIds: [], iterations: 1 }),
  })

  await engine.startTurn({
    userId,
    sessionId: 'turn-engine-session',
    turnId,
    content: 'Contain the canary recorder rejection.',
  })
  await engine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId })

  assert.equal(recorderCalls, 1)
  assert.equal(events(turnId).at(-1).type, 'turn.completed')
})

test('TurnEngine freezes prompt and canary attribution across checkpoint recovery', async () => {
  const turnId = 'turn-prompt-canary-checkpoint-recovery'
  const content = 'Resume the frozen candidate prompt.'
  const candidatePrompt = 'Frozen candidate workspace instructions.'
  const baselinePrompt = 'New baseline instructions that must not replace the checkpoint.'
  const candidateAssignment = {
    id: 'canary-assignment-frozen',
    releaseId: 'canary-release-frozen',
    variant: 'candidate',
    decisionReason: 'traffic_candidate',
    target: 'prompt:workspace-instructions',
    promptContent: candidatePrompt,
  }
  const frozenMessages = [
    { role: 'system', content: candidatePrompt },
    { role: 'user', content },
  ]
  let initialResolverCalls = 0
  const firstEngine = createTestEngine({
    ...checkpointEnvironmentEngineOptions(),
    resolveCanaryAssignment: () => {
      initialResolverCalls += 1
      return candidateAssignment
    },
    preparePromptContext: ({ canaryAssignment }) => {
      assert.equal(canaryAssignment, candidateAssignment)
      return {
        messages: [{ role: 'system', content: candidatePrompt }],
        effectiveAgentId: 'agent-frozen',
        skillIds: ['skill-frozen'],
        memoryIds: ['memory-frozen'],
        pluginPromptBlockIds: ['plugin-frozen:prompt-frozen'],
        canaryAssignment,
      }
    },
    runLoop: async ({ saveCheckpoint }) => {
      await saveCheckpoint({
        messages: frozenMessages,
        toolCalls: [],
        artifactIds: [],
        iterations: 1,
      })
      return {
        interrupted: true,
        code: 'MODEL_HTTP_503',
        reason: 'simulate a process restart after the durable checkpoint',
        artifactIds: [],
        iterations: 1,
      }
    },
  })

  await firstEngine.startTurn({
    userId,
    sessionId: 'turn-engine-session',
    turnId,
    content,
  })
  await firstEngine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId })
  assert.equal(initialResolverCalls, 1)
  assert.equal(events(turnId).at(-1)?.type, 'turn.interrupted')

  const checkpoint = getTurnCheckpoint({
    userId,
    sessionId: 'turn-engine-session',
    turnId,
  })
  assert.deepEqual(checkpoint?.state?.promptContextSnapshot, {
    version: 1,
    effectiveAgentId: 'agent-frozen',
    skillIds: ['skill-frozen'],
    memoryIds: ['memory-frozen'],
    pluginPromptBlockIds: ['plugin-frozen:prompt-frozen'],
    canaryAssignment: {
      id: candidateAssignment.id,
      releaseId: candidateAssignment.releaseId,
      variant: 'candidate',
      decisionReason: 'traffic_candidate',
      target: candidateAssignment.target,
    },
  })

  let recoveryResolverCalls = 0
  let recoveryPromptCalls = 0
  let modelMessages = null
  let toolResolutionMessages = null
  const outcomes = []
  const recoveryEngine = createTestEngine({
    ...checkpointEnvironmentEngineOptions(),
    resolveCanaryAssignment: () => {
      recoveryResolverCalls += 1
      return {
        ...candidateAssignment,
        id: 'canary-assignment-new-baseline',
        releaseId: 'canary-release-new-baseline',
        variant: 'baseline',
        decisionReason: 'traffic_baseline',
        promptContent: baselinePrompt,
      }
    },
    preparePromptContext: () => {
      recoveryPromptCalls += 1
      return {
        messages: [{ role: 'system', content: baselinePrompt }],
        effectiveAgentId: 'agent-new-baseline',
        skillIds: ['skill-new-baseline'],
        memoryIds: [],
        pluginPromptBlockIds: [],
      }
    },
    resolveToolSpecs: async (request) => {
      toolResolutionMessages = request.messages
      return []
    },
    runModel: async (request) => {
      modelMessages = request.messages
      return { content: 'Recovered with the frozen candidate.', toolCalls: [] }
    },
    recordCanaryOutcome: (outcome) => outcomes.push(outcome),
  })

  await recoveryEngine.resumeTurn({ userId, sessionId: 'turn-engine-session', turnId })
  await recoveryEngine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId })

  assert.equal(recoveryResolverCalls, 0)
  assert.equal(recoveryPromptCalls, 0)
  assert.equal(toolResolutionMessages.some(({ content: text }) => text === candidatePrompt), true)
  assert.equal(toolResolutionMessages.some(({ content: text }) => text === baselinePrompt), false)
  assert.equal(modelMessages.some(({ content: text }) => text === candidatePrompt), true)
  assert.equal(modelMessages.some(({ content: text }) => text === baselinePrompt), false)
  assert.equal(outcomes.length, 1)
  assert.equal(outcomes[0].effectiveVariant, 'candidate')
  assert.equal(outcomes[0].decisionReason, 'traffic_candidate')
  assert.equal(events(turnId).at(-1)?.type, 'turn.completed')
  const assistant = listMessages({ userId, sessionId: 'turn-engine-session', limit: 500 })
    .find((message) => message.id === `${turnId}:assistant`)
  assert.deepEqual(assistant?.modelContext?.pluginPromptBlockIds, ['plugin-frozen:prompt-frozen'])
})

test('TurnEngine flushes deferred deltas before tools, checkpoints, and terminal events', async () => {
  const turnId = 'turn-write-behind-barrier'
  const batches = []
  const writer = createEventWriteBehind({
    writeBatch: (entries) => {
      batches.push(entries.map(({ event }) => event.type))
      return appendTurnEvents(entries)
    },
    writeBatchSync: appendTurnEvents,
    maxDelayMs: 10_000,
  })
  const engine = createTestEngine({
    eventWriteBehindFactory: () => writer,
    runLoop: async ({ onModelDelta, onReasoningDelta, onToolStarted, saveCheckpoint }) => {
      await onModelDelta({ text: 'answer', iteration: 0, modelName: 'test' })
      await onReasoningDelta({ text: 'thought', iteration: 0, modelName: 'test' })
      assert.equal(writer.getStats().pending, 2)
      await onToolStarted({ id: 'tool-1', name: 'read_file', args: { path: 'README.md' } })
      assert.equal(writer.getStats().pending, 0)
      await onModelDelta({ text: ' after tool', iteration: 1, modelName: 'test' })
      await saveCheckpoint({ messages: [], artifactIds: [], iterations: 1 })
      return { text: 'answer after tool', artifactIds: [], iterations: 1 }
    },
  })

  await engine.startTurn({ userId, sessionId: 'turn-engine-session', turnId, content: 'run barriers' })
  await engine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId })

  assert.deepEqual(batches, [
    ['assistant.delta', 'reasoning.delta'],
    ['assistant.delta'],
  ])
  const types = events(turnId).map(({ type }) => type)
  assert.ok(types.indexOf('assistant.delta') < types.indexOf('tool.started'))
  assert.ok(types.lastIndexOf('assistant.delta') < types.indexOf('turn.checkpoint'))
  assert.ok(types.indexOf('turn.checkpoint') < types.indexOf('turn.completed'))
})

test('TurnEngine fails closed when deferred delta persistence exhausts its retries', async () => {
  const turnId = 'turn-write-behind-failure'
  let attempts = 0
  let failures = 0
  const writer = createEventWriteBehind({
    writeBatch() {
      attempts += 1
      throw new Error('simulated delta write failure')
    },
    recordFailure({ batch }) { failures += batch.length },
    logger: { error() {} },
    maxDelayMs: 10_000,
  })
  const engine = createTestEngine({
    eventWriteBehindFactory: () => writer,
    runLoop: async ({ onModelDelta }) => {
      await onModelDelta({ text: 'recoverable stream', iteration: 0, modelName: 'test' })
      return { text: 'durable completion', artifactIds: [], iterations: 0 }
    },
  })

  await engine.startTurn({ userId, sessionId: 'turn-engine-session', turnId, content: 'survive write failure' })
  await engine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId })

  assert.equal(attempts, 3)
  assert.equal(failures, 1)
  const turnEvents = events(turnId)
  const failed = turnEvents.at(-1)
  assert.equal(turnEvents.some(({ type }) => type === 'turn.completed'), false)
  assert.equal(failed.type, 'turn.failed')
  assert.equal(failed.payload.code, 'TURN_EVENT_PERSISTENCE_FAILED')
  assert.equal(failed.payload.error.retryable, true)
  assert.deepEqual(failed.payload.error.persistence, {
    failedEventCount: 1,
    blockedEventCount: 0,
    failedEventTypes: ['assistant.delta'],
    firstFailedSequence: 1,
    lastFailedSequence: 1,
    failedAt: failed.payload.error.persistence.failedAt,
  })
  assert.equal(Number.isInteger(failed.payload.error.persistence.failedAt), true)
  assert.equal(Object.hasOwn(failed.payload, 'message'), false)
  assert.equal(Object.hasOwn(failed.payload.error, 'message'), false)
  assert.equal((await engine.getTurn({ userId, sessionId: 'turn-engine-session', turnId })).status, 'failed')
})

test('TurnEngine fails closed when a legacy writer reports failure without rejecting flush', async () => {
  const turnId = 'turn-legacy-write-behind-failure'
  const pending = []
  let failedEvents = 0
  const writer = {
    enqueue(entry) {
      pending.push(entry)
      return entry
    },
    async flush() {
      if (pending.length > 0) failedEvents += pending.splice(0).length
      return {
        failedEvents,
        failedBatches: failedEvents > 0 ? 1 : 0,
        lastError: 'legacy writer exhausted retries',
      }
    },
    async close() {
      return this.flush()
    },
    getStats() {
      return { failedEvents, failedBatches: failedEvents > 0 ? 1 : 0 }
    },
  }
  const engine = createTestEngine({
    eventWriteBehindFactory: () => writer,
    runLoop: async ({ onModelDelta }) => {
      await onModelDelta({ text: 'not durable', iteration: 0, modelName: 'test' })
      return { text: 'must not complete', artifactIds: [], iterations: 0 }
    },
  })

  await engine.startTurn({ userId, sessionId: 'turn-engine-session', turnId, content: 'fail closed' })
  await engine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId })

  const turnEvents = events(turnId)
  assert.equal(turnEvents.some(({ type }) => type === 'turn.completed'), false)
  assert.deepEqual(turnEvents.map(({ type }) => type), ['turn.started', 'turn.failed'])
  assert.equal(turnEvents.at(-1)?.payload?.code, 'TURN_EVENT_PERSISTENCE_FAILED')
  assert.equal(turnEvents.at(-1)?.payload?.error?.persistence?.firstFailedSequence, 1)
  assert.equal((await engine.getTurn({ userId, sessionId: 'turn-engine-session', turnId })).status, 'failed')
})

test('TurnEngine never appends a contradictory failure after a terminal append has an unknown outcome', async () => {
  const turnId = 'turn-terminal-append-unknown'
  const journals = []
  const engine = createTestEngine({
    appendEvent: async (entry) => {
      const stored = appendTurnEvent(entry)
      if (entry.event.type === 'turn.completed') throw new Error('completion acknowledgement lost')
      return stored
    },
    recordEventWriteFailure: (entry) => { journals.push(entry) },
    runLoop: async () => ({ text: 'durable completion', artifactIds: [], iterations: 1 }),
  })

  await engine.startTurn({ userId, sessionId: 'turn-engine-session', turnId, content: 'complete once' })
  await assert.rejects(
    engine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId }),
    (error) => error?.code === 'TURN_TERMINAL_PERSISTENCE_FAILED'
      && error?.terminalEventType === 'turn.completed',
  )

  const turnEvents = events(turnId)
  assert.equal(turnEvents.filter(({ type }) => type === 'turn.completed').length, 1)
  assert.equal(turnEvents.some(({ type }) => type === 'turn.failed'), false)
  assert.equal(listMessages({ userId, sessionId: 'turn-engine-session', limit: 500 })
    .some((message) => message.id === `${turnId}:assistant`), false)
  assert.equal(journals.length, 1)
  assert.equal(journals[0].batch[0].event.type, 'turn.completed')
  assert.equal(journals[0].attempts, 1)
})

test('TurnEngine never retries a failed terminal whose append acknowledgement was lost', async () => {
  const turnId = 'turn-failed-terminal-unknown'
  let failedTerminalAttempts = 0
  const engine = createTestEngine({
    appendEvent: async (entry) => {
      if (entry.event.type === 'turn.failed') failedTerminalAttempts += 1
      const stored = appendTurnEvent(entry)
      if (entry.event.type === 'turn.failed') {
        throw Object.assign(new Error('failed terminal acknowledgement lost'), {
          code: 'TURN_EVENT_PERSISTENCE_FAILED',
          firstFailedSequence: entry.event.sequence,
        })
      }
      return stored
    },
    recordEventWriteFailure: () => {},
    runLoop: async () => {
      throw Object.assign(new Error('injected loop failure'), { code: 'INJECTED_LOOP_FAILURE' })
    },
  })

  await engine.startTurn({ userId, sessionId: 'turn-engine-session', turnId, content: 'fail once' })
  await assert.rejects(
    engine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId }),
    (error) => error?.code === 'TURN_TERMINAL_PERSISTENCE_FAILED'
      && error?.terminalEventType === 'turn.failed',
  )

  assert.equal(failedTerminalAttempts, 1)
  assert.equal(events(turnId).filter(({ type }) => type === 'turn.failed').length, 1)
})

test('TurnEngine keeps a durable completion authoritative when its message projection fails', async () => {
  const turnId = 'turn-completion-message-projection-failure'
  const engine = createTestEngine({
    writeMessage: (message) => {
      if (message.id === `${turnId}:assistant`) throw new Error('assistant projection unavailable')
      return upsertMessage(message)
    },
    runLoop: async () => ({ text: 'durable event response', artifactIds: [], iterations: 1 }),
  })

  await engine.startTurn({
    userId,
    sessionId: 'turn-engine-session',
    turnId,
    content: 'Complete even if the message projection fails.',
  })
  await engine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId })

  const turnEvents = events(turnId)
  assert.equal(turnEvents.at(-1)?.type, 'turn.completed')
  assert.equal(turnEvents.at(-1)?.payload.text, 'durable event response')
  assert.equal(turnEvents.some(({ type }) => type === 'turn.failed'), false)
  assert.equal(listMessages({ userId, sessionId: 'turn-engine-session', limit: 500 })
    .some((message) => message.id === `${turnId}:assistant`), false)
})

test('TurnEngine journals a direct non-terminal append failure and emits a structured failed terminal', async () => {
  const turnId = 'turn-direct-event-append-failure'
  const journals = []
  const engine = createTestEngine({
    appendEvent: async (entry) => {
      if (entry.event.type === 'tool.started') throw new Error('tool event store unavailable')
      return appendTurnEvent(entry)
    },
    recordEventWriteFailure: (entry) => { journals.push(entry) },
    runLoop: async ({ onToolStarted }) => {
      await onToolStarted({ id: 'tool-direct-failure', name: 'read_file', args: { path: 'README.md' } })
      return { text: 'unreachable', artifactIds: [], iterations: 1 }
    },
  })

  await engine.startTurn({
    userId,
    sessionId: 'turn-engine-session',
    turnId,
    content: 'Fail a direct event append.',
  })
  await engine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId })

  const failed = events(turnId).at(-1)
  assert.equal(failed.type, 'turn.failed')
  assert.equal(failed.payload.code, 'TURN_EVENT_PERSISTENCE_FAILED')
  assert.deepEqual(failed.payload.error.persistence.failedEventTypes, ['tool.started'])
  assert.equal(failed.payload.error.persistence.failedEventCount, 1)
  assert.equal(journals.length, 1)
  assert.equal(journals[0].batch[0].event.type, 'tool.started')
  assert.equal(journals[0].batch[0].event.sequence, failed.sequence)
})

test('TurnEngine isolates deferred event queues across concurrent turns', async () => {
  const failedTurnId = 'turn-isolated-writer-failure'
  const healthyTurnId = 'turn-isolated-writer-healthy'
  const engine = createTestEngine({
    eventWriteBehindFactory: () => createEventWriteBehind({
      writeBatch(entries) {
        if (entries.some(({ event }) => event.turnId === failedTurnId)) {
          throw new Error('isolated event store failure')
        }
        return appendTurnEvents(entries)
      },
      logger: { error() {} },
      maxDelayMs: 10_000,
      maxAttempts: 1,
    }),
    runLoop: async ({ job, onModelDelta }) => {
      await onModelDelta({ text: job.id, iteration: 0, modelName: 'test' })
      return { text: `${job.id} complete`, artifactIds: [], iterations: 1 }
    },
  })

  await Promise.all([
    engine.startTurn({
      userId,
      sessionId: 'turn-engine-session',
      turnId: failedTurnId,
      content: 'fail only this event queue',
    }),
    engine.startTurn({
      userId,
      sessionId: 'turn-engine-session',
      turnId: healthyTurnId,
      content: 'keep this event queue healthy',
    }),
  ])
  await Promise.all([
    engine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId: failedTurnId }),
    engine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId: healthyTurnId }),
  ])

  assert.equal(events(failedTurnId).at(-1)?.type, 'turn.failed')
  assert.equal(events(healthyTurnId).at(-1)?.type, 'turn.completed')
  assert.equal(events(healthyTurnId).some(({ type }) => type === 'assistant.delta'), true)
})

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

test('TurnEngine persists latest context usage and only aggregates complete cost evidence', async () => {
  const turnId = 'turn-latest-model-usage'
  const firstUsage = { promptTokens: 120, completionTokens: 20, totalTokens: 140, costUsd: 0.01 }
  const latestUsage = { promptTokens: 360, completionTokens: 40, totalTokens: 400 }
  const turnModelUsage = { promptTokens: 480, completionTokens: 60, totalTokens: 540 }
  const engine = createTestEngine({
    runLoop: async ({ onModelPhase, saveCheckpoint }) => {
      await onModelPhase({
        phase: 'completed', iteration: 1, usage: firstUsage, modelName: 'test-model', error: null,
      })
      await onModelPhase({
        phase: 'completed', iteration: 2, usage: latestUsage, modelName: 'test-model', error: null,
      })
      await saveCheckpoint({ messages: [], artifactIds: [], iterations: 2 })
      return { text: 'Usage recorded.', artifactIds: [], iterations: 2 }
    },
  })

  await engine.startTurn({
    userId,
    sessionId: 'turn-engine-session',
    turnId,
    content: 'Record the latest context usage.',
  })
  await engine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId })

  const turnEvents = events(turnId)
  assert.deepEqual(
    turnEvents.filter((event) => event.type === 'model.phase').map((event) => event.payload.usage),
    [firstUsage, latestUsage],
  )
  const completed = turnEvents.find((event) => event.type === 'turn.completed')
  assert.deepEqual(completed.payload.usage, latestUsage)
  assert.deepEqual(completed.payload.turnModelUsage, turnModelUsage)
  const checkpoint = getTurnCheckpoint({
    userId,
    sessionId: 'turn-engine-session',
    turnId,
  }).state
  assert.deepEqual(checkpoint.latestModelUsage, latestUsage)
  assert.deepEqual(checkpoint.turnModelUsage, turnModelUsage)
  const assistant = listMessages({ userId, sessionId: 'turn-engine-session' })
    .find((message) => message.id === `${turnId}:assistant`)
  assert.deepEqual(assistant.modelContext.usage, latestUsage)
  assert.deepEqual(assistant.modelContext.turnModelUsage, turnModelUsage)
  assert.ok(Number.isFinite(assistant.modelContext.turnStartedAt))
  assert.ok(Number.isFinite(assistant.modelContext.turnCompletedAt))
  assert.equal(
    assistant.modelContext.latency,
    assistant.modelContext.turnCompletedAt - assistant.modelContext.turnStartedAt,
  )
})

test('TurnEngine keeps total cost unknown when an earlier round lacks cost evidence', async () => {
  const turnId = 'turn-model-usage-unknown-first'
  const firstUsage = { promptTokens: 40, completionTokens: 4, totalTokens: 44 }
  const latestUsage = { promptTokens: 80, completionTokens: 8, totalTokens: 88, costUsd: 0.02 }
  const engine = createTestEngine({
    runLoop: async ({ onModelPhase }) => {
      await onModelPhase({ phase: 'completed', iteration: 1, usage: firstUsage })
      await onModelPhase({ phase: 'completed', iteration: 2, usage: latestUsage })
      return { text: 'Unknown cost preserved.', artifactIds: [], iterations: 2 }
    },
  })

  await engine.startTurn({
    userId,
    sessionId: 'turn-engine-session',
    turnId,
    content: 'Keep incomplete cost evidence unknown.',
  })
  await engine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId })

  const completed = events(turnId).find((event) => event.type === 'turn.completed')
  assert.deepEqual(completed.payload.usage, latestUsage)
  assert.deepEqual(completed.payload.turnModelUsage, {
    promptTokens: 120,
    completionTokens: 12,
    totalTokens: 132,
  })
  assert.equal(Object.hasOwn(completed.payload.turnModelUsage, 'costUsd'), false)
})

test('TurnEngine aggregates explicit zero-cost rounds as measured evidence', async () => {
  const turnId = 'turn-model-usage-measured-zero'
  const engine = createTestEngine({
    runLoop: async ({ onModelPhase }) => {
      await onModelPhase({
        phase: 'completed',
        iteration: 1,
        usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12, costUsd: 0 },
      })
      await onModelPhase({
        phase: 'completed',
        iteration: 2,
        usage: { promptTokens: 20, completionTokens: 3, totalTokens: 23, costUsd: 0.01 },
      })
      return { text: 'Measured zero retained.', artifactIds: [], iterations: 2 }
    },
  })

  await engine.startTurn({
    userId,
    sessionId: 'turn-engine-session',
    turnId,
    content: 'Aggregate measured costs.',
  })
  await engine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId })

  const completed = events(turnId).find((event) => event.type === 'turn.completed')
  assert.deepEqual(completed.payload.turnModelUsage, {
    promptTokens: 30,
    completionTokens: 5,
    totalTokens: 35,
    costUsd: 0.01,
  })
})

test('TurnEngine blocks permission drift, preserves its checkpoint, and succeeds after explicit repaired retry', async () => {
  const turnId = 'turn-execution-environment-drift'
  let approvalMode = 'normal'
  let loopCalls = 0
  const toolSpecs = [{
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read one file',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
    },
  }]
  const engine = createTestEngine({
    readApprovalMode: () => approvalMode,
    readFileAccessStatus: () => ({
      projectDirectory: 'D:/workspace',
      defaultOutputDirectory: 'D:/workspace/output',
      grants: [],
      workspace: { enabled: false },
      runtime: { localCodeExecutionEnabled: true },
    }),
    readRuntimePlugins: () => [],
    readRuntimePluginStates: () => [],
    resolveToolSpecs: async () => toolSpecs,
    runLoop: async ({ saveCheckpoint }) => {
      loopCalls += 1
      await saveCheckpoint({ messages: [], artifactIds: [], iterations: 1 })
      if (loopCalls > 1) {
        return { text: 'recovered after permission repair', artifactIds: [], iterations: 2 }
      }
      return {
        interrupted: true,
        code: 'MODEL_HTTP_503',
        reason: 'pause for recovery verification',
        artifactIds: [],
        iterations: 1,
      }
    },
  })

  await engine.startTurn({
    userId,
    sessionId: 'turn-engine-session',
    turnId,
    content: 'Persist the exact execution environment.',
  })
  await engine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId })
  const checkpoint = getTurnCheckpoint({
    userId,
    sessionId: 'turn-engine-session',
    turnId,
  })
  assert.match(checkpoint.state.executionEnvironment.fingerprint, /^[a-f0-9]{64}$/u)
  assert.equal(checkpoint.state.executionEnvironment.approvalMode, 'normal')

  approvalMode = 'bypass'
  await engine.resumeTurn({ userId, sessionId: 'turn-engine-session', turnId })
  await engine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId })

  const blocked = events(turnId).at(-1)
  assert.equal(blocked.type, 'turn.blocked')
  assert.equal(blocked.payload.code, 'TURN_PERMISSION_CONTEXT_DRIFT')
  assert.equal(blocked.payload.retryable, false)
  assert.equal(blocked.payload.manualRetryable, true)
  assert.equal(events(turnId).some((event) => event.type === 'turn.failed'), false)
  assert.equal(getTurnCheckpoint({
    userId,
    sessionId: 'turn-engine-session',
    turnId,
  })?.eventSequence, checkpoint.eventSequence)
  assert.equal(getTurnRecoveryState({
    userId,
    sessionId: 'turn-engine-session',
    turnId,
  })?.status, 'dead_letter')
  assert.equal((await engine.getTurn({ userId, sessionId: 'turn-engine-session', turnId })).status, 'blocked')
  assert.equal(loopCalls, 1, 'drift must be rejected before the shared loop can execute again')

  await assert.rejects(
    engine.resumeTurn({ userId, sessionId: 'turn-engine-session', turnId }),
    (error) => error?.code === 'TURN_RECOVERY_DEAD_LETTER' && error?.status === 409,
  )
  approvalMode = 'normal'
  await engine.resumeTurn({
    userId,
    sessionId: 'turn-engine-session',
    turnId,
    retryRecovery: true,
  })
  await engine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId })
  assert.equal(events(turnId).at(-1)?.type, 'turn.completed')
  assert.equal(loopCalls, 2)
  assert.equal(getTurnRecoveryState({
    userId,
    sessionId: 'turn-engine-session',
    turnId,
  }), null)
})

test('TurnEngine blocks recovery before the loop when runtime policy provenance drifts', async () => {
  const turnId = 'turn-runtime-policy-drift'
  let policy = {
    id: 'builtin.harness-policy',
    owner: 'builtin',
    version: '0.11.31',
    revision: 1,
    releaseDigest: null,
    generation: 1,
    source: 'registry_default',
  }
  let loopCalls = 0
  const engine = createTestEngine({
    ...checkpointEnvironmentEngineOptions(),
    readRuntimePolicyProvenance: () => policy,
    runLoop: async ({ saveCheckpoint }) => {
      loopCalls += 1
      await saveCheckpoint({ messages: [], artifactIds: [], iterations: 1 })
      if (loopCalls > 1) {
        return { text: 'Recovered under the same policy binding.', artifactIds: [], iterations: 2 }
      }
      return {
        interrupted: true,
        code: 'MODEL_HTTP_503',
        reason: 'pause before policy recovery verification',
        artifactIds: [],
        iterations: 1,
      }
    },
  })

  await engine.startTurn({
    userId,
    sessionId: 'turn-engine-session',
    turnId,
    content: 'Persist the active Harness policy.',
  })
  await engine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId })
  const checkpoint = getTurnCheckpoint({ userId, sessionId: 'turn-engine-session', turnId })
  assert.equal(checkpoint.state.executionEnvironment.policy.revision, 1)

  policy = { ...policy, revision: 2, generation: 2 }
  await engine.resumeTurn({ userId, sessionId: 'turn-engine-session', turnId })
  await engine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId })

  const blocked = events(turnId).at(-1)
  assert.equal(blocked.type, 'turn.blocked')
  assert.equal(blocked.payload.code, 'TURN_POLICY_CONTEXT_DRIFT')
  assert.equal(blocked.payload.retryable, false)
  assert.equal(loopCalls, 1)
  assert.equal(getTurnCheckpoint({
    userId,
    sessionId: 'turn-engine-session',
    turnId,
  })?.eventSequence, checkpoint.eventSequence)

  policy = { ...policy, revision: 1, generation: 3 }
  await engine.resumeTurn({
    userId,
    sessionId: 'turn-engine-session',
    turnId,
    retryRecovery: true,
  })
  await engine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId })
  assert.equal(events(turnId).at(-1)?.type, 'turn.completed')
  assert.equal(loopCalls, 2)
})

test('TurnEngine dead-letters recovery when tool implementation revision drifts', async () => {
  const turnId = 'turn-tool-implementation-drift'
  let toolImplementations = CHECKPOINT_TOOL_IMPLEMENTATIONS
  let loopCalls = 0
  const toolSpecs = [checkpointReadToolSpec]
  const engine = createTestEngine({
    ...checkpointEnvironmentEngineOptions(toolSpecs),
    resolveToolImplementationRevisions: () => toolImplementations,
    runLoop: async ({ saveCheckpoint }) => {
      loopCalls += 1
      await saveCheckpoint({ messages: [], artifactIds: [], iterations: 1 })
      return {
        interrupted: true,
        code: 'MODEL_HTTP_503',
        reason: 'pause before implementation drift verification',
        artifactIds: [],
        iterations: 1,
      }
    },
  })

  await engine.startTurn({
    userId,
    sessionId: 'turn-engine-session',
    turnId,
    content: 'Pin the executable tool implementation.',
  })
  await engine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId })
  const checkpoint = getTurnCheckpoint({
    userId,
    sessionId: 'turn-engine-session',
    turnId,
  })
  assert.ok(checkpoint)

  toolImplementations = {
    ...CHECKPOINT_TOOL_IMPLEMENTATIONS,
    builtinRevision: `sha256-${'b'.repeat(64)}`,
  }
  await engine.resumeTurn({ userId, sessionId: 'turn-engine-session', turnId })
  await engine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId })

  const blocked = events(turnId).at(-1)
  assert.equal(blocked.type, 'turn.blocked')
  assert.equal(blocked.payload.code, 'TURN_TOOL_IMPLEMENTATION_DRIFT')
  assert.equal(blocked.payload.retryable, false)
  assert.equal(blocked.payload.manualRetryable, true)
  assert.equal(loopCalls, 1, 'implementation drift must be rejected before replay executes')
  assert.equal(getTurnCheckpoint({
    userId,
    sessionId: 'turn-engine-session',
    turnId,
  })?.eventSequence, checkpoint.eventSequence)
  assert.equal(getTurnRecoveryState({
    userId,
    sessionId: 'turn-engine-session',
    turnId,
  })?.status, 'dead_letter')
})

test('TurnEngine verifies active runtime plugin releases and blocks a corrupt release before recovery executes', async () => {
  const turnId = 'turn-corrupt-runtime-plugin-release'
  let releaseCorrupt = false
  let loopCalls = 0
  const stateReadOptions = []
  const engine = createTestEngine({
    ...checkpointEnvironmentEngineOptions(),
    readRuntimePluginStates: (options) => {
      stateReadOptions.push(options)
      if (releaseCorrupt) {
        const error = new Error('active runtime plugin release content digest does not match')
        error.code = 'PLUGIN_RELEASE_CORRUPT'
        error.statusCode = 500
        throw error
      }
      return []
    },
    runLoop: async ({ saveCheckpoint }) => {
      loopCalls += 1
      await saveCheckpoint({ messages: [], artifactIds: [], iterations: 1 })
      return {
        interrupted: true,
        code: 'MODEL_HTTP_503',
        reason: 'pause before recovery integrity verification',
        artifactIds: [],
        iterations: 1,
      }
    },
  })

  await engine.startTurn({
    userId,
    sessionId: 'turn-engine-session',
    turnId,
    content: 'Verify the active plugin release before replaying this turn.',
  })
  await engine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId })
  const checkpoint = getTurnCheckpoint({
    userId,
    sessionId: 'turn-engine-session',
    turnId,
  })
  assert.ok(checkpoint)
  assert.equal(loopCalls, 1)

  releaseCorrupt = true
  await engine.resumeTurn({ userId, sessionId: 'turn-engine-session', turnId })
  await engine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId })

  const blocked = events(turnId).at(-1)
  assert.equal(blocked.type, 'turn.blocked')
  assert.equal(blocked.payload.code, 'PLUGIN_RELEASE_CORRUPT')
  assert.equal(blocked.payload.retryable, false)
  assert.equal(blocked.payload.manualRetryable, true)
  assert.equal(loopCalls, 1, 'corrupt releases must be rejected before recovery enters the loop')
  assert.equal(getTurnCheckpoint({
    userId,
    sessionId: 'turn-engine-session',
    turnId,
  })?.eventSequence, checkpoint.eventSequence)
  assert.equal(getTurnRecoveryState({
    userId,
    sessionId: 'turn-engine-session',
    turnId,
  })?.status, 'dead_letter')
  assert.deepEqual(stateReadOptions, [
    { verifyActiveReleases: true },
    { verifyActiveReleases: true },
  ])
})

test('TurnEngine persists the final server request estimate when provider usage is absent', async () => {
  const turnId = 'turn-server-prompt-estimate'
  const engine = createTestEngine({
    runModel: async () => ({ content: 'estimated', toolCalls: [] }),
    runLoop: async ({ runModel, saveCheckpoint }) => {
      await runModel({
        messages: [
          { role: 'system', content: 'Keep the response concise.' },
          { role: 'user', content: 'Summarize the compacted request.' },
        ],
        tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }],
      })
      await saveCheckpoint({ messages: [], artifactIds: [], iterations: 1 })
      return { text: 'Estimate recorded.', artifactIds: [], iterations: 1 }
    },
  })

  await engine.startTurn({
    userId,
    sessionId: 'turn-engine-session',
    turnId,
    content: 'Record the server request estimate.',
  })
  await engine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId })

  const completed = events(turnId).find((event) => event.type === 'turn.completed')
  const estimate = completed.payload.estimatedPromptTokens
  assert.ok(Number.isInteger(estimate) && estimate > 0)
  const checkpoint = getTurnCheckpoint({
    userId,
    sessionId: 'turn-engine-session',
    turnId,
  }).state
  assert.equal(checkpoint.latestEstimatedPromptTokens, estimate)
  const assistant = listMessages({ userId, sessionId: 'turn-engine-session' })
    .find((message) => message.id === `${turnId}:assistant`)
  assert.equal(assistant.modelContext.estimatedPromptTokens, estimate)
  assert.equal(assistant.modelContext.usage, undefined)
})

test('TurnEngine preserves explicit empty delivery ids through checkpoint, model context, and completion', async () => {
  const turnId = 'turn-explicit-empty-delivery'
  const artifactIds = ['draft-artifact', 'final-artifact']
  const engine = createTestEngine({
    runLoop: async ({ saveCheckpoint }) => {
      await saveCheckpoint({
        messages: [],
        artifactIds,
        deliveryArtifactIds: [],
        iterations: 1,
      })
      return {
        text: 'The turn intentionally delivers no files.',
        artifactIds,
        deliveryArtifactIds: [],
        iterations: 1,
      }
    },
  })

  await engine.startTurn({
    userId,
    sessionId: 'turn-engine-session',
    turnId,
    content: 'Finish without delivering a file.',
  })
  await engine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId })

  const turnEvents = events(turnId)
  const checkpoint = turnEvents.find((event) => event.type === 'turn.checkpoint')
  const completed = turnEvents.find((event) => event.type === 'turn.completed')
  assert.deepEqual(checkpoint.payload, {
    storage: 'turn_checkpoints',
    checkpointVersion: 1,
    iterations: 1,
    toolCallCount: 0,
  })
  const storedCheckpoint = getTurnCheckpoint({
    userId,
    sessionId: 'turn-engine-session',
    turnId,
  })
  assert.ok(Object.hasOwn(storedCheckpoint.state, 'deliveryArtifactIds'))
  assert.deepEqual(storedCheckpoint.state.deliveryArtifactIds, [])
  assert.ok(Object.hasOwn(completed.payload, 'deliveryArtifactIds'))
  assert.deepEqual(completed.payload.deliveryArtifactIds, [])

  const assistant = listMessages({ userId, sessionId: 'turn-engine-session' })
    .find((message) => message.id === `${turnId}:assistant`)
  assert.ok(Object.hasOwn(assistant.modelContext, 'deliveryArtifactIds'))
  assert.deepEqual(assistant.modelContext.deliveryArtifactIds, [])
  assert.deepEqual(assistant.modelContext.artifactIds, artifactIds)
})

test('TurnEngine clears a stale delivery fallback when a legacy checkpoint adds artifacts without the field', async () => {
  const turnId = 'turn-stale-delivery-cleared'
  const engine = createTestEngine({
    runLoop: async ({ saveCheckpoint }) => {
      await saveCheckpoint({
        messages: [],
        artifactIds: ['draft-artifact'],
        deliveryArtifactIds: ['draft-artifact'],
        iterations: 1,
      })
      await saveCheckpoint({
        messages: [],
        artifactIds: ['draft-artifact', 'new-artifact'],
        iterations: 2,
      })
      return {
        interrupted: true,
        code: 'MODEL_HTTP_503',
        reason: 'provider interrupted after producing a newer artifact',
        artifactIds: ['draft-artifact', 'new-artifact'],
        iterations: 2,
      }
    },
  })

  await engine.startTurn({
    userId,
    sessionId: 'turn-engine-session',
    turnId,
    content: 'Create and deliver the final file.',
  })
  await engine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId })

  const interrupted = events(turnId).find((event) => event.type === 'turn.interrupted')
  assert.ok(interrupted)
  assert.ok(Object.hasOwn(interrupted.payload, 'deliveryArtifactIds'))
  assert.deepEqual(interrupted.payload.deliveryArtifactIds, [])

  const assistant = listMessages({ userId, sessionId: 'turn-engine-session' })
    .find((message) => message.id === `${turnId}:assistant`)
  assert.ok(Object.hasOwn(assistant.modelContext, 'deliveryArtifactIds'))
  assert.deepEqual(assistant.modelContext.deliveryArtifactIds, [])
  assert.deepEqual(assistant.modelContext.artifactIds, ['draft-artifact', 'new-artifact'])
})

test('TurnEngine keeps repeated checkpoints linear in the event log', async () => {
  const turnId = 'turn-linear-checkpoints'
  const checkpointCount = 40
  const engine = createTestEngine({
    runLoop: async ({ saveCheckpoint }) => {
      const messages = []
      for (let index = 0; index < checkpointCount; index += 1) {
        messages.push({ role: 'tool', tool_call_id: `call-${index}`, content: 'x'.repeat(500) })
        await saveCheckpoint({
          messages: [...messages],
          toolCalls: Array.from({ length: index + 1 }, (_, callIndex) => ({
            id: `call-${callIndex}`,
            name: 'read_file',
            checkpointStatus: 'completed',
          })),
          artifactIds: [],
          iterations: index + 1,
        })
      }
      return { text: 'Checkpointed work completed.', artifactIds: [], iterations: checkpointCount }
    },
  })

  await engine.startTurn({
    userId,
    sessionId: 'turn-engine-session',
    turnId,
    content: 'Exercise many checkpoints.',
  })
  await engine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId })

  const checkpoints = events(turnId).filter((event) => event.type === 'turn.checkpoint')
  assert.equal(checkpoints.length, 1, 'superseded checkpoint events should be compacted')
  assert.equal(checkpoints.every((event) => event.payload.storage === 'turn_checkpoints'), true)
  assert.equal(checkpoints.some((event) => Object.hasOwn(event.payload, 'state')), false)
  assert.ok(
    checkpoints.reduce((sum, event) => sum + JSON.stringify(event.payload).length, 0) < 150,
    'durable replay metadata must stay bounded',
  )
  const rows = getDb().prepare(`
    SELECT state_json FROM turn_checkpoints
     WHERE user_id = ? AND session_id = ? AND turn_id = ?
  `).all(userId, 'turn-engine-session', turnId)
  assert.equal(rows.length, 1)
  assert.equal(JSON.parse(rows[0].state_json).iterations, checkpointCount)
})

test('TurnEngine rejects a custom event adapter without atomic checkpoint capability before writing a checkpoint event', async () => {
  const turnId = 'turn-non-atomic-checkpoint-adapter'
  let postCheckpointSideEffects = 0
  const engine = createTestEngine({
    appendEvent: (entry) => appendTurnEvent(entry),
    runLoop: async ({ saveCheckpoint }) => {
      await saveCheckpoint({ messages: [], artifactIds: [], iterations: 1 })
      postCheckpointSideEffects += 1
      return { text: 'must not complete', artifactIds: [], iterations: 1 }
    },
  })

  await engine.startTurn({
    userId,
    sessionId: 'turn-engine-session',
    turnId,
    content: 'Do not create a half-committed recovery point.',
  })
  await engine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId })

  const turnEvents = events(turnId)
  assert.equal(postCheckpointSideEffects, 0)
  assert.equal(turnEvents.some(({ type }) => type === 'turn.checkpoint'), false)
  assert.equal(turnEvents.some(({ type }) => type === 'turn.completed'), false)
  assert.equal(turnEvents.at(-1)?.type, 'turn.failed')
  assert.equal(turnEvents.at(-1)?.payload?.code, 'TURN_ATOMIC_CHECKPOINT_UNSUPPORTED')
})

test('TurnEngine rejects an event adapter that drops checkpoint state before post-checkpoint side effects', async () => {
  const turnId = 'turn-broken-atomic-checkpoint-adapter'
  let postCheckpointSideEffects = 0
  const engine = createTestEngine({
    supportsAtomicCheckpointState: true,
    appendEvent: ({ userId: eventUserId, event }) => appendTurnEvent({ userId: eventUserId, event }),
    runLoop: async ({ saveCheckpoint }) => {
      await saveCheckpoint({ messages: [], artifactIds: [], iterations: 1 })
      postCheckpointSideEffects += 1
      return { text: 'must not complete', artifactIds: [], iterations: 1 }
    },
  })

  await engine.startTurn({
    userId,
    sessionId: 'turn-engine-session',
    turnId,
    content: 'Detect a false atomic checkpoint capability claim.',
  })
  await engine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId })

  const turnEvents = events(turnId)
  assert.equal(postCheckpointSideEffects, 0)
  assert.equal(turnEvents.some(({ type }) => type === 'turn.completed'), false)
  assert.equal(turnEvents.some(({ type }) => type === 'turn.checkpoint'), false)
  assert.equal(turnEvents.at(-1)?.type, 'turn.failed')
  assert.equal(turnEvents.at(-1)?.payload?.code, 'TURN_EVENT_PERSISTENCE_FAILED')
  assert.equal(getTurnCheckpoint({
    userId,
    sessionId: 'turn-engine-session',
    turnId,
  }), null)
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
  const summaryText = 'Persisted archive summary: the first turn requested the initial page.'
  upsertSession({ id: sessionId, userId, title: 'Compaction continuity' })
  const preparedContexts = []
  const loopMessages = []
  let loopCalls = 0
  let archiveId = null
  const engine = createTestEngine({
    preparePromptContext: async (request) => {
      const prepared = prepareTurnPromptContext(request)
      preparedContexts.push(prepared)
      return prepared
    },
    runLoop: async (options) => {
      loopMessages.push(options.messages)
      loopCalls += 1
      if (loopCalls === 1) {
        const archive = createCompactionArchive({
          userId,
          sessionId,
          archivedMessages: [{ role: 'user', content: 'Earlier context' }],
          summaryText,
        })
        archiveId = archive.id
        return {
          text: 'First reply',
          artifactIds: [],
          iterations: 1,
          recovery: {
            archiveId,
            lastCompactedMessageId: 'turn-compaction-first:user',
          },
        }
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
    /Persisted archive summary: the first turn requested the initial page\./,
  )
  const secondPayload = loopMessages[1].map((message) => message.content).join('\n')
  assert.doesNotMatch(secondPayload, /^First turn$/m, 'archive-covered user text must not be replayed')
  assert.match(secondPayload, /First reply/)
  assert.match(secondPayload, /Second turn/)
})

test('TurnEngine always keeps the active user request when a compaction boundary is stale', async () => {
  const sessionId = 'turn-engine-stale-compaction-boundary'
  const turnId = 'turn-stale-compaction-boundary'
  upsertSession({ id: sessionId, userId, title: 'Stale compaction boundary' })
  let loopMessages = []
  const engine = createTestEngine({
    preparePromptContext: async () => ({
      messages: [{ role: 'system', content: 'Valid archive summary.' }],
      effectiveAgentId: null,
      skillIds: [],
      memoryIds: [],
      compactionBoundary: {
        compacted: true,
        firstKeptMessageId: 'missing-retained-message',
        lastCompactedMessageId: 'missing-archived-message',
      },
    }),
    runLoop: async (options) => {
      loopMessages = options.messages
      return { text: 'Current request handled.', artifactIds: [], iterations: 0 }
    },
  })

  await engine.startTurn({
    userId,
    sessionId,
    turnId,
    content: 'ACTIVE_USER_REQUEST_MUST_SURVIVE',
  })
  await engine.waitForTurn({ userId, sessionId, turnId })

  assert.ok(loopMessages.some((message) => (
    message.role === 'user' && message.content === 'ACTIVE_USER_REQUEST_MUST_SURVIVE'
  )))
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
  assert.equal(await engine.hasActiveSession({ userId, sessionId }), true)
  assert.equal(await engine.hasActiveSession({ userId: 'another-user', sessionId }), false)

  releaseStarted()
  await starting
  assert.equal(await engine.hasActiveSession({ userId, sessionId }), true)
  releaseLoop({ text: 'done', artifactIds: [], iterations: 0 })
  await engine.waitForTurn({ userId, sessionId, turnId: 'turn-active-window' })
  assert.equal(await engine.hasActiveSession({ userId, sessionId }), false)
})

test('TurnEngine fails closed when durable session activity cannot be checked', async () => {
  const leaseFailure = new Error('lease backend unavailable')
  const engine = createTestEngine({
    runtimeCore: {
      checkpoint: { load: () => null, save: () => null, clear: () => 0 },
      lease: {
        hasActiveSession: () => { throw leaseFailure },
      },
      approval: { release: () => 0 },
    },
  })

  await assert.rejects(
    engine.hasActiveSession({ userId, sessionId: 'turn-engine-session' }),
    (error) => error?.code === 'TURN_SESSION_ACTIVITY_CHECK_FAILED'
      && error?.status === 503
      && error?.message === 'failed to verify whether the session has an active turn'
      && error?.cause === leaseFailure,
  )
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
  assert.equal(await engine.hasActiveSession({ userId, sessionId }), false)
})

test('TurnEngine model-readiness rejection leaves no session, message, or event state', async () => {
  const sessionId = 'turn-engine-model-readiness-failure'
  const turnId = 'turn-model-readiness-failure'
  let loopCalls = 0
  const readinessError = Object.assign(new Error('模型 Provider 尚未测试'), {
    code: 'MODEL_PROVIDER_UNVERIFIED',
    statusCode: 409,
    action: 'test_provider',
  })
  const engine = createTestEngine({
    resolveModelBinding: () => { throw readinessError },
    runLoop: async () => {
      loopCalls += 1
      return { text: 'must not run' }
    },
  })

  await assert.rejects(
    engine.startTurn({ userId, sessionId, turnId, content: '这条消息不应产生空会话' }),
    (error) => error === readinessError,
  )

  assert.equal(getSession({ userId, sessionId }), null)
  assert.deepEqual(listMessages({ userId, sessionId, limit: 100 }), [])
  assert.deepEqual(listTurnEvents({ requestedUser: userId, userId, sessionId, turnId, limit: 100 }), [])
  assert.equal(await engine.hasActiveSession({ userId, sessionId }), false)
  assert.equal(loopCalls, 0)
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
  }, { legacyPersistence: true })

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

  assert.equal((await engine.getTurn({ userId, sessionId, turnId })).status, 'completed')
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

  assert.equal((await engine.getTurn({ userId, sessionId: 'turn-engine-session', turnId: 'turn-text' })).status, 'completed')
  assert.deepEqual(events('turn-text').map((event) => event.type), [
    'turn.started', 'model.phase', 'model.phase', 'model.phase', 'assistant.delta', 'turn.checkpoint', 'turn.completed',
  ])
  assert.deepEqual(
    events('turn-text').filter((event) => event.type === 'model.phase').map((event) => event.payload.phase),
    ['started', 'waiting_first_token', 'completed'],
  )
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

test('TurnEngine reads the user approval mode once and shares it with discovery and execution', async () => {
  let loopOptions = null
  let toolRequest = null
  const approvalModeRequests = []
  const engine = createTestEngine({
    readApprovalMode: (request) => {
      approvalModeRequests.push(request)
      return 'bypass'
    },
    resolveToolSpecs: async (request) => {
      toolRequest = request
      return request.baseSpecs
    },
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

  assert.deepEqual(approvalModeRequests, [{ userId }])
  assert.equal(toolRequest.permissionMode, 'bypass')
  assert.equal(loopOptions.approvalMode, 'bypass')
  assert.equal(loopOptions.approvalOrigin, 'chat')
  assert.equal(loopOptions.job.origin, 'chat')
})

test('TurnEngine host projects custom resolver schemas before model and loop access in plan mode', async () => {
  const turnId = `turn-plan-host-projection-${Date.now()}`
  const resolverSpecs = ['read_file', 'write_file', 'bash_exec'].map((name) => ({
    type: 'function',
    function: { name, parameters: { type: 'object' } },
  }))
  let loopOptions = null
  let modelRequest = null
  const engine = createTestEngine({
    toolSpecs: resolverSpecs,
    readFileAccessStatus: () => ({
      projectDirectory: tempDir,
      defaultOutputDirectory: tempDir,
      grants: [{
        id: 'turn-plan-read-grant',
        path: tempDir,
        resourceType: 'directory',
        accessMode: 'read_only',
        scope: 'session',
        available: true,
      }],
      workspace: { enabled: false },
      runtime: { localCodeExecutionEnabled: false },
    }),
    resolveToolSpecs: async () => resolverSpecs,
    runModel: async (request) => {
      modelRequest = request
      return { content: '只读检查完成。', toolCalls: [], modelName: 'stub' }
    },
    runLoop: async (options) => {
      loopOptions = options
      await options.runModel({ messages: options.messages, tools: options.toolSpecs })
      return { text: '只读检查完成。', artifactIds: [], iterations: 0 }
    },
  })

  await engine.startTurn({
    userId,
    sessionId: 'turn-engine-session',
    turnId,
    content: '只规划，不修改',
    approvalMode: 'plan',
  })
  await engine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId })

  const namesOf = (specs) => specs.map((spec) => spec?.function?.name)
  assert.deepEqual(namesOf(loopOptions.toolSpecs), ['read_file'])
  assert.deepEqual(namesOf(loopOptions.fallbackToolSpecs), ['read_file'])
  assert.deepEqual(namesOf(modelRequest.tools), ['read_file'])
  for (const name of ['write_file', 'bash_exec']) {
    assert.ok(loopOptions.toolResolutionDecision.excludedTools.some((entry) => (
      entry.name === name
        && entry.stage === 'permission'
        && entry.reason === 'permission_mode_plan'
    )))
  }
})

test('TurnEngine exposes only request_directory in unauthorized plan mode', async () => {
  const turnId = `turn-unauthorized-workspace-projection-${Date.now()}`
  const resolverSpecs = [
    'request_directory',
    'reflect',
    'set_deliverables',
    'read_file',
    'write_file',
    'bash_exec',
  ].map((name) => ({
    type: 'function',
    function: { name, parameters: { type: 'object' } },
  }))
  let loopOptions = null
  let modelRequest = null
  const engine = createTestEngine({
    toolSpecs: resolverSpecs,
    readFileAccessStatus: () => ({ grants: [] }),
    resolveToolSpecs: async () => resolverSpecs,
    runModel: async (request) => {
      modelRequest = request
      return { content: '请先授权工作区。', toolCalls: [], modelName: 'stub' }
    },
    runLoop: async (options) => {
      loopOptions = options
      await options.runModel({ messages: options.messages, tools: options.toolSpecs })
      return { text: '请先授权工作区。', artifactIds: [], iterations: 0 }
    },
  })

  await engine.startTurn({
    userId,
    sessionId: 'turn-engine-session',
    turnId,
    content: '读取并修改项目文件',
    approvalMode: 'plan',
  })
  await engine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId })

  const namesOf = (specs) => specs.map((spec) => spec?.function?.name)
  assert.deepEqual(namesOf(loopOptions.toolSpecs), ['request_directory'])
  assert.deepEqual(namesOf(loopOptions.fallbackToolSpecs), ['request_directory'])
  assert.deepEqual(namesOf(modelRequest.tools), ['request_directory'])
})

test('TurnEngine applies and persists each validated per-turn approval mode', async () => {
  for (const mode of ['normal', 'acceptEdits', 'plan', 'bypass']) {
    const turnId = `turn-runtime-approval-override-${mode}`
    let toolRequest = null
    let loopOptions = null
    const engine = createTestEngine({
      readApprovalMode: () => mode === 'normal' ? 'bypass' : 'normal',
      resolveToolSpecs: async (request) => {
        toolRequest = request
        return []
      },
      runLoop: async (options) => {
        loopOptions = options
        await options.saveCheckpoint({ messages: [], artifactIds: [], iterations: 1 })
        return { text: 'override applied', artifactIds: [], iterations: 1 }
      },
    })

    await engine.startTurn({
      userId,
      sessionId: 'turn-engine-session',
      turnId,
      content: 'use only this turn permission mode',
      approvalMode: mode,
    })
    await engine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId })

    const started = events(turnId).find((event) => event.type === 'turn.started')
    assert.equal(started?.payload?.approvalMode, mode)
    assert.equal(toolRequest?.permissionMode, mode)
    assert.equal(loopOptions?.approvalMode, mode)
    assert.equal(getTurnCheckpoint({
      userId,
      sessionId: 'turn-engine-session',
      turnId,
    })?.state?.approvalMode, mode)
  }
})

test('TurnEngine rejects invalid per-turn approval modes before persisting the turn', async () => {
  const invalidModes = ['unsafe', '', ' bypass ', 1, true, {}]
  const engine = createTestEngine({
    runLoop: async () => {
      assert.fail('invalid approval mode must not execute the loop')
    },
  })

  for (const [index, approvalMode] of invalidModes.entries()) {
    const turnId = `turn-invalid-approval-mode-${index}`
    await assert.rejects(
      engine.startTurn({
        userId,
        sessionId: 'turn-engine-session',
        turnId,
        content: 'reject invalid mode',
        approvalMode,
      }),
      (error) => error?.code === 'TURN_APPROVAL_MODE_INVALID' && error?.status === 400,
    )
    assert.deepEqual(events(turnId), [])
    assert.equal(
      listMessages({ userId, sessionId: 'turn-engine-session', limit: 500 })
        .some((message) => message.id === `${turnId}:user`),
      false,
    )
  }
})

test('TurnEngine restores a persisted per-turn approval mode and forbids resume-time replacement', async () => {
  const turnId = 'turn-persisted-approval-mode-resume'
  let configuredMode = 'normal'
  const observedModes = []
  const engine = createTestEngine({
    readApprovalMode: () => configuredMode,
    resolveToolSpecs: async (request) => request.baseSpecs,
    runLoop: async (options) => {
      observedModes.push(options.approvalMode)
      if (observedModes.length === 1) {
        await options.saveCheckpoint({ messages: [], artifactIds: [], iterations: 1 })
        return {
          interrupted: true,
          code: 'MODEL_HTTP_503',
          reason: 'resume from the persisted checkpoint',
          artifactIds: [],
          iterations: 1,
        }
      }
      return { text: 'resumed with the original permission', artifactIds: [], iterations: 2 }
    },
  })

  await engine.startTurn({
    userId,
    sessionId: 'turn-engine-session',
    turnId,
    content: 'pin bypass to this turn',
    approvalMode: 'bypass',
  })
  await engine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId })
  assert.equal(events(turnId).at(-1)?.type, 'turn.interrupted')
  assert.equal(getTurnCheckpoint({
    userId,
    sessionId: 'turn-engine-session',
    turnId,
  })?.state?.approvalMode, 'bypass')

  configuredMode = 'plan'
  await assert.rejects(
    engine.resumeTurn({
      userId,
      sessionId: 'turn-engine-session',
      turnId,
      approvalMode: 'plan',
    }),
    (error) => error?.code === 'TURN_APPROVAL_MODE_OVERRIDE_FORBIDDEN'
      && error?.status === 409,
  )
  assert.deepEqual(observedModes, ['bypass'])

  await engine.resumeTurn({ userId, sessionId: 'turn-engine-session', turnId })
  await engine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId })
  assert.deepEqual(observedModes, ['bypass', 'bypass'])
  assert.equal(events(turnId).at(-1)?.type, 'turn.completed')
})

test('TurnEngine keeps schemas stable while projecting stored bypass capabilities', async (t) => {
  setApprovalMode({ userId, mode: 'bypass' })
  t.after(() => {
    getDb().prepare('DELETE FROM user_approval_settings WHERE user_id = ?').run(userId)
  })
  let modelRequest = null
  const engine = createTestEngine({
    toolSpecs: [
      { type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } },
      { type: 'function', function: { name: 'request_directory', parameters: { type: 'object' } } },
    ],
    runModel: async (request) => {
      modelRequest = request
      return { content: '权限状态已确认。', toolCalls: [], modelName: 'stub' }
    },
  })

  await engine.startTurn({
    userId,
    sessionId: 'turn-engine-session',
    turnId: 'turn-stored-bypass-capabilities',
    content: '说明当前文件访问能力',
  })
  await engine.waitForTurn({
    userId,
    sessionId: 'turn-engine-session',
    turnId: 'turn-stored-bypass-capabilities',
  })

  assert.ok(modelRequest)
  assert.equal(
    modelRequest.tools.some((tool) => tool?.function?.name === 'request_directory'),
    true,
  )
  const capabilityMessage = modelRequest.messages.find((message) => (
    message?.role === 'system'
      && String(message.content || '').includes('[RUNTIME CAPABILITIES]')
  ))
  assert.match(capabilityMessage?.content || '', /Approval mode: bypass \(allow all\)/)
  assert.doesNotMatch(capabilityMessage?.content || '', /- Authorization:/)
})

test('TurnEngine persists and applies agent, skill, memory, and tools context', async () => {
  let promptRequest = null
  let toolRequest = null
  let loopOptions = null
  let contextWindowRequest = null
  let modelRequest = null
  const baseSpecs = [
    { type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } },
    { type: 'function', function: { name: 'bash_exec', parameters: { type: 'object' } } },
  ]
  const engine = createTestEngine({
    toolSpecs: baseSpecs,
    readFileAccessStatus: () => readOnlyDirectoryAccessStatus('turn-context-read-grant'),
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
        pluginPromptBlockIds: ['trusted-context:project-hints'],
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
    runModel: async (request) => {
      modelRequest = request
      return { content: '', toolCalls: [] }
    },
    runLoop: async (options) => {
      loopOptions = options
      await options.runModel({ messages: options.messages, tools: [] })
      return { text: 'context applied', artifactIds: [], iterations: 0 }
    },
  })

  await engine.startTurn({
    userId,
    sessionId: 'turn-engine-session',
    turnId: 'turn-context',
    content: 'use memory and review skill',
    modelName: 'context-model',
    modelProviderId: ' provider-local ',
    agentId: ' agent-input ',
    skillIds: [' skill-review ', 'skill-review'],
    skillDefinitions: [{
      id: 'skill-review',
      name: 'Local review',
      description: 'A local review workflow.',
      permissions: ['read'],
      systemPrompt: 'Use the local review instructions.',
    }],
    toolsConfig: { enabled: ['read_file'], disabled: ['bash_exec'] },
    intentMode: 'execute',
  })
  await engine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId: 'turn-context' })

  const started = events('turn-context').find((event) => event.type === 'turn.started')
  assert.equal(started.payload.modelProviderId, 'provider-local')
  assert.equal(started.payload.agentId, 'agent-input')
  assert.deepEqual(started.payload.skillIds, ['skill-review'])
  assert.equal(started.payload.skillDefinitions[0].id, 'skill-review')
  assert.match(started.payload.skillDefinitions[0].systemPrompt, /gugo-skill-quality:v1/)
  assert.deepEqual(started.payload.toolsConfig, { enabled: ['read_file'], disabled: ['bash_exec'] })
  assert.equal(started.payload.intentMode, 'execute')
  assert.equal(promptRequest.agentId, 'agent-input')
  assert.deepEqual(promptRequest.skillIds, ['skill-review'])
  assert.equal(promptRequest.skillDefinitions[0].id, 'skill-review')
  assert.match(promptRequest.skillDefinitions[0].systemPrompt, /Use the local review instructions\./)
  assert.equal(promptRequest.query, 'use memory and review skill')
  assert.equal(promptRequest.includeRecentTranscript, false)
  assert.deepEqual(toolRequest.toolsConfig, { enabled: ['read_file'], disabled: ['bash_exec'] })
  assert.equal(toolRequest.prompt, 'use memory and review skill')
  assert.deepEqual(toolRequest.skillIds, ['skill-review'])
  assert.ok(toolRequest.messages.some((message) => message.role === 'user' && message.content === 'use memory and review skill'))
  assert.equal(loopOptions.messages[0].content, '# Skill\nreview carefully')
  assert.equal(loopOptions.messages[1].content, '# Memory\nproject uses SQLite')
  assert.deepEqual(loopOptions.toolSpecs.map((spec) => spec.function.name), ['read_file'])
  assert.deepEqual(
    loopOptions.fallbackToolSpecs.map((spec) => spec.function.name),
    ['read_file'],
    'dynamic recovery must receive only the current turn resolved/enabled catalog',
  )
  assert.equal(loopOptions.skillId, 'skill-review')
  assert.equal(loopOptions.job.agentId, 'agent-resolved')
  assert.equal(loopOptions.job.modelName, 'context-model')
  assert.equal(loopOptions.job.modelProviderId, 'provider-local')
  assert.deepEqual(loopOptions.job.skillIds, ['skill-review'])
  assert.equal(loopOptions.job.skillDefinitions[0].id, 'skill-review')
  assert.match(loopOptions.job.skillDefinitions[0].systemPrompt, /gugo-skill-quality:v1/)
  assert.equal(loopOptions.contextWindow, 8192)
  assert.equal(loopOptions.intentMode, 'execute')
  assert.equal(contextWindowRequest.userId, userId)
  assert.equal(contextWindowRequest.modelName, 'context-model')
  assert.equal(contextWindowRequest.modelProviderId, 'provider-local')
  assert.equal(modelRequest.modelProviderId, 'provider-local')
  const assistant = listMessages({ userId, sessionId: 'turn-engine-session' })
    .find((message) => message.id === 'turn-context:assistant')
  assert.deepEqual(
    assistant.modelContext.pluginPromptBlockIds,
    ['trusted-context:project-hints'],
  )
})

test('TurnEngine sanitizes oversized inline skill fields before persisting turn.started', async () => {
  const turnId = 'turn-inline-skill-bounds'
  const limits = INLINE_SKILL_DEFINITION_LIMITS
  const engine = createTestEngine({
    runLoop: async () => ({ text: 'bounded inline skill', artifactIds: [], iterations: 0 }),
  })

  await engine.startTurn({
    userId,
    sessionId: 'turn-engine-session',
    turnId,
    content: 'run the bounded skill',
    skillIds: ['bounded-local-skill'],
    skillDefinitions: [{
      id: 'bounded-local-skill',
      name: 'N'.repeat(limits.name.maxCharacters + 400),
      description: '说明🙂'.repeat(limits.description.maxCharacters + 100),
      permissions: Array.from({ length: limits.maxPermissions + 10 }, (_, index) => (
        `permission-${index}-` + 'x'.repeat(limits.permission.maxCharacters + 100)
      )),
      systemPrompt: '执行并验证🙂'.repeat(limits.systemPrompt.maxUtf8Bytes),
    }],
  })
  await engine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId })

  const definition = events(turnId).find((event) => event.type === 'turn.started')?.payload.skillDefinitions?.[0]
  assert.ok(definition)
  assert.ok(unicodeCharacterLength(definition.name) <= limits.name.maxCharacters)
  assert.ok(utf8ByteLength(definition.name) <= limits.name.maxUtf8Bytes)
  assert.ok(unicodeCharacterLength(definition.description) <= limits.description.maxCharacters)
  assert.ok(utf8ByteLength(definition.description) <= limits.description.maxUtf8Bytes)
  assert.equal(definition.permissions.length, limits.maxPermissions)
  assert.ok(definition.permissions.every((permission) => (
    unicodeCharacterLength(permission) <= limits.permission.maxCharacters
      && utf8ByteLength(permission) <= limits.permission.maxUtf8Bytes
  )))
  assert.ok(utf8ByteLength(definition.systemPrompt) <= limits.systemPrompt.maxUtf8Bytes)
  assert.match(definition.systemPrompt, /gugo-skill-quality:v1/)
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
  assert.equal((await engine.getTurn({ userId, sessionId: 'turn-engine-session', turnId })).status, 'paused')
  assert.equal(memoryExtractions, 0)
  const pausedMessage = getMessage({
    userId,
    sessionId: 'turn-engine-session',
    messageId: `${turnId}:assistant`,
  })
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
    authorization_scope: 'session',
    grant_id: 'turn-directory-resolution-grant',
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

  grants = [{
    id: resolution.grant_id,
    path: tempDir,
    resourceType: 'directory',
    accessMode: 'read_write',
    scope: resolution.authorization_scope,
    available: true,
  }]
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
  const completedMessage = getMessage({
    userId,
    sessionId: 'turn-engine-session',
    messageId: `${turnId}:assistant`,
  })
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
  assert.equal(turnEvents.some((event) => event.type === 'turn.completed'), false)
  const failed = turnEvents.at(-1)
  assert.equal(failed.type, 'turn.failed')
  assert.equal(Object.hasOwn(failed.payload, 'message'), false)
  assert.equal(Object.hasOwn(failed.payload.error, 'message'), false)
  assert.equal((await engine.getTurn({ userId, sessionId: 'turn-engine-session', turnId })).status, 'failed')
})

test('TurnEngine projects a missing clarification as a stable reason code without server copy', async () => {
  const turnId = 'turn-code-only-clarification'
  const engine = createTestEngine({
    runLoop: async () => ({ paused: true, artifactIds: [], iterations: 1 }),
  })

  await engine.startTurn({
    userId,
    sessionId: 'turn-engine-session',
    turnId,
    content: 'Pause without a model-authored question.',
  })
  await engine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId })

  const paused = events(turnId).at(-1)
  assert.equal(paused.type, 'turn.paused')
  assert.equal(paused.payload.text, '')
  assert.deepEqual(paused.payload.clarification, {
    reason_code: 'clarification_required',
    blocker_kind: 'missing_info',
  })
  assert.equal(JSON.stringify(paused.payload).includes('需要你补充信息'), false)
  const message = getMessage({
    userId,
    sessionId: 'turn-engine-session',
    messageId: `${turnId}:assistant`,
  })
  assert.equal(message.content, '')
  assert.equal(message.modelContext.clarification.reason_code, 'clarification_required')
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

test('TurnEngine restores a persisted inline skill into prompt preparation after restart', async () => {
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
        skillDefinitions: [{
          id: 'skill-resume',
          name: 'Persisted local skill',
          description: 'Survives process restart.',
          permissions: ['read'],
          systemPrompt: 'Use the persisted local workflow.',
        }],
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
  assert.equal(promptRequest.skillDefinitions[0].id, 'skill-resume')
  assert.match(promptRequest.skillDefinitions[0].systemPrompt, /Use the persisted local workflow\./)
  assert.deepEqual(toolRequest.toolsConfig, { enabled: [], disabled: ['bash_exec'] })
  assert.equal(loopOptions.skillId, 'skill-resume')
  assert.equal(loopOptions.job.agentId, 'agent-resume')
  assert.equal(loopOptions.intentMode, 'answer')
})

test('TurnEngine blocks legacy checkpoints without a v4 snapshot and explicit retry remains blocked', async () => {
  const turnId = 'turn-legacy-checkpoint-environment-missing'
  appendTurnEvent({
    userId,
    event: createTurnEvent({
      id: `${turnId}:start`,
      sessionId: 'turn-engine-session',
      turnId,
      sequence: 0,
      type: 'turn.started',
      payload: { content: 'Do not adopt the current runtime.' },
      createdAt: 1,
    }),
  })
  appendLegacyTurnEvent({
    userId,
    event: createTurnEvent({
      id: `${turnId}:checkpoint`,
      sessionId: 'turn-engine-session',
      turnId,
      sequence: 1,
      type: 'turn.checkpoint',
      payload: { state: { messages: [], artifactIds: [], iterations: 1 } },
      createdAt: 2,
    }),
  })
  let loopCalls = 0
  const engine = createTestEngine({
    readFileAccessStatus: () => ({ grants: [] }),
    readRuntimePlugins: () => [],
    readRuntimePluginStates: () => [],
    runLoop: async () => {
      loopCalls += 1
      return { text: 'unsafe', artifactIds: [], iterations: 1 }
    },
  })

  await engine.resumeTurn({ userId, sessionId: 'turn-engine-session', turnId })
  await engine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId })

  assert.equal(loopCalls, 0)
  const firstBlocked = events(turnId).at(-1)
  assert.equal(firstBlocked.type, 'turn.blocked')
  assert.equal(firstBlocked.payload.code, 'TURN_EXECUTION_ENVIRONMENT_MISSING')
  assert.equal(firstBlocked.payload.retryable, false)
  assert.equal(events(turnId).some((event) => event.type === 'turn.failed'), false)
  const retainedCheckpoint = events(turnId).find((event) => event.type === 'turn.checkpoint')
  assert.equal(retainedCheckpoint?.sequence, 1)
  assert.equal(getTurnRecoveryState({
    userId,
    sessionId: 'turn-engine-session',
    turnId,
  })?.status, 'dead_letter')

  await engine.resumeTurn({
    userId,
    sessionId: 'turn-engine-session',
    turnId,
    retryRecovery: true,
  })
  await engine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId })
  const blockedEvents = events(turnId).filter((event) => event.type === 'turn.blocked')
  assert.equal(blockedEvents.length, 2)
  assert.equal(blockedEvents.at(-1).payload.code, 'TURN_EXECUTION_ENVIRONMENT_MISSING')
  assert.equal(loopCalls, 0)
  assert.equal(
    events(turnId).filter((event) => event.type === 'turn.checkpoint').length,
    1,
  )
  assert.equal(
    events(turnId).find((event) => event.type === 'turn.checkpoint')?.sequence,
    retainedCheckpoint.sequence,
  )
})

test('TurnEngine resumes after a final bookkeeping tool when workspace failure codes are persisted', async () => {
  const turnId = 'turn-resume-workspace-status-error-code'
  const unavailableTrust = {
    rootPath: 'E:/missing-workspace',
    trusted: false,
    available: false,
    trustRootPath: null,
    trustScope: null,
    inherited: false,
    trustedAt: null,
    updatedAt: null,
    config: {
      present: null,
      valid: false,
      loaded: false,
      blocked: false,
      path: null,
      sourceRoot: null,
      permissions: null,
      error: { code: 'WORKSPACE_CONFIG_INVALID' },
    },
    global: {},
    effective: {},
    error: { code: 'WORKSPACE_PATH_NOT_FOUND' },
  }
  const fileAccess = {
    projectDirectory: tempDir,
    defaultOutputDirectory: tempDir,
    grants: [],
    workspace: { enabled: false },
    trustedWorkspaces: [unavailableTrust],
    runtime: { localCodeExecutionEnabled: false },
  }
  appendTurnEvent({
    userId,
    event: createTurnEvent({
      id: `${turnId}:start`,
      sessionId: 'turn-engine-session',
      turnId,
      sequence: 0,
      type: 'turn.started',
      payload: { content: 'Finish the project after the final progress review.' },
      createdAt: 1,
    }),
  })
  appendTurnEvent({
    userId,
    event: createTurnEvent({
      id: `${turnId}:checkpoint`,
      sessionId: 'turn-engine-session',
      turnId,
      sequence: 1,
      type: 'turn.checkpoint',
      payload: { storage: 'turn_checkpoints', checkpointVersion: 1 },
      createdAt: 2,
    }),
    checkpointState: {
      approvalMode: 'normal',
      executionEnvironment: checkpointEnvironment({ fileAccess }),
      messages: [
        { role: 'user', content: 'Finish the project after the final progress review.' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'final-reflect',
            type: 'function',
            function: {
              name: 'reflect',
              arguments: '{"observation":"implementation complete","next_step":"done"}',
            },
          }],
        },
        {
          role: 'tool',
          tool_call_id: 'final-reflect',
          name: 'reflect',
          content: '{"ok":true,"accepted":true}',
        },
      ],
      toolCalls: [{
        id: 'final-reflect',
        name: 'reflect',
        args: { observation: 'implementation complete', next_step: 'done' },
        checkpointStatus: 'completed',
        checkpointResult: { ok: true, accepted: true },
      }],
      artifactIds: [],
      iterations: 1,
    },
  })

  let restoredCheckpoint = null
  const engine = createTestEngine({
    ...checkpointEnvironmentEngineOptions([], fileAccess),
    runLoop: async (options) => {
      restoredCheckpoint = await options.loadCheckpoint()
      return { text: 'Recovered and completed.', artifactIds: [], iterations: 2 }
    },
  })

  await engine.resumeTurn({ userId, sessionId: 'turn-engine-session', turnId })
  await engine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId })

  assert.equal(restoredCheckpoint?.toolCalls?.at(-1)?.name, 'reflect')
  assert.equal(events(turnId).at(-1)?.type, 'turn.completed')
  assert.equal(
    events(turnId).some((event) => (
      event.type === 'turn.blocked'
      && event.payload?.code === 'TURN_EXECUTION_ENVIRONMENT_MISSING'
    )),
    false,
  )
})

test('TurnEngine blocks when checkpoint approval mode disagrees with its execution snapshot', async () => {
  const turnId = 'turn-checkpoint-approval-mode-mismatch'
  appendTurnEvent({
    userId,
    event: createTurnEvent({
      id: `${turnId}:start`,
      sessionId: 'turn-engine-session',
      turnId,
      sequence: 0,
      type: 'turn.started',
      payload: { content: 'Do not trust a conflicting checkpoint permission.' },
      createdAt: 1,
    }),
  })
  appendLegacyTurnEvent({
    userId,
    event: createTurnEvent({
      id: `${turnId}:checkpoint`,
      sessionId: 'turn-engine-session',
      turnId,
      sequence: 1,
      type: 'turn.checkpoint',
      payload: {
        state: {
          messages: [],
          artifactIds: [],
          iterations: 1,
          approvalMode: 'bypass',
          executionEnvironment: checkpointEnvironment(),
        },
      },
      createdAt: 2,
    }),
  })
  let loopCalls = 0
  const engine = createTestEngine({
    ...checkpointEnvironmentEngineOptions(),
    runLoop: async () => {
      loopCalls += 1
      return { text: 'unsafe', artifactIds: [], iterations: 1 }
    },
  })

  await engine.resumeTurn({ userId, sessionId: 'turn-engine-session', turnId })
  await engine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId })

  assert.equal(loopCalls, 0)
  const blocked = events(turnId).at(-1)
  assert.equal(blocked.type, 'turn.blocked')
  assert.equal(blocked.payload.code, 'TURN_PERMISSION_CONTEXT_DRIFT')
  assert.equal(blocked.payload.retryable, false)
  assert.equal(events(turnId).some((event) => event.type === 'turn.failed'), false)
})

test('TurnEngine resets only the unconfirmed streaming suffix before a recovered model call', async () => {
  const turnId = 'turn-stream-recovery'
  const persist = (sequence, type, payload = {}) => {
    const entry = {
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
    }
    return type === 'turn.checkpoint'
      ? appendLegacyTurnEvent(entry)
      : appendTurnEvent(entry)
  }
  persist(0, 'turn.started', { content: 'resume interrupted output' })
  persist(1, 'assistant.delta', { text: 'confirmed answer' })
  persist(2, 'reasoning.delta', { text: 'confirmed reasoning' })
  persist(3, 'turn.checkpoint', {
    state: {
      messages: [],
      approvalMode: 'normal',
      executionEnvironment: checkpointEnvironment(),
    },
  })
  persist(4, 'assistant.delta', { text: ' stale half sentence' })
  persist(5, 'reasoning.delta', { text: ' stale reasoning' })

  let eventAtModelCall = null
  const engine = createTestEngine({
    ...checkpointEnvironmentEngineOptions(),
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
    [2, 'turn.checkpoint', {
      state: {
        messages: [],
        approvalMode: 'normal',
        executionEnvironment: checkpointEnvironment(),
      },
    }],
  ]) {
    const appendFixtureEvent = type === 'turn.checkpoint'
      ? appendLegacyTurnEvent
      : appendTurnEvent
    appendFixtureEvent({
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
    ...checkpointEnvironmentEngineOptions(),
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
  const turnEvents = events('turn-tools')
  const types = turnEvents.map((event) => event.type)
  for (const type of ['tool.call', 'tool.started', 'tool.completed', 'turn.completed']) assert.ok(types.includes(type))
  const started = turnEvents.find((event) => event.type === 'tool.started')
  assert.equal(started.payload.args.path, 'README.md')
  assert.equal(started.payload.outputReplay, 'live_only')
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
  assert.equal(Object.hasOwn(interrupted.payload, 'message'), false)
  assert.equal(interrupted.payload.retryable, true)
  assert.equal(interrupted.payload.text, '')
  assert.equal(interruptedEvents.some((event) => event.type === 'turn.completed'), false)
  assert.equal((await engine.getTurn({ userId, sessionId: 'turn-engine-session', turnId })).status, 'interrupted')
  const interruptedEvidence = getMessage({
    userId,
    sessionId: 'turn-engine-session',
    messageId: `${turnId}:assistant`,
  })
  assert.equal(interruptedEvidence?.modelContext?.turnEvidence, true)
  assert.equal(interruptedEvidence?.modelContext?.evidenceState, 'interrupted')
  assert.equal(interruptedEvidence?.modelContext?.serverLastSequence, interrupted.sequence)
  assert.equal(interruptedEvidence?.content, '')
  const interruptedCheckpoint = getTurnCheckpoint({
    userId,
    sessionId: 'turn-engine-session',
    turnId,
  }).state
  assert.match(
    interruptedCheckpoint.messages.find((message) => (
      message.role === 'tool' && message.tool_call_id === 'read-once'
    ))?.content || '',
    /durable README content/,
  )
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
  assert.equal(getMessage({
    userId,
    sessionId: 'turn-engine-session',
    messageId: `${turnId}:assistant`,
  })?.content, 'Recovered from the durable tool result.')
  const completedAssistant = getMessage({
    userId,
    sessionId: 'turn-engine-session',
    messageId: `${turnId}:assistant`,
  })
  assert.notEqual(completedAssistant?.modelContext?.turnEvidence, true)
  assert.equal(completedAssistant?.modelContext?.toolTrace?.length, 2)
})

test('TurnEngine pauses at approval and resumes after the persisted decision', async (t) => {
  setApprovalMode({ userId, mode: 'normal' })
  t.after(() => {
    getDb().prepare('DELETE FROM user_approval_settings WHERE user_id = ?').run(userId)
  })
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
    { name: 'read_file', args: { path: 'safe-note.txt' } },
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
  assert.equal((await engine.getTurn({ userId, sessionId: 'turn-engine-session', turnId: 'turn-approval' })).status, 'completed')
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
  const cancelled = events('turn-cancel').at(-1)
  assert.equal(cancelled.type, 'turn.cancelled')
  assert.equal(cancelled.payload.code, 'TURN_CANCELLED')
  assert.equal(Object.hasOwn(cancelled.payload, 'reason'), false)
  assert.equal(Object.hasOwn(cancelled.payload, 'message'), false)
  assert.deepEqual(cancelled.payload.artifactIds, [])
  assert.deepEqual(cancelled.payload.deliveryArtifactIds, [])
  assert.equal(getMessage({
    userId,
    sessionId: 'turn-engine-session',
    messageId: 'turn-cancel:assistant',
  })?.content, '')
})

test('TurnEngine keeps turn.cancelled durable when cancelled evidence message persistence fails', async () => {
  const turnId = 'turn-cancel-message-write-failure'
  let ready
  const checkpointReady = new Promise((resolve) => { ready = resolve })
  const engine = createTestEngine({
    runLoop: async ({ signal }) => {
      ready()
      await new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
      return { text: 'unreachable' }
    },
    writeMessage: (message) => {
      if (message.id === `${turnId}:assistant`) throw new Error('cancelled message write failed')
      return upsertMessage(message)
    },
  })

  await engine.startTurn({
    userId,
    sessionId: 'turn-engine-session',
    turnId,
    content: 'Wait until cancelled.',
  })
  await checkpointReady
  await engine.cancelTurn({ userId, sessionId: 'turn-engine-session', turnId })
  await engine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId })

  assert.equal(events(turnId).at(-1)?.type, 'turn.cancelled')
  assert.equal(listMessages({ userId, sessionId: 'turn-engine-session', limit: 500 })
    .some((message) => message.id === `${turnId}:assistant`), false)
})

test('TurnEngine requests cancellation when recovery wins the inactive-turn execution fence', async () => {
  const turnId = 'turn-cancel-recovery-race'
  appendTurnEvent({
    userId,
    event: createTurnEvent({
      id: `${turnId}:started`, sessionId: 'turn-engine-session', turnId, sequence: 0,
      type: 'turn.started', payload: { content: 'recover me' }, createdAt: 1,
    }),
  })
  let cancellationRequests = 0
  let acquireCalls = 0
  const engine = createTestEngine({
    runtimeCore: {
      checkpoint: { load: () => null, save: () => null, clear: () => 0 },
      lease: {
        isActive: () => true,
        requestCancellation: () => {
          cancellationRequests += 1
          return cancellationRequests === 2
        },
        acquire: () => {
          acquireCalls += 1
          return null
        },
        closeSteeringInbox: () => null,
      },
      approval: { release: () => 0 },
    },
  })

  const turn = await engine.cancelTurn({ userId, sessionId: 'turn-engine-session', turnId })
  assert.equal(turn.status, 'cancelling')
  assert.equal(acquireCalls, 1)
  assert.equal(cancellationRequests, 2)
  assert.deepEqual(events(turnId).map(({ type }) => type), ['turn.started'])
})

test('TurnEngine reports deferred event loss instead of masking it as cancellation', async () => {
  const turnId = 'turn-cancel-after-event-loss'
  let ready
  const deltaQueued = new Promise((resolve) => { ready = resolve })
  const writer = createEventWriteBehind({
    writeBatch() { throw new Error('delta persistence failed') },
    logger: { error() {} },
    maxDelayMs: 10_000,
    maxAttempts: 1,
  })
  const engine = createTestEngine({
    eventWriteBehindFactory: () => writer,
    runLoop: async ({ onModelDelta, signal }) => {
      await onModelDelta({ text: 'not durable', iteration: 0, modelName: 'test' })
      ready()
      await new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
      return { text: 'unreachable' }
    },
  })

  await engine.startTurn({
    userId,
    sessionId: 'turn-engine-session',
    turnId,
    content: 'Cancel after the stream write is queued.',
  })
  await deltaQueued
  await engine.cancelTurn({ userId, sessionId: 'turn-engine-session', turnId })
  await engine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId })

  const turnEvents = events(turnId)
  assert.equal(turnEvents.some(({ type }) => type === 'turn.cancelled'), false)
  assert.equal(turnEvents.at(-1)?.type, 'turn.failed')
  assert.equal(turnEvents.at(-1)?.payload.code, 'TURN_EVENT_PERSISTENCE_FAILED')
})

test('TurnEngine does not persist a cancelled message when terminal event append fails', async () => {
  const turnId = 'turn-cancel-event-append-failure'
  appendTurnEvent({
    userId,
    event: createTurnEvent({
      id: `${turnId}:started`,
      sessionId: 'turn-engine-session',
      turnId,
      sequence: 0,
      type: 'turn.started',
      payload: { content: 'Cancel after worker restart.' },
      createdAt: 1,
    }),
  })
  let assistantWrites = 0
  const engine = createTestEngine({
    executionLeases: {
      ownerId: 'cancel-event-failure-worker',
      claim: () => true,
      hold: () => () => {},
      isActive: () => false,
      requestCancellation: () => false,
    },
    appendEvent: async ({ event, ...rest }) => {
      if (event.type === 'turn.cancelled') throw new Error('cancel event append failed')
      return appendTurnEvent({ event, ...rest })
    },
    writeMessage: (message) => {
      if (message.id === `${turnId}:assistant`) assistantWrites += 1
      return upsertMessage(message)
    },
  })

  await assert.rejects(
    engine.cancelTurn({ userId, sessionId: 'turn-engine-session', turnId }),
    /cancel event append failed/,
  )
  assert.equal(assistantWrites, 0)
  assert.equal(listMessages({ userId, sessionId: 'turn-engine-session', limit: 500 })
    .some((message) => message.id === `${turnId}:assistant`), false)
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
  const evidence = getMessage({
    userId,
    sessionId: 'turn-engine-session',
    messageId: `${turnId}:assistant`,
  })
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
  assert.equal(failed.payload.incompleteReason, 'post_mutation_verification_missing')
  assert.deepEqual(failed.payload.missingRequirements, ['mutation_readback', 'diff_or_project_check'])
  assert.equal(failed.payload.error.incompleteReason, 'post_mutation_verification_missing')
  assert.deepEqual(failed.payload.error.missingRequirements, ['mutation_readback', 'diff_or_project_check'])
  assert.equal(failed.payload.error.retryable, true)
  assert.equal(Object.hasOwn(failed.payload, 'message'), false)
  assert.equal(Object.hasOwn(failed.payload.error, 'message'), false)
  assert.equal(failed.payload.partialText, '')
  assert.doesNotMatch(failed.payload.partialText, /requested mutation could not be verified/i)
  assert.deepEqual(failed.payload.artifactIds, ['artifact-unverified'])
  assert.equal((await engine.getTurn({ userId, sessionId: 'turn-engine-session', turnId })).status, 'failed')
  const evidence = getMessage({
    userId,
    sessionId: 'turn-engine-session',
    messageId: `${turnId}:assistant`,
  })
  assert.equal(evidence?.modelContext?.evidenceState, 'failed')
  assert.equal(evidence?.modelContext?.error?.incompleteReason, 'post_mutation_verification_missing')
  assert.deepEqual(evidence?.modelContext?.error?.missingRequirements, ['mutation_readback', 'diff_or_project_check'])
  assert.equal(evidence?.content, '')
})

test('TurnEngine preserves a concrete task-verification blocker and structured recovery data', async () => {
  const turnId = `turn-task-verification-blocker-${Date.now()}`
  const blocker = 'Task verification did not pass (test@. via npm test). Last failure: src/result.test.js expected 2, received 1.'
  const taskVerification = {
    version: 1,
    maxFailures: 3,
    consecutiveFailures: 3,
    checks: [{
      status: 'failed',
      kind: 'test',
      cwd: '.',
      commandScope: 'npm test',
      coverage: 'cwd',
      code: 'task_test_failed',
      failures: 3,
      requiredEpoch: 2,
      mutationTargets: ['src/result.js'],
      diagnostic: 'src/result.test.js expected 2, received 1',
    }],
  }
  const engine = createTestEngine({
    runLoop: async () => ({
      text: blocker,
      iterations: 6,
      incomplete: true,
      code: 'TASK_VERIFICATION_REPAIR_EXHAUSTED',
      reason: 'task_verification_repair_exhausted',
      missingRequirements: [
        'verification_failure_repair',
        'passing_project_check',
        'explicit_recovery_retry',
      ],
      retryable: false,
      manualRetryable: true,
      taskVerification,
    }),
  })

  await engine.startTurn({
    userId,
    sessionId: 'turn-engine-session',
    turnId,
    content: 'Fix the failing implementation and verify the project.',
  })
  await engine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId })

  const failed = events(turnId).at(-1)
  assert.equal(failed.type, 'turn.failed')
  assert.equal(failed.payload.code, 'TASK_VERIFICATION_REPAIR_EXHAUSTED')
  assert.equal(failed.payload.incompleteReason, 'task_verification_repair_exhausted')
  assert.equal(failed.payload.partialText, '')
  assert.equal(failed.payload.error.retryable, false)
  assert.equal(failed.payload.error.manualRetryable, true)
  assert.deepEqual(failed.payload.error.missingRequirements, [
    'verification_failure_repair',
    'passing_project_check',
    'explicit_recovery_retry',
  ])
  assert.deepEqual(failed.payload.error.taskVerification.checks[0], {
    ...taskVerification.checks[0],
    code: 'TASK_TEST_FAILED',
  })

  const evidence = getMessage({
    userId,
    sessionId: 'turn-engine-session',
    messageId: `${turnId}:assistant`,
  })
  assert.equal(evidence?.content, '')
  assert.equal(evidence?.modelContext?.error?.retryable, false)
  assert.deepEqual(
    evidence?.modelContext?.error?.taskVerification,
    failed.payload.error.taskVerification,
  )
})

test('TurnEngine executes one explicit manual retry and resets the exhausted verification budget', async () => {
  const turnId = `turn-task-verification-manual-retry-${Date.now()}`
  let loopCalls = 0
  const engine = createTestEngine({
    runLoop: async ({ loadCheckpoint, saveCheckpoint }) => {
      loopCalls += 1
      if (loopCalls === 1) {
        await saveCheckpoint({
          messages: [],
          artifactIds: [],
          iterations: 3,
          completionGuards: {
            pendingMutationTargets: ['src/result.js'],
            taskVerificationRepair: {
              consecutiveFailures: 3,
              lastFailureBatchId: 'failure-batch-3',
              pending: [{
                kind: 'test',
                cwd: '.',
                commandScope: 'npm test',
                coverage: 'cwd',
                failures: 3,
                lastFailureBatchId: 'failure-batch-3',
              }],
            },
          },
          final: { incomplete: true },
        })
        return {
          incomplete: true,
          code: 'TASK_VERIFICATION_REPAIR_EXHAUSTED',
          reason: 'task_verification_repair_exhausted',
          retryable: false,
          manualRetryable: true,
          iterations: 3,
        }
      }
      const restored = await loadCheckpoint()
      assert.equal(restored.completionGuards.taskVerificationRepair.consecutiveFailures, 0)
      assert.equal(restored.completionGuards.taskVerificationRepair.pending[0].failures, 0)
      assert.deepEqual(restored.completionGuards.pendingMutationTargets, ['src/result.js'])
      return { text: '修复后验证已通过。', iterations: 4 }
    },
  })

  await engine.startTurn({
    userId,
    sessionId: 'turn-engine-session',
    turnId,
    content: '修复失败检查并重新验证。',
  })
  await engine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId })
  assert.equal(events(turnId).at(-1)?.payload?.error?.manualRetryable, true)

  await engine.resumeTurn({
    userId,
    sessionId: 'turn-engine-session',
    turnId,
    retryFailed: true,
  })
  await engine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId })

  const turnEvents = events(turnId)
  assert.equal(turnEvents.find((event) => event.type === 'turn.attempt')?.payload?.manualRetry, true)
  assert.equal(turnEvents.at(-1)?.type, 'turn.completed')
  assert.equal(loopCalls, 2)
})

test('TurnEngine projects reasoning runaway with a stable reason and concrete missing requirement', async () => {
  const turnId = 'turn-reasoning-runaway-incomplete'
  const engine = createTestEngine({
    runLoop: async () => ({
      text: '模型推理超过安全上限，任务已停止。',
      iterations: 1,
      incomplete: true,
      code: 'REASONING_RUNAWAY',
      reason: 'internal provider-specific reasoning limit detail',
    }),
  })

  await engine.startTurn({
    userId,
    sessionId: 'turn-engine-session',
    turnId,
    content: 'Complete the task without exceeding the safe reasoning limit.',
  })
  await engine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId })

  const failed = events(turnId).at(-1)
  assert.equal(failed.type, 'turn.failed')
  assert.equal(failed.payload.code, 'REASONING_RUNAWAY')
  assert.equal(failed.payload.incompleteReason, 'reasoning_runaway')
  assert.deepEqual(failed.payload.missingRequirements, ['bounded_model_response'])
  assert.equal(failed.payload.error.incompleteReason, 'reasoning_runaway')
  assert.deepEqual(failed.payload.error.missingRequirements, ['bounded_model_response'])
  assert.equal(failed.payload.error.retryable, false)
})

test('TurnEngine preserves deterministic no-progress failures and forbids failed retry', async () => {
  const turnId = 'turn-non-retryable-repeat-window'
  const hint = '请停止交替重复读取，改用已有结果完成验证。'
  const engine = createTestEngine({
    runLoop: async ({ saveCheckpoint }) => {
      await saveCheckpoint({
        messages: [],
        artifactIds: [],
        iterations: 7,
        final: {
          text: '工具调用重复，任务未完成。',
          iterations: 7,
          incomplete: true,
          noProgress: true,
          code: 'repeated_tool_call_window',
          retryable: false,
          hint,
        },
      })
      return {
        text: '工具调用重复，任务未完成。',
        artifactIds: [],
        iterations: 7,
        incomplete: true,
        noProgress: true,
        code: 'repeated_tool_call_window',
        retryable: false,
        hint,
        reason: '同一工具调用反复出现，未取得实质进展',
      }
    },
  })

  await engine.startTurn({
    userId,
    sessionId: 'turn-engine-session',
    turnId,
    content: '完成工具任务。',
  })
  await engine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId })

  const failed = events(turnId).at(-1)
  assert.equal(failed.type, 'turn.failed')
  assert.equal(failed.payload.code, 'REPEATED_TOOL_CALL_WINDOW')
  assert.equal(failed.payload.error.retryable, false)
  assert.equal(Object.hasOwn(failed.payload.error, 'hint'), false)
  assert.equal(Object.hasOwn(failed.payload, 'message'), false)
  await assert.rejects(
    engine.resumeTurn({
      userId,
      sessionId: 'turn-engine-session',
      turnId,
      retryFailed: true,
    }),
    (error) => error?.code === 'TURN_FAILED_RETRY_NOT_ALLOWED',
  )
})

test('TurnEngine coalesces concurrent failed-turn retries on the original Turn', async () => {
  const turnId = 'turn-incomplete-concurrent-retry'
  let loopCalls = 0
  let releaseRetry
  const retryGate = new Promise((resolve) => { releaseRetry = resolve })
  const engine = createTestEngine({
    runLoop: async ({ loadCheckpoint, saveCheckpoint }) => {
      loopCalls += 1
      if (loopCalls === 1) {
        await saveCheckpoint({
          messages: [],
          artifactIds: ['artifact-retained-across-retry'],
          iterations: 1,
          final: {
            text: 'The first attempt needs another pass.',
            iterations: 1,
            incomplete: true,
            reason: 'verification_pending',
          },
        })
        return {
          text: 'The first attempt needs another pass.',
          artifactIds: ['artifact-retained-across-retry'],
          iterations: 1,
          incomplete: true,
          reason: 'verification_pending',
        }
      }
      const resumedCheckpoint = await loadCheckpoint()
      assert.equal(resumedCheckpoint.final, null)
      assert.deepEqual(resumedCheckpoint.artifactIds, ['artifact-retained-across-retry'])
      await retryGate
      return {
        text: 'The original Turn is now complete.',
        artifactIds: ['artifact-retained-across-retry'],
        iterations: 2,
      }
    },
  })

  await engine.startTurn({
    userId,
    sessionId: 'turn-engine-session',
    turnId,
    content: 'Finish this without creating another user message.',
  })
  await engine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId })
  assert.equal(events(turnId).at(-1)?.type, 'turn.failed')
  const messagesBeforeRetry = listMessages({
    userId,
    sessionId: 'turn-engine-session',
    limit: 500,
  })
  const userMessageIdsBeforeRetry = messagesBeforeRetry
    .filter((message) => message.role === 'user')
    .map((message) => message.id)

  const retryScope = {
    userId,
    sessionId: 'turn-engine-session',
    turnId,
    retryFailed: true,
  }
  const resumed = await Promise.all([
    engine.resumeTurn(retryScope),
    engine.resumeTurn(retryScope),
  ])
  assert.deepEqual(resumed.map((turn) => turn.turnId), [turnId, turnId])

  releaseRetry()
  await engine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId })

  const turnEvents = events(turnId)
  assert.equal(turnEvents.filter((event) => event.type === 'turn.started').length, 1)
  assert.equal(turnEvents.filter((event) => (
    event.type === 'turn.attempt' && event.payload?.reason === 'failed_retry'
  )).length, 1)
  assert.equal(turnEvents.at(-1)?.type, 'turn.completed')
  assert.equal(loopCalls, 2)
  const userMessageIdsAfterRetry = listMessages({
    userId,
    sessionId: 'turn-engine-session',
    limit: 500,
  }).filter((message) => message.role === 'user').map((message) => message.id)
  assert.deepEqual(userMessageIdsAfterRetry, userMessageIdsBeforeRetry)
})

test('TurnEngine allows one checkpoint retry and closes a repeatedly incomplete turn', async () => {
  const turnId = 'turn-incomplete-retry-limit'
  let loopCalls = 0
  const engine = createTestEngine({
    runLoop: async ({ saveCheckpoint }) => {
      loopCalls += 1
      if (loopCalls === 1) {
        await saveCheckpoint({
          messages: [],
          artifactIds: ['retained-output'],
          iterations: 1,
          final: {
            text: '第一次执行仍需验证。',
            iterations: 1,
            incomplete: true,
          },
        })
      }
      return {
        text: loopCalls === 1 ? '第一次执行仍需验证。' : '续写后仍缺少最终验证。',
        artifactIds: ['retained-output'],
        iterations: loopCalls,
        incomplete: true,
        reason: '最终验证仍未完成',
      }
    },
  })

  await engine.startTurn({
    userId,
    sessionId: 'turn-engine-session',
    turnId,
    content: '完成并验证任务。',
  })
  await engine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId })
  assert.equal(events(turnId).at(-1)?.payload?.error?.retryable, true)

  await engine.resumeTurn({
    userId,
    sessionId: 'turn-engine-session',
    turnId,
    retryFailed: true,
  })
  await engine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId })

  const repeatedFailure = events(turnId).at(-1)
  assert.equal(repeatedFailure.type, 'turn.failed')
  assert.equal(repeatedFailure.payload.code, 'TURN_INCOMPLETE')
  assert.equal(repeatedFailure.payload.error.retryable, false)
  assert.equal(Object.hasOwn(repeatedFailure.payload.error, 'hint'), false)
  assert.equal(loopCalls, 2)
  await assert.rejects(
    engine.resumeTurn({
      userId,
      sessionId: 'turn-engine-session',
      turnId,
      retryFailed: true,
    }),
    (error) => error?.code === 'TURN_FAILED_RETRY_LIMIT_REACHED'
      && error?.message === 'TURN_FAILED_RETRY_LIMIT_REACHED'
      && error?.retryable === false
      && !Object.hasOwn(error, 'hint'),
  )
})

test('TurnEngine permanently seals a failed retry when its checkpoint is missing', async () => {
  const turnId = 'turn-incomplete-missing-retry-checkpoint'
  let loopCalls = 0
  const engine = createTestEngine({
    runLoop: async () => {
      loopCalls += 1
      return {
        text: '任务产生了部分结果，但没有可验证的恢复检查点。',
        artifactIds: [],
        iterations: 1,
        incomplete: true,
        reason: 'checkpoint_missing',
      }
    },
  })

  await engine.startTurn({
    userId,
    sessionId: 'turn-engine-session',
    turnId,
    content: '完成任务并验证结果。',
  })
  await engine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId })

  const failure = events(turnId).at(-1)
  const eventCount = events(turnId).length
  assert.equal(failure.type, 'turn.failed')
  assert.equal(failure.payload.error.retryable, true)
  assert.equal(getTurnCheckpoint({ userId, sessionId: 'turn-engine-session', turnId }), null)

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(
      engine.resumeTurn({
        userId,
        sessionId: 'turn-engine-session',
        turnId,
        retryFailed: true,
      }),
      (error) => error?.code === 'TURN_FAILED_RETRY_CHECKPOINT_REQUIRED'
        && error?.retryable === false
        && error?.message === 'TURN_FAILED_RETRY_CHECKPOINT_REQUIRED',
    )
  }

  const sealedEvidence = getMessage({
    userId,
    sessionId: 'turn-engine-session',
    messageId: `${turnId}:assistant`,
  })
  assert.equal(sealedEvidence?.modelContext?.turnEvidence, true)
  assert.equal(sealedEvidence?.modelContext?.evidenceState, 'failed')
  assert.equal(sealedEvidence?.modelContext?.serverLastSequence, failure.sequence)
  assert.equal(sealedEvidence?.modelContext?.error?.code, 'TURN_FAILED_RETRY_CHECKPOINT_REQUIRED')
  assert.equal(sealedEvidence?.modelContext?.error?.retryable, false)
  assert.equal(Object.hasOwn(sealedEvidence?.modelContext?.error || {}, 'message'), false)
  assert.equal(Object.hasOwn(sealedEvidence?.modelContext?.error || {}, 'hint'), false)
  assert.deepEqual(sealedEvidence?.modelContext?.failedRetryRejection, {
    code: 'TURN_FAILED_RETRY_CHECKPOINT_REQUIRED',
    failureSequence: failure.sequence,
  })
  assert.equal(events(turnId).length, eventCount)
  assert.equal(events(turnId).at(-1)?.id, failure.id)
  assert.equal(loopCalls, 1)
})

test('TurnEngine permanently seals a manually recoverable failure when its checkpoint is missing', async () => {
  const turnId = `turn-manual-retry-missing-checkpoint-${Date.now()}`
  let loopCalls = 0
  const engine = createTestEngine({
    runLoop: async () => {
      loopCalls += 1
      return {
        incomplete: true,
        code: 'TASK_VERIFICATION_REPAIR_EXHAUSTED',
        reason: 'task_verification_repair_exhausted',
        retryable: false,
        manualRetryable: true,
        iterations: 3,
      }
    },
  })

  await engine.startTurn({
    userId,
    sessionId: 'turn-engine-session',
    turnId,
    content: '修复检查失败并重新验证。',
  })
  await engine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId })

  const failure = events(turnId).at(-1)
  const eventCount = events(turnId).length
  assert.equal(failure.type, 'turn.failed')
  assert.equal(failure.payload.error.retryable, false)
  assert.equal(failure.payload.error.manualRetryable, true)
  assert.equal(getTurnCheckpoint({ userId, sessionId: 'turn-engine-session', turnId }), null)

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(
      engine.resumeTurn({
        userId,
        sessionId: 'turn-engine-session',
        turnId,
        retryFailed: true,
      }),
      (error) => error?.code === 'TURN_FAILED_RETRY_CHECKPOINT_REQUIRED'
        && error?.retryable === false
        && error?.message === 'TURN_FAILED_RETRY_CHECKPOINT_REQUIRED',
    )
  }

  const sealedEvidence = getMessage({
    userId,
    sessionId: 'turn-engine-session',
    messageId: `${turnId}:assistant`,
  })
  assert.equal(sealedEvidence?.modelContext?.turnEvidence, true)
  assert.equal(sealedEvidence?.modelContext?.evidenceState, 'failed')
  assert.equal(sealedEvidence?.modelContext?.serverLastSequence, failure.sequence)
  assert.equal(sealedEvidence?.modelContext?.error?.code, 'TURN_FAILED_RETRY_CHECKPOINT_REQUIRED')
  assert.equal(sealedEvidence?.modelContext?.error?.retryable, false)
  assert.equal(Object.hasOwn(sealedEvidence?.modelContext?.error || {}, 'message'), false)
  assert.equal(Object.hasOwn(sealedEvidence?.modelContext?.error || {}, 'hint'), false)
  assert.deepEqual(sealedEvidence?.modelContext?.failedRetryRejection, {
    code: 'TURN_FAILED_RETRY_CHECKPOINT_REQUIRED',
    failureSequence: failure.sequence,
  })
  assert.equal(events(turnId).length, eventCount)
  assert.equal(events(turnId).at(-1)?.id, failure.id)
  assert.equal(loopCalls, 1)
})

test('TurnEngine preserves approval metadata source in the durable approval event', async () => {
  const turnId = 'turn-approval-metadata-source'
  const engine = createTestEngine({
    runLoop: async ({ onApprovalPending }) => {
      await onApprovalPending({
        id: 'approval-declared',
        toolName: 'write_file',
        args: { path: 'demo.txt' },
        risk: 'medium',
        metadataSource: 'declared',
        reason: 'writes a local file',
        expiresAt: Date.now() + 60_000,
      })
      return { text: 'Approval event emitted.', artifactIds: [], iterations: 1 }
    },
  })

  await engine.startTurn({
    userId,
    sessionId: 'turn-engine-session',
    turnId,
    content: 'Emit an approval event.',
  })
  await engine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId })

  const required = events(turnId).find((event) => event.type === 'approval.required')
  assert.equal(required.payload.metadataSource, 'declared')
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
  const fileAccess = readOnlyDirectoryAccessStatus('turn-resume-read-grant')
  appendTurnEvent({
    userId,
    event: createTurnEvent({
      id: 'resume-start', sessionId: 'turn-engine-session', turnId: 'turn-resume', sequence: 0,
      type: 'turn.started', payload: { content: '继续', modelName: 'stub' }, createdAt: 1,
    }),
  })
  appendLegacyTurnEvent({
    userId,
    event: createTurnEvent({
      id: 'resume-checkpoint', sessionId: 'turn-engine-session', turnId: 'turn-resume', sequence: 1,
      type: 'turn.checkpoint', createdAt: 2,
      payload: {
        state: {
          approvalMode: 'normal',
          executionEnvironment: checkpointEnvironment({
            modelName: 'stub',
            toolSpecs: [checkpointReadToolSpec],
            fileAccess,
          }),
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
          latestModelUsage: { promptTokens: 140, completionTokens: 10, totalTokens: 150 },
          turnModelUsage: { promptTokens: 240, completionTokens: 30, totalTokens: 270 },
        },
      },
    }),
  })
  let executions = 0
  const engine = createTestEngine({
    ...checkpointEnvironmentEngineOptions([checkpointReadToolSpec], fileAccess),
    runModel: async () => ({
      content: '从断点完成。',
      toolCalls: [],
      usage: { promptTokens: 200, completionTokens: 20, totalTokens: 220 },
    }),
    executeTool: async () => { executions += 1; return { ok: true } },
  })
  await engine.resumeTurn({ userId, sessionId: 'turn-engine-session', turnId: 'turn-resume' })
  await engine.waitForTurn({ userId, sessionId: 'turn-engine-session', turnId: 'turn-resume' })
  assert.equal(executions, 0)
  const completed = events('turn-resume').at(-1)
  assert.equal(completed.type, 'turn.completed')
  assert.deepEqual(completed.payload.usage, {
    promptTokens: 200,
    completionTokens: 20,
    totalTokens: 220,
  })
  assert.deepEqual(completed.payload.turnModelUsage, {
    promptTokens: 440,
    completionTokens: 50,
    totalTokens: 490,
  })
  assert.equal(await engine.getTurn({ userId: 'another-user', sessionId: 'turn-engine-session', turnId: 'turn-resume' }), null)
})

test('TurnEngine resumes a compacted checkpoint and completes a legal tool round', async () => {
  const sessionId = 'turn-engine-session'
  const turnId = 'turn-resume-compacted-tool-loop'
  const fileAccess = readOnlyDirectoryAccessStatus('turn-resume-compacted-read-grant')
  const canonicalMessages = [
    { role: 'user', content: 'Read the earlier proof.' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'archived-read',
        type: 'function',
        function: { name: 'read_file', arguments: '{"path":"earlier.txt"}' },
      }],
    },
    {
      role: 'tool',
      tool_call_id: 'archived-read',
      name: 'read_file',
      content: '{"ok":true,"content":"earlier proof"}',
    },
    { role: 'user', content: 'Continue by reading final.txt.' },
  ]
  const compaction = buildCompaction({ messages: canonicalMessages, keepMessages: 1, force: true })
  assert.equal(compaction.ok, true)
  assert.equal(validateToolCallChain(compaction.outboundMessages).ok, true)
  assert.equal(
    validateCompactCheckpointSource(
      compaction.summaryMessage.meta.compactCheckpointSource,
      compaction.archivedMessages,
    ).ok,
    true,
  )
  const archive = createCompactionArchive({
    userId,
    sessionId,
    archivedMessages: compaction.archivedMessages,
    summaryText: compaction.summaryText,
  })
  const checkpointMessages = compaction.outboundMessages.map((message) => (
    message === compaction.summaryMessage
      ? { ...message, meta: { ...message.meta, archiveId: archive.id } }
      : message
  ))
  appendTurnEvent({
    userId,
    event: createTurnEvent({
      id: `${turnId}:started`, sessionId, turnId, sequence: 0,
      type: 'turn.started', payload: { content: 'Continue by reading final.txt.', modelName: 'stub' }, createdAt: 1,
    }),
  })
  appendTurnEvent({
    userId,
    event: createTurnEvent({
      id: `${turnId}:checkpoint`, sessionId, turnId, sequence: 1,
      type: 'turn.checkpoint', payload: { storage: 'turn_checkpoints', checkpointVersion: 1 }, createdAt: 2,
    }),
    checkpointState: {
      approvalMode: 'normal',
      executionEnvironment: checkpointEnvironment({
        modelName: 'stub',
        toolSpecs: [checkpointReadToolSpec],
        fileAccess,
      }),
      messages: checkpointMessages,
      toolCalls: [],
      artifactIds: [],
      iterations: 1,
      recovery: {
        archiveId: archive.id,
        compactCheckpointSource: compaction.summaryMessage.meta.compactCheckpointSource,
      },
    },
  })

  let modelCalls = 0
  let executions = 0
  const modelRequests = []
  const engine = createTestEngine({
    ...checkpointEnvironmentEngineOptions([checkpointReadToolSpec], fileAccess),
    runModel: async ({ messages } = {}) => {
      modelCalls += 1
      modelRequests.push(messages)
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [{
            id: 'resumed-final-read',
            function: { name: 'read_file', arguments: '{"path":"final.txt"}' },
          }],
        }
      }
      return { content: 'Compacted recovery completed.', toolCalls: [] }
    },
    executeTool: async ({ name, args }) => {
      executions += 1
      assert.equal(name, 'read_file')
      assert.equal(args.path, 'final.txt')
      return { ok: true, content: 'final proof' }
    },
  })

  await engine.resumeTurn({ userId, sessionId, turnId })
  await engine.waitForTurn({ userId, sessionId, turnId })

  assert.equal(modelCalls, 2)
  assert.equal(executions, 1)
  assert.equal(modelRequests.every((messages) => validateToolCallChain(messages).ok), true)
  assert.equal(events(turnId).at(-1)?.type, 'turn.completed')
  assert.equal(events(turnId).at(-1)?.payload?.text, 'Compacted recovery completed.')
})

test('TurnEngine creates a missing owned session but cannot claim another user session id', async () => {
  createUser({ id: 'turn-engine-other', email: 'turn-engine-other@example.com' })
  upsertSession({ id: 'owned-by-other', userId: 'turn-engine-other', title: 'Other' })
  const engine = createTestEngine({
    runLoop: async () => ({ text: 'ok', artifactIds: [], iterations: 1 }),
  })
  await engine.startTurn({ userId, sessionId: 'created-by-engine', turnId: 'turn-created-session', content: 'create' })
  await engine.waitForTurn({ userId, sessionId: 'created-by-engine', turnId: 'turn-created-session' })
  assert.equal((await engine.getTurn({ userId, sessionId: 'created-by-engine', turnId: 'turn-created-session' })).status, 'completed')
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
      id: 'legacy-started-event', sessionId, turnId: 'legacy-complete-turn', sequence: 0,
      type: 'turn.started', payload: {}, createdAt: 1,
    }),
  })
  appendTurnEvent({
    userId: legacyUserId,
    event: createTurnEvent({
      id: 'legacy-event', sessionId, turnId: 'legacy-complete-turn', sequence: 1,
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
  assert.equal((await engine.getTurn({ userId, sessionId, turnId: 'turn-local-claim' })).status, 'completed')
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
  assert.equal((await engine.getTurn({ userId, sessionId, turnId })).status, 'completed')
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
