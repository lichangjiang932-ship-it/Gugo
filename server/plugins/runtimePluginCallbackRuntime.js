import { AsyncLocalStorage } from 'node:async_hooks'

import {
  isolatePluginDisposerError,
  isolatePluginSetupError,
} from './pluginLifecycle.js'
import {
  pluginAsyncResultKind,
  suppressNativePromiseRejection,
} from './runtimePluginAsyncBoundary.js'

// Lifecycle mutations must observe the innermost plugin-controlled frame across
// every registry instance. One shared scope preserves nesting order; separate
// callback/setup/cleanup scopes can misattribute an inner frame to an outer one.
const lifecycleScope = new AsyncLocalStorage()

export function createRuntimePluginCallbackRuntime(registryToken) {
  const finishCallback = (record) => {
    record.activeCallbacks -= 1
    if (record.activeCallbacks !== 0) return
    for (const resolve of record.callbackDrainWaiters) resolve()
    record.callbackDrainWaiters.clear()
  }

  const waitForCallbacksToDrain = (record) => {
    if (record.activeCallbacks === 0) return Promise.resolve()
    return new Promise((resolve) => record.callbackDrainWaiters.add(resolve))
  }

  const invokePluginCallback = async (record, kind, callback, args) => {
    record.activeCallbacks += 1
    const invocation = { record, kind, active: true, registryToken }
    try {
      return await lifecycleScope.run(invocation, () => callback(...args))
    } finally {
      invocation.active = false
      finishCallback(record)
    }
  }

  const invokePluginCallbackSync = (record, kind, callback, args, options = {}) => {
    record.activeCallbacks += 1
    const invocation = { record, kind, active: true, registryToken }
    const complete = typeof options.complete === 'function' ? options.complete : (value) => value
    const isolateError = typeof options.isolateError === 'function' ? options.isolateError : null
    try {
      return lifecycleScope.run(invocation, () => {
        try {
          const result = callback(...args)
          const asyncResultKind = pluginAsyncResultKind(result)
          if (asyncResultKind) {
            if (asyncResultKind === 'promise') suppressNativePromiseRejection(result)
            const isPrompt = kind === 'prompt'
            const isPolicy = kind === 'policy'
            const error = new TypeError(isPrompt
              ? 'plugin prompt render must be synchronous'
              : isPolicy
                ? 'plugin policy classify must be synchronous'
                : 'plugin model provider callbacks must be synchronous')
            error.code = isPrompt
              ? 'PLUGIN_PROMPT_ASYNC_UNSUPPORTED'
              : isPolicy
                ? 'PLUGIN_POLICY_ASYNC_UNSUPPORTED'
                : 'PLUGIN_MODEL_PROVIDER_ASYNC_UNSUPPORTED'
            error.retryable = false
            throw error
          }
          return complete(result)
        } catch (error) {
          throw isolateError ? isolateError(error) : error
        }
      })
    } finally {
      invocation.active = false
      finishCallback(record)
    }
  }

  const callbackDrainDeadlockError = (
    operation,
    invocation,
    targetPluginId = '',
    targetRegistryToken = null,
  ) => {
    const { record } = invocation
    const pluginId = record.manifest.id
    const normalizedTargetId = typeof targetPluginId === 'string' ? targetPluginId.trim() : ''
    const crossRegistry = invocation.registryToken !== targetRegistryToken
    const samePlugin = !crossRegistry && normalizedTargetId === pluginId
    const selfUnregister = operation === 'unregister' && samePlugin
    let message
    let code
    if (operation === 'unregister') {
      message = selfUnregister
        ? `plugin callback cannot unregister its own plugin before returning because that would deadlock callback drain: ${pluginId}`
        : `plugin callback cannot unregister another plugin before returning because that would deadlock callback drain: ${pluginId} -> ${normalizedTargetId || '(invalid)'}`
      code = selfUnregister
        ? 'PLUGIN_CALLBACK_SELF_UNREGISTER_DEADLOCK'
        : 'PLUGIN_CALLBACK_UNREGISTER_DEADLOCK'
    } else if (operation === 'reload') {
      message = samePlugin
        ? 'plugin callback cannot reload its own configuration before returning'
        : `plugin callback cannot reload another plugin before returning because that would deadlock callback drain: ${pluginId} -> ${normalizedTargetId || '(invalid)'}`
      code = 'PLUGIN_CONFIG_RELOAD_CALLBACK_DEADLOCK'
    } else {
      message = crossRegistry
        ? `plugin callback cannot shut down another runtime plugin registry before returning because that would deadlock callback drain: ${pluginId}`
        : `plugin callback cannot shut down the runtime plugin registry before returning because that would deadlock callback drain: ${pluginId}`
      code = 'PLUGIN_CALLBACK_SHUTDOWN_DEADLOCK'
    }
    const error = new Error(message)
    error.code = code
    error.retryable = false
    error.pluginId = pluginId
    error.phase = invocation.kind
    error.operation = operation
    error.crossRegistry = crossRegistry
    if (normalizedTargetId) error.targetPluginId = normalizedTargetId
    if (operation === 'reload') error.statusCode = 409
    return error
  }

  const activeCallbackInvocation = () => {
    const invocation = lifecycleScope.getStore()
    return invocation?.active === true ? invocation : null
  }

  const invokePluginCleanup = (record, kind, callback) => {
    const invocation = { record, kind, active: true, registryToken }
    const result = lifecycleScope.run(invocation, callback)
    return result.finally(() => {
      invocation.active = false
    })
  }

  const disposePluginEffects = async (record) => {
    const invocation = { record, kind: 'dispose', active: true, registryToken }
    try {
      return await lifecycleScope.run(invocation, async () => {
        const errors = await record.effects.disposeAll()
        return errors.map((error) => isolatePluginDisposerError(error, record.manifest.id))
      })
    } finally {
      invocation.active = false
    }
  }

  const invokePluginSetup = async (record, setup, context) => {
    const invocation = { record, kind: 'setup', active: true, registryToken }
    try {
      return await lifecycleScope.run(invocation, async () => {
        try {
          const setupEffects = await setup(context)
          if (setupEffects != null) record.effects.track(setupEffects)
        } catch (error) {
          throw isolatePluginSetupError(error, record.manifest.id)
        }
      })
    } finally {
      invocation.active = false
    }
  }

  return Object.freeze({
    activeCallbackInvocation,
    callbackDrainDeadlockError,
    disposePluginEffects,
    invokePluginCallback,
    invokePluginCallbackSync,
    invokePluginCleanup,
    invokePluginSetup,
    waitForCallbacksToDrain,
  })
}
