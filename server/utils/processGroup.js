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
 * 可选 controlPipe 会把 fd3 作为独立的原始二进制控制管道，并返回
 * { control, controlError, controlTruncated, controlTotalBytes }。
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { processExecutionNotStartedResult } from './processExecutionFailure.js'
import { sanitizeChildEnv } from './sensitiveEnv.js'
import {
  prepareWindowsProcessExecution,
  WINDOWS_PROCESS_GATE_PATH,
  WINDOWS_PROCESS_GATE_PROTOCOL,
  windowsProcessGateEnv,
} from './windowsProcessGateRuntime.js'
import { windowsTreeKillWorkerScript } from './windowsTreeKillWorkerSource.js'
import {
  bindWindowsProcessTree,
  createWindowsTreeKillWorkerManager,
  releaseWindowsProcessTree,
  terminateWindowsProcessTree,
  windowsTreeKillTesting,
} from './windowsTreeKillRuntime.js'
const GRACE_MS = 2_000
const WINDOWS_TREE_HANDLE_DRAIN_MS = 250
function utf8Tail(value, maxBytes) {
  const source = Buffer.from(String(value || ''), 'utf8')
  if (source.length <= maxBytes) return source.toString('utf8')
  let start = Math.max(0, source.length - Math.max(0, maxBytes))
  while (start < source.length && (source[start] & 0xc0) === 0x80) start += 1
  return source.subarray(start).toString('utf8')
}

/**
 * Terminate one process tree and wait for the platform cleanup proof.
 *
 * Windows uses the shared Toolhelp32/TerminateProcess worker and also closes
 * the direct child handle as a last-resort root-process guarantee. POSIX uses
 * the detached process group when available.
 */
