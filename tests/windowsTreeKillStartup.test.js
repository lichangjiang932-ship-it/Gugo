import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { createWindowsWorkerStartupDiagnostics, windowsWorkerStartupMarker } from '../server/utils/windowsTreeKillStartup.js'
import { createWindowsTreeKillWorkerManager, windowsTreeKillTesting } from '../server/utils/windowsTreeKillRuntime.js'
import { prepareWindowsProcessExecution } from '../server/utils/windowsProcessGateRuntime.js'

test('worker startup diagnostics accept only bounded constant phases across fragmented stderr', () => {
  let clock = 100
  const diagnostics = createWindowsWorkerStartupDiagnostics({ now: () => clock })
  diagnostics.accept('secret=DO_NOT_DISCLOSE\n' + 'x'.repeat(100_000))
  diagnostics.accept('GUGO_WORKER_STARTUP\tready\n')
  diagnostics.accept('GUGO_WORKER_START')
  clock = 112
  diagnostics.accept('UP\tbootstrap_entered\r\nGUGO_WORKER_STARTUP\tpayload_received\n')
  diagnostics.accept('GUGO_WORKER_STARTUP\tapi_key_DO_NOT_DISCLOSE\n')
  diagnostics.accept('GUGO_WORKER_STARTUP\tbootstrap_entered\n')
  diagnostics.accept('GUGO_WORKER_STARTUP\tready\n')
  assert.deepEqual(diagnostics.snapshot(), {
    phase: 'payload_received', elapsedMs: 12,
    phases: [{ phase: 'spawn_requested', elapsedMs: 0 },
      { phase: 'bootstrap_entered', elapsedMs: 12 }, { phase: 'payload_received', elapsedMs: 12 }],
  })
  assert.doesNotMatch(JSON.stringify(diagnostics.snapshot()), /DO_NOT_DISCLOSE|secret|api_key/u)
  const snapshot = diagnostics.snapshot()
  snapshot.phases[0].phase = 'mutated'
  assert.equal(diagnostics.snapshot().phases[0].phase, 'spawn_requested')
})

test('worker startup errors retain code and safe last phase without raw host stderr', () => {
  let clock = 0
  const diagnostics = createWindowsWorkerStartupDiagnostics({ now: () => clock })
  diagnostics.accept('GUGO_WORKER_STARTUP\tadd_type_begin\nC:\\private\\secret-do-not-copy\n')
  clock = 30_000
  const error = Object.assign(new Error('startup timed out'), { code: 'WORKER_TEST_FAILURE' })
  assert.equal(diagnostics.annotate(error), error)
  assert.equal(error.code, 'WORKER_TEST_FAILURE')
  assert.match(error.message, /startup phase=add_type_begin, elapsedMs=30000/u)
  assert.doesNotMatch(JSON.stringify(error), /private|secret-do-not-copy/u)
  const original = error.message
  diagnostics.annotate(error)
  assert.equal(error.message, original, 'annotation is not repeated for multiple rejected waiters')
})

test('worker startup marker rejects text outside the fixed vocabulary', () => {
  assert.throws(() => windowsWorkerStartupMarker('untrusted-script'), /Unknown/u)
  assert.match(windowsWorkerStartupMarker('add_type_begin'), /GUGO_WORKER_STARTUP/u)
})

function workerFixture(t, { startupTimeoutMs = 30_000 } = {}) {
  const child = new EventEmitter()
  child.pid = 1234
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.killCalls = []
  child.kill = (signal) => { child.killCalls.push(signal); return true }
  let spawnOptions
  const manager = createWindowsTreeKillWorkerManager({
    spawnProcess: (_path, _args, options) => { spawnOptions = options; return child },
    workerArgs: [], workerPayload: null, startupTimeoutMs,
  })
  t.after(() => manager.shutdown())
  return { child, manager, spawnOptions: () => spawnOptions }
}

