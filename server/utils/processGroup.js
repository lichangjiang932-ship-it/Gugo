/**
 * 进程组安全执行(M3.5)。
 *
 * 标准 child_process.execFile 的 timeout 行为:
 *   - 仅向 child 发 SIGTERM(可被忽略)
 *   - child 的 child(孙进程)成孤儿,继续占资源
 *
 * 本模块用 detached + process group 做正确的清理:
 *   - 创建独立进程组(setsid 行为):options.detached=true → spawn 返回的 pid 也是 pgid
 *   - 到点先发 SIGTERM 给整个进程组(`-pid` 表示 group),给 2s grace period
 *   - 仍未退出则 SIGKILL 整个组,确保孙进程也被收
 *
 * 限制:
 *   - 仅 POSIX(win32 退化为旧行为,平台限制)
 *   - 仅适合执行明确受控的命令,不替代真正的 OS 级 sandbox(那是 M4)
 *
 * 返回结构与 execFile 兼容:{ stdout, stderr, code, signal, timedOut, killed, truncated }
 */

import { spawn } from 'node:child_process'

const GRACE_MS = 2_000

export function runProcessWithGroup({
  shellPath,
  shellArgs,
  cwd,
  env,
  timeout = 60_000,
  maxBuffer = 1 * 1024 * 1024,
  windowsHide = true,
}) {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32'
    const child = spawn(shellPath, shellArgs, {
      cwd,
      env,
      windowsHide,
      // ★ POSIX:detached=true → 子进程成为新进程组 leader,pgid === child.pid
      detached: !isWin,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdoutBuf = ''
    let stderrBuf = ''
    let truncated = false
    let timedOut = false
    let killed = false
    let settled = false
    let killTimer = null
    let sigkillTimer = null

    const stopBuffering = () => {
      try { child.stdout?.destroy() } catch { /* noop */ }
      try { child.stderr?.destroy() } catch { /* noop */ }
    }

    const collect = (stream, which) => {
      stream?.setEncoding('utf8')
      stream?.on('data', (chunk) => {
        if (truncated) return
        const total = stdoutBuf.length + stderrBuf.length
        const remaining = maxBuffer - total
        if (remaining <= 0) { truncated = true; stopBuffering(); killTree('SIGTERM'); return }
        const slice = chunk.length > remaining ? chunk.slice(0, remaining) : chunk
        if (which === 'out') stdoutBuf += slice
        else stderrBuf += slice
        if (chunk.length > remaining) { truncated = true; stopBuffering(); killTree('SIGTERM') }
      })
    }
    collect(child.stdout, 'out')
    collect(child.stderr, 'err')

    function killTree(signal) {
      if (settled || child.pid == null) return
      killed = true
      try {
        if (isWin) {
          // Windows 下用 taskkill 杀进程树
          spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true }).on('error', () => {})
        } else {
          // 负 pid → kill 整个进程组
          process.kill(-child.pid, signal)
        }
      } catch { /* 进程可能已退出 */ }
    }

    killTimer = setTimeout(() => {
      timedOut = true
      killTree('SIGTERM')
      sigkillTimer = setTimeout(() => killTree('SIGKILL'), GRACE_MS)
    }, timeout)

    const finalize = (code, signal) => {
      if (settled) return
      settled = true
      if (killTimer) clearTimeout(killTimer)
      if (sigkillTimer) clearTimeout(sigkillTimer)
      // 兜底:即便正常退出也再 kill 一次进程组,清掉 detached 留下的孙子
      // (没有进程会报错,捕获忽略)
      if (!isWin && child.pid != null && !timedOut) {
        try { process.kill(-child.pid, 'SIGTERM') } catch { /* noop */ }
      }
      resolve({
        stdout: stdoutBuf,
        stderr: stderrBuf,
        code: typeof code === 'number' ? code : null,
        signal: signal || null,
        timedOut,
        killed,
        truncated,
      })
    }

    child.on('error', (err) => {
      // spawn 本身失败(命令不存在等)
      finalize(null, null)
      stderrBuf = (stderrBuf || '') + (err?.message || String(err))
    })
    child.on('close', (code, signal) => finalize(code, signal))
  })
}
