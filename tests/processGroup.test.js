import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { runProcessWithGroup } from '../server/utils/processGroup.js'

const isPosix = process.platform !== 'win32'

test('runProcessWithGroup: 正常退出收集 stdout/stderr/code', async () => {
  const r = await runProcessWithGroup({
    shellPath: '/bin/sh',
    shellArgs: ['-c', 'echo hello; echo bad 1>&2; exit 0'],
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
    shellPath: '/bin/sh',
    shellArgs: ['-c', 'exit 42'],
    cwd: process.cwd(),
    env: process.env,
    timeout: 5_000,
  })
  assert.equal(r.code, 42)
})

test('runProcessWithGroup: 超时杀死 + timedOut=true', async () => {
  const t0 = Date.now()
  const r = await runProcessWithGroup({
    shellPath: '/bin/sh',
    shellArgs: ['-c', 'sleep 5'],
    cwd: process.cwd(),
    env: process.env,
    timeout: 300,
  })
  const elapsed = Date.now() - t0
  assert.equal(r.timedOut, true)
  assert.equal(r.killed, true)
  assert.ok(elapsed < 4_000, `应在 4s 内被杀,实际 ${elapsed}ms`)
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
    shellPath: '/bin/sh',
    shellArgs: ['-c', 'yes hello | head -c 200000; sleep 5'],
    cwd: process.cwd(),
    env: process.env,
    timeout: 10_000,
    maxBuffer: 10_000,
  })
  assert.equal(r.truncated, true)
  assert.ok(r.stdout.length <= 10_000)
  // 应该不会等 5s 才返回
}, { timeout: 5_000 })

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