test('startup phase markers never replace the required READY stdout handshake', async (t) => {
  const { child, manager, spawnOptions } = workerFixture(t)
  let settled = false
  const pending = manager.ready().then((result) => { settled = true; return result })
  child.stderr.write('GUGO_WORKER_STARTUP\tadd_type_end\nGUGO_WORKER_STARTUP\tready\nREADY\t2\n')
  await Promise.resolve()
  assert.equal(settled, false)
  assert.equal(manager.snapshot().ready, false)
  assert.equal(manager.startupDiagnostics().phase, 'add_type_end')
  assert.deepEqual(spawnOptions().stdio, ['pipe', 'pipe', 'pipe'])
  child.stdout.write('READY\t2\n')
  assert.equal(await pending, true)
  assert.equal(manager.startupDiagnostics().phase, 'ready')
  child.stderr.write('GUGO_WORKER_STARTUP\tworker_entered\n')
  assert.equal(manager.startupDiagnostics().phase, 'ready')
})

test('startup timeout exposes its phase, rejects all waiters and never starts a command', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { child, manager } = workerFixture(t)
  windowsTreeKillTesting.setManager(manager)
  t.after(() => windowsTreeKillTesting.reset())
  let starts = 0
  const execution = prepareWindowsProcessExecution({ timeout: 35_000 }, () => { starts += 1 })
  const secondWaiter = assert.rejects(manager.ready(), (error) => {
    assert.equal(error.code, 'WINDOWS_TREE_KILL_WORKER_START_TIMEOUT')
    assert.equal(error.startupDiagnostics.phase, 'add_type_begin')
    assert.doesNotMatch(error.message, /diagnostic-secret/u)
    return true
  })
  child.stderr.write('GUGO_WORKER_STARTUP\tadd_type_begin\ndiagnostic-secret\n')
  t.mock.timers.tick(30_000)
  await secondWaiter
  const result = await execution
  assert.equal(starts, 0)
  assert.equal(result.processIsolationFailed, true)
  assert.equal(result.timedOut, false)
  assert.match(result.stderr, /startup phase=add_type_begin/u)
  assert.equal(manager.snapshot().active, false)
  assert.equal(manager.snapshot().pending, 0)
  assert.deepEqual(child.killCalls, ['SIGKILL'])
  assert.equal(manager.startupDiagnostics().phase, 'add_type_begin')
})

test('caller cancellation remains independent of startup progress and shared readiness', async (t) => {
  const { child, manager } = workerFixture(t)
  const controller = new AbortController()
  const pending = manager.ready({ signal: controller.signal })
  child.stderr.write('GUGO_WORKER_STARTUP\tpayload_decoded\n')
  controller.abort()
  await assert.rejects(pending, { code: 'WINDOWS_TREE_KILL_WORKER_READY_ABORTED' })
  assert.equal(manager.snapshot().active, true)
  assert.deepEqual(child.killCalls, [])
  child.stdout.write('READY\t2\n')
  assert.equal(await manager.ready(), true)
})

test('caller deadline does not become an isolation failure or extend the worker deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { child, manager } = workerFixture(t)
  windowsTreeKillTesting.setManager(manager)
  t.after(() => windowsTreeKillTesting.reset())
  let starts = 0
  const execution = prepareWindowsProcessExecution({ timeout: 200 }, () => { starts += 1 })
  child.stderr.write('GUGO_WORKER_STARTUP\tworker_entered\n')
  t.mock.timers.tick(200)
  const result = await execution
  assert.equal(starts, 0)
  assert.equal(result.timedOut, true)
  assert.equal(result.processIsolationFailed, false)
  assert.deepEqual(child.killCalls, [])
  const failure = assert.rejects(manager.ready(), { code: 'WINDOWS_TREE_KILL_WORKER_START_TIMEOUT' })
  t.mock.timers.tick(29_800)
  await failure
  assert.deepEqual(child.killCalls, ['SIGKILL'])
})

test('stderr failure is informational; stdout protocol failures still deny readiness', async (t) => {
  const { child, manager } = workerFixture(t)
  const pending = assert.rejects(manager.ready(), { code: 'WINDOWS_TREE_KILL_WORKER_PROTOCOL_ERROR' })
  child.stderr.emit('error', new Error('host-error-do-not-copy'))
  child.stdout.write('NOT_READY\n')
  await pending
  assert.equal(manager.snapshot().ready, false)
  assert.deepEqual(child.killCalls, ['SIGKILL'])
})
