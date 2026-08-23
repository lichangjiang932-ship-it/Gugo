import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isProviderFailoverError,
  resolveModelFailoverConfigs,
  runWithProviderFailover,
  streamWithProviderFailover,
} from '../server/adapters/modelProxy.js'
import { modelRequestOutcomeUnknown } from '../server/adapters/modelRequestOutcome.js'

test('unbound provider selection fails closed across providers by default', () => {
  const env = {
    MODEL_NAME: 'primary-model',
    MODEL_PROVIDERS: 'primary,backup',
    MODEL_PROVIDER_PRIMARY_BASE_URL: 'https://primary.example/v1',
    MODEL_PROVIDER_PRIMARY_API_KEY: 'p',
    MODEL_PROVIDER_PRIMARY_MODELS: 'primary-model',
    MODEL_PROVIDER_BACKUP_BASE_URL: 'https://backup.example/v1',
    MODEL_PROVIDER_BACKUP_API_KEY: 'b',
    // ★ 备用 provider 必须提供**同名**模型才算合格备选。
    // 原来这里是 'backup-model'(不同模型)也被当成备选 —— 那正是
    // 「选了 deepseek-v4-flash 却按 mimo-v2.5 计费」的成因。
    MODEL_PROVIDER_BACKUP_MODELS: 'primary-model',
  }
  const configs = resolveModelFailoverConfigs({ env })
  assert.deepEqual(configs.map((config) => config.providerId), ['primary'])
  assert.deepEqual(configs.map((config) => config.modelName), ['primary-model'])
  assert.deepEqual(configs[0].failoverPolicy, {
    blockedProviderCount: 1,
    reason: 'explicit_opt_in_required',
  })

  const opened = resolveModelFailoverConfigs({
    env: { ...env, MODEL_FAILOVER_CROSS_PROVIDER: '1' },
  })
  assert.deepEqual(opened.map((config) => config.providerId), ['primary', 'backup'])

  const explicitlyBound = resolveModelFailoverConfigs({
    modelName: 'primary-model',
    providerId: 'backup',
    env: { ...env, MODEL_FAILOVER_CROSS_PROVIDER: '1' },
  })
  assert.deepEqual(explicitlyBound.map((config) => config.providerId), ['backup'])
})

test('★ 备用 provider 没有同名模型时被剔除 —— 不能静默换模型并按它计费', () => {
  const env = {
    MODEL_NAME: 'primary-model',
    MODEL_PROVIDERS: 'primary,backup',
    MODEL_PROVIDER_PRIMARY_BASE_URL: 'https://primary.example/v1',
    MODEL_PROVIDER_PRIMARY_API_KEY: 'p',
    MODEL_PROVIDER_PRIMARY_MODELS: 'primary-model',
    MODEL_PROVIDER_BACKUP_BASE_URL: 'https://backup.example/v1',
    MODEL_PROVIDER_BACKUP_API_KEY: 'b',
    MODEL_PROVIDER_BACKUP_MODELS: 'backup-model',
  }
  const configs = resolveModelFailoverConfigs({ env })
  assert.deepEqual(configs.map((config) => config.modelName), ['primary-model'])

  // 显式开启后才允许跨模型
  const opened = resolveModelFailoverConfigs({
    env: {
      ...env,
      MODEL_FAILOVER_CROSS_PROVIDER: '1',
      MODEL_STRICT_SELECTION: '0',
      MODEL_FAILOVER_CROSS_MODEL: '1',
    },
  })
  assert.deepEqual(opened.map((config) => config.modelName), ['primary-model', 'backup-model'])
})

test('provider-level opt-in enables cross-provider failover and explicit false overrides global opt-in', () => {
  const env = {
    MODEL_NAME: 'shared-model',
    MODEL_PROVIDERS: 'primary,backup',
    MODEL_PROVIDER_PRIMARY_BASE_URL: 'https://primary.example/v1',
    MODEL_PROVIDER_PRIMARY_MODELS: 'shared-model',
    MODEL_PROVIDER_BACKUP_BASE_URL: 'https://backup.example/v1',
    MODEL_PROVIDER_BACKUP_MODELS: 'shared-model',
  }
  const providerOptIn = resolveModelFailoverConfigs({
    env: {
      ...env,
      MODEL_PROVIDER_PRIMARY_PROFILE: JSON.stringify({ failoverEnabled: true }),
    },
  })
  assert.deepEqual(providerOptIn.map((config) => config.providerId), ['primary', 'backup'])

  const providerOptOut = resolveModelFailoverConfigs({
    env: {
      ...env,
      MODEL_FAILOVER_CROSS_PROVIDER: '1',
      MODEL_PROVIDER_PRIMARY_PROFILE: JSON.stringify({ failoverEnabled: false }),
    },
  })
  assert.deepEqual(providerOptOut.map((config) => config.providerId), ['primary'])
  assert.equal(providerOptOut[0].failoverPolicy.reason, 'primary_provider_disabled')
})

