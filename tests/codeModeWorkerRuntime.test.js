import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import { runCodeModeWorker } from '../server/services/codeModeWorkerRuntime.js'

test('Code Mode worker returns JSON values and bounded console output', async () => {
  const result = await runCodeModeWorker({
    code: "console.log('hello', '世界'); return { answer: 42 }",
  })

  assert.deepEqual(result, {
    ok: true,
    logs: ['hello 世界'],
    value: { answer: 42 },
  })
  assert.equal(Object.isFrozen(result), true)
  assert.equal(Object.isFrozen(result.logs), true)
})

test('every Code Mode run gets a fresh worker global', async () => {
  const code = 'globalThis.__counter = (globalThis.__counter || 0) + 1; return globalThis.__counter'
  const first = await runCodeModeWorker({ code })
  const second = await runCodeModeWorker({ code })

  assert.equal(first.value, 1)
  assert.equal(second.value, 1)
})

test('Code Mode context has no ambient Node authority or dynamic code generation', async () => {
  const globals = await runCodeModeWorker({
    code: `return {
      process: typeof process,
      require: typeof require,
      workerData: typeof workerData,
      buffer: typeof Buffer,
    }`,
  })
  assert.deepEqual(globals.value, {
    process: 'undefined',
    require: 'undefined',
    workerData: 'undefined',
    buffer: 'undefined',
  })

  const dynamicCode = await runCodeModeWorker({
    code: "return Function('return 1')()",
  })
  assert.equal(dynamicCode.ok, false)
  assert.equal(dynamicCode.error.kind, 'exception')

  const moduleImport = await runCodeModeWorker({
    code: "return await import('node:fs')",
  })
  assert.equal(moduleImport.ok, false)
  assert.equal(moduleImport.error.kind, 'exception')
})

test('Code Mode console bridge cannot expose host constructors', async () => {
  const result = await runCodeModeWorker({
    code: `return {
      consolePrototype: Object.getPrototypeOf(console),
      logPrototype: Object.getPrototypeOf(console.log),
      consoleConstructor: typeof console.constructor,
      logConstructor: typeof console.log.constructor,
      logBind: typeof console.log.bind,
    }`,
  })

  assert.deepEqual(result, {
    ok: true,
    logs: [],
    value: {
      consolePrototype: null,
      logPrototype: null,
      consoleConstructor: 'undefined',
      logConstructor: 'undefined',
      logBind: 'undefined',
    },
  })

  const escape = await runCodeModeWorker({
    code: "return console.log.constructor('return typeof process')()",
  })
  assert.equal(escape.ok, false)
  assert.equal(escape.error.kind, 'exception')
})

test('Code Mode worker enforces compute and wall-clock limits', async () => {
  const compute = await runCodeModeWorker({
    code: 'while (true) {}',
    computeMs: 25,
    maxWallMs: 2_000,
  })
  assert.equal(compute.ok, false)
  assert.equal(compute.error.kind, 'timeout')

  const asyncStartedAt = Date.now()
  const asyncCompute = await runCodeModeWorker({
    code: 'await Promise.resolve(); while (true) {}',
    computeMs: 50,
    maxWallMs: 1_000,
  })
  assert.equal(asyncCompute.ok, false)
  assert.equal(asyncCompute.error.kind, 'timeout')
  assert.match(asyncCompute.error.message, /compute/i)
  assert.ok(Date.now() - asyncStartedAt < 800, 'async hot loop should not consume the wall budget')

  const wall = await runCodeModeWorker({
    code: 'await new Promise(() => {})',
    computeMs: 1_000,
    maxWallMs: 50,
  })
  assert.equal(wall.ok, false)
  assert.equal(wall.error.kind, 'timeout')
  assert.match(wall.error.message, /wall-clock/i)
})

test('Code Mode worker counts UTF-8 output and rejects non-JSON values', async () => {
  const output = await runCodeModeWorker({
    code: "console.log('你'.repeat(40)); return true",
    maxOutputBytes: 64,
  })
  assert.equal(output.ok, false)
  assert.equal(output.error.kind, 'output-limit')

  const invalid = await runCodeModeWorker({ code: 'return 1n' })
  assert.equal(invalid.ok, false)
  assert.equal(invalid.error.kind, 'invalid-output')

  const oversizedFailure = await runCodeModeWorker({
    code: "throw new Error('你'.repeat(1000))",
    maxOutputBytes: 64,
  })
  assert.equal(oversizedFailure.ok, false)
  assert.equal(oversizedFailure.error.kind, 'output-limit')

  const logsAndFailure = await runCodeModeWorker({
    code: "console.log('x'.repeat(35)); return 1n",
    maxOutputBytes: 64,
  })
  assert.equal(logsAndFailure.ok, false)
  assert.equal(logsAndFailure.error.kind, 'output-limit')
})

test('Code Mode worker honors preflight and in-flight cancellation', async () => {
  const preflight = new AbortController()
  preflight.abort(new DOMException('cancelled', 'AbortError'))
  const beforeStart = await runCodeModeWorker({
    code: 'return 1',
    signal: preflight.signal,
  })
  assert.equal(beforeStart.ok, false)
  assert.equal(beforeStart.error.kind, 'cancelled')

  const inFlight = new AbortController()
  const pending = runCodeModeWorker({
    code: 'await new Promise(() => {})',
    signal: inFlight.signal,
    maxWallMs: 5_000,
  })
  setTimeout(() => inFlight.abort(new DOMException('cancelled', 'AbortError')), 25)
  const cancelled = await pending
  assert.equal(cancelled.ok, false)
  assert.equal(cancelled.error.kind, 'cancelled')
})

test('Code Mode worker rejects malformed requests without starting a worker', async () => {
  assert.equal((await runCodeModeWorker()).error.kind, 'invalid-request')
  assert.equal((await runCodeModeWorker({ code: '   ' })).error.kind, 'invalid-request')
  assert.equal((await runCodeModeWorker({ code: 'return 1', maxWallMs: 0 })).error.kind, 'invalid-request')
  assert.equal((await runCodeModeWorker({ code: 'return 1', signal: {} })).error.kind, 'invalid-request')
})

test('Code Mode runtime waits for worker termination before resolving', async () => {
  let terminationFinished = false
  class ControlledWorker extends EventEmitter {
    constructor() {
      super()
      this.stdout = { resume() {} }
      this.stderr = { resume() {} }
      this.performance = { eventLoopUtilization: () => ({ active: 0 }) }
      queueMicrotask(() => this.emit('message', { type: 'ready' }))
    }

    postMessage(message) {
      if (message?.type === 'start') {
        queueMicrotask(() => this.emit('message', {
          type: 'done',
          logs: [],
          valueJson: '7',
        }))
      }
    }

    async terminate() {
      await new Promise((resolve) => setTimeout(resolve, 25))
      terminationFinished = true
      return 0
    }
  }

  const result = await runCodeModeWorker({
    code: 'return 7',
    WorkerClass: ControlledWorker,
  })
  assert.equal(terminationFinished, true)
  assert.deepEqual(result, { ok: true, logs: [], value: 7 })
})
