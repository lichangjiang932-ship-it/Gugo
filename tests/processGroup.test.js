import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { _testing, runProcessWithGroup, terminateProcessTree } from '../server/utils/processGroup.js'
import { WINDOWS_PROCESS_GATE_PROTOCOL } from '../server/utils/windowsProcessGateRuntime.js'
import {
  windowsTreeKillWorkerArgs,
  windowsTreeKillWorkerPayload,
  windowsTreeKillWorkerScript,
  windowsPowerShellPath,
} from '../server/utils/windowsTreeKillWorkerSource.js'

const isPosix = process.platform !== 'win32'
const node = process.execPath
const processKillBudgetMs = process.platform === 'win32' ? 8_000 : 4_000

function nodeArgs(script) {
  return ['-e', script]
}

function trackedEmitter() {
  const emitter = new EventEmitter()
  emitter.referenced = null
  emitter.refCalls = 0
  emitter.unrefCalls = 0
  emitter.ref = () => {
    emitter.referenced = true
    emitter.refCalls += 1
  }
  emitter.unref = () => {
    emitter.referenced = false
    emitter.unrefCalls += 1
  }
  return emitter
}

function mockWindowsTreeKillWorker(pid, { writeCallbackDelayMs = 0 } = {}) {
  const child = trackedEmitter()
  child.pid = pid
  child.stdin = trackedEmitter()
  child.stdout = trackedEmitter()
  child.stderr = trackedEmitter()
  child.stdin.writes = []
  child.stdin.write = (chunk, callback) => {
    child.stdin.writes.push(String(chunk))
    if (writeCallbackDelayMs > 0) {
      setTimeout(() => callback?.(null), writeCallbackDelayMs)
    } else {
      queueMicrotask(() => callback?.(null))
    }
    return true
  }
  child.stdin.destroyed = false
  child.stdin.destroy = () => { child.stdin.destroyed = true }
  child.stdout.setEncoding = () => {}
  child.killCalls = []
  child.kill = (signal) => {
    child.killCalls.push(signal)
    return true
  }
  return child
}

let nextMockWindowsGatePid = 30_000

function mockWindowsProcessGate({
  ready = true,
  onSend = null,
  closeDelayMs = 0,
  exitBeforeReady = false,
} = {}) {
  const child = new EventEmitter()
  child.pid = nextMockWindowsGatePid += 1
  child.exitCode = null
  child.signalCode = null
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.stdio = [child.stdin, child.stdout, child.stderr]
  child.sentMessages = []
  child.killCalls = []
  child.ref = () => {}
  child.unref = () => {}
  child.send = (message, callback) => {
    child.sentMessages.push(message)
    if (onSend) onSend({ child, message, callback })
    else queueMicrotask(() => callback?.(null))
    return true
  }
  child.kill = (signal) => {
    if (signal === 0) return child.exitCode == null && child.signalCode == null
    child.killCalls.push(signal)
    if (child.exitCode != null || child.signalCode != null) return false
    child.signalCode = signal
    const finish = () => {
      child.emit('exit', null, signal)
      child.stdin.end()
      child.stdout.end()
      child.stderr.end()
      child.emit('close', null, signal)
    }
    if (closeDelayMs > 0) setTimeout(finish, closeDelayMs)
    else queueMicrotask(finish)
    return true
  }
  // The real gate cannot announce READY before spawnProcessFn returns and the
  // caller installs its IPC listeners. Keep the fixture on that same boundary.
  setImmediate(() => {
    child.emit('spawn')
    if (exitBeforeReady) {
      child.exitCode = 1
      child.emit('exit', 1, null)
      child.stdin.end()
      child.stdout.end()
      child.stderr.end()
      child.emit('close', 1, null)
      return
    }
    if (ready) child.emit('message', {
      protocol: WINDOWS_PROCESS_GATE_PROTOCOL,
      operation: 'READY',
    })
  })
  return child
}

async function settlesWithin(promise, timeoutMs = 1_000) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('process result did not settle')), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function mockWindowsTreeKillManager({
  requestTimeoutMs = 5_000,
  writeCallbackDelayMs = 0,
} = {}) {
  const children = []
  const manager = _testing.createWindowsTreeKillWorkerManager({
    spawnProcess: () => {
      const child = mockWindowsTreeKillWorker(
        10_000 + children.length,
        { writeCallbackDelayMs },
      )
      children.push(child)
      return child
    },
    startupTimeoutMs: 5_000,
    requestTimeoutMs,
    workerArgs: [],
    workerPayload: null,
  })
  return { children, manager }
}

function workerRequestRows(child) {
  return child.stdin.writes.map((line) => {
    const fields = line.trimEnd().split('\t')
    if (fields[0] === 'BIND') {
      return {
        operation: fields[0],
        requestId: fields[1],
        leaseId: fields[2],
        pid: Number(fields[3]),
        identityCutoffMs: Number(fields[4]),
      }
    }
    return {
      operation: fields[0],
      requestId: fields[1],
      leaseId: fields[2],
      timeoutMs: Number(fields[3]),
    }
  })
}

function respond(child, row, succeeded = true) {
  child.stdout.emit('data', `${row.requestId}\t${succeeded ? '1' : '0'}\n`)
}

const nextTurn = () => new Promise((resolve) => setImmediate(resolve))

function requestWithKnownIdentity(manager, pid, options = {}) {
  return manager.request(pid, {
    ...options,
    identityCutoffMs: options.identityCutoffMs ?? Date.now(),
  })
}

function processExists(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    throw error
  }
}

async function waitForProcessExit(pid, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!processExists(pid)) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return !processExists(pid)
}

async function completeBoundRequest(child, pending, { bind = true, kill = true } = {}) {
  const bindRow = workerRequestRows(child).at(-1)
  assert.equal(bindRow.operation, 'BIND')
  respond(child, bindRow, bind)
  if (!bind) return pending
  await nextTurn()
  const killRow = workerRequestRows(child).at(-1)
  assert.equal(killRow.operation, 'KILL')
  assert.equal(killRow.leaseId, bindRow.leaseId)
  respond(child, killRow, kill)
  return pending
}

test('Windows tree-kill worker: prewarm 与连续 BIND/KILL 复用同一 worker', async (t) => {
  const { children, manager } = mockWindowsTreeKillManager()
  t.after(() => manager.shutdown())

  assert.equal(manager.prewarm(), true)
  assert.equal(manager.prewarm(), true)
  assert.equal(children.length, 1)
  children[0].stdout.emit('data', 'READY\t2\n')

  const first = requestWithKnownIdentity(manager, 101)
  const firstBind = workerRequestRows(children[0])[0]
  assert.equal(await completeBoundRequest(children[0], first), true)

  const second = requestWithKnownIdentity(manager, 202)
  const secondBind = workerRequestRows(children[0])[2]
  assert.equal(await completeBoundRequest(children[0], second), true)
  assert.deepEqual([firstBind.pid, secondBind.pid], [101, 202])
  assert.notEqual(firstBind.leaseId, secondBind.leaseId)
  assert.equal(children.length, 1)
  assert.equal(manager.snapshot().spawnCount, 1)
})