test('blocked cross-provider fallback returns actionable redacted diagnostics', async () => {
  const secret = 'sk-must-not-leak'
  const configs = resolveModelFailoverConfigs({
    env: {
      MODEL_NAME: 'shared-model',
      MODEL_PROVIDERS: 'primary,backup',
      MODEL_PROVIDER_PRIMARY_BASE_URL: 'https://primary.example/v1',
      MODEL_PROVIDER_PRIMARY_API_KEY: secret,
      MODEL_PROVIDER_PRIMARY_MODELS: 'shared-model',
      MODEL_PROVIDER_BACKUP_BASE_URL: 'https://backup.example/v1',
      MODEL_PROVIDER_BACKUP_API_KEY: 'backup-secret',
      MODEL_PROVIDER_BACKUP_MODELS: 'shared-model',
    },
  })
  let calls = 0
  await assert.rejects(
    () => runWithProviderFailover(configs, async () => {
      calls += 1
      throw Object.assign(new Error(`upstream echoed ${secret}`), { status: 503 })
    }),
    (error) => {
      assert.equal(error?.code, 'MODEL_CROSS_PROVIDER_FAILOVER_BLOCKED')
      assert.equal(error?.retryable, true)
      assert.match(error?.hint || '', /Provider/u)
      assert.deepEqual(error?.details, {
        reason: 'explicit_opt_in_required',
        blockedProviderCount: 1,
        action: 'enable_cross_provider_failover',
      })
      assert.doesNotMatch(JSON.stringify(error), /sk-must-not-leak|backup-secret/u)
      assert.doesNotMatch(error.message, /primary\.example|backup\.example/u)
      return true
    },
  )
  assert.equal(calls, 1)
})

test('blocked stream fallback is structured only before output starts', async () => {
  const configs = [{
    providerId: 'primary',
    failoverPolicy: { blockedProviderCount: 1, reason: 'explicit_opt_in_required' },
  }]
  await assert.rejects(async () => {
    for await (const item of streamWithProviderFailover(configs, async function* failBeforeOutput() {
      yield* []
      throw Object.assign(new Error('down'), { status: 503 })
    }, { maxAttemptsPerProvider: 1 })) void item
  }, (error) => error?.code === 'MODEL_CROSS_PROVIDER_FAILOVER_BLOCKED')

  await assert.rejects(async () => {
    for await (const item of streamWithProviderFailover(configs, async function* failAfterOutput() {
      yield 'partial'
      throw Object.assign(new Error('late failure'), { status: 503 })
    }, { maxAttemptsPerProvider: 1 })) void item
  }, (error) => error?.message === 'late failure' && !error?.details)
})

test('provider failover changes provider for recoverable failures', async () => {
  const attempted = []
  const result = await runWithProviderFailover([
    { providerId: 'primary' },
    { providerId: 'backup' },
  ], async (config) => {
    attempted.push(config.providerId)
    if (config.providerId === 'primary') throw Object.assign(new Error('upstream down'), { status: 503 })
    return 'ok'
  })
  assert.equal(result, 'ok')
  assert.deepEqual(attempted, ['primary', 'backup'])
})

test('provider failover does not hide authentication or request errors', async () => {
  assert.equal(isProviderFailoverError(Object.assign(new Error('down'), { status: 503 })), true)
  assert.equal(isProviderFailoverError(Object.assign(new Error('timeout'), { status: 504 })), true)
  assert.equal(isProviderFailoverError(Object.assign(new Error('bad key'), { status: 401 })), false)
  assert.equal(isProviderFailoverError(Object.assign(new Error('cancelled'), { name: 'AbortError' })), false)
  let calls = 0
  await assert.rejects(() => runWithProviderFailover([
    { providerId: 'primary' },
    { providerId: 'backup' },
  ], async () => {
    calls += 1
    throw Object.assign(new Error('bad request'), { status: 400 })
  }), /bad request/)
  assert.equal(calls, 1)
})

