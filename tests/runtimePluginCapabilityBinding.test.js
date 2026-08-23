import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildModelProviderRequest,
  parseModelProviderResponse,
  profileForConfig,
  resolveModelConfigForModel,
} from '../server/adapters/modelProxy.js'
import { createModelProviderAttempt } from '../server/adapters/modelRequestAttempt.js'
import {
  consumeNativeProviderStreamPayload,
  createNativeProviderStreamState,
  finishNativeProviderStream,
  isNativeProviderKind,
} from '../server/adapters/nativeModelProviders.js'
import { reconcileModelRequestWithProvider } from '../server/adapters/modelRequestReconciler.js'
import { hasModelProviderAdapter } from '../server/adapters/modelProviderRegistry.js'
import {
  listEffectiveRuntimeCapabilityBindings,
  prepareRuntimeCapabilitySnapshot,
} from '../server/core/runtimeCapabilityHost.js'
import {
  getRuntimePlugin,
  registerPlugin,
  unregisterPlugin,
} from '../server/plugins/pluginRegistry.js'
import { runToolsLoop } from '../server/services/loop/index.js'
import { executeServerTool } from '../server/services/loop/heuristics/toolExecutor.js'
import { resolveTurnToolSpecs } from '../server/services/turnToolSpecs.js'
import {
  getBuiltinSpec,
  getDynamicTool,
  listAllSpecs,
} from '../server/utils/toolSchemaCatalog.js'

function manifest(id, contributes, overrides = {}) {
  return {
    id,
    name: id,
    version: '2.3.4',
    contributes,
    ...overrides,
  }
}

function providerAdapter(label, { reconciler = false } = {}) {
  const adapter = {
    buildRequest({ messages }) {
      return {
        url: `https://${label}.plugin.test/generate`,
        init: { method: 'POST', body: JSON.stringify({ messages, label }) },
      }
    },
    parseResponse(data) {
      return {
        content: `${label}:${data.answer || ''}`,
        toolCalls: [],
        usage: data.usage || null,
        finishReason: 'stop',
      }
    },
    extractUsage(data) {
      return data.usage || null
    },
    createStreamState() {
      return { finished: false }
    },
    consumeStreamPayload(data, state) {
      if (data.done) {
        state.finished = true
        return [{ type: 'finish', finishReason: 'stop' }]
      }
      return [{ type: 'text', delta: `${label}:${data.text || ''}` }]
    },
    finishStream(state) {
      if (state.finished) return []
      state.finished = true
      return [{ type: 'finish', finishReason: 'stop' }]
    },
  }
  if (reconciler) {
    adapter.requestReconciler = {
      contractVersion: 1,
      authority: 'provider_request_status',
      async reconcile(input) {
        return {
          outcome: 'completed',
          authoritative: true,
          response: { content: `${label}:recovered`, toolCalls: [] },
          receipt: { label, requestId: input.request.id },
        }
      },
    }
  }
  return adapter
}

function binding(type, slot) {
  return listEffectiveRuntimeCapabilityBindings()
    .find((entry) => entry.binding === `${type}:${slot}`) || null
}

test.before(async () => {
  await prepareRuntimeCapabilitySnapshot({
    env: {
      APP_DATA_DIR: 'Z:\\gugo-runtime-plugin-capability-missing',
      GUGO_LOAD_DOTENV: '0',
    },
  })
})

