import assert from 'node:assert/strict'
import test from 'node:test'

import {
  callStreamingModelWithTools,
  profileForConfig,
  resolveModelConfigForModel,
} from '../server/adapters/modelProxy.js'
import {
  createModelProviderAttempt,
  fingerprintModelProviderConfig,
  fingerprintModelProviderEndpoint,
} from '../server/adapters/modelRequestAttempt.js'
import { reconcileModelRequestWithProvider } from '../server/adapters/modelRequestReconciler.js'
import {
  getEffectiveModelProviderProvenance,
  registerModelProviderAdapter,
} from '../server/adapters/nativeModelProviders.js'
import {
  prepareRuntimeCapabilitySnapshot,
  registerRuntimeCapabilityContribution,
} from '../server/core/runtimeCapabilityHost.js'
import {
  appendModelProviderAttempt,
  createModelInvocation,
  normalizeModelInvocation,
} from '../server/services/loop/modelInvocationCheckpoint.js'
import { runToolLoop } from '../server/services/loop/index.js'
import { createJobLoopModelBridge } from '../server/services/jobModelExecutionRuntime.js'

const MODEL_NAME = 'shared-model'
const REQUEST_FINGERPRINT = 'a'.repeat(64)
const TEST_PROVIDER_RELEASE_DIGEST = `sha256-${'b'.repeat(64)}`

test.before(async () => {
  await prepareRuntimeCapabilitySnapshot({
    env: {
      APP_DATA_DIR: 'Z:\\gugo-provider-attempt-recovery-missing',
      GUGO_LOAD_DOTENV: '0',
    },
  })
})

function failoverEnv(overrides = {}) {
  return {
    MODEL_NAME,
    MODEL_PROVIDERS: 'primary,backup',
    MODEL_PROVIDER_PRIMARY_BASE_URL: 'https://primary.example/v1',
    MODEL_PROVIDER_PRIMARY_API_KEY: 'primary-key',
    MODEL_PROVIDER_PRIMARY_MODELS: MODEL_NAME,
    MODEL_PROVIDER_BACKUP_BASE_URL: 'https://backup.example/v1',
    MODEL_PROVIDER_BACKUP_API_KEY: 'backup-key',
    MODEL_PROVIDER_BACKUP_MODELS: MODEL_NAME,
    MODEL_FAILOVER_CROSS_PROVIDER: '1',
    ...overrides,
  }
}