test('Windows tree-kill worker: 并发响应乱序仍按 request id 与 lease 关联', async (t) => {
  const { children, manager } = mockWindowsTreeKillManager()
  t.after(() => manager.shutdown())
  manager.prewarm()
  const child = children[0]
  child.stdout.emit('data', 'READY\t2\n')

  const first = requestWithKnownIdentity(manager, 301)
  const second = requestWithKnownIdentity(manager, 302)
  const [firstBind, secondBind] = workerRequestRows(child)
  respond(child, secondBind, true)
  respond(child, firstBind, true)
  await nextTurn()
  const kills = workerRequestRows(child).filter((row) => row.operation === 'KILL')
  const firstKill = kills.find((row) => row.leaseId === firstBind.leaseId)
  const secondKill = kills.find((row) => row.leaseId === secondBind.leaseId)
  respond(child, secondKill, false)
  respond(child, firstKill, true)

  assert.deepEqual(await Promise.all([first, second]), [true, false])
  assert.deepEqual([firstBind.pid, secondBind.pid], [301, 302])
  assert.notEqual(firstBind.requestId, secondBind.requestId)
})

test('Windows tree-kill worker: 崩溃拒绝全部 pending 且下次请求重建', async (t) => {
  const { children, manager } = mockWindowsTreeKillManager()
  t.after(() => manager.shutdown())
  manager.prewarm()
  const crashed = children[0]
  crashed.stdout.emit('data', 'READY\t2\n')

  const firstRejected = assert.rejects(
    requestWithKnownIdentity(manager, 401),
    (error) => error?.code === 'WINDOWS_TREE_KILL_WORKER_CRASHED',
  )
  const secondRejected = assert.rejects(
    requestWithKnownIdentity(manager, 402),
    (error) => error?.code === 'WINDOWS_TREE_KILL_WORKER_CRASHED',
  )
  crashed.emit('close', 9, null)
  await Promise.all([firstRejected, secondRejected])
  assert.equal(manager.snapshot().active, false)
  assert.equal(manager.snapshot().pending, 0)

  const rebuiltRequest = requestWithKnownIdentity(manager, 403)
  assert.equal(children.length, 2)
  const rebuilt = children[1]
  rebuilt.stdout.emit('data', 'READY\t2\n')
  assert.equal(await completeBoundRequest(rebuilt, rebuiltRequest), true)
  assert.equal(manager.snapshot().spawnCount, 2)
  assert.equal(manager.snapshot().generation, 2)
})

test('Windows tree-kill worker: idle 句柄 unref，pending 期间临时 ref', async (t) => {
  const { children, manager } = mockWindowsTreeKillManager()
  t.after(() => manager.shutdown())
  manager.prewarm()
  const child = children[0]
  const handles = [child, child.stdin, child.stdout, child.stderr]
  assert.equal(handles.every((handle) => handle.referenced === false), true)

  const pending = requestWithKnownIdentity(manager, 501)
  assert.equal(handles.every((handle) => handle.referenced === true), true)
  child.stdout.emit('data', 'READY\t2\n')
  assert.equal(await completeBoundRequest(child, pending), true)
  assert.equal(handles.every((handle) => handle.referenced === false), true)
  assert.equal(handles.every((handle) => handle.refCalls >= 1), true)
  assert.equal(handles.every((handle) => handle.unrefCalls >= 2), true)
})

test('Windows tree-kill worker: READY waiter 保活至握手后恢复 idle unref', async (t) => {
  const { children, manager } = mockWindowsTreeKillManager()
  t.after(() => manager.shutdown())
  const pending = manager.ready()
  const child = children[0]
  const handles = [child, child.stdin, child.stdout, child.stderr]
  assert.equal(handles.every((handle) => handle.referenced === true), true)
  child.stdout.emit('data', 'READY\t2\n')
  assert.equal(await pending, true)
  assert.equal(handles.every((handle) => handle.referenced === false), true)
})

test('Windows tree-kill worker: READY waiter 可取消且不关闭共享 worker', async (t) => {
  const { children, manager } = mockWindowsTreeKillManager()
  t.after(() => manager.shutdown())
  const controller = new AbortController()
  const pending = manager.ready({ signal: controller.signal })
  const child = children[0]
  const handles = [child, child.stdin, child.stdout, child.stderr]

  controller.abort()
  await assert.rejects(
    pending,
    (error) => error?.code === 'WINDOWS_TREE_KILL_WORKER_READY_ABORTED',
  )
  assert.equal(manager.snapshot().active, true)
  assert.equal(handles.every((handle) => handle.referenced === false), true)
  assert.deepEqual(child.killCalls, [])

  child.stdout.emit('data', 'READY\t2\n')
  assert.equal(await manager.ready(), true)
})

test('Windows tree-kill worker: 排队 BIND 取消不会解除其他 READY waiter 的保活', async (t) => {
  const { children, manager } = mockWindowsTreeKillManager()
  t.after(() => manager.shutdown())
  const readyPending = manager.ready()
  const child = children[0]
  const handles = [child, child.stdin, child.stdout, child.stderr]
  const controller = new AbortController()
  const bindPending = manager.bind(701, {
    identityCutoffMs: Date.now(),
    signal: controller.signal,
  })

  controller.abort()
  await assert.rejects(
    bindPending,
    (error) => error?.code === 'WINDOWS_TREE_KILL_TARGET_EXITED',
  )
  assert.equal(handles.every((handle) => handle.referenced === true), true)
  assert.equal(manager.snapshot().pending, 0)

  child.stdout.emit('data', 'READY\t2\n')
  assert.equal(await readyPending, true)
  assert.equal(handles.every((handle) => handle.referenced === false), true)
})

test('Windows tree-kill worker: READY waiter 使用调用方短超时且不关闭共享 worker', async (t) => {
  const { children, manager } = mockWindowsTreeKillManager()
  t.after(() => manager.shutdown())
  const startedAt = Date.now()

  await assert.rejects(
    manager.ready({ timeoutMs: 25 }),
    (error) => error?.code === 'WINDOWS_TREE_KILL_WORKER_READY_TIMEOUT',
  )
  assert.ok(Date.now() - startedAt < 500, 'caller READY timeout must beat the worker startup timeout')
  assert.equal(manager.snapshot().active, true)
  assert.deepEqual(children[0].killCalls, [])
})

test('Windows tree-kill worker: 冷启动等待不消耗 BIND 响应超时', async (t) => {
  const children = []
  const manager = _testing.createWindowsTreeKillWorkerManager({
    spawnProcess: () => {
      const child = mockWindowsTreeKillWorker(20_000 + children.length)
      children.push(child)
      return child
    },
    startupTimeoutMs: 500,
    requestTimeoutMs: 20,
    workerArgs: [],
    workerPayload: null,
  })
  t.after(() => manager.shutdown())

  let settled = false
  const pending = requestWithKnownIdentity(manager, 601).finally(() => { settled = true })
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(settled, false, 'request timeout must not start while queued for READY')

  const child = children[0]
  child.stdout.emit('data', 'READY\t2\n')
  assert.equal(await completeBoundRequest(child, pending), true)
})

test('Windows tree-kill worker: READY 前目标退出会撤销排队 BIND', async (t) => {
  const { children, manager } = mockWindowsTreeKillManager()
  t.after(() => manager.shutdown())
  const controller = new AbortController()
  const pending = requestWithKnownIdentity(manager, 602, { signal: controller.signal })
  controller.abort()
  await assert.rejects(
    pending,
    (error) => error?.code === 'WINDOWS_TREE_KILL_TARGET_EXITED',
  )
  const child = children[0]
  child.stdout.emit('data', 'READY\t2\n')
  assert.equal(child.stdin.writes.length, 0)
  assert.equal(manager.snapshot().pending, 0)
  assert.deepEqual(child.killCalls, [])
})

