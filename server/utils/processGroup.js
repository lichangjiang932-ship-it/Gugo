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
import { performance } from 'node:perf_hooks'
import { sanitizeChildEnv } from './sensitiveEnv.js'
import { windowsTreeKillWorkerScript } from './windowsTreeKillWorkerSource.js'
import {
  bindWindowsProcessTree,
  createWindowsTreeKillWorkerManager,
  prepareWindowsTreeKillWorker,
  releaseWindowsProcessTree,
  terminateWindowsProcessTree,
  windowsTreeKillTesting,
} from './windowsTreeKillRuntime.js'

const GRACE_MS = 2_000
const WINDOWS_TREE_HANDLE_DRAIN_MS = 250
const DEFAULT_PROCESS_TIMEOUT_MS = 60_000

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
  if (process.platform === 'win32' && options?.cleanupWindowsTreeOnExit === true) {
    if (options?.signal?.aborted) return runProcessWithGroupStarted(options)
    const requestedTimeout = options?.timeout == null
      ? DEFAULT_PROCESS_TIMEOUT_MS
      : Math.max(0, Math.floor(Number(options.timeout) || 0))
    const startedAt = performance.now()
    const beforeExecutionResult = ({ error = null, aborted = false, timedOut = false } = {}) => ({
        stdout: '',
        stderr: error ? (error?.message || String(error)) : '',
        code: null,
        signal: null,
        timedOut,
        killed: false,
        processTreeCleanupFailed: Boolean(error && !aborted && !timedOut),
        truncated: false,
        aborted,
        totalOutputBytes: 0,
        ...(options?.controlPipe === true
          ? {
              control: Buffer.alloc(0),
              controlError: error
                ? 'Windows process-tree worker was unavailable before execution'
                : null,
              controlTruncated: false,
              controlTotalBytes: 0,
            }
          : {}),
      })
    if (requestedTimeout <= 0) {
      return Promise.resolve(beforeExecutionResult({ timedOut: true }))
    }
    return prepareWindowsTreeKillWorker({
      signal: options?.signal || null,
      timeoutMs: requestedTimeout,
    }).then(
      () => {
        if (options?.signal?.aborted) return runProcessWithGroupStarted(options)
        const elapsed = performance.now() - startedAt
        const remainingTimeout = Math.max(0, Math.floor(requestedTimeout - elapsed))
        if (remainingTimeout <= 0) return beforeExecutionResult({ timedOut: true })
        return runProcessWithGroupStarted({ ...options, timeout: remainingTimeout })
      },
      (error) => {
        const aborted = Boolean(
          options?.signal?.aborted
          || error?.code === 'WINDOWS_TREE_KILL_WORKER_READY_ABORTED'
        )
        const timedOut = !aborted && error?.code === 'WINDOWS_TREE_KILL_WORKER_READY_TIMEOUT'
        return beforeExecutionResult({ error: aborted || timedOut ? null : error, aborted, timedOut })
      },
    )
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
    return Promise.resolve({
      stdout: '',
      stderr: '',
      code: null,
      signal: null,
      timedOut: false,
      killed: false,
      truncated: false,
      aborted: true,
      totalOutputBytes: 0,
      ...(hasControlPipe
        ? {
            control: Buffer.alloc(0),
            controlError: null,
            controlTruncated: false,
            controlTotalBytes: 0,
          }
        : {}),
    })
  }
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32'
    const child = spawn(shellPath, shellArgs, {
      cwd,
      env: sanitizeChildEnv({}, {
        sourceEnv: env || process.env,
        inheritKeys: inheritEnvKeys,
      }),
      windowsHide,
      windowsVerbatimArguments,
      // ★ POSIX:detached=true → 子进程成为新进程组 leader,pgid === child.pid
      detached: !isWin,
      stdio: hasControlPipe
        ? [hasStdinInput ? 'pipe' : 'ignore', 'pipe', 'pipe', 'pipe']
        : [hasStdinInput ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    })

    const windowsBindController = isWin && cleanupWindowsTreeOnExit
      ? new AbortController()
      : null
    const windowsTreeLeasePromise = windowsBindController
      ? bindWindowsProcessTree({
          pid: child.pid,
          child,
          signal: windowsBindController.signal,
        }).catch(() => null)
      : null

    child.stdin?.on('error', () => { /* child may exit before consuming trusted input */ })
    child.once('spawn', () => {
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
    const streamsPausedForLog = new Set()

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
      // spawn 本身失败(命令不存在等)
      stderrBuf = (stderrBuf || '') + (err?.message || String(err))
      windowsBindController?.abort()
      void finalize(null, null)
    })
    child.on('exit', () => {
      if (isWin && cleanupWindowsTreeOnExit) {
        killTree('SIGTERM', { markKilled: false, stopOutput: false })
      }
      windowsBindController?.abort()
    })
    child.on('close', (code, signal) => { void finalize(code, signal) })
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
