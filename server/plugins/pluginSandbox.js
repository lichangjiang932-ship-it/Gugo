import fs from 'node:fs/promises'
import { Worker } from 'node:worker_threads'
import { performance } from 'node:perf_hooks'
import { PLUGIN_CAPABILITIES } from './pluginManifest.js'

const DEFAULT_TIMEOUT_MS = 5000
const DEFAULT_MEMORY_LIMIT_MB = 32
const ERROR_LIMIT = 1024

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
  vm.runInContext(String(source) + "\\n;module.exports = transform;", context, {
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

function sanitizeCapabilities(capabilities) {
  if (!Array.isArray(capabilities)) return []
  return capabilities.filter((cap) => PLUGIN_CAPABILITIES.includes(cap))
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
  if (!plugin || typeof plugin !== 'object') {
    throw new Error('plugin is required')
  }
  const source = typeof plugin.source === 'string'
    ? plugin.source
    : await fs.readFile(plugin.entryPath, 'utf8')
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