test('Windows tree-kill worker: 大源码通过 stdin 传输且启动命令远低于系统上限', () => {
  const args = windowsTreeKillWorkerArgs()
  const payload = windowsTreeKillWorkerPayload()
  const commandLineChars = args.reduce((total, arg) => total + String(arg).length + 3, 0)

  assert.ok(commandLineChars < 8_192, `bootstrap command line is unexpectedly large: ${commandLineChars}`)
  assert.equal(Buffer.from(payload, 'base64').toString('utf8'), windowsTreeKillWorkerScript())
  assert.ok(payload.length > commandLineChars, 'full worker source must not be embedded in argv')
})

test('Windows tree-kill worker: cleanup deadline is monotonic and keeps a bounded final proof', () => {
  const source = windowsTreeKillWorkerScript()
  assert.match(source, /Stopwatch\.StartNew\(\)/u)
  assert.match(source, /return ConfirmBoundTreeEmpty\(lease, tracked\);/u)
  assert.doesNotMatch(source, /DateTime\.UtcNow/u)
})

test('Windows tree-kill worker: repeated KILL reuses worker threads without leaking handles', {
  skip: process.platform !== 'win32',
  // The worker may spend up to 30s in its own readiness gate before this
  // 48-process steady-state stress loop begins. Keep the outer test budget
  // independent from that inner deadline so ordinary CI load is not a failure.
  timeout: 90_000,
}, async (t) => {
  const manager = _testing.createWindowsTreeKillWorkerManager()
  t.after(() => manager.shutdown())
  await manager.ready({ timeoutMs: 30_000 })
  const workerPid = manager.snapshot().pid
  assert.ok(workerPid > 0)

  const handleCount = () => {
    const output = execFileSync(windowsPowerShellPath(), [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `(Get-Process -Id ${workerPid}).HandleCount`,
    ], { encoding: 'utf8', windowsHide: true })
    const count = Number.parseInt(output.trim(), 10)
    assert.ok(Number.isSafeInteger(count) && count > 0, `invalid worker handle count: ${output}`)
    return count
  }

  const killOne = async () => {
    const target = spawn(node, ['-e', "process.stdout.write('READY\\n'); setInterval(() => {}, 1_000)"], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    })
    const closed = new Promise((resolve) => target.once('close', resolve))
    try {
      await new Promise((resolve, reject) => {
        target.stdout.once('data', resolve)
        target.once('error', reject)
      })
      const lease = await manager.bind(target.pid)
      assert.ok(lease, 'worker must bind the live target')
      assert.equal(await manager.kill(lease), true)
      await closed
    } finally {
      if (target.exitCode == null && target.signalCode == null) {
        try { target.kill('SIGKILL') } catch { /* target already exited */ }
      }
    }
  }

  // Warm the CLR thread pool before measuring its steady-state handle count.
  for (let index = 0; index < 8; index += 1) await killOne()
  const before = handleCount()
  for (let index = 0; index < 40; index += 1) await killOne()
  const after = handleCount()

  assert.ok(
    after - before <= 8,
    `worker handles grew from ${before} to ${after}; repeated KILL must not allocate dedicated threads`,
  )
})

test('Windows tree-kill worker: invalid identity cutoff rejects the bind without killing the target', {
  skip: process.platform !== 'win32',
  timeout: 15_000,
}, async (t) => {
  const manager = _testing.createWindowsTreeKillWorkerManager()
  t.after(() => manager.shutdown())
  await manager.ready({ timeoutMs: 30_000 })
  const target = spawn(node, ['-e', 'setInterval(() => {}, 1_000)'], {
    stdio: 'ignore',
    windowsHide: true,
  })
  const closed = new Promise((resolve) => target.once('close', resolve))
  try {
    await new Promise((resolve, reject) => {
      target.once('spawn', resolve)
      target.once('error', reject)
    })
    assert.equal(
      await manager.bind(target.pid, { identityCutoffMs: 1 }),
      null,
      'an identity created after the claimed cutoff must not be bound',
    )
    assert.equal(processExists(target.pid), true, 'a rejected bind must not terminate the target')
  } finally {
    if (processExists(target.pid)) target.kill('SIGKILL')
    await closed
  }
})

test('Windows tree-kill worker: a process created after the identity cutoff is never bound', {
  skip: process.platform !== 'win32',
  timeout: 15_000,
}, async (t) => {
  const manager = _testing.createWindowsTreeKillWorkerManager()
  t.after(() => manager.shutdown())
  await manager.ready({ timeoutMs: 30_000 })

  const identityCutoffMs = Date.now()
  await new Promise((resolve) => setTimeout(resolve, 20))
  const target = spawn(node, ['-e', 'setInterval(() => {}, 1_000)'], {
    stdio: 'ignore',
    windowsHide: true,
  })
  const closed = new Promise((resolve) => target.once('close', resolve))
  try {
    await new Promise((resolve, reject) => {
      target.once('spawn', resolve)
      target.once('error', reject)
    })
    assert.equal(
      await manager.bind(target.pid, { identityCutoffMs }),
      null,
      'an identity created after the cutoff must fail closed',
    )
    assert.equal(processExists(target.pid), true, 'a rejected bind must not terminate the target')
  } finally {
    if (processExists(target.pid)) target.kill('SIGKILL')
    await closed
  }
})