test('runtime plugin explicitly replaces a builtin tool in catalog and real execution, then restores it', async () => {
  const pluginId = 'bound-tool-plugin'
  const name = 'reflect'
  let plannedRegistrationId
  await registerPlugin(manifest(pluginId, [`tool:${name}`]), (context) => {
    context.tools.register({
      name,
      spec: getBuiltinSpec(name),
      exec: async ({ note }) => ({ ok: true, replaced: true, note }),
      replaces: `builtin.tool.${name}`,
      priority: 100,
    })
  })

  try {
    const selected = binding('tool', name)
    assert.equal(selected?.owner, pluginId)
    assert.equal(selected?.revision, 1)
    assert.equal(selected?.version, '2.3.4')
    assert.equal(selected?.id, `plugin.${pluginId}.tool.${name}`)
    assert.equal(selected?.replaces, `builtin.tool.${name}`)
    assert.deepEqual(
      listAllSpecs().filter((entry) => entry.name === name).map((entry) => entry.origin),
      ['plugin'],
    )
    assert.deepEqual(await executeServerTool({ name, args: { note: 'bound' } }), {
      ok: true,
      replaced: true,
      note: 'bound',
    })
    plannedRegistrationId = getDynamicTool(name)?.registrationId || null
    assert.ok(plannedRegistrationId)

    await assert.rejects(
      registerPlugin(manifest('duplicate-bound-tool-plugin', [`tool:${name}`]), (context) => {
        context.tools.register({
          name,
          spec: getBuiltinSpec(name),
          exec: async () => ({ ok: true, duplicate: true }),
          replaces: `builtin.tool.${name}`,
          priority: 101,
        })
      }),
      (error) => error?.code === 'RUNTIME_CAPABILITY_REPLACEMENT_REQUIRED',
    )
    assert.equal(getRuntimePlugin('duplicate-bound-tool-plugin'), null)
    assert.equal(getDynamicTool(name)?.source, pluginId)
    assert.equal(binding('tool', name)?.owner, pluginId)
  } finally {
    await unregisterPlugin(pluginId)
  }

  assert.equal(binding('tool', name)?.owner, 'builtin')
  assert.deepEqual(
    listAllSpecs().filter((entry) => entry.name === name).map((entry) => entry.origin),
    ['builtin'],
  )
  assert.deepEqual(await executeServerTool({
    name,
    args: { note: 'must-not-run-builtin' },
    dynamicToolRegistrationId: plannedRegistrationId,
  }), {
    ok: false,
    code: 'runtime_tool_binding_changed',
    error: `The capability binding for ${name} changed before execution. The stale call was not executed.`,
    retryable: false,
    refreshToolCatalog: true,
  })
  assert.notEqual((await executeServerTool({ name, args: { note: 'builtin' } }))?.replaced, true)
})

test('runtime plugin replacing read_file inherits workspace visibility and cannot execute in plan mode', async () => {
  const pluginId = 'workspace-bound-read-file-plugin'
  const name = 'read_file'
  let pluginExecutions = 0
  let approvalRequests = 0
  await registerPlugin(manifest(pluginId, [`tool:${name}`]), (context) => {
    context.tools.register({
      name,
      spec: getBuiltinSpec(name),
      exec: async () => {
        pluginExecutions += 1
        return { ok: true, leaked: true }
      },
      replaces: `builtin.tool.${name}`,
      priority: 100,
    })
  })

  const fileAccessStatus = {
    grants: [{
      available: true,
      resourceType: 'directory',
      accessMode: 'read_only',
    }],
  }
  const names = (specs) => specs.map((spec) => spec?.function?.name).filter(Boolean)

  try {
    const hiddenWithoutGrant = await resolveTurnToolSpecs({
      baseSpecs: [getBuiltinSpec(name)],
      fileAccessStatus: { grants: [] },
      permissionMode: 'normal',
    })
    assert.equal(names(hiddenWithoutGrant).includes(name), false)

    const visibleWithGrant = await resolveTurnToolSpecs({
      baseSpecs: [getBuiltinSpec(name)],
      fileAccessStatus,
      permissionMode: 'normal',
    })
    assert.equal(names(visibleWithGrant).includes(name), true)

    const hiddenInPlan = await resolveTurnToolSpecs({
      baseSpecs: [getBuiltinSpec(name)],
      fileAccessStatus,
      permissionMode: 'plan',
    })
    assert.equal(names(hiddenInPlan).includes(name), false)

    const dynamicSpec = listAllSpecs().find((entry) => entry.name === name && entry.origin === 'plugin')?.tool
    assert.ok(dynamicSpec)
    let completedResult = null
    let modelCalls = 0
    await runToolsLoop({
      job: { id: 'plan-dynamic-read-file-job', userId: 'plan-dynamic-read-file-user', origin: 'chat' },
      step: { id: 'plan-dynamic-read-file-step', kind: 'chat' },
      messages: [{ role: 'user', content: 'Read README.md.' }],
      toolSpecs: [dynamicSpec],
      approvalMode: 'plan',
      maxIters: 2,
      enableToolHooks: false,
      requestToolApproval: async ({ args }) => {
        approvalRequests += 1
        return { proceed: true, args }
      },
      runModel: async () => {
        modelCalls += 1
        if (modelCalls === 1) {
          return {
            content: '',
            finishReason: 'tool_calls',
            toolCalls: [{
              id: 'plan-dynamic-read-file-call',
              type: 'function',
              function: { name, arguments: JSON.stringify({ path: 'README.md' }) },
            }],
          }
        }
        return { content: 'blocked', toolCalls: [], finishReason: 'stop' }
      },
      executeTool: (input) => executeServerTool(input),
      onToolCompleted: async ({ result }) => {
        completedResult = result
      },
    })
    assert.equal(completedResult?.code, 'permission_mode_plan_dynamic_tool')
    assert.equal(pluginExecutions, 0)
    assert.equal(approvalRequests, 0)
  } finally {
    await unregisterPlugin(pluginId)
  }

  const restoredInPlan = await resolveTurnToolSpecs({
    baseSpecs: [getBuiltinSpec(name)],
    fileAccessStatus,
    permissionMode: 'plan',
  })
  assert.equal(names(restoredInPlan).includes(name), true)
})

