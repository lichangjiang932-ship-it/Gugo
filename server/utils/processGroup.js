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
const WINDOWS_TREE_HANDLE_DRAIN_MS = 250
const WINDOWS_TREE_KILL_TIMEOUT_MS = 6_000

function windowsPowerShellPath() {
  const systemRoot = String(process.env.SystemRoot || process.env.WINDIR || '').trim()
  return systemRoot
    ? `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
    : 'powershell.exe'
}

function windowsTreeKillScript(pid) {
  const rootPid = Math.max(1, Math.floor(Number(pid) || 0))
  return [
    '$ErrorActionPreference = "SilentlyContinue"',
    `$rootPid = ${rootPid}`,
    '$rows = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId)',
    '$targetIds = [System.Collections.Generic.HashSet[int]]::new()',
    '[void] $targetIds.Add($rootPid)',
    '$changed = $true',
    'while ($changed) { $changed = $false; foreach ($row in $rows) { $processId = [int] $row.ProcessId; $parentId = [int] $row.ParentProcessId; if ($targetIds.Contains($parentId) -and $targetIds.Add($processId)) { $changed = $true } } }',
    '& taskkill.exe /pid $rootPid /t /f *> $null',
    '$descendantIds = @($targetIds | Where-Object { $_ -ne $rootPid })',
    'if ($descendantIds.Count -gt 0) { Stop-Process -Id $descendantIds -Force }',
    'Stop-Process -Id $rootPid -Force',
    '$deadline = [DateTime]::UtcNow.AddSeconds(4)',
    'do { $alive = @($targetIds | Where-Object { Get-Process -Id $_ }); if ($alive.Count -eq 0) { exit 0 }; Start-Sleep -Milliseconds 50 } while ([DateTime]::UtcNow -lt $deadline)',
    'exit 1',
  ].join('; ')
}

export function runProcessWithGroup({
  shellPath,
  shellArgs,
  cwd,
  env,
  timeout = 60_000,
  maxBuffer = 1 * 1024 * 1024,
  windowsHide = true,
  windowsVerbatimArguments = false,
  signal = null,
}) {
  if (signal?.aborted) {
    return Promise.resolve({
      stdout: '',
      stderr: '',
      code: null,
      signal: null,
      timedOut: false,
      killed: false,
      truncated: false,
      aborted: true,
    })
  }
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32'
    const child = spawn(shellPath, shellArgs, {
      cwd,
      env,
      windowsHide,
      windowsVerbatimArguments,
      // ★ POSIX:detached=true → 子进程成为新进程组 leader,pgid === child.pid
      detached: !isWin,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdoutBuf = ''
    let stderrBuf = ''
    let truncated = false
    let timedOut = false
    let aborted = false
    let killed = false
    let settled = false
    let killTimer = null
    let sigkillTimer = null
    let abortListener = null
    let finalizing = false
    let windowsTreeKillPromise = null

    const stopBuffering = () => {
      try { child.stdout?.destroy() } catch { /* noop */ }
      try { child.stderr?.destroy() } catch { /* noop */ }
    }

    const collect = (stream, which) => {
      stream?.setEncoding('utf8')
      // ★ Lens-3 fix: child 还在写时 destroy 会触发 EPIPE,静默吃掉避免日志噪
      stream?.on('error', () => { /* ignore EPIPE after destroy */ })
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
      // Descendants can inherit the root process' stdout/stderr handles. On
      // Windows that keeps ChildProcess `close` pending even after cmd.exe was
      // killed, so stop reading before terminating the tree.
      stopBuffering()
      try {
        if (isWin) {
          // `taskkill /T` may still be walking descendants after cmd.exe has
          // emitted `close`. Track the helper and make finalization wait for it;
          // otherwise callers can observe a cancelled command while a child is
          // still holding the working directory open.
          if (!windowsTreeKillPromise) {
            windowsTreeKillPromise = new Promise((resolveTreeKill) => {
              let finished = false
              let hardStop = null
              const finish = () => {
                if (finished) return
                finished = true
                if (hardStop) clearTimeout(hardStop)
                resolveTreeKill()
              }
              let killer = null
              let fallbackActive = false
              try {
                // Snapshot descendants before killing the root. taskkill /T
                // alone races with short-lived cmd.exe wrappers: if the root
                // exits first, its Node/Python child becomes an orphan and
                // keeps cwd locked until natural exit. The PowerShell helper
                // captures the entire PID tree first, then tree-kills and
                // independently terminates every captured descendant.
                killer = spawn(windowsPowerShellPath(), [
                  '-NoLogo',
                  '-NoProfile',
                  '-NonInteractive',
                  '-Command',
                  windowsTreeKillScript(child.pid),
                ], {
                  windowsHide: true,
                  stdio: 'ignore',
                })
                killer.once('error', () => {
                  fallbackActive = true
                  try {
                    const fallbackKiller = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
                      windowsHide: true,
                      stdio: 'ignore',
                    })
                    fallbackKiller.once('error', finish)
                    fallbackKiller.once('close', finish)
                  } catch {
                    try { child.kill('SIGKILL') } catch { /* process may already be gone */ }
                    finish()
                  }
                })
                killer.once('close', () => {
                  if (!fallbackActive) finish()
                })
              } catch {
                try { child.kill('SIGKILL') } catch { /* process may already be gone */ }
                finish()
              }
              // Never let a broken process-enumeration helper make
              // cancellation hang indefinitely.
              if (!finished) {
                hardStop = setTimeout(() => {
                  try { killer?.kill('SIGKILL') } catch { /* helper may already be gone */ }
                  try {
                    spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
                      windowsHide: true,
                      stdio: 'ignore',
                    }).unref()
                  } catch { /* fallback unavailable */ }
                  try { child.kill('SIGKILL') } catch { /* process may already be gone */ }
                  finish()
                }, WINDOWS_TREE_KILL_TIMEOUT_MS)
                hardStop.unref?.()
              }
            })
          } else if (signal === 'SIGKILL') {
            try { child.kill('SIGKILL') } catch { /* process may already be gone */ }
          }
        } else {
          // 负 pid → kill 整个进程组
          process.kill(-child.pid, signal)
        }
      } catch { /* 进程可能已退出 */ }
    }

    const scheduleForceKill = () => {
      if (sigkillTimer) clearTimeout(sigkillTimer)
      sigkillTimer = setTimeout(() => killTree('SIGKILL'), GRACE_MS)
    }

    if (signal) {
      abortListener = () => {
        if (settled || aborted) return
        aborted = true
        killTree('SIGTERM')
        scheduleForceKill()
      }
      signal.addEventListener('abort', abortListener, { once: true })
      if (signal.aborted) abortListener()
    }

    killTimer = setTimeout(() => {
      timedOut = true
      killTree('SIGTERM')
      scheduleForceKill()
    }, timeout)

    const finalize = async (code, exitSignal) => {
      if (settled || finalizing) return
      finalizing = true
      if (killTimer) clearTimeout(killTimer)
      if (sigkillTimer) clearTimeout(sigkillTimer)
      if (abortListener) signal?.removeEventListener('abort', abortListener)
      if (isWin && killed && windowsTreeKillPromise) {
        await windowsTreeKillPromise
        // Even after every captured PID is gone, Windows can retain a closing
        // cwd handle for a few scheduler ticks. Keep a short bounded drain
        // before exposing cancellation as complete.
        await new Promise((resolveDrain) => {
          setTimeout(resolveDrain, WINDOWS_TREE_HANDLE_DRAIN_MS)
        })
      }
      settled = true
      // ★ Lens-2 fix: 不再无条件给已退出 child 的 pgid 再发 SIGTERM
      // 原因:child.pid 在 close 后可能被 OS 复用,主动 kill(-pid) 会误杀别人。
      // 只在 timedOut 路径杀进程组(那时仍然 alive,killTree 内已处理)。
      // 孤儿孙进程的清理由 timedOut 分支负责,正常退出场景假定 child 自己已带走孙
      // (POSIX 下 detached + setsid 不会自动带,但 detached process 退出后 init 收;
      //  这是 trade-off:可控误杀风险 vs. 罕见孤儿。选可控。)
      resolve({
        stdout: stdoutBuf,
        stderr: stderrBuf,
        code: typeof code === 'number' ? code : null,
        signal: exitSignal || null,
        timedOut,
        killed,
        truncated,
        aborted,
      })
    }

    child.on('error', (err) => {
      // spawn 本身失败(命令不存在等)
      stderrBuf = (stderrBuf || '') + (err?.message || String(err))
      void finalize(null, null)
    })
    child.on('close', (code, signal) => { void finalize(code, signal) })
  })
}