test('terminateProcessTree late-bind removes a root, child, and grandchild before reporting success', {
  skip: process.platform !== 'win32',
  timeout: 20_000,
}, async () => {
  _testing.resetWindowsTreeKillWorker()
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-late-bind-tree-'))
  const childScript = path.join(fixture, 'child.cjs')
  const identityPath = path.join(fixture, 'tree.json')
  const identities = []
  let root = null
  let removed = false
  try {
    fs.writeFileSync(childScript, [
      "const fs = require('node:fs')",
      "const { spawn } = require('node:child_process')",
      "const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: __dirname, stdio: 'ignore', windowsHide: true })",
      "fs.writeFileSync(process.argv[2], JSON.stringify({ childPid: process.pid, grandchildPid: grandchild.pid }))",
      'setInterval(() => {}, 1000)',
    ].join(';'), 'utf8')
    const rootScript = [
      "const { spawn } = require('node:child_process')",
      `spawn(process.execPath, [${JSON.stringify(childScript)}, ${JSON.stringify(identityPath)}], { cwd: ${JSON.stringify(fixture)}, stdio: 'ignore', windowsHide: true })`,
      'setInterval(() => {}, 1000)',
    ].join(';')
    root = spawn(node, ['-e', rootScript], {
      cwd: fixture,
      stdio: 'ignore',
      windowsHide: true,
    })
    const rootClosed = new Promise((resolve) => root.once('close', resolve))
    await new Promise((resolve, reject) => {
      root.once('spawn', resolve)
      root.once('error', reject)
    })

    const readyDeadline = Date.now() + 5_000
    while (!fs.existsSync(identityPath) && Date.now() < readyDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    assert.equal(fs.existsSync(identityPath), true, 'child and grandchild identities must be observable')
    const recorded = JSON.parse(fs.readFileSync(identityPath, 'utf8'))
    identities.push(root.pid, recorded.childPid, recorded.grandchildPid)
    assert.equal(identities.every((pid) => Number.isSafeInteger(pid) && pid > 0), true)
    assert.equal(identities.every(processExists), true)

    assert.equal(
      await terminateProcessTree({ pid: root.pid, child: root, killRootOnFailure: false }),
      true,
      'late-bound cleanup must prove the complete pre-existing tree exited',
    )
    await rootClosed
    assert.deepEqual(
      await Promise.all(identities.map((pid) => waitForProcessExit(pid))),
      [true, true, true],
    )
    fs.rmSync(fixture, { recursive: true, force: true })
    removed = true
  } finally {
    for (const pid of identities.reverse()) {
      if (processExists(pid)) {
        try { process.kill(pid, 'SIGKILL') } catch { /* already exited */ }
      }
    }
    if (root && processExists(root.pid)) {
      try { root.kill('SIGKILL') } catch { /* already exited */ }
    }
    if (!removed) fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    _testing.resetWindowsTreeKillWorker()
  }
})

test('terminateProcessTree waits for POSIX process-group exit and escalates ignored SIGTERM', {
  skip: process.platform === 'win32',
  timeout: 10_000,
}, async () => {
  const target = spawn(node, ['-e', [
    "process.on('SIGTERM', () => {})",
    "process.stdout.write('READY\\n')",
    'setInterval(() => {}, 1000)',
  ].join(';')], {
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  const closed = new Promise((resolve) => target.once('close', resolve))
  try {
    await new Promise((resolve, reject) => {
      target.stdout.once('data', resolve)
      target.once('error', reject)
    })
    assert.equal(await terminateProcessTree({ pid: target.pid, child: target }), true)
    await closed
    assert.equal(processExists(target.pid), false)
  } finally {
    if (processExists(target.pid)) {
      try { process.kill(-target.pid, 'SIGKILL') } catch { /* already exited */ }
      try { target.kill('SIGKILL') } catch { /* already exited */ }
      await closed
    }
  }
})

test('runProcessWithGroup waits for a POSIX descendant that outlives the SIGTERM root', {
  skip: process.platform === 'win32',
  timeout: 10_000,
}, async () => {
  const descendantScript = [
    "process.on('SIGTERM', () => {})",
    "process.stdout.write('descendant=' + process.pid + '\\n')",
    'setInterval(() => {}, 1000)',
  ].join(';')
  const rootScript = [
    "const { spawn } = require('node:child_process')",
    `spawn(process.execPath, ['-e', ${JSON.stringify(descendantScript)}], { stdio: ['ignore', 'inherit', 'ignore'] })`,
    'setInterval(() => {}, 1000)',
  ].join(';')
  let rootPid = 0
  let descendantPid = 0

  try {
    const result = await runProcessWithGroup({
      shellPath: node,
      shellArgs: nodeArgs(rootScript),
      cwd: process.cwd(),
      env: process.env,
      timeout: 1_500,
      onSpawn: (child) => { rootPid = child.pid },
    })
    const match = /descendant=(\d+)/u.exec(result.stdout)
    assert.ok(match, 'the descendant must be ready before the timeout')
    descendantPid = Number(match[1])
    assert.equal(result.timedOut, true)
    assert.equal(result.processTreeCleanupFailed, false)
    assert.equal(processExists(descendantPid), false)
    rootPid = 0
    descendantPid = 0
  } finally {
    if (rootPid > 0) {
      try { process.kill(-rootPid, 'SIGKILL') } catch { /* already exited */ }
    }
    if (descendantPid > 0) {
      try { process.kill(descendantPid, 'SIGKILL') } catch { /* already exited */ }
    }
  }
})

test('Windows tree-kill worker: 响应超时会关闭 worker 并拒绝请求', async (t) => {
  const { children, manager } = mockWindowsTreeKillManager({ requestTimeoutMs: 20 })
  t.after(() => manager.shutdown())
  manager.prewarm()
  const child = children[0]
  child.stdout.emit('data', 'READY\t2\n')

  const keepAlive = setTimeout(() => {}, 100)
  await assert.rejects(
    requestWithKnownIdentity(manager, 603).finally(() => clearTimeout(keepAlive)),
    (error) => error?.code === 'WINDOWS_TREE_KILL_WORKER_REQUEST_TIMEOUT',
  )
  assert.equal(manager.snapshot().pending, 0)
  assert.deepEqual(child.killCalls, ['SIGKILL'])
})

test('Windows tree-kill worker: 响应计时仅在真实写入完成后开始', async (t) => {
  const { children, manager } = mockWindowsTreeKillManager({
    requestTimeoutMs: 50,
    writeCallbackDelayMs: 25,
  })
  t.after(() => manager.shutdown())
  manager.prewarm()
  const child = children[0]
  child.stdout.emit('data', 'READY\t2\n')

  let settled = false
  const pending = requestWithKnownIdentity(manager, 604).finally(() => { settled = true })
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(settled, false, 'response timeout must start after the delayed write callback')
  const bindRow = workerRequestRows(child)[0]
  respond(child, bindRow, true)
  await nextTurn()
  const killRow = workerRequestRows(child).at(-1)
  assert.equal(killRow.operation, 'KILL')
  respond(child, killRow, true)
  assert.equal(await pending, true)
})

test('runProcessWithGroup: 正常退出收集 stdout/stderr/code', async () => {
  const r = await runProcessWithGroup({
    shellPath: node,
    shellArgs: nodeArgs("console.log('hello'); console.error('bad'); process.exit(0)"),
    cwd: process.cwd(),
    env: process.env,
    timeout: 5_000,
  })
  assert.equal(r.code, 0)
  assert.match(r.stdout, /hello/)
  assert.match(r.stderr, /bad/)
  assert.equal(r.timedOut, false)
})

test('runProcessWithGroup: 非零退出码', async () => {
  const r = await runProcessWithGroup({
    shellPath: node,
    shellArgs: nodeArgs('process.exit(42)'),
    cwd: process.cwd(),
    env: process.env,
    timeout: 5_000,
  })
  assert.equal(r.code, 42)
})

test('runProcessWithGroup: 可选 fd3 控制管道原样收集二进制数据', async () => {
  const expected = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x41, 0x00, 0xf0, 0x9f, 0xa7, 0xaa])
  const r = await runProcessWithGroup({
    shellPath: node,
    shellArgs: nodeArgs(`require('node:fs').writeSync(3, Buffer.from('${expected.toString('base64')}', 'base64'))`),
    cwd: process.cwd(),
    env: process.env,
    timeout: 5_000,
    controlPipe: true,
  })

  assert.equal(r.code, 0, r.stderr)
  assert.ok(Buffer.isBuffer(r.control))
  assert.deepEqual(r.control, expected)
  assert.equal(r.controlError, null)
  assert.equal(r.controlTruncated, false)
  assert.equal(r.controlTotalBytes, expected.length)
})

test('runProcessWithGroup: fd3 超限时继续排空并明确报告截断', async () => {
  const r = await runProcessWithGroup({
    shellPath: node,
    shellArgs: nodeArgs("require('node:fs').writeFileSync(3, Buffer.alloc(65_536, 0x7b)); process.stdout.write('completed')"),
    cwd: process.cwd(),
    env: process.env,
    timeout: 5_000,
    controlPipe: true,
    controlMaxBuffer: 31,
  })

  assert.equal(r.code, 0, r.stderr)
  assert.equal(r.stdout, 'completed')
  assert.deepEqual(r.control, Buffer.alloc(31, 0x7b))
  assert.equal(r.controlError, null)
  assert.equal(r.controlTruncated, true)
  assert.equal(r.controlTotalBytes, 65_536)
})

test('runProcessWithGroup: 未启用 fd3 时保持原返回结构', async () => {
  const r = await runProcessWithGroup({
    shellPath: node,
    shellArgs: nodeArgs('process.exit(0)'),
    cwd: process.cwd(),
    env: process.env,
    timeout: 5_000,
  })

  assert.equal(Object.hasOwn(r, 'control'), false)
  assert.equal(Object.hasOwn(r, 'controlError'), false)
  assert.equal(Object.hasOwn(r, 'controlTruncated'), false)
  assert.equal(Object.hasOwn(r, 'controlTotalBytes'), false)
})

test('runProcessWithGroup: 超时中断 fd3 时明确报告控制数据不完整', async () => {
  const r = await runProcessWithGroup({
    shellPath: node,
    shellArgs: nodeArgs('setInterval(() => {}, 1_000)'),
    cwd: process.cwd(),
    env: process.env,
    timeout: 300,
    controlPipe: true,
  })

  assert.equal(r.timedOut, true)
  assert.equal(r.killed, true)
  assert.equal(r.controlTruncated, true)
  assert.equal(r.controlError, null)
  assert.ok(Buffer.isBuffer(r.control))
})

test('runProcessWithGroup: 默认剥离敏感与运行时注入变量，只恢复显式批准的 env key', async () => {
  const secretKey = 'GUGO_PROCESS_TEST_TOKEN'
  const sourceEnv = {
    ...process.env,
    [secretKey]: 'approved-operational-secret',
    NODE_OPTIONS: '--definitely-invalid-gugo-option',
    eLeCtRoN_rUn_As_NoDe: '1',
  }
  const script = `process.stdout.write(JSON.stringify({ secret: process.env.${secretKey} || null, nodeOptions: process.env.NODE_OPTIONS || null, electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE || null }))`
  const denied = await runProcessWithGroup({
    shellPath: node,
    shellArgs: nodeArgs(script),
    cwd: process.cwd(),
    env: sourceEnv,
    timeout: 5_000,
  })
  assert.equal(denied.code, 0, denied.stderr)
  assert.deepEqual(JSON.parse(denied.stdout), {
    secret: null,
    nodeOptions: null,
    electronRunAsNode: null,
  })

  const approved = await runProcessWithGroup({
    shellPath: node,
    shellArgs: nodeArgs(script),
    cwd: process.cwd(),
    env: sourceEnv,
    inheritEnvKeys: [secretKey, 'eLeCtRoN_rUn_As_NoDe'],
    timeout: 5_000,
  })
  assert.equal(approved.code, 0, approved.stderr)
  assert.deepEqual(JSON.parse(approved.stdout), {
    secret: 'approved-operational-secret',
    nodeOptions: null,
    electronRunAsNode: null,
  })
})

test('runProcessWithGroup: 超时杀死 + timedOut=true', async () => {
  const t0 = Date.now()
  const r = await runProcessWithGroup({
    shellPath: node,
    shellArgs: nodeArgs('setTimeout(() => {}, 15_000)'),
    cwd: process.cwd(),
    env: process.env,
    timeout: 300,
  })
  const elapsed = Date.now() - t0
  assert.equal(r.timedOut, true)
  assert.equal(r.killed, true)
  assert.ok(elapsed < processKillBudgetMs, `process tree should stop within ${processKillBudgetMs}ms; actual ${elapsed}ms`)
})

test('runProcessWithGroup: AbortSignal 取消时杀死进程组', async () => {
  const controller = new AbortController()
  const t0 = Date.now()
  const pending = runProcessWithGroup({
    shellPath: node,
    shellArgs: nodeArgs('setInterval(() => {}, 1_000)'),
    cwd: process.cwd(),
    env: process.env,
    timeout: 10_000,
    signal: controller.signal,
  })
  setTimeout(() => controller.abort(), 100)

  const result = await pending
  const elapsed = Date.now() - t0
  assert.equal(result.aborted, true)
  assert.equal(result.timedOut, false)
  assert.equal(result.killed, true)
  assert.ok(elapsed < processKillBudgetMs, `cancelled process tree should stop within ${processKillBudgetMs}ms; actual ${elapsed}ms`)
})

if (isPosix) {
  test('runProcessWithGroup: 杀整个进程组(孙进程也被收)', async () => {
    // 启动 shell,它再 spawn 一个长 sleep 的孙进程并 echo 孙的 PID
    // 我们让 shell 自己秒退,但孙 sleep 应被 process group kill
    const r = await runProcessWithGroup({
      shellPath: '/bin/sh',
      shellArgs: ['-c', '( sleep 10 ) & echo "grand=$!"; sleep 0.2'],
      cwd: process.cwd(),
      env: process.env,
      timeout: 5_000,
    })
    const m = /grand=(\d+)/.exec(r.stdout)
    assert.ok(m, '应抓到孙 PID')
    const grandPid = Number(m[1])
    // 给一点时间让 finalize 的兜底 process.kill(-pgid) 生效
    await new Promise((res) => setTimeout(res, 400))
    let stillAlive = true
    try { process.kill(grandPid, 0) } catch { stillAlive = false }
    assert.equal(stillAlive, false, `孙进程 ${grandPid} 应已被收`)
  })
}

test('runProcessWithGroup: maxBuffer 触发 truncated 并杀进程', async () => {
  const r = await runProcessWithGroup({
    shellPath: node,
    shellArgs: nodeArgs("process.stdout.write('x'.repeat(200_000)); setTimeout(() => {}, 5_000)"),
    cwd: process.cwd(),
    env: process.env,
    timeout: 10_000,
    maxBuffer: 10_000,
  })
  assert.equal(r.truncated, true)
  assert.ok(r.stdout.length <= 10_000)
  // 应该不会等 5s 才返回
}, { timeout: 5_000 })

test('runProcessWithGroup: tail 模式保留完整日志且不因输出过长杀进程', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-process-tail-'))
  const fullOutputPath = path.join(root, 'full.log')
  try {
    const r = await runProcessWithGroup({
      shellPath: node,
      shellArgs: nodeArgs("process.stdout.write('HEAD_MARKER\\n' + 'x'.repeat(200_000) + '\\nTAIL_MARKER')"),
      cwd: process.cwd(),
      env: process.env,
      timeout: 5_000,
      maxBuffer: 10_000,
      overflowMode: 'tail',
      fullOutputPath,
    })
    assert.equal(r.code, 0)
    assert.equal(r.truncated, true)
    assert.equal(r.killed, false)
    assert.equal(r.fullOutputPath, fullOutputPath)
    assert.ok(Buffer.byteLength(`${r.stdout}${r.stderr}`, 'utf8') <= 10_000)
    assert.match(r.stdout, /TAIL_MARKER/)
    assert.doesNotMatch(r.stdout, /HEAD_MARKER/)
    const full = fs.readFileSync(fullOutputPath, 'utf8')
    assert.match(full, /HEAD_MARKER/)
    assert.match(full, /TAIL_MARKER/)
    assert.ok(r.totalOutputBytes > 200_000)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('runProcessWithGroup: fullOutputPath 已存在时不得删除或覆盖调用者文件', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-process-tail-owned-'))
  const fullOutputPath = path.join(root, 'existing.log')
  const original = 'DO_NOT_DELETE_OR_REPLACE'
  fs.writeFileSync(fullOutputPath, original, 'utf8')
  try {
    const r = await runProcessWithGroup({
      shellPath: node,
      shellArgs: nodeArgs("process.stdout.write('x'.repeat(32_000))"),
      cwd: process.cwd(),
      env: process.env,
      timeout: 5_000,
      maxBuffer: 16,
      overflowMode: 'tail',
      fullOutputPath,
    })

    assert.equal(r.code, 0, r.stderr)
    assert.equal(r.truncated, true)
    assert.equal(Object.hasOwn(r, 'fullOutputPath'), false)
    assert.ok(r.outputLogError)
    assert.equal(fs.readFileSync(fullOutputPath, 'utf8'), original)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('runProcessWithGroup: 命令不存在不挂', async () => {
  const r = await runProcessWithGroup({
    shellPath: '/bin/sh',
    shellArgs: ['-c', '/nonexistent/binary'],
    cwd: process.cwd(),
    env: process.env,
    timeout: 3_000,
  })
  // shell 返回 127
  assert.notEqual(r.code, 0)
})

test('runProcessWithGroup: Windows 预取消不启动 worker 或用户命令', {
  skip: process.platform !== 'win32',
}, async () => {
  _testing.resetWindowsTreeKillWorker()
  const controller = new AbortController()
  controller.abort()
  let spawned = false
  const result = await runProcessWithGroup({
    shellPath: node,
    shellArgs: nodeArgs('process.exit(99)'),
    cwd: process.cwd(),
    env: process.env,
    signal: controller.signal,
    cleanupWindowsTreeOnExit: true,
    onSpawn: () => { spawned = true },
  })

  assert.equal(result.aborted, true)
  assert.equal(spawned, false)
  assert.equal(_testing.getWindowsTreeKillWorkerSnapshot().spawnCount, 0)
})

test('runProcessWithGroup: Windows worker 冷启动等待响应运行中取消且不启动用户命令', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const { children, manager } = mockWindowsTreeKillManager()
  _testing.setWindowsTreeKillWorkerManager(manager)
  t.after(() => _testing.resetWindowsTreeKillWorker())
  const controller = new AbortController()
  let spawned = false
  const startedAt = performance.now()
  const pending = runProcessWithGroup({
    shellPath: node,
    shellArgs: nodeArgs('process.exit(99)'),
    cwd: process.cwd(),
    env: process.env,
    timeout: 2_000,
    signal: controller.signal,
    cleanupWindowsTreeOnExit: true,
    onSpawn: () => { spawned = true },
  })
  setTimeout(() => controller.abort(), 20)

  const result = await pending
  assert.equal(result.aborted, true)
  assert.equal(result.timedOut, false)
  assert.equal(result.processTreeCleanupFailed, false)
  assert.equal(spawned, false)
  assert.equal(children.length, 1)
  assert.equal(children[0].stdin.writes.length, 0)
  assert.ok(performance.now() - startedAt < 500, 'abort must not wait for the worker startup timeout')
})

test('runProcessWithGroup: Windows worker 冷启动计入任务 deadline 且不启动超时命令', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const { children, manager } = mockWindowsTreeKillManager()
  _testing.setWindowsTreeKillWorkerManager(manager)
  t.after(() => _testing.resetWindowsTreeKillWorker())
  let spawned = false
  const startedAt = performance.now()

  const result = await runProcessWithGroup({
    shellPath: node,
    shellArgs: nodeArgs('process.exit(99)'),
    cwd: process.cwd(),
    env: process.env,
    timeout: 25,
    cleanupWindowsTreeOnExit: true,
    onSpawn: () => { spawned = true },
  })

  assert.equal(result.timedOut, true)
  assert.equal(result.aborted, false)
  assert.equal(result.processTreeCleanupFailed, false)
  assert.equal(spawned, false)
  assert.equal(children.length, 1)
  assert.equal(children[0].stdin.writes.length, 0)
  assert.ok(performance.now() - startedAt < 500, 'task deadline must beat the worker startup timeout')
})

test('runProcessWithGroup: Windows worker 准备预算不受系统墙钟跳变影响', {
  skip: process.platform !== 'win32',
}, async (t) => {
  let resolveReady
  const readyPromise = new Promise((resolve) => { resolveReady = resolve })
  const manager = {
    ready: () => readyPromise,
    bind: () => Promise.resolve({ generation: 1, leaseId: 'clock-test-lease' }),
    kill: () => Promise.resolve(true),
    release: () => Promise.resolve(false),
    shutdown: () => {},
  }
  _testing.setWindowsTreeKillWorkerManager(manager)
  const originalDateNow = Date.now
  t.after(() => {
    Date.now = originalDateNow
    _testing.resetWindowsTreeKillWorker()
  })
  let spawned = false
  const pending = runProcessWithGroup({
    shellPath: node,
    shellArgs: nodeArgs('process.exit(0)'),
    cwd: process.cwd(),
    env: process.env,
    timeout: 1_000,
    cleanupWindowsTreeOnExit: true,
    onSpawn: () => { spawned = true },
  })

  Date.now = () => originalDateNow() + 24 * 60 * 60 * 1_000
  resolveReady(true)
  const result = await pending

  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.timedOut, false)
  assert.equal(spawned, true)
})

test('runProcessWithGroup: Windows worker 准备失败时 fail-closed 且不启动用户命令', {
  skip: process.platform !== 'win32',
}, async () => {
  _testing.resetWindowsTreeKillWorker()
  const originalSystemRoot = process.env.SystemRoot
  const originalWindir = process.env.WINDIR
  const missingRoot = path.join(os.tmpdir(), `gugo-missing-system-root-${process.pid}-${Date.now()}`)
  let spawned = false
  try {
    process.env.SystemRoot = missingRoot
    process.env.WINDIR = missingRoot
    const result = await runProcessWithGroup({
      shellPath: node,
      shellArgs: nodeArgs('process.exit(99)'),
      cwd: process.cwd(),
      env: process.env,
      cleanupWindowsTreeOnExit: true,
      onSpawn: () => { spawned = true },
    })

    assert.equal(result.processIsolationFailed, true)
    assert.match(result.processIsolationError, /worker.*(?:失败|异常)|ENOENT/iu)
    assert.equal(result.processTreeCleanupFailed, false)
    assert.equal(result.code, null)
    assert.equal(spawned, false)
    assert.match(result.stderr, /worker.*(?:失败|异常)|ENOENT/iu)
  } finally {
    if (originalSystemRoot === undefined) delete process.env.SystemRoot
    else process.env.SystemRoot = originalSystemRoot
    if (originalWindir === undefined) delete process.env.WINDIR
    else process.env.WINDIR = originalWindir
    _testing.resetWindowsTreeKillWorker()
  }
})

test('runProcessWithGroup: Windows BIND 确认前不得执行用户命令', {
  skip: process.platform !== 'win32',
  timeout: 10_000,
}, async (t) => {
  let resolveBind
  const bindPending = new Promise((resolve) => { resolveBind = resolve })
  let notifyBind
  const bindCalled = new Promise((resolve) => { notifyBind = resolve })
  const manager = {
    ready: () => Promise.resolve(true),
    bind: () => {
      notifyBind()
      return bindPending
    },
    kill: () => Promise.resolve(true),
    release: () => Promise.resolve(true),
    shutdown: () => {},
  }
  _testing.setWindowsTreeKillWorkerManager(manager)
  t.after(() => _testing.resetWindowsTreeKillWorker())
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-process-bind-gate-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const markerPath = path.join(root, 'started.txt')
  let spawned = false

  const pending = runProcessWithGroup({
    shellPath: node,
    shellArgs: nodeArgs(`require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'started')`),
    cwd: root,
    env: process.env,
    timeout: 5_000,
    cleanupWindowsTreeOnExit: true,
    onSpawn: () => { spawned = true },
  })

  await bindCalled
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(spawned, false, 'onSpawn must describe the real target, not the inert gate')
  assert.equal(fs.existsSync(markerPath), false, 'target must remain gated while BIND is pending')
  resolveBind({ generation: 1, leaseId: 'test-lease' })

  const result = await pending
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.processTreeCleanupFailed, false)
  assert.equal(spawned, true)
  assert.equal(fs.readFileSync(markerPath, 'utf8'), 'started')
})

test('runProcessWithGroup: Windows BIND 失败时不得执行用户命令', {
  skip: process.platform !== 'win32',
  timeout: 10_000,
}, async (t) => {
  const manager = {
    ready: () => Promise.resolve(true),
    bind: () => Promise.resolve(null),
    kill: () => Promise.resolve(false),
    release: () => Promise.resolve(false),
    shutdown: () => {},
  }
  _testing.setWindowsTreeKillWorkerManager(manager)
  t.after(() => _testing.resetWindowsTreeKillWorker())
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-process-bind-denied-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const markerPath = path.join(root, 'must-not-exist.txt')
  let spawned = false

  const result = await runProcessWithGroup({
    shellPath: node,
    shellArgs: nodeArgs(`require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'unsafe')`),
    cwd: root,
    env: process.env,
    timeout: 5_000,
    cleanupWindowsTreeOnExit: true,
    onSpawn: () => { spawned = true },
  })

  assert.equal(result.code, null)
  assert.equal(result.processIsolationFailed, true)
  assert.match(result.processIsolationError, /isolation/iu)
  assert.equal(result.processTreeCleanupFailed, false)
  assert.equal(spawned, false)
  assert.equal(fs.existsSync(markerPath), false)
})

test('runProcessWithGroup: Windows gate 永不 READY 时任务 deadline 仍会收敛', {
  skip: process.platform !== 'win32',
}, async (t) => {
  let bindCalls = 0
  const manager = {
    ready: () => Promise.resolve(true),
    bind: () => { bindCalls += 1; return Promise.resolve(null) },
    kill: () => Promise.resolve(true),
    release: () => Promise.resolve(true),
    shutdown: () => {},
  }
  _testing.setWindowsTreeKillWorkerManager(manager)
  t.after(() => _testing.resetWindowsTreeKillWorker())
  const gate = mockWindowsProcessGate({ ready: false })
  let spawned = false

  const result = await settlesWithin(runProcessWithGroup({
    shellPath: node,
    shellArgs: nodeArgs('process.exit(99)'),
    cwd: process.cwd(),
    env: process.env,
    timeout: 25,
    cleanupWindowsTreeOnExit: true,
    onSpawn: () => { spawned = true },
  }, { spawnProcessFn: () => gate }))

  assert.equal(result.timedOut, true)
  assert.equal(result.aborted, false)
  assert.equal(result.processIsolationFailed, false)
  assert.equal(result.processStartFailed, false)
  assert.equal(result.processTreeCleanupFailed, false)
  assert.equal(bindCalls, 0)
  assert.equal(spawned, false)
  assert.equal(gate.sentMessages.length, 0)
  assert.deepEqual(gate.killCalls, ['SIGKILL'])
})

test('runProcessWithGroup: Windows gate 在 READY 前退出只报告启动失败', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const manager = {
    ready: () => Promise.resolve(true),
    bind: () => Promise.reject(new Error('BIND must not run before READY')),
    kill: () => Promise.resolve(false),
    release: () => Promise.resolve(false),
    shutdown: () => {},
  }
  _testing.setWindowsTreeKillWorkerManager(manager)
  t.after(() => _testing.resetWindowsTreeKillWorker())
  const gate = mockWindowsProcessGate({ ready: false, exitBeforeReady: true })
  let spawned = false

  const result = await settlesWithin(runProcessWithGroup({
    shellPath: node,
    shellArgs: nodeArgs('process.exit(99)'),
    cwd: process.cwd(),
    env: process.env,
    timeout: 2_000,
    onSpawn: () => { spawned = true },
  }, { spawnProcessFn: () => gate }))

  assert.equal(result.processStartFailed, true)
  assert.equal(result.processIsolationFailed, false)
  assert.equal(result.processTreeCleanupFailed, false)
  assert.equal(spawned, false)
  assert.equal(gate.sentMessages.length, 0)
})