export async function terminateProcessTree({
  pid: rawPid,
  child = null,
  killRootOnFailure = true,
} = {}) {
  const pid = Math.floor(Number(rawPid) || 0)
  if (pid <= 0) return false
  if (process.platform === 'win32') {
    return terminateWindowsProcessTree({ pid, child, killRootOnFailure })
  }
  try {
    process.kill(-pid, 'SIGTERM')
    return true
  } catch {
    try {
      process.kill(pid, 'SIGTERM')
      return true
    } catch { return false }
  }
}
export function runProcessWithGroup(options) {
  if (process.platform === 'win32') {
    return prepareWindowsProcessExecution(options, runProcessWithGroupStarted)
  }
  return runProcessWithGroupStarted(options)
}
function runProcessWithGroupStarted({
  shellPath,
  shellArgs,
  cwd,
  env,
  inheritEnvKeys = [],
  timeout = 60_000,
  maxBuffer = 1 * 1024 * 1024,
  windowsHide = true,
  windowsVerbatimArguments = false,
  signal = null,
  overflowMode = 'kill',
  fullOutputPath = null,
  onOutput = null,
  stdinInput = null,
  onSpawn = null,
  cleanupWindowsTreeOnExit = false,
  controlPipe = false,
  controlMaxBuffer = 256 * 1024,
}) {
  const hasControlPipe = controlPipe === true
  const hasStdinInput = typeof stdinInput === 'string' || Buffer.isBuffer(stdinInput)
  const requestedControlMaxBuffer = Number(controlMaxBuffer)
  const normalizedControlMaxBuffer = Number.isFinite(requestedControlMaxBuffer)
    ? Math.max(0, Math.floor(requestedControlMaxBuffer))
    : 256 * 1024
  if (signal?.aborted) {
    return Promise.resolve(processExecutionNotStartedResult({
      controlPipe: hasControlPipe,
      aborted: true,
    }))
  }
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32'
    const targetEnv = sanitizeChildEnv({}, {
      sourceEnv: env || process.env,
      inheritKeys: inheritEnvKeys,
    })
    const useWindowsProcessGate = isWin
    const child = spawn(
      useWindowsProcessGate ? process.execPath : shellPath,
      useWindowsProcessGate ? [WINDOWS_PROCESS_GATE_PATH] : shellArgs,
      {
        cwd: useWindowsProcessGate ? path.dirname(process.execPath) : cwd,
        env: useWindowsProcessGate ? windowsProcessGateEnv(targetEnv) : targetEnv,
        windowsHide,
        windowsVerbatimArguments: useWindowsProcessGate ? false : windowsVerbatimArguments,
        // ★ POSIX:detached=true → 子进程成为新进程组 leader,pgid === child.pid
        detached: !isWin,
        stdio: hasControlPipe
          ? [hasStdinInput ? 'pipe' : 'ignore', 'pipe', 'pipe', 'pipe', ...(useWindowsProcessGate ? ['ipc'] : [])]
          : [hasStdinInput ? 'pipe' : 'ignore', 'pipe', 'pipe', ...(useWindowsProcessGate ? ['ipc'] : [])],
      },
    )

    const windowsBindController = isWin
      ? new AbortController()
      : null
    let windowsBindError = null

    child.stdin?.on('error', () => { /* child may exit before consuming trusted input */ })
    child.once('spawn', () => {
      if (useWindowsProcessGate) return
      try { onSpawn?.(child) } catch { /* observer must not affect execution */ }
      if (hasStdinInput) child.stdin?.end(stdinInput)
    })

    let stdoutBuf = ''
    let stderrBuf = ''
    const controlChunks = []
    let controlBufferedBytes = 0
    let controlTotalBytes = 0
    let controlTruncated = false
    let controlError = null
    const controlStream = hasControlPipe ? child.stdio?.[3] : null
    const tailMode = overflowMode === 'tail'
    const outputEvents = []
    let bufferedOutputBytes = 0
    let totalOutputBytes = 0
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
    let outputLogStream = null
    let outputLogOwned = false
    let outputLogError = null
    let windowsGateStarted = !useWindowsProcessGate
    let windowsStartRequestMayHaveArrived = false
    let processStartFailed = false
    let processStartError = null
    let processIsolationFailed = false
    let processIsolationError = null
    let resolveWindowsGateReady
    let windowsGateReadySettled = !useWindowsProcessGate
    const windowsGateReadyPromise = useWindowsProcessGate
      ? new Promise((resolveReady) => { resolveWindowsGateReady = resolveReady })
      : null
    const settleWindowsGateReady = (ready) => {
      if (windowsGateReadySettled) return
      windowsGateReadySettled = true
      resolveWindowsGateReady?.(ready === true)
    }
    child.once('error', () => settleWindowsGateReady(false))
    child.once('exit', () => settleWindowsGateReady(false))
    // READY is an IPC proof from this exact, still-inert gate. Only after that
    // proof do we capture the identity cutoff and bind the Job Object. This
    // avoids Windows clock-granularity races without adding a PID-reuse
    // tolerance; START remains impossible until the bind succeeds.
    const windowsTreeLeasePromise = windowsBindController
      ? windowsGateReadyPromise.then((gateReady) => {
          if (gateReady !== true) return null
          return bindWindowsProcessTree({
            pid: child.pid,
            child,
            signal: windowsBindController.signal,
          })
        }).catch((error) => {
          windowsBindError = error
          return null
        })
      : null
    const streamsPausedForLog = new Set()

    if (useWindowsProcessGate) {
      child.on('message', (message) => {
        if (message?.protocol !== WINDOWS_PROCESS_GATE_PROTOCOL) return
        if (message?.operation === 'READY') {
          settleWindowsGateReady(true)
          return
        }
        if (message?.operation === 'START_FAILED' && !windowsGateStarted) {
          processStartFailed = true
          processStartError = typeof message.error === 'string' && message.error
            ? message.error
            : 'Windows target process failed to start'
          return
        }
        if (message?.operation !== 'STARTED' || windowsGateStarted) return
        windowsGateStarted = true
        if (settled || finalizing || timedOut || aborted || killed) return
        try {
          onSpawn?.(child, {
            targetPid: Number.isSafeInteger(message.pid) && message.pid > 0 ? message.pid : null,
            supervisor: 'windows-process-gate',
          })
        } catch { /* observer must not affect execution */ }
        if (settled || finalizing || timedOut || aborted || killed) return
        if (hasStdinInput) child.stdin?.end(stdinInput)
      })
      void Promise.all([windowsTreeLeasePromise, windowsGateReadyPromise]).then(([lease, gateReady]) => {
        if (!lease || gateReady !== true) {
          processIsolationFailed = true
          processIsolationError = windowsBindError
            ? (windowsBindError?.message || String(windowsBindError))
            : 'Windows process isolation could not be established before execution'
          if (windowsBindError) stderrBuf += windowsBindError?.message || String(windowsBindError)
          killTree('SIGKILL', { markKilled: false })
          return
        }
        if (settled || finalizing || timedOut || aborted || killed) return
        try {
          windowsStartRequestMayHaveArrived = true
          child.send({
            protocol: WINDOWS_PROCESS_GATE_PROTOCOL,
            operation: 'START',
            shellPath,
            shellArgs,
            cwd,
            env: targetEnv,
            hasStdinInput,
            hasControlPipe,
            windowsHide,
            windowsVerbatimArguments,
          }, (error) => {
            if (!error) return
            processIsolationFailed = true
            processIsolationError = error?.message || String(error)
            stderrBuf += error?.message || String(error)
            killTree('SIGKILL', { markKilled: false })
          })
        } catch (error) {
          processIsolationFailed = true
          processIsolationError = error?.message || String(error)
          stderrBuf += error?.message || String(error)
          killTree('SIGKILL', { markKilled: false })
        }
      })
    }

    if (tailMode && fullOutputPath) {
      try {
        fs.mkdirSync(path.dirname(fullOutputPath), { recursive: true })
        outputLogStream = fs.createWriteStream(fullOutputPath, { flags: 'wx' })
        outputLogStream.once('open', () => { outputLogOwned = true })
        outputLogStream.on('drain', () => {
          for (const stream of streamsPausedForLog) stream.resume?.()
          streamsPausedForLog.clear()
        })
        outputLogStream.on('error', (error) => {
          outputLogError = error
          for (const stream of streamsPausedForLog) stream.resume?.()
          streamsPausedForLog.clear()
        })
      } catch (error) {
        outputLogError = error
      }
    }

    const stopBuffering = () => {
      try { child.stdout?.destroy() } catch { /* noop */ }
      try { child.stderr?.destroy() } catch { /* noop */ }
      if (controlStream && !controlStream.readableEnded && !controlStream.destroyed) {
        controlTruncated = true
      }
      try { controlStream?.destroy() } catch { /* noop */ }
    }

    if (hasControlPipe && !controlStream) {
      controlError = 'control pipe fd3 is unavailable'
    }
    controlStream?.on('error', (error) => {
      if (!controlError) controlError = error?.message || String(error)
    })
    controlStream?.on('data', (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      controlTotalBytes += bytes.length
      const remaining = normalizedControlMaxBuffer - controlBufferedBytes
      if (remaining <= 0) {
        if (bytes.length > 0) controlTruncated = true
        return
      }
      const kept = bytes.length > remaining ? bytes.subarray(0, remaining) : bytes
      if (kept.length > 0) {
        controlChunks.push(Buffer.from(kept))
        controlBufferedBytes += kept.length
      }
      if (kept.length < bytes.length) controlTruncated = true
    })

    const trimTailBuffer = () => {
      while (bufferedOutputBytes > maxBuffer && outputEvents.length > 0) {
        truncated = true
        const first = outputEvents[0]
        const overflow = bufferedOutputBytes - maxBuffer
        if (first.bytes <= overflow) {
          outputEvents.shift()
          bufferedOutputBytes -= first.bytes
          continue
        }
        const kept = utf8Tail(first.text, first.bytes - overflow)
        const keptBytes = Buffer.byteLength(kept, 'utf8')
        bufferedOutputBytes -= first.bytes - keptBytes
        first.text = kept
        first.bytes = keptBytes
      }
    }

    const collect = (stream, which) => {
      stream?.setEncoding('utf8')
      // ★ Lens-3 fix: child 还在写时 destroy 会触发 EPIPE,静默吃掉避免日志噪
      stream?.on('error', () => { /* ignore EPIPE after destroy */ })
      stream?.on('data', (chunk) => {
        const text = String(chunk)
        const bytes = Buffer.byteLength(text, 'utf8')
        totalOutputBytes += bytes
        if (typeof onOutput === 'function') {
          // Live output is best-effort: a slow or throwing subscriber must
          // never stall the child process or its buffer management.
          try { onOutput({ stream: which === 'out' ? 'stdout' : 'stderr', chunk: text }) } catch { /* best-effort */ }
        }
        if (outputLogStream && !outputLogStream.destroyed) {
          try {
            if (!outputLogStream.write(text)) {
              stream.pause?.()
              streamsPausedForLog.add(stream)
            }
          } catch (error) {
            outputLogError = error
            stream.resume?.()
            streamsPausedForLog.delete(stream)
          }
        }
        if (tailMode) {
          outputEvents.push({ which, text, bytes })
          bufferedOutputBytes += bytes
          trimTailBuffer()
          return
        }
        if (truncated) return
        const total = stdoutBuf.length + stderrBuf.length
        const remaining = maxBuffer - total
        if (remaining <= 0) { truncated = true; stopBuffering(); killTree('SIGTERM'); return }
        const slice = text.length > remaining ? text.slice(0, remaining) : text
        if (which === 'out') stdoutBuf += slice
        else stderrBuf += slice
        if (text.length > remaining) { truncated = true; stopBuffering(); killTree('SIGTERM') }
      })
    }
    collect(child.stdout, 'out')
    collect(child.stderr, 'err')

    function killTree(signal, { markKilled = true, stopOutput = true } = {}) {
      if (settled || child.pid == null) return
      if (markKilled) killed = true
      // Descendants can inherit the root process' stdout/stderr handles. On
      // Windows that keeps ChildProcess `close` pending even after cmd.exe was
      // killed, so stop reading before terminating the tree.
      if (stopOutput) stopBuffering()
      try {
        if (isWin) {
          // The bound native lease may still be walking descendants after the
          // root emits `close`; finalization waits for its identity-safe proof.
          if (!windowsTreeKillPromise) {
            // Once BIND succeeds for the original identity, the worker holds
            // that root handle so later PID reuse cannot redirect cleanup.
            windowsTreeKillPromise = terminateWindowsProcessTree({
              pid: child.pid,
              child,
              killRootOnFailure: true,
              leasePromise: windowsTreeLeasePromise,
            })
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
      let processTreeCleanupFailed = false
      if (isWin && windowsTreeKillPromise) {
        processTreeCleanupFailed = !(await windowsTreeKillPromise)
        if (processIsolationFailed && !windowsStartRequestMayHaveArrived && !windowsGateStarted) {
          processTreeCleanupFailed = false
        }
        // Even after every captured PID is gone, Windows can retain a closing
        // cwd handle for a few scheduler ticks. Cancellation must not return
        // until that handle has drained. A normal exit has already crossed the
        // worker's two stable empty snapshots and does not need this extra
        // cancellation-only fence.
        if (timedOut || aborted || killed) {
          await new Promise((resolveDrain) => {
            setTimeout(resolveDrain, WINDOWS_TREE_HANDLE_DRAIN_MS)
          })
        }
      } else if (isWin && windowsTreeLeasePromise) {
        await releaseWindowsProcessTree(windowsTreeLeasePromise)
      }
      if (outputLogStream && !outputLogStream.destroyed) {
        await new Promise((resolveLog) => {
          let done = false
          const finish = () => {
            if (done) return
            done = true
            resolveLog()
          }
          outputLogStream.once('finish', finish)
          outputLogStream.once('close', finish)
          outputLogStream.once('error', finish)
          outputLogStream.end()
        })
      }
      if (tailMode) {
        stdoutBuf = outputEvents
          .filter((entry) => entry.which === 'out')
          .map((entry) => entry.text)
          .join('')
        stderrBuf = outputEvents
          .filter((entry) => entry.which === 'err')
          .map((entry) => entry.text)
          .join('')
      }
      let persistedFullOutputPath = null
      if (tailMode && truncated && fullOutputPath && outputLogOwned && !outputLogError) {
        persistedFullOutputPath = fullOutputPath
      } else if (tailMode && fullOutputPath && outputLogOwned) {
        try { await fs.promises.rm(fullOutputPath, { force: true }) } catch { /* best-effort cleanup */ }
      }
      if (
        useWindowsProcessGate
        && !windowsGateStarted
        && !processIsolationFailed
        && !aborted
        && !timedOut
      ) {
        processStartFailed = true
        if (!processStartError) {
          processStartError = stderrBuf.trim() || 'Windows target process failed to start'
        }
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
        code: processStartFailed || processIsolationFailed
          ? null
          : (typeof code === 'number' ? code : null),
        signal: exitSignal || null,
        timedOut,
        killed,
        processStartFailed,
        processStartError,
        processIsolationFailed,
        processIsolationError,
        processTreeCleanupFailed,
        truncated,
        aborted,
        totalOutputBytes,
        ...(hasControlPipe
          ? {
              control: Buffer.concat(controlChunks, controlBufferedBytes),
              controlError,
              controlTruncated,
              controlTotalBytes,
            }
          : {}),
        ...(persistedFullOutputPath ? { fullOutputPath: persistedFullOutputPath } : {}),
        ...(outputLogError ? { outputLogError: outputLogError?.message || String(outputLogError) } : {}),
      })
    }

    child.on('error', (err) => {
      const message = err?.message || String(err)
      stderrBuf = (stderrBuf || '') + message
      if (useWindowsProcessGate) {
        processIsolationFailed = true
        processIsolationError = message
        resolveWindowsGateReady?.(false)
      } else {
        processStartFailed = true
        processStartError = message
      }
      windowsBindController?.abort()
      void finalize(null, null)
    })
    child.on('exit', () => {
      if (isWin && (cleanupWindowsTreeOnExit || windowsTreeLeasePromise)) {
        killTree('SIGTERM', { markKilled: false, stopOutput: false })
      }
      windowsBindController?.abort()
    })
    child.on('close', (code, signal) => {
      resolveWindowsGateReady?.(false)
      void finalize(code, signal)
    })
  })
}

export const _testing = {
  createWindowsTreeKillWorkerManager,
  windowsTreeKillWorkerScript,
  getWindowsTreeKillWorkerSnapshot: windowsTreeKillTesting.getSnapshot,
  resetWindowsTreeKillWorker: windowsTreeKillTesting.reset,
  prewarmWindowsTreeKillWorker: windowsTreeKillTesting.prewarm,
  requestWindowsTreeKill: windowsTreeKillTesting.request,
  setWindowsTreeKillWorkerManager: windowsTreeKillTesting.setManager,
}
