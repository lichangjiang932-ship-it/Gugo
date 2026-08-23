import assert from 'node:assert/strict'
import test from 'node:test'

import '../server/services/loop/index.js'
import { issueTestSession } from './helpers/testAuth.js'
import { getDb } from '../server/db.js'
import { createSqliteSubagentRunPersistenceAdapter } from '../server/adapters/sqliteSubagentRunPersistenceAdapter.js'
import {
  registerPlugin,
  unregisterPlugin,
} from '../server/plugins/pluginRegistry.js'
import {
  SUBAGENT_PROVIDER_SERVICE,
  SUBAGENT_PROVIDER_TIMEOUT_MS,
  _testing as subagentProviderTesting,
  invokeRuntimeSubagentProvider,
} from '../server/services/subagentProvider.js'
import {
  getSubagentRun,
  runSubagent,
} from '../server/services/subagentRuntime.js'

const { userId } = issueTestSession({ email: 'subagent-provider-test@example.com' })
const persistencePort = createSqliteSubagentRunPersistenceAdapter({ getDb })

function resolveTestModelBinding({ modelName, requirePersistedBinding } = {}) {
  const selectedModel = String(modelName || '').trim()
  if (requirePersistedBinding && !selectedModel) {
    throw Object.assign(new Error('persisted model snapshot is missing'), {
      code: 'MODEL_PROVIDER_BINDING_MISSING',
    })
  }
  return {
    providerId: 'private-model-provider',
    modelName: selectedModel || 'subagent-provider-test-model',
    configRevision: 7,
    env: {
      MODEL_BASE_URL: 'http://127.0.0.1:9/v1',
      MODEL_NAME: selectedModel || 'subagent-provider-test-model',
      MODEL_API_KEY: 'must-never-cross-provider-boundary',
    },
  }
}

function run(options) {
  return runSubagent({
    persistencePort,
    resolveModelBinding: resolveTestModelBinding,
    ...options,
  })
}

function readSubagentRun(input) {
  return getSubagentRun(input, { persistencePort })
}

async function installProvider(t, id, callback) {
  await registerPlugin({
    id,
    name: id,
    version: '1.0.0',
    contributes: [`service:${SUBAGENT_PROVIDER_SERVICE}`],
  }, (context) => {
    context.services.provide(SUBAGENT_PROVIDER_SERVICE, { run: callback })
  })
  t.after(async () => { await unregisterPlugin(id) })
}

test('provider deadlines preserve long local-task budgets instead of clamping at one minute', () => {
  const sixHours = 6 * 60 * 60 * 1_000
  assert.equal(SUBAGENT_PROVIDER_TIMEOUT_MS, 2 * 60 * 60 * 1_000)
  assert.equal(subagentProviderTesting.providerTimeoutMs(60_001), 60_001)
  assert.equal(subagentProviderTesting.providerTimeoutMs(sixHours), sixHours)
  assert.equal(subagentProviderTesting.providerTimeoutMs(0), SUBAGENT_PROVIDER_TIMEOUT_MS)
  assert.equal(subagentProviderTesting.providerTimeoutMs(Number.POSITIVE_INFINITY), SUBAGENT_PROVIDER_TIMEOUT_MS)
})