test('runProcessWithGroup: Windows 取消优先于迟到的 BIND 失败', {
  skip: process.platform !== 'win32',
}, async (t) => {
  let resolveBind
  const bindPending = new Promise((resolve) => { resolveBind = resolve })
  let notifyBind
  const bindCalled = new Promise((resolve) => { notifyBind = resolve })
  const manager = {
    ready: () => Promise.resolve(true),
    bind: () => { notifyBind(); return bindPending },
    kill: () => Promise.resolve(true),
    release: () => Promise.resolve(true),
    shutdown: () => {},
  }
  _testing.setWindowsTreeKillWorkerManager(manager)
  t.after(() => _testing.resetWindowsTreeKillWorker())
  const controller = new AbortController()
  const gate = mockWindowsProcessGate()
  let spawned = false
  const pending = runProcessWithGroup({
    shellPath: node,
    shellArgs: nodeArgs('process.exit(99)'),
    cwd: process.cwd(),
    env: process.env,
    timeout: 2_000,
    signal: controller.signal,
    cleanupWindowsTreeOnExit: true,
    onSpawn: () => { spawned = true },
  }, { spawnProcessFn: () => gate })

  await settlesWithin(bindCalled)
  controller.abort()
  const result = await settlesWithin(pending)
  resolveBind(null)
  await nextTurn()

  assert.equal(result.aborted, true)
  assert.equal(result.processIsolationFailed, false)
  assert.equal(result.processStartFailed, false)
  assert.equal(result.processTreeCleanupFailed, false)
  assert.equal(spawned, false)
  assert.equal(gate.sentMessages.length, 0)
  assert.deepEqual(gate.killCalls, ['SIGKILL'])
})