function streamedText(content) {
  return new Response([
    `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}`,
    '',
    'data: [DONE]',
    '',
  ].join('\n'), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

function pendingInvocation() {
  return createModelInvocation({
    fingerprint: REQUEST_FINGERPRINT,
    jobId: 'turn-provider-attempt',
    stepId: 'turn-provider-attempt',
    iteration: 1,
    attempt: 1,
    modelName: MODEL_NAME,
    modelProviderId: 'primary',
    modelConfigRevision: 7,
  })
}

function physicalAttempt({ env, providerId, sequence, providerAttempt = 1, failoverIndex }) {
  const config = {
    ...resolveModelConfigForModel({ modelName: MODEL_NAME, providerId, env }),
    providerId,
  }
  const profile = profileForConfig(config, env)
  return createModelProviderAttempt({
    config,
    profile,
    requestUrl: `${config.baseUrl.replace(/\/+$/u, '')}/chat/completions`,
    providerCapability: getEffectiveModelProviderProvenance(profile.kind),
    physicalAttempt: sequence,
    providerAttempt,
    failoverIndex,
  })
}

function reconcilerAdapter(onReconcile) {
  return {
    buildRequest() {
      return { url: 'https://unused.example/generate', init: { method: 'POST' } }
    },
    parseResponse() {
      return { content: '', toolCalls: [], usage: null, finishReason: 'stop' }
    },
    requestReconciler: {
      contractVersion: 1,
      authority: 'provider_request_status',
      async reconcile(input) {
        return onReconcile(input)
      },
    },
  }
}

function registerVerifiedReconciler(kind, onReconcile) {
  const adapter = reconcilerAdapter(onReconcile)
  const disposeAdapter = registerModelProviderAdapter(kind, adapter)
  let disposeCapability
  try {
    disposeCapability = registerRuntimeCapabilityContribution({
      id: `test.provider.${kind}`,
      type: 'provider',
      slot: kind,
      owner: 'test-provider-attempt',
      version: '1.0.0',
      priority: 100,
      releaseDigest: TEST_PROVIDER_RELEASE_DIGEST,
      implementation: adapter,
      healthCheck: () => true,
    })
  } catch (error) {
    disposeAdapter()
    throw error
  }
  return () => {
    disposeCapability()
    disposeAdapter()
  }
}

test('every streaming retry and failover attempt is checkpointed before fetch', async () => {
  const timeline = []
  let invocation = pendingInvocation()
  const result = await callStreamingModelWithTools({
    messages: [{ role: 'user', content: 'retry, then fail over' }],
    tools: [],
    modelRequestId: invocation.id,
    env: failoverEnv(),
    onProviderAttempt: async (attempt) => {
      invocation = appendModelProviderAttempt(invocation, attempt)
      timeline.push(`checkpoint:${attempt.sequence}:${attempt.providerId}:${attempt.providerAttempt}`)
    },
    fetchImpl: async (url) => {
      const providerId = String(url).startsWith('https://primary.example/')
        ? 'primary'
        : 'backup'
      timeline.push(`fetch:${providerId}`)
      if (providerId === 'primary') {
        throw Object.assign(new TypeError('fetch failed'), {
          cause: Object.assign(new Error('connection refused before send'), { code: 'ECONNREFUSED' }),
        })
      }
      return streamedText('backup response')
    },
  })

  assert.equal(result.content, 'backup response')
  assert.deepEqual(timeline, [
    'checkpoint:1:primary:1',
    'fetch:primary',
    'checkpoint:2:primary:2',
    'fetch:primary',
    'checkpoint:3:backup:1',
    'fetch:backup',
  ])
  assert.deepEqual(invocation.providerAttempts.map((attempt) => ({
    sequence: attempt.sequence,
    providerId: attempt.providerId,
    providerAttempt: attempt.providerAttempt,
    failoverIndex: attempt.failoverIndex,
  })), [
    { sequence: 1, providerId: 'primary', providerAttempt: 1, failoverIndex: 0 },
    { sequence: 2, providerId: 'primary', providerAttempt: 2, failoverIndex: 0 },
    { sequence: 3, providerId: 'backup', providerAttempt: 1, failoverIndex: 1 },
  ])
})

test('a provider-attempt checkpoint failure prevents fetch, retry, and failover', async () => {
  let checkpointCalls = 0
  let fetchCalls = 0
  const writeFailure = Object.assign(new Error('durable checkpoint unavailable'), {
    code: 'CHECKPOINT_WRITE_FAILED',
  })

  await assert.rejects(
    callStreamingModelWithTools({
      messages: [{ role: 'user', content: 'must not leave this process' }],
      tools: [],
      modelRequestId: pendingInvocation().id,
      env: failoverEnv(),
      onProviderAttempt: async () => {
        checkpointCalls += 1
        throw writeFailure
      },
      fetchImpl: async () => {
        fetchCalls += 1
        return streamedText('must not happen')
      },
    }),
    (error) => error === writeFailure
      && error?.unsafeToReplay === true
      && error?.code === 'CHECKPOINT_WRITE_FAILED',
  )

  assert.equal(checkpointCalls, 1)
  assert.equal(fetchCalls, 0)
})

test('the loop persists each physical attempt in the v3 invocation before provider work continues', async () => {
  const checkpoints = []
  const config = {
    providerId: 'primary',
    modelName: MODEL_NAME,
    baseUrl: 'https://primary.example/v1',
    apiKey: 'runtime-secret',
  }
  const attempt = createModelProviderAttempt({
    config,
    profile: { kind: 'openai-compatible' },
    requestUrl: 'https://primary.example/v1/chat/completions',
    physicalAttempt: 1,
    providerAttempt: 1,
    failoverIndex: 0,
  })
  let providerWork = 0

  const result = await runToolLoop({
    job: {
      id: 'provider-attempt-loop-turn',
      userId: 'provider-attempt-loop-user',
      origin: 'chat',
      prompt: 'answer once',
      modelName: MODEL_NAME,
      modelProviderId: 'primary',
      modelConfigRevision: 7,
    },
    step: { id: 'provider-attempt-loop-turn', kind: 'chat' },
    messages: [{ role: 'user', content: 'answer once' }],
    toolSpecs: [],
    maxIters: 1,
    saveCheckpoint: async (state, meta) => {
      checkpoints.push({
        boundary: meta?.boundary || null,
        state: structuredClone(state),
      })
      return true
    },
    runModel: async (request) => {
      assert.match(request.modelRequestId, /^mr_[a-f0-9]{48}$/u)
      assert.equal(typeof request.onProviderAttempt, 'function')
      await request.onProviderAttempt(attempt)
      assert.equal(checkpoints.at(-1).boundary, 'model-provider-attempt')
      assert.equal(checkpoints.at(-1).state.modelInvocation.providerAttempts.length, 1)
      providerWork += 1
      return { content: 'done', toolCalls: [] }
    },
  })

  assert.equal(result.text, 'done')
  assert.equal(providerWork, 1)
  const attemptCheckpoint = checkpoints.find((entry) => (
    entry.boundary === 'model-provider-attempt'
  ))
  assert.equal(attemptCheckpoint.state.modelInvocation.version, 3)
  assert.equal(attemptCheckpoint.state.modelInvocation.status, 'in_flight')
  assert.deepEqual(attemptCheckpoint.state.modelInvocation.providerAttempts, [attempt])
  const responseCheckpoint = checkpoints.find((entry) => entry.boundary === 'model-response')
  assert.equal(responseCheckpoint.state.modelInvocation.status, 'completed')
  assert.deepEqual(responseCheckpoint.state.modelInvocation.providerAttempts, [attempt])
})

test('a loop checkpoint failure blocks Provider work after the physical attempt callback', async () => {
  const checkpointCause = new Error('model Provider attempt checkpoint failed')
  let providerWork = 0
  let modelProviderAttemptWrites = 0
  const attempt = createModelProviderAttempt({
    config: {
      providerId: 'primary',
      modelName: MODEL_NAME,
      baseUrl: 'https://primary.example/v1',
    },
    profile: { kind: 'openai-compatible' },
    requestUrl: 'https://primary.example/v1/chat/completions',
    physicalAttempt: 1,
    providerAttempt: 1,
    failoverIndex: 0,
  })

  await assert.rejects(runToolLoop({
    job: {
      id: 'provider-attempt-loop-write-failure',
      userId: 'provider-attempt-loop-write-failure-user',
      origin: 'chat',
      prompt: 'must not send',
      modelName: MODEL_NAME,
      modelProviderId: 'primary',
      modelConfigRevision: 7,
    },
    step: { id: 'provider-attempt-loop-write-failure', kind: 'chat' },
    messages: [{ role: 'user', content: 'must not send' }],
    toolSpecs: [],
    maxIters: 1,
    saveCheckpoint: async (_state, meta) => {
      if (meta?.boundary === 'model-provider-attempt') {
        modelProviderAttemptWrites += 1
        throw checkpointCause
      }
      return true
    },
    runModel: async (request) => {
      await request.onProviderAttempt(attempt)
      providerWork += 1
      return { content: 'must not happen', toolCalls: [] }
    },
  }), (error) => error?.code === 'CHECKPOINT_FLUSH_FAILED'
    && error?.cause === checkpointCause
    && error?.unsafeToReplay === true)

  assert.equal(modelProviderAttemptWrites, 1)
  assert.equal(providerWork, 0)
})

test('the Job model bridge forwards the physical-attempt checkpoint callback unchanged', async () => {
  const onProviderAttempt = async () => {}
  let captured = null
  const bridge = createJobLoopModelBridge({
    job: { id: 'job-provider-attempt', userId: 'job-user', modelProviderId: 'primary' },
    step: { id: 'job-provider-attempt-step' },
    selectedModel: MODEL_NAME,
    modelEnv: failoverEnv(),
    runModelWithTools: async (request) => {
      captured = request
      return { content: 'done', toolCalls: [] }
    },
  })

  await bridge.run({
    messages: [{ role: 'user', content: 'job request' }],
    tools: [],
    modelRequestId: 'mr_job_provider_attempt',
    onProviderAttempt,
  })

  assert.strictEqual(captured.onProviderAttempt, onProviderAttempt)
  assert.equal(captured.modelRequestId, 'mr_job_provider_attempt')
  assert.equal(captured.modelName, MODEL_NAME)
  assert.equal(captured.userId, null)
  assert.strictEqual(captured.modelEnv.MODEL_PROVIDER_BACKUP_API_KEY, 'backup-key')
})

test('physical attempt checkpoints contain only hashes, never Provider URL, API key, or headers', () => {
  const secrets = {
    baseUrl: 'https://url-user:url-password@secret-provider.example/private/v1?token=query-secret#fragment-secret',
    apiKey: 'sk-provider-super-secret',
    headerValue: 'header-super-secret',
    requestUrl: 'https://request-secret.example/private/chat/completions?signature=request-secret',
  }
  const config = {
    providerId: 'backup',
    modelName: MODEL_NAME,
    baseUrl: secrets.baseUrl,
    apiKey: secrets.apiKey,
    headers: { Authorization: `Bearer ${secrets.headerValue}` },
  }
  const profile = { kind: 'openai-compatible' }
  const attempt = createModelProviderAttempt({
    config,
    profile,
    requestUrl: secrets.requestUrl,
    physicalAttempt: 1,
    providerAttempt: 1,
    failoverIndex: 1,
  })
  const persisted = normalizeModelInvocation(appendModelProviderAttempt(pendingInvocation(), attempt))
  const serialized = JSON.stringify(persisted)

  assert.deepEqual(Object.keys(attempt).sort(), [
    'configFingerprint',
    'endpointFingerprint',
    'failoverIndex',
    'modelName',
    'providerAttempt',
    'providerId',
    'providerKind',
    'sequence',
    'version',
  ])
  assert.match(attempt.endpointFingerprint, /^[a-f0-9]{64}$/u)
  assert.match(attempt.configFingerprint, /^[a-f0-9]{64}$/u)
  assert.equal(attempt.endpointFingerprint, fingerprintModelProviderEndpoint(secrets.requestUrl))
  assert.equal(attempt.configFingerprint, fingerprintModelProviderConfig({ config, profile }))
  for (const secret of Object.values(secrets)) {
    assert.equal(serialized.includes(secret), false, secret)
  }
  for (const fragment of [
    'secret-provider.example',
    'request-secret.example',
    'url-user',
    'url-password',
    'query-secret',
    'fragment-secret',
    'request-secret',
  ]) {
    assert.equal(serialized.includes(fragment), false, fragment)
  }
})

test('provider reconciliation queries the last physical failover Provider', async () => {
  const kind = 'attempt-reconcile-last-provider'
  const observed = []
  const dispose = registerVerifiedReconciler(kind, async (input) => {
    observed.push(input)
    return {
      outcome: 'completed',
      authoritative: true,
      response: { content: 'recovered from backup', toolCalls: [] },
      receipt: { providerId: input.provider.id },
    }
  })
  const env = failoverEnv({
    MODEL_PROVIDER_PRIMARY_PROFILE: JSON.stringify({ kind }),
    MODEL_PROVIDER_BACKUP_PROFILE: JSON.stringify({ kind }),
  })

  try {
    let invocation = pendingInvocation()
    invocation = appendModelProviderAttempt(invocation, physicalAttempt({
      env,
      providerId: 'primary',
      sequence: 1,
      failoverIndex: 0,
    }))
    invocation = appendModelProviderAttempt(invocation, physicalAttempt({
      env,
      providerId: 'backup',
      sequence: 2,
      failoverIndex: 1,
    }))

    const result = await reconcileModelRequestWithProvider({
      invocation,
      modelName: MODEL_NAME,
      modelProviderId: 'primary',
      modelConfigRevision: 7,
      env,
    })

    assert.equal(result.outcome, 'completed')
    assert.equal(result.authoritative, true)
    assert.deepEqual(result.response, { content: 'recovered from backup', toolCalls: [] })
    assert.deepEqual(result.receipt, { providerId: 'backup' })
    assert.equal(observed.length, 1)
    assert.equal(observed[0].provider.id, 'backup')
    assert.equal(observed[0].provider.logicalProviderId, 'primary')
    assert.equal(observed[0].config.providerId, 'backup')
    assert.equal(observed[0].config.baseUrl, 'https://backup.example/v1')
    assert.equal(observed[0].request.physicalAttempt.providerId, 'backup')
    assert.equal(observed[0].request.physicalAttempt.sequence, 2)
  } finally {
    dispose()
  }
})

test('provider reconciliation rejects a decisive result without authoritative evidence', async () => {
  const kind = 'attempt-reconcile-non-authoritative'
  let reconcileCalls = 0
  const dispose = registerVerifiedReconciler(kind, async () => {
    reconcileCalls += 1
    return {
      outcome: 'completed',
      response: { content: 'unverified response', toolCalls: [] },
      receipt: { lookupId: 'provider-record-1' },
    }
  })
  const env = failoverEnv({
    MODEL_PROVIDER_PRIMARY_PROFILE: JSON.stringify({ kind }),
  })

  try {
    const invocation = appendModelProviderAttempt(pendingInvocation(), physicalAttempt({
      env,
      providerId: 'primary',
      sequence: 1,
      failoverIndex: 0,
    }))
    await assert.rejects(
      reconcileModelRequestWithProvider({
        invocation,
        modelName: MODEL_NAME,
        modelProviderId: 'primary',
        modelConfigRevision: 7,
        env,
      }),
      (error) => error?.code === 'MODEL_REQUEST_RECONCILER_EVIDENCE_INVALID'
        && error?.retryable === false
        && error?.unsafeToReplay === true
        && /must be authoritative/u.test(error.message),
    )
    assert.equal(reconcileCalls, 1)
  } finally {
    dispose()
  }
})

test('reconciliation fails closed when the failover Provider configuration drifted', async () => {
  const kind = 'attempt-reconcile-config-drift'
  let reconcileCalls = 0
  const dispose = registerVerifiedReconciler(kind, async () => {
    reconcileCalls += 1
    return {
      outcome: 'not_sent',
      authoritative: true,
      receipt: { lookupId: 'provider-record-2' },
    }
  })
  const originalEnv = failoverEnv({
    MODEL_PROVIDER_PRIMARY_PROFILE: JSON.stringify({ kind }),
    MODEL_PROVIDER_BACKUP_PROFILE: JSON.stringify({ kind }),
    MODEL_PROVIDER_BACKUP_HEADERS: JSON.stringify({ 'X-Tenant': 'tenant-before' }),
  })

  try {
    let invocation = pendingInvocation()
    invocation = appendModelProviderAttempt(invocation, physicalAttempt({
      env: originalEnv,
      providerId: 'primary',
      sequence: 1,
      failoverIndex: 0,
    }))
    invocation = appendModelProviderAttempt(invocation, physicalAttempt({
      env: originalEnv,
      providerId: 'backup',
      sequence: 2,
      failoverIndex: 1,
    }))

    await assert.rejects(
      reconcileModelRequestWithProvider({
        invocation,
        modelName: MODEL_NAME,
        modelProviderId: 'primary',
        modelConfigRevision: 7,
        env: {
          ...originalEnv,
          MODEL_PROVIDER_BACKUP_API_KEY: 'rotated-backup-key',
          MODEL_PROVIDER_BACKUP_HEADERS: JSON.stringify({ 'X-Tenant': 'tenant-after' }),
        },
      }),
      (error) => error?.code === 'MODEL_REQUEST_CONTEXT_DRIFT'
        && error?.retryable === false
        && /Provider configuration changed/u.test(error.message),
    )
    assert.equal(reconcileCalls, 0)
  } finally {
    dispose()
  }
})
