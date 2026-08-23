import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _testing, runProcessWithGroup } from '../server/utils/processGroup.js'

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

function mockWindowsTreeKillWorker(pid) {
  const child = trackedEmitter()
  child.pid = pid
  child.stdin = trackedEmitter()
  child.stdout = trackedEmitter()
  child.stderr = trackedEmitter()
  child.stdin.writes = []
  child.stdin.write = (chunk, callback) => {
    child.stdin.writes.push(String(chunk))
    queueMicrotask(() => callback?.(null))
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

function mockWindowsTreeKillManager() {
  const children = []
  const manager = _testing.createWindowsTreeKillWorkerManager({
    spawnProcess: () => {
      const child = mockWindowsTreeKillWorker(10_000 + children.length)
      children.push(child)
      return child
    },
    startupTimeoutMs: 5_000,
    requestTimeoutMs: 5_000,
  })
  return { children, manager }
}

function workerRequestRows(child) {
  return child.stdin.writes.map((line) => {
    const [requestId, pid, timeoutMs] = line.trimEnd().split('\t')
    return { requestId, pid: Number(pid), timeoutMs: Number(timeoutMs) }
  })
}

test('Windows tree-kill worker: prewarm 与连续请求复用同一 worker', async (t) => {
  const { children, manager } = mockWindowsTreeKillManager()
  t.after(() => manager.shutdown())

  assert.equal(manager.prewarm(), true)
  assert.equal(manager.prewarm(), true)
  assert.equal(children.length, 1)
  children[0].stdout.emit('data', 'READY\t1\n')

  const first = manager.request(101)
  const firstRow = workerRequestRows(children[0])[0]
  children[0].stdout.emit('data', `${firstRow.requestId}\t1\n`)
  assert.equal(await first, true)

  const second = manager.request(202)
  const secondRow = workerRequestRows(children[0])[1]
  children[0].stdout.emit('data', `${secondRow.requestId}\t1\n`)
  assert.equal(await second, true)
  assert.deepEqual([firstRow.pid, secondRow.pid], [101, 202])
  assert.equal(children.length, 1)
  assert.equal(manager.snapshot().spawnCount, 1)
})

test('Windows tree-kill worker: 并发响应乱序时仍按 request id 关联', async (t) => {
  const { children, manager } = mockWindowsTreeKillManager()
  t.after(() => manager.shutdown())
  manager.prewarm()
  const child = children[0]
  child.stdout.emit('data', 'READY\t1\n')

  const first = manager.request(301)
  const second = manager.request(302)
  const [firstRow, secondRow] = workerRequestRows(child)
  child.stdout.emit('data', `${secondRow.requestId}\t0\n`)
  child.stdout.emit('data', `${firstRow.requestId}\t1\n`)

  assert.deepEqual(await Promise.all([first, second]), [true, false])
  assert.deepEqual([firstRow.pid, secondRow.pid], [301, 302])
  assert.notEqual(firstRow.requestId, secondRow.requestId)
})

test('Windows tree-kill worker: 崩溃拒绝全部 pending 且下次请求重建', async (t) => {
  const { children, manager } = mockWindowsTreeKillManager()
  t.after(() => manager.shutdown())
  manager.prewarm()
  const crashed = children[0]
  crashed.stdout.emit('data', 'READY\t1\n')

  const firstRejected = assert.rejects(
    manager.request(401),
    (error) => error?.code === 'WINDOWS_TREE_KILL_WORKER_CRASHED',
  )
  const secondRejected = assert.rejects(
    manager.request(402),
    (error) => error?.code === 'WINDOWS_TREE_KILL_WORKER_CRASHED',
  )
  crashed.emit('close', 9, null)
  await Promise.all([firstRejected, secondRejected])
  assert.equal(manager.snapshot().active, false)
  assert.equal(manager.snapshot().pending, 0)

  const rebuiltRequest = manager.request(403)
  assert.equal(children.length, 2)
  const rebuilt = children[1]
  rebuilt.stdout.emit('data', 'READY\t1\n')
  const rebuiltRow = workerRequestRows(rebuilt)[0]
  rebuilt.stdout.emit('data', `${rebuiltRow.requestId}\t1\n`)
  assert.equal(await rebuiltRequest, true)
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

  const pending = manager.request(501)
  assert.equal(handles.every((handle) => handle.referenced === true), true)
  child.stdout.emit('data', 'READY\t1\n')
  const row = workerRequestRows(child)[0]
  child.stdout.emit('data', `${row.requestId}\t1\n`)
  assert.equal(await pending, true)
  assert.equal(handles.every((handle) => handle.referenced === false), true)
  assert.equal(handles.every((handle) => handle.refCalls >= 1), true)
  assert.equal(handles.every((handle) => handle.unrefCalls >= 2), true)
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
  }
  const script = `process.stdout.write(JSON.stringify({ secret: process.env.${secretKey} || null, nodeOptions: process.env.NODE_OPTIONS || null }))`
  const denied = await runProcessWithGroup({
    shellPath: node,
    shellArgs: nodeArgs(script),
    cwd: process.cwd(),
    env: sourceEnv,
    timeout: 5_000,
  })
  assert.equal(denied.code, 0, denied.stderr)
  assert.deepEqual(JSON.parse(denied.stdout), { secret: null, nodeOptions: null })

  const approved = await runProcessWithGroup({
    shellPath: node,
    shellArgs: nodeArgs(script),
    cwd: process.cwd(),
    env: sourceEnv,
    inheritEnvKeys: [secretKey],
    timeout: 5_000,
  })
  assert.equal(approved.code, 0, approved.stderr)
  assert.deepEqual(JSON.parse(approved.stdout), {
    secret: 'approved-operational-secret',
    nodeOptions: null,
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

// 防 lint 报 spawn 未用
after(() => { void spawn })