test('runProcessWithGroup: Windows 取消优先于迟到的 START IPC 故障', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const controller = new AbortController()
  const gate = mockWindowsProcessGate({
    onSend: ({ child, message, callback }) => {
      if (message?.operation !== 'START') return callback?.(null)
      controller.abort()
      queueMicrotask(() => {
        callback?.(new Error('late IPC failure'))
        child.emit('message', {
          protocol: WINDOWS_PROCESS_GATE_PROTOCOL,
          operation: 'START_FAILED',
          error: 'late target failure',
        })
        child.emit('message', {
          protocol: WINDOWS_PROCESS_GATE_PROTOCOL,
          operation: 'STARTED',
          pid: 44_444,
        })
      })
    },
  })
  const manager = {
    ready: () => Promise.resolve(true),
    bind: () => Promise.resolve({ generation: 1, leaseId: 'late-ipc-lease' }),
    kill: () => { gate.kill('SIGKILL'); return Promise.resolve(true) },
    release: () => Promise.resolve(true),
    shutdown: () => {},
  }
  _testing.setWindowsTreeKillWorkerManager(manager)
  t.after(() => _testing.resetWindowsTreeKillWorker())
  let spawned = false

  const result = await settlesWithin(runProcessWithGroup({
    shellPath: node,
    shellArgs: nodeArgs('process.exit(99)'),
    cwd: process.cwd(),
    env: process.env,
    timeout: 2_000,
    signal: controller.signal,
    cleanupWindowsTreeOnExit: true,
    onSpawn: () => { spawned = true },
  }, { spawnProcessFn: () => gate }))

  assert.equal(result.aborted, true)
  assert.equal(result.processIsolationFailed, false)
  assert.equal(result.processStartFailed, false)
  assert.equal(result.processTreeCleanupFailed, false)
  assert.equal(spawned, false)
  assert.equal(
    gate.sentMessages.filter((message) => message?.operation === 'START').length,
    1,
  )
})