test('builtin tool overrides fail closed without visibility residue and setup failure rolls back', async () => {
  const name = 'reflect'
  const attempts = [
    {
      id: 'implicit-bound-tool-plugin',
      definition: {
        name,
        spec: getBuiltinSpec(name),
        exec: async () => ({ ok: true }),
        priority: 100,
      },
      code: 'PLUGIN_TOOL_REPLACEMENT_REQUIRED',
    },
    {
      id: 'low-priority-bound-tool-plugin',
      definition: {
        name,
        spec: getBuiltinSpec(name),
        exec: async () => ({ ok: true }),
        replaces: `builtin.tool.${name}`,
        priority: 0,
      },
      code: 'PLUGIN_TOOL_REPLACEMENT_PRIORITY_INVALID',
    },
  ]
  for (const attempt of attempts) {
    await assert.rejects(
      registerPlugin(manifest(attempt.id, [`tool:${name}`]), (context) => {
        context.tools.register(attempt.definition)
      }),
      (error) => error?.code === attempt.code,
    )
    assert.equal(getRuntimePlugin(attempt.id), null)
    assert.equal(getDynamicTool(name), null)
    assert.equal(binding('tool', name)?.owner, 'builtin')
  }

  await assert.rejects(
    registerPlugin(manifest('rollback-bound-tool-plugin', [`tool:${name}`]), (context) => {
      context.tools.register({
        name,
        spec: getBuiltinSpec(name),
        exec: async () => ({ ok: true, leaked: true }),
        replaces: `builtin.tool.${name}`,
        priority: 100,
      })
      throw Object.assign(new Error('setup failed after visible registration'), { code: 'FIXTURE_SETUP_FAILED' })
    }),
    (error) => error?.code === 'FIXTURE_SETUP_FAILED',
  )
  assert.equal(getDynamicTool(name), null)
  assert.equal(binding('tool', name)?.owner, 'builtin')
})

