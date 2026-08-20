import { snapshotPluginData } from './pluginServiceData.js'

const DATA_LIMITS = Object.freeze({
  maxDepth: 32,
  maxNodes: 32_768,
  maxBytes: 8 * 1024 * 1024,
})
const MAX_METADATA_LENGTH = 4_096

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

function isolatedCancellationSignal(executionContext) {
  const controller = new AbortController()
  const hostSignal = ownValue(executionContext, 'signal')
  if (!(hostSignal instanceof AbortSignal)) {
    return { signal: controller.signal, dispose() {} }
  }
  if (hostSignal.aborted) {
    controller.abort()
    return { signal: controller.signal, dispose() {} }
  }
  const abort = () => controller.abort()
  hostSignal.addEventListener('abort', abort, { once: true })
  return {
    signal: controller.signal,
    dispose() {
      hostSignal.removeEventListener('abort', abort)
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
      const result = await invoke(record, 'tool', exec, [input, scope])
      return snapshotResult(result, name)
    } finally {
      cancellation.dispose()
    }
  }
}
