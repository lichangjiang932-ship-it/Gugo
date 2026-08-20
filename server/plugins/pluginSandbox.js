import fs from 'node:fs/promises'
import { Worker } from 'node:worker_threads'
import { performance } from 'node:perf_hooks'
import { types as nodeTypes } from 'node:util'
import { PLUGIN_CAPABILITIES } from './pluginManifest.js'
import { snapshotPluginData } from './pluginServiceData.js'

const DEFAULT_TIMEOUT_MS = 5000
const DEFAULT_MEMORY_LIMIT_MB = 32
const ERROR_LIMIT = 1024
const MAX_CAPABILITY_ENTRIES = 64
const SANDBOX_DATA_LIMITS = Object.freeze({
  maxDepth: 32,
  maxNodes: 8_192,
  maxBytes: 64 * 1024,
})

const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads')
const vm = require('node:vm')
const { types: nodeTypes } = require('node:util')

function outputError(reason) {
  const error = new TypeError('Plugin sandbox output must contain bounded plain data: ' + reason)
  error.code = 'PLUGIN_SANDBOX_OUTPUT_INVALID'
  return error
}

function snapshotOutput(input, plainObjectPrototype) {
  const seen = new WeakSet()
  let nodes = 0
  let bytes = 0

  const clone = (value, depth) => {
    nodes += 1
    if (nodes > ${SANDBOX_DATA_LIMITS.maxNodes}) throw outputError('data has too many nodes')
    if (depth > ${SANDBOX_DATA_LIMITS.maxDepth}) throw outputError('data is too deep')
    if (value === undefined || value === null || typeof value === 'boolean') return value
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw outputError('numbers must be finite')
      return value
    }
    if (typeof value === 'string') {
      bytes += Buffer.byteLength(value, 'utf8')
      if (bytes > ${SANDBOX_DATA_LIMITS.maxBytes}) throw outputError('data is too large')
      return value
    }
    if (!value || typeof value !== 'object') {
      throw outputError('functions and non-data values are not allowed')
    }
    if (nodeTypes.isProxy(value)) throw outputError('Proxy values are not allowed')
    if (nodeTypes.isPromise(value)) throw outputError('Promise values are not allowed')
    if (seen.has(value)) throw outputError('cycles are not allowed')
    seen.add(value)
    try {
      if (Array.isArray(value)) {
        const descriptors = Object.getOwnPropertyDescriptors(value)
        const lengthDescriptor = descriptors.length
        if (!lengthDescriptor
          || !Object.hasOwn(lengthDescriptor, 'value')
          || !Number.isSafeInteger(lengthDescriptor.value)
          || lengthDescriptor.value < 0) {
          throw outputError('arrays must expose an own data length')
        }
        const output = []
        for (let index = 0; index < lengthDescriptor.value; index += 1) {
          const descriptor = descriptors[index]
          if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
            throw outputError('arrays must be dense data arrays')
          }
          output.push(clone(descriptor.value, depth + 1))
        }
        return output
      }
      const prototype = Object.getPrototypeOf(value)
      if (prototype !== plainObjectPrototype && prototype !== null) {
        throw outputError('objects must be plain data objects')
      }
      const descriptors = Object.getOwnPropertyDescriptors(value)
      const output = {}
      for (const key of Reflect.ownKeys(descriptors)) {
        if (typeof key !== 'string') throw outputError('object keys must be strings')
        const descriptor = descriptors[key]
        if (!Object.hasOwn(descriptor, 'value')) {
          throw outputError('getters and setters are not allowed')
        }
        bytes += Buffer.byteLength(key, 'utf8')
        if (bytes > ${SANDBOX_DATA_LIMITS.maxBytes}) throw outputError('data is too large')
        Object.defineProperty(output, key, {
          value: clone(descriptor.value, depth + 1),
          enumerable: true,
          configurable: true,
          writable: true,
        })
      }
      return output
    } finally {
      seen.delete(value)
    }
  }

  return clone(input, 0)
}

function ownErrorText(err, key) {
  if (!err || typeof err !== 'object' || nodeTypes.isProxy(err)) return null
  try {
    const descriptor = Object.getOwnPropertyDescriptor(err, key)
    return descriptor && Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'string'
      ? descriptor.value
      : null
  } catch {
    return null
  }
}

function truncateError(err) {
  let message = ownErrorText(err, 'message')
  if (message === null && (typeof err === 'string'
    || typeof err === 'number'
    || typeof err === 'boolean'
    || typeof err === 'bigint')) {
    message = String(err)
  }
  return (message || 'plugin_error').slice(0, ${ERROR_LIMIT})
}

function stableErrorCode(err) {
  const code = ownErrorText(err, 'code')
  return code === 'PLUGIN_SANDBOX_OUTPUT_INVALID' ? code : undefined
}