test('runtime plugin replaces native and OpenAI-compatible providers across request, response, stream, and reconciliation', async () => {
  const pluginId = 'bound-provider-plugin'
  await registerPlugin(manifest(pluginId, [
    'model-provider:anthropic',
    'model-provider:openai-compatible',
  ], {
    integrity: `sha256-${'a'.repeat(64)}`,
  }), (context) => {
    context.models.providers.register('anthropic', providerAdapter('native'), {
      replaces: 'builtin.provider.anthropic',
      priority: 100,
    })
    context.models.providers.register('openai-compatible', providerAdapter('compatible', {
      reconciler: true,
    }), {
      replaces: 'builtin.provider.openai-compatible',
      priority: 100,
    })
  })

  const nativeProfile = { kind: 'anthropic', supportsTools: true, supportsVision: true }
  const compatibleProfile = { kind: 'openai-compatible', supportsTools: true, supportsVision: true }
  const nativeConfig = {
    baseUrl: 'https://api.anthropic.com/v1/messages',
    modelName: 'claude-test',
    apiKey: 'secret',
  }
  const compatibleConfig = {
    baseUrl: 'https://compatible.example.test/v1',
    modelName: 'compatible-test',
    apiKey: 'secret',
  }
  const messages = [{ role: 'user', content: 'hello' }]
  const reconcileEnv = {
    MODEL_PROVIDERS: 'default',
    MODEL_NAME: compatibleConfig.modelName,
    MODEL_PROVIDER_DEFAULT_BASE_URL: compatibleConfig.baseUrl,
    MODEL_PROVIDER_DEFAULT_API_KEY: compatibleConfig.apiKey,
    MODEL_PROVIDER_DEFAULT_MODELS: compatibleConfig.modelName,
  }

  try {
    for (const [kind, label] of [['anthropic', 'native'], ['openai-compatible', 'compatible']]) {
      const selected = binding('provider', kind)
      assert.equal(selected?.owner, pluginId)
      assert.equal(selected?.revision, 1)
      assert.equal(selected?.replaces, `builtin.provider.${kind}`)
      assert.equal(isNativeProviderKind(kind), true)
      assert.equal(hasModelProviderAdapter(kind), true)

      const profile = kind === 'anthropic' ? nativeProfile : compatibleProfile
      const config = kind === 'anthropic' ? nativeConfig : compatibleConfig
      const request = buildModelProviderRequest({ config, profile, messages })
      assert.equal(request.url, `https://${label}.plugin.test/generate`)
      assert.equal(parseModelProviderResponse(
        { answer: 'world' },
        profile,
        { providerRequest: request },
      ).content, `${label}:world`)

      const state = createNativeProviderStreamState(kind)
      assert.deepEqual(consumeNativeProviderStreamPayload({ text: 'chunk' }, state), [
        { type: 'text', delta: `${label}:chunk` },
      ])
      assert.deepEqual(finishNativeProviderStream(state), [
        { type: 'finish', finishReason: 'stop' },
      ])
    }

    const resolvedCompatibleConfig = {
      ...resolveModelConfigForModel({
        modelName: compatibleConfig.modelName,
        env: reconcileEnv,
      }),
      providerId: 'default',
    }
    const resolvedCompatibleProfile = profileForConfig(resolvedCompatibleConfig, reconcileEnv)
    const providerAttempt = createModelProviderAttempt({
      config: resolvedCompatibleConfig,
      profile: resolvedCompatibleProfile,
      requestUrl: 'https://compatible.plugin.test/generate',
      providerCapability: binding('provider', 'openai-compatible'),
      physicalAttempt: 1,
      providerAttempt: 1,
      failoverIndex: 0,
    })
    const reconciled = await reconcileModelRequestWithProvider({
      invocation: {
        id: 'bound-provider-request',
        providerId: null,
        modelName: compatibleConfig.modelName,
        configRevision: null,
        idempotencyKey: 'bound-provider-idempotency',
        fingerprint: 'fixture-fingerprint',
        iteration: 1,
        attempt: 1,
        providerAttempts: [providerAttempt],
      },
      modelName: compatibleConfig.modelName,
      env: reconcileEnv,
    })
    assert.equal(reconciled.outcome, 'completed', JSON.stringify(reconciled))
    assert.deepEqual(reconciled.receipt, {
      label: 'compatible',
      requestId: 'bound-provider-request',
    })
  } finally {
    await unregisterPlugin(pluginId)
  }

  assert.equal(binding('provider', 'anthropic')?.owner, 'builtin')
  assert.equal(binding('provider', 'openai-compatible')?.owner, 'builtin')
  assert.equal(hasModelProviderAdapter('anthropic'), false)
  assert.equal(hasModelProviderAdapter('openai-compatible'), false)
  assert.equal(isNativeProviderKind('openai-compatible'), false)

  const nativeRequest = buildModelProviderRequest({
    config: nativeConfig,
    profile: nativeProfile,
    messages,
  })
  assert.equal(nativeRequest.url, nativeConfig.baseUrl)
  const compatibleRequest = buildModelProviderRequest({
    config: compatibleConfig,
    profile: compatibleProfile,
    messages,
  })
  assert.match(compatibleRequest.url, /\/chat\/completions$/u)
  assert.equal(parseModelProviderResponse({
    choices: [{ message: { content: 'builtin compatible' }, finish_reason: 'stop' }],
  }, compatibleProfile).content, 'builtin compatible')

  const builtinConfig = {
    ...resolveModelConfigForModel({
      modelName: compatibleConfig.modelName,
      env: reconcileEnv,
    }),
    providerId: 'default',
  }
  const builtinProfile = profileForConfig(builtinConfig, reconcileEnv)
  const builtinAttempt = createModelProviderAttempt({
    config: builtinConfig,
    profile: builtinProfile,
    requestUrl: `${compatibleConfig.baseUrl}/chat/completions`,
    providerCapability: binding('provider', 'openai-compatible'),
    physicalAttempt: 1,
    providerAttempt: 1,
    failoverIndex: 0,
  })

  const reconciledAfterUnload = await reconcileModelRequestWithProvider({
    invocation: {
      id: 'bound-provider-request-after-unload',
      providerId: null,
      modelName: compatibleConfig.modelName,
      configRevision: null,
      idempotencyKey: 'bound-provider-idempotency-after-unload',
      fingerprint: 'fixture-fingerprint-after-unload',
      iteration: 1,
      attempt: 1,
      providerAttempts: [builtinAttempt],
    },
    modelName: compatibleConfig.modelName,
    env: reconcileEnv,
  })
  assert.equal(reconciledAfterUnload.outcome, 'unsupported')
  assert.equal(reconciledAfterUnload.receipt.reason, 'provider_reconciler_not_registered')
})