test('runProcessWithGroup: Windows 取消与超时仅保留先到的终态', {
  skip: process.platform !== 'win32',
  timeout: 10_000,
}, async (t) => {
  const manager = {
    ready: () => Promise.resolve(true),
    bind: () => Promise.reject(new Error('BIND must not run without READY')),
    kill: () => Promise.resolve(false),
    release: () => Promise.resolve(false),
    shutdown: () => {},
  }
  _testing.setWindowsTreeKillWorkerManager(manager)
  t.after(() => _testing.resetWindowsTreeKillWorker())

  for (const firstTerminal of ['timeout', 'abort']) {
    const controller = new AbortController()
    const gate = mockWindowsProcessGate({ ready: false, closeDelayMs: 100 })
    const timeout = firstTerminal === 'timeout' ? 20 : 80
    const abortDelay = firstTerminal === 'timeout' ? 50 : 20
    const pending = runProcessWithGroup({
      shellPath: node,
      shellArgs: nodeArgs('process.exit(99)'),
      cwd: process.cwd(),
      env: process.env,
      timeout,
      signal: controller.signal,
    }, { spawnProcessFn: () => gate })
    setTimeout(() => controller.abort(), abortDelay)

    const result = await settlesWithin(pending)
    assert.equal(result.timedOut, firstTerminal === 'timeout')
    assert.equal(result.aborted, firstTerminal === 'abort')
    assert.equal(result.processIsolationFailed, false)
    assert.equal(result.processStartFailed, false)
  }
})