try {
  const { source, input, capabilities, validateOnly } = workerData
  const context = vm.createContext({})
  vm.runInContext(
    "globalThis.module = Object.create(null); globalThis.module.exports = undefined; globalThis.exports = Object.create(null); Object.defineProperty(globalThis, 'console', { value: undefined, writable: false, configurable: true });",
    context,
  )
  if (Array.isArray(capabilities) && capabilities.includes('log')) {
    vm.runInContext(
      "Object.defineProperty(globalThis, 'console', { value: Object.freeze({ log: function log() {} }), writable: false, configurable: false });",
      context,
    )
  }
  vm.runInContext(source + "\\n;module.exports = transform;", context, {
    filename: 'plugin-transformer.js',
  })
  const transform = vm.runInContext('module.exports', context)
  const plainObjectPrototype = vm.runInContext('Object.prototype', context)
  if (typeof transform !== 'function') {
    throw new Error('transform must be a function')
  }
  if (validateOnly) {
    parentPort.postMessage({ ok: true })
  } else {
    const output = snapshotOutput(transform(input), plainObjectPrototype)
    parentPort.postMessage({ ok: true, output })
  }
} catch (err) {
  parentPort.postMessage({ ok: false, code: stableErrorCode(err), error: truncateError(err) })
}
`

function sandboxDefinitionError(field) {
  const error = new TypeError(`Invalid plugin sandbox definition at ${field}`)
  error.code = 'PLUGIN_SANDBOX_DEFINITION_INVALID'
  error.retryable = false
  return error
}

function ownDefinitionValue(object, key) {
  let descriptor
  try {
    descriptor = Object.getOwnPropertyDescriptor(object, key)
  } catch {
    throw sandboxDefinitionError(`plugin.${key}`)
  }
  if (!descriptor) return undefined
  if (!Object.hasOwn(descriptor, 'value')) throw sandboxDefinitionError(`plugin.${key}`)
  return descriptor.value
}

async function transformerSource(plugin) {
  if (!plugin || typeof plugin !== 'object' || Array.isArray(plugin) || nodeTypes.isProxy(plugin)) {
    throw sandboxDefinitionError('plugin')
  }
  const source = ownDefinitionValue(plugin, 'source')
  if (source !== undefined) {
    if (typeof source !== 'string') throw sandboxDefinitionError('plugin.source')
    return source
  }
  const entryPath = ownDefinitionValue(plugin, 'entryPath')
  if (typeof entryPath !== 'string' || !entryPath) {
    throw sandboxDefinitionError('plugin.entryPath')
  }
  return await fs.readFile(entryPath, 'utf8')
}

function sanitizeCapabilities(capabilities) {
  if (!Array.isArray(capabilities) || nodeTypes.isProxy(capabilities)) return []
  let lengthDescriptor
  try {
    lengthDescriptor = Object.getOwnPropertyDescriptor(capabilities, 'length')
  } catch {
    return []
  }
  const length = lengthDescriptor?.value
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_CAPABILITY_ENTRIES) return []
  const allowed = []
  for (let index = 0; index < length; index += 1) {
    let descriptor
    try {
      descriptor = Object.getOwnPropertyDescriptor(capabilities, String(index))
    } catch {
      return []
    }
    const capability = descriptor && Object.hasOwn(descriptor, 'value')
      ? descriptor.value
      : undefined
    if (typeof capability === 'string'
      && PLUGIN_CAPABILITIES.includes(capability)
      && !allowed.includes(capability)) {
      allowed.push(capability)
    }
  }
  return allowed
}

function durationSince(startedAt) {
  return Math.max(1, Math.round(performance.now() - startedAt))
}

function isMemoryLimitError(err) {
  const msg = `${err?.code || ''} ${err?.message || ''}`.toLowerCase()
  return msg.includes('memory') || msg.includes('heap') || msg.includes('out of memory')
}

async function runTransformerWorker({
  plugin,
  input,
  validateOnly = false,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  memoryLimitMb = DEFAULT_MEMORY_LIMIT_MB,
  capabilities = [],
}) {
  const source = await transformerSource(plugin)
  const isolatedInput = snapshotPluginData(input, {
    code: 'PLUGIN_SANDBOX_INPUT_INVALID',
    label: 'Plugin sandbox input',
    freeze: false,
    rejectProxies: true,
    ...SANDBOX_DATA_LIMITS,
  })
  const allowedCapabilities = sanitizeCapabilities(capabilities)
  const startedAt = performance.now()

  return await new Promise((resolve) => {
    let settled = false
    let terminatingForTimeout = false
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { source, input: isolatedInput, capabilities: allowedCapabilities, validateOnly },
      resourceLimits: { maxOldGenerationSizeMb: memoryLimitMb },
    })

    const settle = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ...result, durationMs: durationSince(startedAt) })
    }

    const timer = setTimeout(() => {
      terminatingForTimeout = true
      worker.terminate().catch(() => {})
      settle({ ok: false, error: 'timeout', timedOut: true })
    }, timeoutMs)

    worker.once('message', (message) => {
      worker.terminate().catch(() => {})
      if (message && message.ok === true) {
        settle(validateOnly ? { ok: true } : { ok: true, output: message.output })
        return
      }
      const error = message && typeof message.error === 'string'
        ? message.error.slice(0, ERROR_LIMIT)
        : 'plugin_error'
      const code = message && message.code === 'PLUGIN_SANDBOX_OUTPUT_INVALID'
        ? message.code
        : undefined
      settle(code ? { ok: false, code, error } : { ok: false, error })
    })

    worker.once('error', (err) => {
      const error = isMemoryLimitError(err) ? 'memory_limit' : String(err?.message || err).slice(0, ERROR_LIMIT)
      settle({ ok: false, error })
    })

    worker.once('exit', (code) => {
      if (settled || terminatingForTimeout || code === 0) return
      settle({ ok: false, error: 'memory_limit' })
    })
  })
}

/** Run a transformer plugin in a worker thread and a vm context. */
export function runTransformer(options) {
  return runTransformerWorker(options)
}

/** Validate transformer loading in the sandbox without invoking transform(input). */
export function validateTransformer(options) {
  return runTransformerWorker({ ...options, validateOnly: true })
}