test('provider reconciliation rejects a plugin release digest drift before invoking the new release', async () => {
  const pluginId = 'provider-release-drift-plugin'
  const kind = 'release-drift-provider'
  const modelName = 'release-drift-model'
  const env = {
    MODEL_PROVIDERS: 'default',
    MODEL_NAME: modelName,
    MODEL_PROVIDER_DEFAULT_BASE_URL: 'https://release-drift.example.test/v1',
    MODEL_PROVIDER_DEFAULT_API_KEY: 'release-drift-secret',
    MODEL_PROVIDER_DEFAULT_MODELS: modelName,
    MODEL_PROVIDER_DEFAULT_PROFILE: JSON.stringify({ kind }),
  }
  const registerRelease = async (digest, label) => registerPlugin(manifest(
    pluginId,
    [`model-provider:${kind}`],
    { integrity: digest },
  ), (context) => {
    context.models.providers.register(kind, providerAdapter(label, { reconciler: true }))
  })

  await registerRelease(`sha256-${'b'.repeat(64)}`, 'release-before')
  const config = {
    ...resolveModelConfigForModel({ modelName, env }),
    providerId: 'default',
  }
  const profile = profileForConfig(config, env)
  const invocation = {
    id: 'plugin-release-drift-request',
    providerId: null,
    modelName,
    configRevision: null,
    idempotencyKey: 'plugin-release-drift-idempotency',
    fingerprint: 'plugin-release-drift-fingerprint',
    iteration: 1,
    attempt: 1,
    providerAttempts: [createModelProviderAttempt({
      config,
      profile,
      requestUrl: 'https://release-before.plugin.test/generate',
      providerCapability: binding('provider', kind),
      physicalAttempt: 1,
      providerAttempt: 1,
      failoverIndex: 0,
    })],
  }

  await unregisterPlugin(pluginId)
  await registerRelease(`sha256-${'c'.repeat(64)}`, 'release-after')
  try {
    await assert.rejects(
      reconcileModelRequestWithProvider({ invocation, modelName, env }),
      (error) => error?.code === 'MODEL_REQUEST_CONTEXT_DRIFT'
        && error?.retryable === false
        && /plugin release changed/u.test(error.message),
    )
  } finally {
    await unregisterPlugin(pluginId)
  }
})

test('builtin provider overrides reject implicit and low-priority replacement without residue', async () => {
  for (const attempt of [
    {
      id: 'implicit-bound-provider-plugin',
      options: { priority: 100 },
      code: 'PLUGIN_MODEL_PROVIDER_REPLACEMENT_REQUIRED',
    },
    {
      id: 'low-priority-bound-provider-plugin',
      options: { replaces: 'builtin.provider.anthropic', priority: 0 },
      code: 'PLUGIN_MODEL_PROVIDER_REPLACEMENT_PRIORITY_INVALID',
    },
  ]) {
    await assert.rejects(
      registerPlugin(manifest(attempt.id, ['model-provider:anthropic']), (context) => {
        context.models.providers.register('anthropic', providerAdapter('rejected'), attempt.options)
      }),
      (error) => error?.code === attempt.code,
    )
    assert.equal(getRuntimePlugin(attempt.id), null)
    assert.equal(hasModelProviderAdapter('anthropic'), false)
    assert.equal(binding('provider', 'anthropic')?.owner, 'builtin')
  }
})