test('runProcessWithGroup: Windows gate 按大小写无关方式剔除 Node IPC 环境污染', {
  skip: process.platform !== 'win32',
  timeout: 10_000,
}, async () => {
  const inheritedEnvKeys = [
    'nOdE_ChAnNeL_Fd',
    'NoDe_ChAnNeL_sErIaLiZaTiOn_MoDe',
    'nOdE_uNiQuE_iD',
  ]
  const env = {
    ...process.env,
    [inheritedEnvKeys[0]]: '99',
    [inheritedEnvKeys[1]]: 'advanced',
    [inheritedEnvKeys[2]]: 'untrusted-parent-identity',
  }
  const script = [
    "const polluted = Object.keys(process.env).filter((key) => /^(?:NODE_CHANNEL_FD|NODE_CHANNEL_SERIALIZATION_MODE|NODE_UNIQUE_ID)$/i.test(key))",
    'process.stdout.write(JSON.stringify(polluted))',
  ].join(';')

  const result = await runProcessWithGroup({
    shellPath: node,
    shellArgs: nodeArgs(script),
    cwd: process.cwd(),
    env,
    inheritEnvKeys: inheritedEnvKeys,
    timeout: 5_000,
    cleanupWindowsTreeOnExit: true,
  })

  assert.equal(result.code, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), [])
})

test('runProcessWithGroup: Windows onSpawn 内同步取消后不得继续写入 stdin', {
  skip: process.platform !== 'win32',
  timeout: 10_000,
}, async () => {
  const controller = new AbortController()
  let stdinWrites = 0

  const result = await runProcessWithGroup({
    shellPath: node,
    shellArgs: nodeArgs('setInterval(() => {}, 1_000)'),
    cwd: process.cwd(),
    env: process.env,
    timeout: 5_000,
    signal: controller.signal,
    stdinInput: 'must-not-be-written',
    cleanupWindowsTreeOnExit: true,
    onSpawn: (child) => {
      child.stdin.end = () => { stdinWrites += 1 }
      controller.abort()
    },
  })

  assert.equal(result.aborted, true)
  assert.equal(result.killed, true)
  assert.equal(stdinWrites, 0)
})

test('runProcessWithGroup: Windows 目标 executable 不存在时明确报告启动失败', {
  skip: process.platform !== 'win32',
  timeout: 10_000,
}, async () => {
  const missingExecutable = path.join(
    os.tmpdir(),
    `gugo-missing-executable-${process.pid}-${Date.now()}.exe`,
  )
  const result = await runProcessWithGroup({
    shellPath: missingExecutable,
    shellArgs: [],
    cwd: process.cwd(),
    env: process.env,
    timeout: 5_000,
    cleanupWindowsTreeOnExit: true,
    controlPipe: true,
  })

  assert.equal(result.code, null)
  assert.equal(result.processStartFailed, true)
  assert.match(result.processStartError, /ENOENT/iu)
  assert.equal(result.processTreeCleanupFailed, false)
  assert.equal(result.controlError, null)
  assert.equal(result.control.length, 0)
  assert.equal(result.timedOut, false)
  assert.equal(result.aborted, false)
})

test('runProcessWithGroup: Windows 根进程自然退出后清理仍存活的后代', {
  skip: process.platform !== 'win32',
  timeout: 15_000,
}, async () => {
  _testing.resetWindowsTreeKillWorker()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-root-exit-tree-'))
  const pidPath = path.join(root, 'descendant.pid')
  let descendantPid = 0
  try {
    const script = [
      "const { spawn } = require('node:child_process')",
      "const fs = require('node:fs')",
      `const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 15000)'], { cwd: ${JSON.stringify(root)}, stdio: 'ignore' })`,
      `fs.writeFileSync(${JSON.stringify(pidPath)}, String(child.pid))`,
      'child.unref()',
    ].join(';')
    const result = await runProcessWithGroup({
      shellPath: node,
      shellArgs: nodeArgs(script),
      cwd: root,
      env: process.env,
      timeout: 10_000,
      cleanupWindowsTreeOnExit: true,
    })
    descendantPid = Number(fs.readFileSync(pidPath, 'utf8'))

    assert.equal(result.code, 0)
    assert.equal(result.processTreeCleanupFailed, false)
    assert.throws(() => process.kill(descendantPid, 0))
    assert.doesNotThrow(() => fs.rmSync(root, { recursive: true, force: true }))
    descendantPid = 0
  } finally {
    if (descendantPid > 0) {
      try { process.kill(descendantPid, 'SIGKILL') } catch { /* already exited */ }
    }
    fs.rmSync(root, { recursive: true, force: true })
    _testing.resetWindowsTreeKillWorker()
  }
})

// 防 lint 报 spawn 未用
after(() => { void spawn })
