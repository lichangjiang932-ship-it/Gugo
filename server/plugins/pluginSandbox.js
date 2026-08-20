import fs from 'node:fs/promises'
import { Worker } from 'node:worker_threads'
import { performance } from 'node:perf_hooks'
import { types as nodeTypes } from 'node:util'
import { PLUGIN_CAPABILITIES } from './pluginManifest.js'

const DEFAULT_TIMEOUT_MS = 5000
const DEFAULT_MEMORY_LIMIT_MB = 32
const ERROR_LIMIT = 1024
const MAX_CAPABILITY_ENTRIES = 64

const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads')
const vm = require('node:vm')

function truncateError(err) {
  const msg = err && typeof err.message === 'string' ? err.message : String(err)
  return msg.slice(0, ${ERROR_LIMIT})
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
  if (typeof transform !== 'function') {
    throw new Error('transform must be a function')
  }
  if (validateOnly) {
    parentPort.postMessage({ ok: true })
  } else {
    const output = transform(input)
    JSON.stringify(output)
    parentPort.postMessage({ ok: true, output })
  }
} catch (err) {
  parentPort.postMessage({ ok: false, error: truncateError(err) })
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
  const allowedCapabilities = sanitizeCapabilities(capabilities)
  const startedAt = performance.now()

  return await new Promise((resolve) => {
    let settled = false
    let terminatingForTimeout = false
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { source, input, capabilities: allowedCapabilities, validateOnly },
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
      settle({ ok: false, error: String(message?.error || 'plugin_error').slice(0, ERROR_LIMIT) })
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
