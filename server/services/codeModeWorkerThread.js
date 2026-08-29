/**
 * Per-invocation Code Mode worker. The VM context removes ambient Node globals
 * and dynamic code generation, while the parent owns wall-clock termination.
 * This is containment and resource control, not an operating-system sandbox.
 */
import vm from 'node:vm'
import { parentPort, workerData } from 'node:worker_threads'

const OUTPUT_LIMIT_ERROR = Symbol('code-mode-output-limit')

function utf8Bytes(value) {
  return Buffer.byteLength(value, 'utf8')
}

function formatLogValue(value) {
  if (typeof value === 'string') return value
  if (typeof value === 'bigint') return `${value}n`
  if (value instanceof Error) return `${value.name}: ${value.message}`
  try {
    const encoded = JSON.stringify(value)
    return encoded === undefined ? String(value) : encoded
  } catch {
    return String(value)
  }
}

function createOutputLedger(maxOutputBytes) {
  const logs = []
  let encodedBytes = 2 // []
  let exceeded = false

  const append = (...values) => {
    if (exceeded) throw OUTPUT_LIMIT_ERROR
    const text = values.map(formatLogValue).join(' ')
    const encoded = JSON.stringify(text)
    const nextBytes = encodedBytes + (logs.length > 0 ? 1 : 0) + utf8Bytes(encoded)
    if (nextBytes > maxOutputBytes) {
      exceeded = true
      throw OUTPUT_LIMIT_ERROR
    }
    logs.push(text)
    encodedBytes = nextBytes
  }

  const encodeResult = (value) => {
    if (exceeded) throw OUTPUT_LIMIT_ERROR
    if (value === undefined) return null
    let encoded
    try {
      encoded = JSON.stringify(value)
    } catch {
      return undefined
    }
    if (encoded === undefined) return undefined
    if (encodedBytes + utf8Bytes(encoded) > maxOutputBytes) throw OUTPUT_LIMIT_ERROR
    return encoded
  }

  const canFitMessage = (message) => (
    encodedBytes + utf8Bytes(JSON.stringify(message)) <= maxOutputBytes
  )

  return {
    append,
    canFitMessage,
    encodeResult,
    exceeded: () => exceeded,
    snapshot: () => [...logs],
  }
}

function hardenCallable(callable) {
  Object.setPrototypeOf(callable, null)
  return Object.freeze(callable)
}

function safeMessage(error) {
  const raw = error instanceof Error ? error.message : String(error)
  const normalized = raw.replace(/[\r\n]+/gu, ' ').trim()
  if (!normalized) return 'Model code failed'
  return normalized.length > 1024 ? `${normalized.slice(0, 1021)}...` : normalized
}

function postResult(result) {
  try {
    parentPort?.postMessage(result)
  } catch {
    parentPort?.postMessage({
      type: 'done',
      logs: [],
      error: { kind: 'invalid-output', message: 'Model code returned a non-JSON value' },
    })
  }
}

function postOutputLimit(maxOutputBytes) {
  postResult({
    type: 'done',
    logs: [],
    error: { kind: 'output-limit', message: `Code output exceeded ${maxOutputBytes} bytes` },
  })
}

function postFailure(output, maxOutputBytes, kind, message) {
  if (!output.canFitMessage(message)) {
    postOutputLimit(maxOutputBytes)
    return
  }
  postResult({
    type: 'done',
    logs: output.snapshot(),
    error: { kind, message },
  })
}

async function execute() {
  const code = workerData?.code
  const computeMs = workerData?.computeMs
  const maxOutputBytes = workerData?.maxOutputBytes
  if (typeof code !== 'string'
    || !Number.isSafeInteger(computeMs)
    || !Number.isSafeInteger(maxOutputBytes)) {
    postResult({
      type: 'done',
      logs: [],
      error: { kind: 'invalid-request', message: 'Invalid Code Mode worker request' },
    })
    return
  }

  const output = createOutputLedger(maxOutputBytes)
  // Objects and callables crossing into a vm context must not retain host
  // Object/Function prototypes. Otherwise model code can reach the worker's
  // Node process through `console.log.constructor('return process')()` even
  // when string code generation is disabled inside the context.
  const safeConsole = Object.create(null)
  for (const name of ['log', 'info', 'warn', 'error']) {
    Object.defineProperty(safeConsole, name, {
      value: hardenCallable((...values) => output.append(...values)),
      enumerable: true,
      configurable: false,
      writable: false,
    })
  }
  Object.freeze(safeConsole)
  const sandbox = Object.create(null)
  Object.defineProperty(sandbox, 'console', {
    value: safeConsole,
    enumerable: true,
    configurable: false,
    writable: false,
  })
  const context = vm.createContext(sandbox, {
    name: 'gugo-code-mode',
    codeGeneration: { strings: false, wasm: false },
  })

  // A pending Promise does not keep a Node worker alive by itself. Keep the
  // worker observable until the program settles so the parent-owned wall
  // timer, rather than an incidental empty event loop, decides the outcome.
  const pendingRunKeepAlive = setInterval(() => {}, 1_000)
  try {
    const script = new vm.Script(`(async () => {\n'use strict';\n${code}\n})()`, {
      filename: 'model-code.js',
      displayErrors: false,
    })
    const value = await script.runInContext(context, { timeout: computeMs })
    if (output.exceeded()) throw OUTPUT_LIMIT_ERROR
    const valueJson = output.encodeResult(value)
    if (valueJson === undefined) {
      postFailure(
        output,
        maxOutputBytes,
        'invalid-output',
        'Model code returned a non-JSON value',
      )
      return
    }
    postResult({
      type: 'done',
      logs: output.snapshot(),
      ...(valueJson === null ? {} : { valueJson }),
    })
  } catch (error) {
    if (error === OUTPUT_LIMIT_ERROR || output.exceeded()) {
      postOutputLimit(maxOutputBytes)
      return
    }
    if (error?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
      postFailure(output, maxOutputBytes, 'timeout', 'Code compute budget exceeded')
      return
    }
    postFailure(output, maxOutputBytes, 'exception', safeMessage(error))
  } finally {
    clearInterval(pendingRunKeepAlive)
  }
}

let started = false
parentPort?.once('message', (message) => {
  if (started) return
  started = true
  if (!message || typeof message !== 'object' || message.type !== 'start') {
    postResult({
      type: 'done',
      logs: [],
      error: { kind: 'invalid-request', message: 'Invalid Code Mode start request' },
    })
    return
  }
  void execute()
})
parentPort?.postMessage({ type: 'ready' })