test('an ambiguous tracked request is neither retried nor sent to another provider', async () => {
  const attempts = []
  const ambiguous = () => modelRequestOutcomeUnknown(
    Object.assign(new Error('upstream unavailable after accepting the request'), { status: 503 }),
    {
      modelRequestId: 'mr_ambiguous-request',
      phase: 'response',
      responseReceived: true,
    },
  )
  assert.equal(isProviderFailoverError(ambiguous()), false)

  await assert.rejects(
    () => runWithProviderFailover([
      { providerId: 'primary' },
      { providerId: 'backup' },
    ], async (config) => {
      attempts.push(config.providerId)
      throw ambiguous()
    }),
    (error) => error?.code === 'MODEL_REQUEST_OUTCOME_UNKNOWN'
      && error?.unsafeToReplay === true,
  )
  assert.deepEqual(attempts, ['primary'])

  const streamAttempts = []
  await assert.rejects(async () => {
    for await (const item of streamWithProviderFailover([
      { providerId: 'primary' },
      { providerId: 'backup' },
    ], async function* ambiguousStream(config) {
      streamAttempts.push(config.providerId)
      yield* []
      throw ambiguous()
    }, {
      maxAttemptsPerProvider: 3,
      retrySleepImpl: async () => {},
    })) void item
  }, (error) => error?.code === 'MODEL_REQUEST_OUTCOME_UNKNOWN')
  assert.deepEqual(streamAttempts, ['primary'])
})

test('stream failover only switches before the first emitted event', async () => {
  async function* beforeFirst(config) {
    if (config.providerId === 'primary') throw Object.assign(new Error('down'), { status: 503 })
    yield 'backup text'
  }
  const received = []
  for await (const item of streamWithProviderFailover([
    { providerId: 'primary' },
    { providerId: 'backup' },
  ], beforeFirst)) received.push(item)
  assert.deepEqual(received, [{ event: 'backup text', config: { providerId: 'backup' } }])

  async function* afterFirst() {
    yield 'partial'
    throw Object.assign(new Error('late failure'), { status: 503 })
  }
  await assert.rejects(async () => {
    for await (const item of streamWithProviderFailover([
      { providerId: 'primary' },
      { providerId: 'backup' },
    ], afterFirst)) {
      // Consume the first event; a late failure must surface without replaying.
      void item
    }
  }, /late failure/)
})

test('stream retries a transient failure on the same provider only before its first event', async () => {
  const attempts = []
  async function* transient(config) {
    attempts.push(config.providerId)
    if (attempts.length === 1) {
      throw Object.assign(new Error('temporarily overloaded'), { status: 503 })
    }
    yield 'recovered text'
  }

  const received = []
  for await (const item of streamWithProviderFailover([
    { providerId: 'primary', modelName: 'local-model' },
    { providerId: 'backup', modelName: 'local-model' },
  ], transient, {
    maxAttemptsPerProvider: 2,
    retrySleepImpl: async () => {},
  })) received.push(item)

  assert.deepEqual(attempts, ['primary', 'primary'])
  assert.deepEqual(received, [{
    event: 'recovered text',
    config: { providerId: 'primary', modelName: 'local-model' },
  }])
})

test('stream never retries or fails over after output has started', async () => {
  const attempts = []
  async function* lateFailure(config) {
    attempts.push(config.providerId)
    yield 'visible prefix'
    throw Object.assign(new Error('connection lost after output'), { status: 503 })
  }

  const received = []
  await assert.rejects(async () => {
    for await (const item of streamWithProviderFailover([
      { providerId: 'primary' },
      { providerId: 'backup' },
    ], lateFailure, {
      maxAttemptsPerProvider: 3,
      retrySleepImpl: async () => {},
    })) received.push(item)
  }, /connection lost after output/)

  assert.deepEqual(attempts, ['primary'])
  assert.deepEqual(received, [{ event: 'visible prefix', config: { providerId: 'primary' } }])
})

test('breaking stream consumption closes the active provider iterator exactly once', async () => {
  let returnCalls = 0
  let nextCalls = 0
  const source = {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          nextCalls += 1
          return { done: false, value: `chunk-${nextCalls}` }
        },
        async return() {
          returnCalls += 1
          return { done: true }
        },
      }
    },
  }

  for await (const item of streamWithProviderFailover(
    [{ providerId: 'primary' }],
    () => source,
  )) {
    assert.equal(item.event, 'chunk-1')
    break
  }

  assert.equal(nextCalls, 1)
  assert.equal(returnCalls, 1)
})

test('stream failover reports provider switch and retry through observer callbacks', async () => {
  const observed = []
  async function* transient(config) {
    if (config.providerId === 'primary') throw Object.assign(new Error('down'), { status: 503 })
    yield 'ok'
  }
  for await (const item of streamWithProviderFailover([
    { providerId: 'primary', modelName: 'm1' },
    { providerId: 'backup', modelName: 'm1' },
  ], transient, {
    maxAttemptsPerProvider: 1,
    retrySleepImpl: async () => {},
    onFailover: (payload) => observed.push(payload),
    onRetry: (payload) => observed.push(payload),
  })) {
    void item
  }
  const failover = observed.find((entry) => entry.kind === 'failover')
  assert.ok(failover, 'failover observer must fire')
  assert.equal(failover.from, 'primary')
  assert.equal(failover.to, 'backup')
  assert.equal(failover.modelName, 'm1')
})
