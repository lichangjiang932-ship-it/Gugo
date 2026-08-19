import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildModelProviderRequest,
  parseModelProviderResponse,
} from '../server/adapters/modelProxy.js'
import {
  consumeNativeProviderStreamPayload,
  createNativeProviderStreamState,
  finishNativeProviderStream,
  isNativeProviderKind,
  registerModelProviderAdapter,
} from '../server/adapters/nativeModelProviders.js'
import { resolveEndpointProfile } from '../server/utils/endpointProfile.js'
import { createRuntimePluginRegistry } from '../server/plugins/runtimePluginRegistry.js'

function adapter() {
  return {
    buildRequest({ config, messages }) {
      return {
        url: `${config.baseUrl}/generate`,
        init: { method: 'POST', body: JSON.stringify({ messages }) },
      }
    },
    parseResponse(data) {
      return { content: data.answer || '', toolCalls: [], usage: data.usage || null, finishReason: 'stop' }
    },
    extractUsage(data) {
      return data.usage || null
    },
    createStreamState(kind) {
      return { kind, finished: false }
    },
    consumeStreamPayload(data, state) {
      if (data.done) {
        state.finished = true
        return [{ type: 'finish', finishReason: 'stop' }]
      }
      return [{ type: 'text', delta: data.text || '' }]
    },
    finishStream(state) {
      if (state.finished) return []
      state.finished = true
      return [{ type: 'finish', finishReason: 'stop' }]
    },
  }
}

test('custom model providers register, drive request/response/stream adapters, and uninstall cleanly', () => {
  const dispose = registerModelProviderAdapter('custom-native', adapter())
  try {
    const profile = resolveEndpointProfile({
      baseUrl: 'https://models.example.test',
      modelName: 'custom-1',
      env: {},
      overrides: { kind: 'custom-native', supportsStreaming: true },
    })
    assert.equal(profile.kind, 'custom-native')
    assert.equal(isNativeProviderKind(profile.kind), true)

    const request = buildModelProviderRequest({
      config: { baseUrl: profile.baseUrl, modelName: profile.modelName },
      profile,
      messages: [{ role: 'user', content: 'hello' }],
    })
    assert.equal(request.url, 'https://models.example.test/generate')
    assert.equal(JSON.parse(request.init.body).messages[0].content, 'hello')
    assert.equal(parseModelProviderResponse({ answer: 'world' }, profile).content, 'world')

    const state = createNativeProviderStreamState(profile.kind)
    assert.deepEqual(consumeNativeProviderStreamPayload({ text: 'chunk' }, state), [{ type: 'text', delta: 'chunk' }])
    assert.deepEqual(finishNativeProviderStream(state), [{ type: 'finish', finishReason: 'stop' }])
  } finally {
    assert.equal(dispose(), true)
  }
  assert.equal(isNativeProviderKind('custom-native'), false)
  assert.equal(resolveEndpointProfile({
    baseUrl: 'https://models.example.test',
    overrides: { kind: 'custom-native' },
    env: {},
  }).kind, 'openai-compatible')
})

test('a non-streaming custom provider response keeps its request adapter after uninstall', () => {
  const frozenRequestAdapter = adapter()
  const buildRequest = frozenRequestAdapter.buildRequest
  frozenRequestAdapter.buildRequest = (args) => Object.freeze(buildRequest(args))
  const dispose = registerModelProviderAdapter('request-lease-native', frozenRequestAdapter)
  const profile = resolveEndpointProfile({
    baseUrl: 'https://lease.example.test',
    modelName: 'lease-1',
    env: {},
    overrides: { kind: 'request-lease-native', supportsStreaming: false },
  })
  const providerRequest = buildModelProviderRequest({
    config: { baseUrl: profile.baseUrl, modelName: profile.modelName },
    profile,
    messages: [{ role: 'user', content: 'hello' }],
  })

  assert.equal(dispose(), true)
  assert.equal(isNativeProviderKind(profile.kind), false)
  assert.equal(parseModelProviderResponse(
    { answer: 'response after unload' },
    profile,
    { providerRequest },
  ).content, 'response after unload')
})

test('model provider registry rejects duplicate kinds and partial streaming adapters', () => {
  assert.throws(() => registerModelProviderAdapter('partial-stream', {
    buildRequest() {},
    parseResponse() {},
    createStreamState() {},
  }), /must define createStreamState, consumeStreamPayload, and finishStream together/)

  const dispose = registerModelProviderAdapter('duplicate-native', adapter())
  try {
    assert.throws(() => registerModelProviderAdapter('duplicate-native', adapter()), /already registered/)
  } finally {
    dispose()
  }
})

test('runtime plugins publish model providers and uninstall them with the plugin lifecycle', async () => {
  const registry = createRuntimePluginRegistry()
  await registry.registerPlugin({
    id: 'provider-plugin',
    name: 'Provider plugin',
    version: '1.0.0',
    contributes: ['model-provider:plugin-native'],
  }, (context) => {
    context.models.providers.register('plugin-native', adapter())
  })

  assert.equal(isNativeProviderKind('plugin-native'), true)
  assert.equal(resolveEndpointProfile({
    baseUrl: 'https://plugin.example.test',
    overrides: { kind: 'plugin-native' },
    env: {},
  }).kind, 'plugin-native')

  assert.equal(await registry.unregisterPlugin('provider-plugin'), true)
  assert.equal(isNativeProviderKind('plugin-native'), false)
})
