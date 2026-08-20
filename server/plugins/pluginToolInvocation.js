import { types as nodeTypes } from 'node:util'

import { snapshotPluginData } from './pluginServiceData.js'

const DATA_LIMITS = Object.freeze({
  maxDepth: 32,
  maxNodes: 32_768,
  maxBytes: 8 * 1024 * 1024,
})
const MAX_METADATA_LENGTH = 4_096
const abortSignalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')?.get
const addEventListener = EventTarget.prototype.addEventListener
const removeEventListener = EventTarget.prototype.removeEventListener

function toolError(code, message) {
  const error = new TypeError(message)
  error.code = code
  error.retryable = false
  return error
}

function ownValue(object, key) {
  if (!object || typeof object !== 'object') return undefined
  const descriptor = Object.getOwnPropertyDescriptor(object, key)
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined
}

function normalizedMetadata(value) {
  if (typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value))) return null
  const text = String(value).trim()
  return text && text.length <= MAX_METADATA_LENGTH ? text : null
}

function snapshotArguments(args, name) {
  const snapshot = snapshotPluginData(args, {
    code: 'PLUGIN_TOOL_ARGUMENT_INVALID',
    label: `plugin tool ${name} arguments`,
    ...DATA_LIMITS,
  })
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw toolError('PLUGIN_TOOL_ARGUMENT_INVALID', `plugin tool ${name} arguments must be a plain data object`)
  }
  return snapshot
}

function snapshotResult(result, name) {
  return snapshotPluginData(result, {
    code: 'PLUGIN_TOOL_RESULT_INVALID',
    label: `plugin tool ${name} result`,
    ...DATA_LIMITS,
  })
}

function errorField(error, key) {
  try {
    return ownValue(error, key)
  } catch {
    return undefined
  }
}

function isolatedExecutionError(thrown, name) {
  const primitive = thrown === null || (typeof thrown !== 'object' && typeof thrown !== 'function')
    ? String(thrown)
    : ''
  const ownMessage = errorField(thrown, 'message')
  const message = typeof ownMessage === 'string'
    ? ownMessage
    : primitive
  const boundedMessage = message.trim().slice(0, MAX_METADATA_LENGTH)
  const ownCode = errorField(thrown, 'code')
  const code = typeof ownCode === 'string' && /^[A-Z][A-Z0-9_]{0,127}$/.test(ownCode)
    ? ownCode
    : 'PLUGIN_TOOL_EXECUTION_FAILED'
  const error = new Error(boundedMessage || `plugin tool ${name} execution failed`)
  error.code = code
  error.retryable = false
  return error
}

function accountedExecutor(exec, name) {
  return async (...args) => {
    try {
      return snapshotResult(await exec(...args), name)
    } catch (error) {
      throw isolatedExecutionError(error, name)
    }
  }
}

function isolatedCancellationSignal(executionContext) {
  const controller = new AbortController()
  const hostSignal = ownValue(executionContext, 'signal')
  if (!hostSignal || nodeTypes.isProxy(hostSignal)) {
    return { signal: controller.signal, dispose() {} }
  }
  let aborted
  try {
    aborted = abortSignalAborted?.call(hostSignal)
  } catch {
    return { signal: controller.signal, dispose() {} }
  }
  if (aborted) {
    controller.abort()
    return { signal: controller.signal, dispose() {} }
  }
  const abort = () => controller.abort()
  try {
    addEventListener.call(hostSignal, 'abort', abort, { once: true })
  } catch {
    return { signal: controller.signal, dispose() {} }
  }
  return {
    signal: controller.signal,
    dispose() {
      try {
        removeEventListener.call(hostSignal, 'abort', abort)
      } catch {
        // The wrapper signal remains detached even if host cleanup rejects.
      }
    },
  }
}

function executionScope(executionContext, { name, pluginId, signal }) {
  const job = ownValue(executionContext, 'job')
  const step = ownValue(executionContext, 'step')
  return Object.freeze({
    name,
    userId: normalizedMetadata(ownValue(executionContext, 'userId')),
    jobId: normalizedMetadata(ownValue(job, 'id')),
    stepId: normalizedMetadata(ownValue(step, 'id')),
    skillId: normalizedMetadata(ownValue(executionContext, 'skillId')),
    toolCallId: normalizedMetadata(ownValue(executionContext, 'toolCallId')),
    idempotencyKey: normalizedMetadata(ownValue(executionContext, 'idempotencyKey')),
    origin: 'plugin',
    source: pluginId,
    signal,
  })
}

export function createRuntimePluginToolExecutor({ record, name, exec, invoke }) {
  const executeAndSnapshot = accountedExecutor(exec, name)
  const unavailable = () => {
    const error = new Error(`plugin tool is unavailable: ${record.manifest.id}/${name}`)
    error.code = 'PLUGIN_TOOL_UNAVAILABLE'
    error.retryable = false
    return error
  }

  return async (args = {}, executionContext = {}) => {
    if (record.state !== 'active') throw unavailable()
    const input = snapshotArguments(args, name)
    const cancellation = isolatedCancellationSignal(executionContext)
    const scope = executionScope(executionContext, {
      name,
      pluginId: record.manifest.id,
      signal: cancellation.signal,
    })
    try {
      if (record.state !== 'active') throw unavailable()
      return await invoke(record, 'tool', executeAndSnapshot, [input, scope])
    } finally {
      cancellation.dispose()
    }
  }
}
