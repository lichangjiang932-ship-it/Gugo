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
import { registerEndpointKind, resolveEndpointProfile } from '../server/utils/endpointProfile.js'
import {
  getModelProviderAdapter,
  hasModelProviderAdapter,
  unregisterModelProviderAdapter,
} from '../server/adapters/modelProviderRegistry.js'
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

test('model provider registry rejects duplicate kinds, accessors, inherited methods, and partial streaming adapters', () => {
  let getterCalls = 0
  const accessorAdapter = {
    parseResponse() {},
  }
  Object.defineProperty(accessorAdapter, 'buildRequest', {
    enumerable: true,
    get() {
      getterCalls += 1
      return () => ({})
    },
  })
  assert.throws(
    () => registerModelProviderAdapter('accessor-native', accessorAdapter),
    /buildRequest must be an own function property/,
  )
  assert.equal(getterCalls, 0)

  const inheritedAdapter = Object.create({
    buildRequest() {},
    parseResponse() {},
  })
  assert.throws(
    () => registerModelProviderAdapter('inherited-native', inheritedAdapter),
    /buildRequest must be an own function property/,
  )

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

test('model provider kind boundaries reject object coercion without changing registry state', () => {
  let propertyReads = 0
  const hostileKind = new Proxy({}, {
    get() {
      propertyReads += 1
      throw new Error('kind coercion must not execute')
    },
  })
  const dispose = registerModelProviderAdapter('strict-kind-native', adapter())
  try {
    assert.throws(
      () => registerModelProviderAdapter(hostileKind, adapter()),
      /model provider kind must be a string/,
    )
    assert.throws(
      () => registerEndpointKind(hostileKind),
      /endpoint kind must be a string/,
    )
    assert.equal(getModelProviderAdapter(hostileKind), null)
    assert.equal(hasModelProviderAdapter(hostileKind), false)
    assert.equal(unregisterModelProviderAdapter(hostileKind), false)
    assert.equal(isNativeProviderKind(hostileKind), false)
    assert.equal(hasModelProviderAdapter('strict-kind-native'), true)
    assert.equal(propertyReads, 0)
  } finally {
    assert.equal(dispose(), true)
  }
})

test('runtime model provider callbacks are fenced by plugin lifecycle', async () => {
  const registry = createRuntimePluginRegistry()
  let buildCalls = 0
  let parseCalls = 0
  let selfUnregister = null
  await registry.registerPlugin({
    id: 'fenced-provider-plugin',
    name: 'Fenced provider plugin',
    version: '1.0.0',
    contributes: ['model-provider:fenced-native'],
  }, (context) => {
    const providerAdapter = adapter()
    providerAdapter.buildRequest = function buildRequest(args) {
      buildCalls += 1
      selfUnregister = registry.unregisterPlugin('fenced-provider-plugin')
      return adapter().buildRequest(args)
    }
    providerAdapter.parseResponse = function parseResponse(data) {
      parseCalls += 1
      return adapter().parseResponse(data)
    }
    context.models.providers.register('fenced-native', providerAdapter)
  })

  const profile = resolveEndpointProfile({
    baseUrl: 'https://fenced.example.test',
    modelName: 'fenced-1',
    env: {},
    overrides: { kind: 'fenced-native', supportsStreaming: false },
  })
  const providerRequest = buildModelProviderRequest({
    config: { baseUrl: profile.baseUrl, modelName: profile.modelName },
    profile,
    messages: [{ role: 'user', content: 'hello' }],
  })
  assert.equal(buildCalls, 1)
  await assert.rejects(
    selfUnregister,
    (error) => error?.code === 'PLUGIN_CALLBACK_SELF_UNREGISTER_DEADLOCK',
  )

  assert.equal(await registry.unregisterPlugin('fenced-provider-plugin'), true)
  assert.throws(
    () => parseModelProviderResponse({ answer: 'stale response' }, profile, { providerRequest }),
    (error) => error?.code === 'PLUGIN_MODEL_PROVIDER_UNAVAILABLE' && error?.retryable === false,
  )
  assert.equal(parseCalls, 0)
})

test('runtime model provider callbacks must stay synchronous', async () => {
  const registry = createRuntimePluginRegistry()
  await registry.registerPlugin({
    id: 'async-provider-plugin',
    name: 'Async provider plugin',
    version: '1.0.0',
    contributes: ['model-provider:async-native'],
  }, (context) => {
    const providerAdapter = adapter()
    providerAdapter.buildRequest = async (args) => adapter().buildRequest(args)
    context.models.providers.register('async-native', providerAdapter)
  })

  const profile = resolveEndpointProfile({
    baseUrl: 'https://async.example.test',
    modelName: 'async-1',
    env: {},
    overrides: { kind: 'async-native', supportsStreaming: false },
  })
  assert.throws(
    () => buildModelProviderRequest({
      config: { baseUrl: profile.baseUrl, modelName: profile.modelName },
      profile,
      messages: [{ role: 'user', content: 'hello' }],
    }),
    (error) => error?.code === 'PLUGIN_MODEL_PROVIDER_ASYNC_UNSUPPORTED'
      && error?.retryable === false,
  )
  assert.equal(await registry.unregisterPlugin('async-provider-plugin'), true)
})

test('runtime model provider result traversal remains inside callback accounting', async () => {
  const registry = createRuntimePluginRegistry()
  let unregisterAttempt = null
  await registry.registerPlugin({
    id: 'provider-result-accounting-plugin',
    name: 'Provider result accounting plugin',
    version: '1.0.0',
    contributes: ['model-provider:provider-result-accounting-native'],
  }, (context) => {
    const providerAdapter = adapter()
    providerAdapter.buildRequest = ({ config }) => new Proxy({
      url: `${config.baseUrl}/accounted`,
      init: { method: 'POST', body: '{}' },
    }, {
      getPrototypeOf(target) {
        if (!unregisterAttempt) {
          unregisterAttempt = registry.unregisterPlugin('provider-result-accounting-plugin')
        }
        return Reflect.getPrototypeOf(target)
      },
    })
    context.models.providers.register('provider-result-accounting-native', providerAdapter)
  })

  const profile = resolveEndpointProfile({
    baseUrl: 'https://provider-accounting.example.test',
    modelName: 'accounted-1',
    env: {},
    overrides: { kind: 'provider-result-accounting-native', supportsStreaming: false },
  })
  const request = buildModelProviderRequest({
    config: { baseUrl: profile.baseUrl, modelName: profile.modelName },
    profile,
    messages: [{ role: 'user', content: 'hello' }],
  })
  assert.equal(request.url, 'https://provider-accounting.example.test/accounted')
  await assert.rejects(
    unregisterAttempt,
    (error) => error?.code === 'PLUGIN_CALLBACK_SELF_UNREGISTER_DEADLOCK'
      && error?.retryable === false,
  )
  assert.equal(registry.getPlugin('provider-result-accounting-plugin')?.state, 'active')
  assert.equal(await registry.unregisterPlugin('provider-result-accounting-plugin'), true)
})

test('runtime model provider thrown values cross as detached non-retryable errors', async () => {
  const registry = createRuntimePluginRegistry()
  let unregisterAttempt = null
  let messageGetterCalls = 0
  const thrown = {}
  Object.defineProperties(thrown, {
    message: {
      get() {
        messageGetterCalls += 1
        return 'getter must not execute'
      },
    },
    code: { value: 'PLUGIN_CUSTOM_PROVIDER_FAILURE' },
    retryable: { value: true },
    cause: { value: { providerCapability: true } },
  })
  const trappedError = new Proxy(thrown, {
    getOwnPropertyDescriptor(target, key) {
      if (!unregisterAttempt) {
        unregisterAttempt = registry.unregisterPlugin('provider-error-accounting-plugin')
      }
      return Reflect.getOwnPropertyDescriptor(target, key)
    },
  })

  await registry.registerPlugin({
    id: 'provider-error-accounting-plugin',
    name: 'Provider error accounting plugin',
    version: '1.0.0',
    contributes: ['model-provider:provider-error-accounting-native'],
  }, (context) => {
    const providerAdapter = adapter()
    providerAdapter.parseResponse = () => { throw trappedError }
    context.models.providers.register('provider-error-accounting-native', providerAdapter)
  })

  const profile = resolveEndpointProfile({
    baseUrl: 'https://provider-error.example.test',
    modelName: 'error-1',
    env: {},
    overrides: { kind: 'provider-error-accounting-native', supportsStreaming: false },
  })
  const providerRequest = buildModelProviderRequest({
    config: { baseUrl: profile.baseUrl, modelName: profile.modelName },
    profile,
    messages: [{ role: 'user', content: 'hello' }],
  })
  assert.throws(
    () => parseModelProviderResponse({ answer: 'never returned' }, profile, { providerRequest }),
    (error) => {
      assert.notEqual(error, trappedError)
      assert.equal(error?.code, 'PLUGIN_CUSTOM_PROVIDER_FAILURE')
      assert.equal(error?.retryable, false)
      assert.equal(error?.message, 'plugin model provider callback failed: provider-error-accounting-native/parseResponse')
      assert.equal(error?.pluginId, 'provider-error-accounting-plugin')
      assert.equal(error?.providerKind, 'provider-error-accounting-native')
      assert.equal(error?.method, 'parseResponse')
      assert.equal(Object.hasOwn(error, 'cause'), false)
      return true
    },
  )
  assert.equal(messageGetterCalls, 0)
  await assert.rejects(
    unregisterAttempt,
    (error) => error?.code === 'PLUGIN_CALLBACK_SELF_UNREGISTER_DEADLOCK'
      && error?.retryable === false,
  )
  assert.equal(registry.getPlugin('provider-error-accounting-plugin')?.state, 'active')
  assert.equal(await registry.unregisterPlugin('provider-error-accounting-plugin'), true)
})

test('runtime model providers exchange isolated data and keep stream state opaque', async () => {
  const registry = createRuntimePluginRegistry()
  let requestResult = null
  let parseResult = null
  let issuedState = null
  let callbackState = null
  let finishCallbackState = null
  await registry.registerPlugin({
    id: 'isolated-provider-plugin',
    name: 'Isolated provider plugin',
    version: '1.0.0',
    contributes: ['model-provider:isolated-native'],
  }, (context) => {
    const providerAdapter = adapter()
    providerAdapter.buildRequest = (input) => {
      assert.equal(Object.isFrozen(input), true)
      assert.equal(Object.isFrozen(input.config), true)
      assert.equal(Object.isFrozen(input.messages), true)
      assert.equal(Object.isFrozen(input.messages[0]), true)
      requestResult = {
        url: `${input.config.baseUrl}/isolated`,
        init: { method: 'POST', body: JSON.stringify({ messages: input.messages }) },
      }
      return requestResult
    }
    providerAdapter.parseResponse = (data) => {
      assert.equal(Object.isFrozen(data), true)
      parseResult = {
        content: data.answer,
        toolCalls: [],
        usage: null,
        finishReason: 'stop',
      }
      return parseResult
    }
    providerAdapter.createStreamState = () => {
      issuedState = { chunks: 0, nested: { finished: false } }
      return issuedState
    }
    providerAdapter.consumeStreamPayload = (data, state) => {
      assert.equal(Object.isFrozen(data), true)
      assert.equal(Object.isFrozen(data.nested), true)
      callbackState = state
      state.chunks += 1
      return [{ type: 'text', delta: `${data.text}:${state.chunks}` }]
    }
    providerAdapter.finishStream = (state) => {
      finishCallbackState = state
      state.nested.finished = true
      return [{ type: 'finish', finishReason: 'stop' }]
    }
    context.models.providers.register('isolated-native', providerAdapter)
  })

  const profile = resolveEndpointProfile({
    baseUrl: 'https://isolated.example.test',
    modelName: 'isolated-1',
    env: {},
    overrides: { kind: 'isolated-native', supportsStreaming: true },
  })
  const request = buildModelProviderRequest({
    config: { baseUrl: profile.baseUrl, modelName: profile.modelName },
    profile,
    messages: [{ role: 'user', content: 'hello' }],
  })
  requestResult.url = 'https://mutated.example.test'
  assert.equal(request.url, 'https://isolated.example.test/isolated')

  const parsed = parseModelProviderResponse({ answer: 'world' }, profile, { providerRequest: request })
  parseResult.content = 'mutated'
  assert.equal(parsed.content, 'world')

  const state = createNativeProviderStreamState(profile.kind)
  assert.deepEqual(Object.keys(state), ['kind'])
  issuedState.chunks = 99
  const events = consumeNativeProviderStreamPayload({ text: 'chunk', nested: { value: 1 } }, state)
  assert.notEqual(callbackState, issuedState)
  assert.equal(callbackState.chunks, 1)
  assert.deepEqual(events, [{ type: 'text', delta: 'chunk:1' }])
  assert.equal(Object.isFrozen(events), true)
  assert.equal(Object.isFrozen(events[0]), true)

  const escapedState = callbackState
  escapedState.chunks = 99
  assert.deepEqual(
    consumeNativeProviderStreamPayload({ text: 'next', nested: { value: 2 } }, state),
    [{ type: 'text', delta: 'next:2' }],
  )
  assert.notEqual(callbackState, escapedState)
  assert.equal(callbackState.chunks, 2)
  assert.deepEqual(finishNativeProviderStream(state), [{ type: 'finish', finishReason: 'stop' }])
  assert.notEqual(finishCallbackState, callbackState)
  assert.equal(finishCallbackState.nested.finished, true)

  assert.equal(await registry.unregisterPlugin('isolated-provider-plugin'), true)
})

test('runtime model providers reject accessor data, capability results, and forged stream state', async () => {
  const registry = createRuntimePluginRegistry()
  let parseCalls = 0
  let invalidParseResult = false
  let invalidStreamState = true
  await registry.registerPlugin({
    id: 'invalid-data-provider-plugin',
    name: 'Invalid data provider plugin',
    version: '1.0.0',
    contributes: ['model-provider:invalid-data-native'],
  }, (context) => {
    const providerAdapter = adapter()
    providerAdapter.parseResponse = (data) => {
      parseCalls += 1
      if (invalidParseResult) {
        return {
          content: data.answer,
          toolCalls: [],
          usage: null,
          finishReason: 'stop',
          capability() {},
        }
      }
      return adapter().parseResponse(data)
    }
    providerAdapter.createStreamState = () => invalidStreamState
      ? { capability() {} }
      : { chunks: 0 }
    context.models.providers.register('invalid-data-native', providerAdapter)
  })

  const profile = resolveEndpointProfile({
    baseUrl: 'https://invalid-data.example.test',
    modelName: 'invalid-data-1',
    env: {},
    overrides: { kind: 'invalid-data-native', supportsStreaming: true },
  })
  let getterCalls = 0
  const accessorResponse = { answer: 'world' }
  Object.defineProperty(accessorResponse, 'trap', {
    enumerable: true,
    get() {
      getterCalls += 1
      return 'not data'
    },
  })
  assert.throws(
    () => parseModelProviderResponse(accessorResponse, profile),
    (error) => error?.code === 'PLUGIN_MODEL_PROVIDER_ARGUMENT_INVALID'
      && error?.retryable === false,
  )
  assert.equal(getterCalls, 0)
  assert.equal(parseCalls, 0)

  invalidParseResult = true
  assert.throws(
    () => parseModelProviderResponse({ answer: 'world' }, profile),
    (error) => error?.code === 'PLUGIN_MODEL_PROVIDER_RESULT_INVALID'
      && error?.retryable === false,
  )
  assert.equal(parseCalls, 1)

  assert.throws(
    () => createNativeProviderStreamState(profile.kind),
    (error) => error?.code === 'PLUGIN_MODEL_PROVIDER_STREAM_STATE_INVALID'
      && error?.retryable === false,
  )
  invalidStreamState = false
  const state = createNativeProviderStreamState(profile.kind)
  assert.throws(
    () => consumeNativeProviderStreamPayload({ text: 'chunk' }, { kind: profile.kind }),
    (error) => error?.code === 'PLUGIN_MODEL_PROVIDER_STREAM_STATE_INVALID'
      && error?.retryable === false,
  )
  assert.deepEqual(finishNativeProviderStream(state), [{ type: 'finish', finishReason: 'stop' }])

  assert.equal(await registry.unregisterPlugin('invalid-data-provider-plugin'), true)
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