test('runtime subagent provider receives only a frozen bounded task envelope', async (t) => {
  const pluginId = 'subagent-provider-minimal-input'
  const privateSkillBody = `private-skill-body-${Math.random()}`
  const privateParentSession = `private-parent-session-${Math.random()}`
  const privateParentMessage = `private-parent-message-${Math.random()}`
  let received = null
  let providerCalls = 0
  let modelCalls = 0

  await installProvider(t, pluginId, (scope) => {
    providerCalls += 1
    received = scope
    return {
      decision: 'handled',
      status: 'completed',
      text: 'completed by runtime provider',
      reason: 'provider verified completion',
    }
  })

  const id = `subagent-provider-minimal-${Date.now()}-${Math.random()}`
  const completed = await run({
    id,
    userId,
    type: 'explore',
    prompt: 'inspect the provider boundary',
    description: 'bounded provider task',
    agentId: 'private-agent-id',
    skillIds: ['private-skill-id'],
    skillDefinitions: [{
      id: 'private-skill-id',
      name: 'Private skill',
      systemPrompt: privateSkillBody,
    }],
    parentSessionId: privateParentSession,
    parentMessageId: privateParentMessage,
    modelName: 'subagent-provider-test-model',
    team: {
      id: 'team-provider-test',
      name: 'Provider test team',
      mode: 'swarm',
      role: 'reviewer',
      size: 2,
      memberIndex: 1,
      privateField: 'must not cross',
    },
    callModel: async () => {
      modelCalls += 1
      return { content: 'must not run', toolCalls: [] }
    },
  })

  assert.equal(completed.status, 'completed')
  assert.equal(completed.resultText, 'completed by runtime provider')
  assert.equal(modelCalls, 0)
  assert.equal(providerCalls, 1)
  assert.equal(Object.isFrozen(received), true)
  assert.equal(Object.isFrozen(received.model), true)
  assert.equal(Object.isFrozen(received.team), true)
  assert.deepEqual(Object.keys(received).sort(), [
    'depth',
    'description',
    'model',
    'prompt',
    'resume',
    'runId',
    'team',
    'type',
  ])
  assert.deepEqual(received.model, {
    name: 'subagent-provider-test-model',
    providerId: 'private-model-provider',
    configRevision: 7,
  })
  assert.deepEqual(received.team, {
    id: 'team-provider-test',
    name: 'Provider test team',
    mode: 'swarm',
    role: 'reviewer',
    size: 2,
    memberIndex: 1,
  })
  const serializedScope = JSON.stringify(received)
  for (const excluded of [
    userId,
    privateSkillBody,
    privateParentSession,
    privateParentMessage,
    'private-agent-id',
    'private-skill-id',
    'MODEL_API_KEY',
    'must-never-cross-provider-boundary',
    'privateField',
  ]) {
    assert.doesNotMatch(serializedScope, new RegExp(excluded.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
  assert.deepEqual(completed.provider, {
    pluginId,
    service: SUBAGENT_PROVIDER_SERVICE,
    decision: 'handled',
  })
  assert.deepEqual(
    completed.trace.findLast((event) => event.type === 'subagent_provider').provider,
    completed.provider,
  )

  const replay = await run({
    id,
    userId,
    type: 'explore',
    prompt: 'inspect the provider boundary',
  })
  assert.equal(replay.status, 'completed')
  assert.equal(providerCalls, 1, 'a durable terminal run must not invoke the provider twice')
})

test('explicit decline uses builtin execution and uninstall restores builtin for new runs', async (t) => {
  const pluginId = 'subagent-provider-decline'
  let providerCalls = 0
  let modelCalls = 0
  await installProvider(t, pluginId, () => {
    providerCalls += 1
    return { decision: 'decline' }
  })

  const attemptsByPrompt = new Map()
  const builtinModel = async ({ messages }) => {
    modelCalls += 1
    const prompt = messages.findLast((message) => message.role === 'user')?.content || ''
    const attempt = (attemptsByPrompt.get(prompt) || 0) + 1
    attemptsByPrompt.set(prompt, attempt)
    if (attempt === 1) {
      return {
        content: '',
        toolCalls: [{
          id: `provider-decline-read-${modelCalls}`,
          function: { name: 'read_file', arguments: JSON.stringify({ path: 'README.md' }) },
        }],
      }
    }
    return { content: `builtin result ${attemptsByPrompt.size}`, toolCalls: [] }
  }
  const declined = await run({
    id: `subagent-provider-decline-${Date.now()}-${Math.random()}`,
    userId,
    type: 'explore',
    prompt: 'run with explicit provider decline',
    callModel: builtinModel,
    executeTool: async () => ({ ok: true, content: 'durable read evidence' }),
  })
  assert.equal(declined.status, 'completed')
  assert.equal(declined.resultText, 'builtin result 1')
  assert.deepEqual(declined.provider, {
    pluginId,
    service: SUBAGENT_PROVIDER_SERVICE,
    decision: 'decline',
  })

  assert.equal(await unregisterPlugin(pluginId), true)
  const afterUnload = await run({
    id: `subagent-provider-unloaded-${Date.now()}-${Math.random()}`,
    userId,
    type: 'explore',
    prompt: 'run after provider unload',
    callModel: builtinModel,
    executeTool: async () => ({ ok: true, content: 'durable read evidence' }),
  })
  assert.equal(afterUnload.status, 'completed')
  assert.equal(afterUnload.resultText, 'builtin result 2')
  assert.deepEqual(afterUnload.provider, {
    pluginId: null,
    service: SUBAGENT_PROVIDER_SERVICE,
    decision: 'absent',
  })
  assert.equal(providerCalls, 1)
  assert.equal(modelCalls, 4)
})

test('provider-handled interruption resumes with the same durable run id and envelope', async (t) => {
  const pluginId = 'subagent-provider-resume'
  const scopes = []
  let modelCalls = 0
  await installProvider(t, pluginId, (scope) => {
    scopes.push(scope)
    if (!scope.resume) {
      return {
        decision: 'handled',
        status: 'interrupted',
        text: 'provider checkpoint is durable',
        reason: 'provider requested resume',
      }
    }
    return {
      decision: 'handled',
      status: 'completed',
      text: 'provider resumed to completion',
    }
  })

  const id = `subagent-provider-resume-${Date.now()}-${Math.random()}`
  const first = await run({
    id,
    userId,
    type: 'plan',
    prompt: 'resume the same provider operation',
    description: 'durable provider operation',
    modelName: 'subagent-provider-test-model',
    team: {
      id: 'durable-provider-team',
      name: 'Durable provider team',
      mode: 'solo',
      role: 'planner',
      size: 1,
      memberIndex: 0,
    },
    callModel: async () => {
      modelCalls += 1
      return { content: 'must not run', toolCalls: [] }
    },
  })
  assert.equal(first.status, 'interrupted')
  assert.equal(first.resultText, 'provider checkpoint is durable')

  const resumed = await run({
    id,
    userId,
    type: 'plan',
    prompt: 'resume the same provider operation',
    callModel: async () => {
      modelCalls += 1
      return { content: 'must not run', toolCalls: [] }
    },
  })
  assert.equal(resumed.status, 'completed')
  assert.equal(resumed.resultText, 'provider resumed to completion')
  assert.equal(modelCalls, 0)
  assert.equal(scopes.length, 2)
  assert.equal(scopes[0].runId, id)
  assert.equal(scopes[1].runId, id)
  assert.equal(scopes[0].resume, false)
  assert.equal(scopes[1].resume, true)
  assert.equal(scopes[1].description, 'durable provider operation')
  assert.equal(scopes[1].team.id, 'durable-provider-team')
  assert.deepEqual(scopes[1].model, scopes[0].model)
})

test('unloaded provider cannot silently hand an existing durable run to builtin execution', async (t) => {
  const pluginId = 'subagent-provider-unavailable-resume'
  let providerCalls = 0
  let modelCalls = 0
  await installProvider(t, pluginId, () => {
    providerCalls += 1
    return {
      decision: 'handled',
      status: 'interrupted',
      text: 'provider owns this durable operation',
    }
  })

  const id = `subagent-provider-unavailable-${Date.now()}-${Math.random()}`
  const interrupted = await run({
    id,
    userId,
    type: 'explore',
    prompt: 'keep provider ownership across resume',
    callModel: async () => {
      modelCalls += 1
      return { content: 'must not run', toolCalls: [] }
    },
  })
  assert.equal(interrupted.status, 'interrupted')
  assert.equal(await unregisterPlugin(pluginId), true)

  await assert.rejects(
    run({
      id,
      userId,
      type: 'explore',
      prompt: 'keep provider ownership across resume',
      callModel: async () => {
        modelCalls += 1
        return { content: 'must not run', toolCalls: [] }
      },
    }),
    (error) => error?.code === 'SUBAGENT_PROVIDER_UNAVAILABLE'
      && error?.retryable === false,
  )
  const failed = await readSubagentRun({ userId, id })
  assert.equal(failed.status, 'failed')
  assert.deepEqual(failed.provider, {
    pluginId,
    service: SUBAGENT_PROVIDER_SERVICE,
    decision: 'error',
    error: 'SUBAGENT_PROVIDER_UNAVAILABLE',
  })
  assert.equal(providerCalls, 1)
  assert.equal(modelCalls, 0)
})

test('active provider failure is durable, redacted, and never falls back locally', async (t) => {
  const pluginId = 'subagent-provider-failure'
  const privateFailure = `private-provider-failure-${Math.random()}`
  let providerCalls = 0
  let modelCalls = 0
  await installProvider(t, pluginId, () => {
    providerCalls += 1
    throw Object.assign(new Error(privateFailure), { code: 'PRIVATE_PROVIDER_FAILURE' })
  })

  const id = `subagent-provider-failure-${Date.now()}-${Math.random()}`
  await assert.rejects(
    run({
      id,
      userId,
      type: 'general',
      prompt: 'do not replay this operation locally',
      callModel: async () => {
        modelCalls += 1
        return { content: 'must not run', toolCalls: [] }
      },
    }),
    (error) => error?.code === 'SUBAGENT_PROVIDER_INVOCATION_FAILED'
      && error?.message === 'runtime subagent provider invocation failed',
  )

  const failed = await readSubagentRun({ userId, id })
  assert.equal(failed.status, 'failed')
  assert.equal(failed.resultText, 'runtime subagent provider invocation failed')
  assert.deepEqual(failed.provider, {
    pluginId,
    service: SUBAGENT_PROVIDER_SERVICE,
    decision: 'error',
    error: 'PRIVATE_PROVIDER_FAILURE',
  })
  assert.doesNotMatch(JSON.stringify(failed), new RegExp(privateFailure.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.equal(modelCalls, 0)

  const replay = await run({
    id,
    userId,
    type: 'general',
    prompt: 'do not replay this operation locally',
  })
  assert.equal(replay.status, 'failed')
  assert.equal(providerCalls, 1)
  assert.equal(modelCalls, 0)
})

test('invalid, timed-out, and handled-failed provider results stay terminal', async () => {
  await assert.rejects(
    invokeRuntimeSubagentProvider({ runId: 'invalid-result', prompt: 'test', type: 'general' }, {
      invokePluginService: async () => ({
        found: true,
        pluginId: 'invalid-result-provider',
        value: { decision: 'handled', status: 'running', text: 'not terminal' },
      }),
    }),
    (error) => error?.code === 'SUBAGENT_PROVIDER_RESULT_INVALID'
      && error?.providerProvenance?.pluginId === 'invalid-result-provider',
  )

  await assert.rejects(
    invokeRuntimeSubagentProvider({ runId: 'timed-out-result', prompt: 'test', type: 'general' }, {
      invokePluginService: async () => new Promise(() => {}),
      timeoutMs: 5,
    }),
    (error) => error?.code === 'SUBAGENT_PROVIDER_TIMEOUT'
      && error?.retryable === false,
  )

  const handledFailure = await invokeRuntimeSubagentProvider({
    runId: 'handled-failure',
    prompt: 'test',
    type: 'general',
  }, {
    invokePluginService: async () => ({
      found: true,
      pluginId: 'handled-failure-provider',
      value: {
        decision: 'handled',
        status: 'failed',
        reason: 'provider terminal failure',
      },
    }),
  })
  assert.equal(handledFailure.kind, 'handled')
  assert.deepEqual(handledFailure.terminal, {
    status: 'failed',
    text: '',
    reason: 'provider terminal failure',
  })
})

test('host cancellation reaches the provider and late completion cannot rewrite the durable run', async (t) => {
  const pluginId = 'subagent-provider-host-cancel'
  const controller = new AbortController()
  const cancellation = Object.assign(new Error('host cancelled provider execution'), {
    name: 'AbortError',
    code: 'SUBAGENT_HOST_CANCELLED',
  })
  let markStarted
  const started = new Promise((resolve) => { markStarted = resolve })
  let resolveLate
  let providerContext = null

  await installProvider(t, pluginId, (_scope, context) => {
    providerContext = context
    markStarted()
    return new Promise((resolve) => { resolveLate = resolve })
  })

  const id = `subagent-provider-host-cancel-${Date.now()}-${Math.random()}`
  const running = run({
    id,
    userId,
    type: 'explore',
    prompt: 'cancel the provider from the host',
    signal: controller.signal,
  })
  await started
  assert.equal(Object.isFrozen(providerContext), true)
  assert.deepEqual(Object.keys(providerContext), ['signal'])
  assert.equal(providerContext.signal instanceof AbortSignal, true)
  assert.equal(providerContext.signal.aborted, false)

  controller.abort(cancellation)
  await assert.rejects(running, (error) => error === cancellation)
  assert.equal(providerContext.signal.aborted, true)

  const interrupted = await readSubagentRun({ userId, id })
  assert.equal(interrupted.status, 'interrupted')
  const durableSnapshot = JSON.stringify(interrupted)

  resolveLate({
    decision: 'handled',
    status: 'completed',
    text: 'late provider completion must be ignored',
  })
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(JSON.stringify(await readSubagentRun({ userId, id })), durableSnapshot)
})

test('plugin unload revokes an active provider call and ignores its late completion', async (t) => {
  const pluginId = 'subagent-provider-plugin-revoke'
  let markStarted
  const started = new Promise((resolve) => { markStarted = resolve })
  let resolveLate
  let providerSignal = null
  let abortEvents = 0
  const unhandled = []
  const onUnhandled = (error) => unhandled.push(error)
  process.on('unhandledRejection', onUnhandled)
  t.after(() => process.removeListener('unhandledRejection', onUnhandled))

  await installProvider(t, pluginId, (_scope, context) => {
    providerSignal = context.signal
    providerSignal.addEventListener('abort', () => { abortEvents += 1 }, { once: true })
    markStarted()
    return new Promise((resolve) => { resolveLate = resolve })
  })

  const id = `subagent-provider-plugin-revoke-${Date.now()}-${Math.random()}`
  const running = run({
    id,
    userId,
    type: 'explore',
    prompt: 'stop the provider when its plugin is unloaded',
  })
  await started
  const rejected = assert.rejects(
    running,
    (error) => error?.code === 'SUBAGENT_PROVIDER_INVOCATION_FAILED'
      && error?.providerProvenance?.error === 'PLUGIN_SERVICE_CALL_ABORTED',
  )
  const unloadResult = await Promise.race([
    unregisterPlugin(pluginId).then(() => 'unloaded'),
    new Promise((resolve) => setTimeout(() => resolve('timed-out'), 5_000)),
  ])
  assert.equal(unloadResult, 'unloaded')
  await rejected
  assert.equal(providerSignal.aborted, true)
  assert.equal(abortEvents, 1)

  const failed = await readSubagentRun({ userId, id })
  assert.equal(failed.status, 'failed')
  assert.equal(failed.provider?.error, 'PLUGIN_SERVICE_CALL_ABORTED')
  const durableSnapshot = JSON.stringify(failed)

  resolveLate({
    decision: 'handled',
    status: 'completed',
    text: 'late provider completion must stay invisible',
  })
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(unhandled, [])
  assert.equal(JSON.stringify(await readSubagentRun({ userId, id })), durableSnapshot)
})

test('provider timeout aborts its callback and late rejection cannot produce a second terminal state', async (t) => {
  const pluginId = 'subagent-provider-timeout-cancel'
  let markStarted
  const started = new Promise((resolve) => { markStarted = resolve })
  let rejectLate
  let providerSignal = null
  let abortEvents = 0
  const unhandled = []
  const onUnhandled = (error) => unhandled.push(error)
  process.on('unhandledRejection', onUnhandled)
  t.after(() => process.removeListener('unhandledRejection', onUnhandled))

  await installProvider(t, pluginId, (_scope, context) => {
    providerSignal = context.signal
    providerSignal.addEventListener('abort', () => { abortEvents += 1 }, { once: true })
    markStarted()
    return new Promise((_, reject) => { rejectLate = reject })
  })

  const id = `subagent-provider-timeout-cancel-${Date.now()}-${Math.random()}`
  const running = run({
    id,
    userId,
    type: 'explore',
    prompt: 'time out the provider callback',
    invokeSubagentProvider: (input, dependencies) => invokeRuntimeSubagentProvider(input, {
      ...dependencies,
      timeoutMs: 20,
    }),
  })
  await started
  await assert.rejects(
    running,
    (error) => error?.code === 'SUBAGENT_PROVIDER_TIMEOUT' && error?.retryable === false,
  )
  assert.equal(providerSignal.aborted, true)
  assert.equal(abortEvents, 1)

  const failed = await readSubagentRun({ userId, id })
  assert.equal(failed.status, 'failed')
  const durableSnapshot = JSON.stringify(failed)

  rejectLate(Object.assign(new Error('late private provider failure'), {
    code: 'LATE_PRIVATE_PROVIDER_FAILURE',
  }))
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(unhandled, [])
  assert.equal(JSON.stringify(await readSubagentRun({ userId, id })), durableSnapshot)
})
