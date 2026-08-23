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
import { sanitizeChildEnv } from './sensitiveEnv.js'

const GRACE_MS = 2_000
const WINDOWS_TREE_HANDLE_DRAIN_MS = 250
const WINDOWS_TREE_KILL_INTERNAL_TIMEOUT_MS = 4_000
// Windows PowerShell must start and compile the native helper before its own
// process-tree deadline begins. Under a loaded CI runner Add-Type alone can
// exceed the old 6s outer timeout, causing Node to kill a helper that was still
// making progress and incorrectly report processTreeCleanupFailed. Keep those
// two budgets separate so the outer watchdog cannot expire before the helper's
// advertised cleanup window.
const WINDOWS_TREE_KILL_STARTUP_TIMEOUT_MS = 8_000
const WINDOWS_TREE_KILL_TIMEOUT_MS = WINDOWS_TREE_KILL_STARTUP_TIMEOUT_MS
  + WINDOWS_TREE_KILL_INTERNAL_TIMEOUT_MS

function utf8Tail(value, maxBytes) {
  const source = Buffer.from(String(value || ''), 'utf8')
  if (source.length <= maxBytes) return source.toString('utf8')
  let start = Math.max(0, source.length - Math.max(0, maxBytes))
  while (start < source.length && (source[start] & 0xc0) === 0x80) start += 1
  return source.subarray(start).toString('utf8')
}

function windowsPowerShellPath() {
  const systemRoot = String(process.env.SystemRoot || process.env.WINDIR || '').trim()
  return systemRoot
    ? `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
    : 'powershell.exe'
}

function windowsTreeKillWorkerScript() {
  return `
$ErrorActionPreference = 'Stop'
$nativeSource = @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Threading;

public static class GugoProcessTreeNative {
  private const uint TH32CS_SNAPPROCESS = 0x00000002;
  private const uint PROCESS_TERMINATE = 0x00000001;
  private const uint SYNCHRONIZE = 0x00100000;
  private static readonly IntPtr INVALID_HANDLE_VALUE = new IntPtr(-1);
  private static readonly object ResponseLock = new object();

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
  private struct PROCESSENTRY32 {
    public uint dwSize;
    public uint cntUsage;
    public uint th32ProcessID;
    public IntPtr th32DefaultHeapID;
    public uint th32ModuleID;
    public uint cntThreads;
    public uint th32ParentProcessID;
    public int pcPriClassBase;
    public uint dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
    public string szExeFile;
  }

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);
  [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
  private static extern bool Process32First(IntPtr snapshot, ref PROCESSENTRY32 entry);
  [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
  private static extern bool Process32Next(IntPtr snapshot, ref PROCESSENTRY32 entry);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern IntPtr OpenProcess(uint access, bool inheritHandle, uint processId);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool TerminateProcess(IntPtr process, uint exitCode);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

  private static List<PROCESSENTRY32> Snapshot() {
    IntPtr snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snapshot == INVALID_HANDLE_VALUE) {
      throw new Win32Exception(Marshal.GetLastWin32Error());
    }
    try {
      var rows = new List<PROCESSENTRY32>();
      var entry = new PROCESSENTRY32();
      entry.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
      if (Process32First(snapshot, ref entry)) {
        do {
          rows.Add(entry);
          entry.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
        } while (Process32Next(snapshot, ref entry));
      }
      return rows;
    } finally {
      CloseHandle(snapshot);
    }
  }

  private static void ExpandDescendants(HashSet<uint> tracked, List<PROCESSENTRY32> rows) {
    bool changed;
    do {
      changed = false;
      foreach (var row in rows) {
        if (row.th32ProcessID != 0 && tracked.Contains(row.th32ParentProcessID)
            && tracked.Add(row.th32ProcessID)) {
          changed = true;
        }
      }
    } while (changed);
  }

  private static void Terminate(uint processId) {
    IntPtr process = OpenProcess(PROCESS_TERMINATE | SYNCHRONIZE, false, processId);
    if (process == IntPtr.Zero) return;
    try {
      TerminateProcess(process, 1);
      WaitForSingleObject(process, 500);
    } finally {
      CloseHandle(process);
    }
  }

  private static bool AnyTrackedProcessAlive(HashSet<uint> tracked, List<PROCESSENTRY32> rows) {
    foreach (var row in rows) {
      if (tracked.Contains(row.th32ProcessID)) return true;
    }
    return false;
  }

  public static bool KillTree(int rootPid, int timeoutMs) {
    if (rootPid <= 0) return true;
    var tracked = new HashSet<uint>();
    tracked.Add((uint)rootPid);
    DateTime deadline = DateTime.UtcNow.AddMilliseconds(Math.Max(250, timeoutMs));
    int stableEmptySnapshots = 0;

    while (DateTime.UtcNow < deadline) {
      List<PROCESSENTRY32> before = Snapshot();
      ExpandDescendants(tracked, before);

      // Stop the shell first so it cannot create another descendant between
      // enumeration and cleanup. Windows keeps creator PIDs on descendants,
      // so later snapshots can still discover processes below a dead parent.
      Terminate((uint)rootPid);
      foreach (uint processId in tracked) {
        if (processId != (uint)rootPid) Terminate(processId);
      }

      Thread.Sleep(50);
      List<PROCESSENTRY32> after = Snapshot();
      ExpandDescendants(tracked, after);
      if (AnyTrackedProcessAlive(tracked, after)) {
        stableEmptySnapshots = 0;
        continue;
      }

      stableEmptySnapshots++;
      if (stableEmptySnapshots >= 2) return true;
      Thread.Sleep(50);
    }
    return false;
  }

  public static void WriteResponse(string requestId, bool succeeded) {
    lock (ResponseLock) {
      Console.Out.WriteLine(requestId + "\\t" + (succeeded ? "1" : "0"));
      Console.Out.Flush();
    }
  }

  public static void QueueKill(string requestId, int rootPid, int timeoutMs) {
    var thread = new Thread(delegate() {
      bool succeeded = false;
      try {
        succeeded = KillTree(rootPid, timeoutMs);
      } catch {
        succeeded = false;
      }
      WriteResponse(requestId, succeeded);
    });
    thread.IsBackground = true;
    thread.Start();
  }
}
'@
$null = Add-Type -TypeDefinition $nativeSource
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::Out.WriteLine("READY" + [char]9 + "1")
[Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $parts = $line.Split([char]9)
  if ($parts.Length -ne 3 -or [string]::IsNullOrWhiteSpace($parts[0])) { continue }
  $rootPid = 0
  $timeoutMs = 0
  if (-not [int]::TryParse($parts[1], [ref]$rootPid) -or -not [int]::TryParse($parts[2], [ref]$timeoutMs) -or $rootPid -le 0) {
    [GugoProcessTreeNative]::WriteResponse($parts[0], $false)
    continue
  }
  [GugoProcessTreeNative]::QueueKill($parts[0], $rootPid, $timeoutMs)
}
`.trim()
}

function windowsTreeKillWorkerArgs() {
  const encoded = Buffer.from(windowsTreeKillWorkerScript(), 'utf16le').toString('base64')
  return [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    encoded,
  ]
}

function windowsTreeKillWorkerError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function setProcessAndPipesReferenced(child, referenced) {
  const method = referenced ? 'ref' : 'unref'
  child?.[method]?.()
  child?.stdin?.[method]?.()
  child?.stdout?.[method]?.()
  child?.stderr?.[method]?.()
}

function createWindowsTreeKillWorkerManager({
  spawnProcess = spawn,
  workerPath = windowsPowerShellPath(),
  workerArgs = windowsTreeKillWorkerArgs(),
  startupTimeoutMs = WINDOWS_TREE_KILL_STARTUP_TIMEOUT_MS,
  requestTimeoutMs = WINDOWS_TREE_KILL_TIMEOUT_MS,
} = {}) {
  let activeWorker = null
  let generation = 0
  let nextRequestId = 0
  let spawnCount = 0

  const failWorker = (worker, error, { terminate = true } = {}) => {
    if (!worker || worker.failed) return
    worker.failed = true
    if (worker.startupTimer) clearTimeout(worker.startupTimer)
    worker.startupTimer = null
    if (activeWorker === worker) activeWorker = null
    for (const pending of worker.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    worker.pending.clear()
    worker.queue.length = 0
    setProcessAndPipesReferenced(worker.child, false)
    if (terminate) {
      try { worker.child.stdin?.destroy() } catch { /* already closed */ }
      try { worker.child.kill('SIGKILL') } catch { /* already exited */ }
    }
  }

  const flushWorkerQueue = (worker) => {
    if (!worker?.ready || worker.failed) return
    while (worker.queue.length > 0) {
      const requestId = worker.queue.shift()
      const pending = worker.pending.get(requestId)
      if (!pending || pending.sent) continue
      pending.sent = true
      try {
        worker.child.stdin.write(
          `${requestId}\t${pending.pid}\t${WINDOWS_TREE_KILL_INTERNAL_TIMEOUT_MS}\n`,
          (error) => {
            if (!error) return
            failWorker(worker, windowsTreeKillWorkerError(
              'WINDOWS_TREE_KILL_WORKER_WRITE_FAILED',
              `Windows 进程树清理 worker 写入失败：${error?.message || String(error)}`,
            ))
          },
        )
      } catch (error) {
        failWorker(worker, windowsTreeKillWorkerError(
          'WINDOWS_TREE_KILL_WORKER_WRITE_FAILED',
          `Windows 进程树清理 worker 写入失败：${error?.message || String(error)}`,
        ))
        return
      }
    }
  }

  const acceptWorkerLine = (worker, rawLine) => {
    const line = String(rawLine || '').replace(/^\uFEFF/u, '').replace(/\r$/u, '')
    if (!line) return
    if (!worker.ready) {
      if (line !== 'READY\t1') {
        failWorker(worker, windowsTreeKillWorkerError(
          'WINDOWS_TREE_KILL_WORKER_PROTOCOL_ERROR',
          'Windows 进程树清理 worker 启动握手无效',
        ))
        return
      }
      worker.ready = true
      if (worker.startupTimer) clearTimeout(worker.startupTimer)
      worker.startupTimer = null
      flushWorkerQueue(worker)
      return
    }

    const fields = line.split('\t')
    if (fields.length !== 2 || (fields[1] !== '0' && fields[1] !== '1')) {
      failWorker(worker, windowsTreeKillWorkerError(
        'WINDOWS_TREE_KILL_WORKER_PROTOCOL_ERROR',
        'Windows 进程树清理 worker 返回了无效响应',
      ))
      return
    }
    const pending = worker.pending.get(fields[0])
    if (!pending) {
      failWorker(worker, windowsTreeKillWorkerError(
        'WINDOWS_TREE_KILL_WORKER_PROTOCOL_ERROR',
        'Windows 进程树清理 worker 返回了未知请求响应',
      ))
      return
    }
    clearTimeout(pending.timer)
    worker.pending.delete(fields[0])
    pending.resolve(fields[1] === '1')
    if (worker.pending.size === 0) setProcessAndPipesReferenced(worker.child, false)
  }

  const spawnWorker = () => {
    let child
    try {
      child = spawnProcess(workerPath, workerArgs, {
        env: sanitizeChildEnv(),
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'ignore'],
      })
    } catch (error) {
      throw windowsTreeKillWorkerError(
        'WINDOWS_TREE_KILL_WORKER_START_FAILED',
        `Windows 进程树清理 worker 启动失败：${error?.message || String(error)}`,
      )
    }

    const worker = {
      child,
      generation: ++generation,
      ready: false,
      failed: false,
      stdoutBuffer: '',
      pending: new Map(),
      queue: [],
      startupTimer: null,
    }
    activeWorker = worker
    spawnCount += 1
    setProcessAndPipesReferenced(child, false)

    child.stdout?.setEncoding?.('utf8')
    child.stdout?.on('data', (chunk) => {
      if (worker.failed) return
      worker.stdoutBuffer += String(chunk || '')
      while (true) {
        const newlineAt = worker.stdoutBuffer.indexOf('\n')
        if (newlineAt < 0) break
        const line = worker.stdoutBuffer.slice(0, newlineAt)
        worker.stdoutBuffer = worker.stdoutBuffer.slice(newlineAt + 1)
        acceptWorkerLine(worker, line)
        if (worker.failed) return
      }
    })
    child.stdin?.on('error', (error) => {
      failWorker(worker, windowsTreeKillWorkerError(
        'WINDOWS_TREE_KILL_WORKER_PIPE_FAILED',
        `Windows 进程树清理 worker 输入管道失败：${error?.message || String(error)}`,
      ))
    })
    child.stdout?.on('error', (error) => {
      failWorker(worker, windowsTreeKillWorkerError(
        'WINDOWS_TREE_KILL_WORKER_PIPE_FAILED',
        `Windows 进程树清理 worker 输出管道失败：${error?.message || String(error)}`,
      ))
    })
    child.once('error', (error) => {
      failWorker(worker, windowsTreeKillWorkerError(
        'WINDOWS_TREE_KILL_WORKER_CRASHED',
        `Windows 进程树清理 worker 异常：${error?.message || String(error)}`,
      ), { terminate: false })
    })
    child.once('close', (code, signal) => {
      failWorker(worker, windowsTreeKillWorkerError(
        'WINDOWS_TREE_KILL_WORKER_CRASHED',
        `Windows 进程树清理 worker 已退出${typeof code === 'number' ? ` (code=${code})` : ''}${signal ? ` (${signal})` : ''}`,
      ), { terminate: false })
    })

    if (!child.stdin || !child.stdout) {
      queueMicrotask(() => failWorker(worker, windowsTreeKillWorkerError(
        'WINDOWS_TREE_KILL_WORKER_PIPE_FAILED',
        'Windows 进程树清理 worker 缺少协议管道',
      )))
      return worker
    }

    worker.startupTimer = setTimeout(() => {
      failWorker(worker, windowsTreeKillWorkerError(
        'WINDOWS_TREE_KILL_WORKER_START_TIMEOUT',
        'Windows 进程树清理 worker 启动超时',
      ))
    }, startupTimeoutMs)
    worker.startupTimer.unref?.()
    return worker
  }

  const ensureWorker = () => {
    if (activeWorker && !activeWorker.failed) return activeWorker
    return spawnWorker()
  }

  const prewarm = () => {
    try {
      ensureWorker()
      return true
    } catch {
      // Prewarming is opportunistic. The real cleanup request still reports
      // startup failures and uses the bounded taskkill fallback.
      return false
    }
  }

  const request = (rawPid) => {
    const pid = Math.floor(Number(rawPid) || 0)
    if (pid <= 0) {
      return Promise.reject(windowsTreeKillWorkerError(
        'WINDOWS_TREE_KILL_WORKER_PID_INVALID',
        'Windows 进程树清理请求的 PID 无效',
      ))
    }
    let worker
    try {
      worker = ensureWorker()
    } catch (error) {
      return Promise.reject(error)
    }
    const requestId = `${worker.generation}:${++nextRequestId}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        failWorker(worker, windowsTreeKillWorkerError(
          'WINDOWS_TREE_KILL_WORKER_REQUEST_TIMEOUT',
          'Windows 进程树清理 worker 请求超时',
        ))
      }, requestTimeoutMs)
      timer.unref?.()
      worker.pending.set(requestId, {
        pid,
        resolve,
        reject,
        timer,
        sent: false,
      })
      if (worker.pending.size === 1) setProcessAndPipesReferenced(worker.child, true)
      worker.queue.push(requestId)
      flushWorkerQueue(worker)
    })
  }

  const shutdown = () => {
    if (!activeWorker) return
    failWorker(activeWorker, windowsTreeKillWorkerError(
      'WINDOWS_TREE_KILL_WORKER_SHUTDOWN',
      'Windows 进程树清理 worker 已关闭',
    ))
  }

  const snapshot = () => ({
    active: Boolean(activeWorker && !activeWorker.failed),
    pid: activeWorker?.child?.pid || null,
    ready: Boolean(activeWorker?.ready && !activeWorker.failed),
    pending: activeWorker?.pending?.size || 0,
    queued: activeWorker?.queue?.length || 0,
    generation: activeWorker?.generation || generation,
    spawnCount,
  })

  return { prewarm, request, shutdown, snapshot }
}

let windowsTreeKillWorkerManager = null

function getWindowsTreeKillWorkerManager() {
  if (!windowsTreeKillWorkerManager) {
    windowsTreeKillWorkerManager = createWindowsTreeKillWorkerManager()
  }
  return windowsTreeKillWorkerManager
}

function runWindowsTaskkillFallback(pid) {
  return new Promise((resolve) => {
    let helper = null
    let settled = false
    let timer = null
    const finish = (succeeded) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(Boolean(succeeded))
    }
    try {
      helper = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], {
        env: sanitizeChildEnv(),
        windowsHide: true,
        stdio: 'ignore',
      })
      helper.once('error', () => finish(false))
      helper.once('close', (code) => finish(code === 0))
      timer = setTimeout(() => {
        try { helper?.kill('SIGKILL') } catch { /* helper may already be gone */ }
        finish(false)
      }, WINDOWS_TREE_KILL_INTERNAL_TIMEOUT_MS)
      timer.unref?.()
    } catch {
      finish(false)
    }
  })
}

async function killWindowsProcessTree(pid) {
  try {
    return await getWindowsTreeKillWorkerManager().request(pid)
  } catch {
    return runWindowsTaskkillFallback(pid)
  }
}

/**
 * Terminate one process tree and wait for the platform cleanup proof.
 *
 * Windows uses the shared Toolhelp32/TerminateProcess worker and also closes
 * the direct child handle as a last-resort root-process guarantee. POSIX uses
 * the detached process group when available.
 */
export async function terminateProcessTree({ pid: rawPid, child = null } = {}) {
  const pid = Math.floor(Number(rawPid) || 0)
  if (pid <= 0) return false
  if (process.platform === 'win32') {
    const treeKillPromise = killWindowsProcessTree(pid)
    try { child?.kill?.('SIGKILL') } catch { /* process may already be gone */ }
    return await treeKillPromise === true
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

export function runProcessWithGroup({
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

    if (isWin && cleanupWindowsTreeOnExit) {
      // Compile the native tree walker while the command is running. Besides
      // removing cold-start latency from cleanup, this makes the first tree
      // snapshot happen before short-lived cmd.exe wrappers disappear.
      getWindowsTreeKillWorkerManager().prewarm()
    }

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
          // `taskkill /T` may still be walking descendants after cmd.exe has
          // emitted `close`. Track the helper and make finalization wait for it;
          // otherwise callers can observe a cancelled command while a child is
          // still holding the working directory open.
          if (!windowsTreeKillPromise) {
            // The PowerShell process and Add-Type compilation are shared by all
            // requests. Each cleanup is correlated by request id inside the
            // worker; a worker crash rejects every in-flight request and this
            // call then uses the bounded taskkill fallback.
            windowsTreeKillPromise = killWindowsProcessTree(child.pid)
            // This direct handle is always available to the parent Node
            // process, even in sandboxes that deny taskkill or native snapshot
            // access. The worker independently follows creator PID links to
            // collect and terminate every descendant.
            try { child.kill('SIGKILL') } catch { /* process may already be gone */ }
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
      void finalize(null, null)
    })
    child.on('exit', () => {
      if (isWin && cleanupWindowsTreeOnExit) {
        killTree('SIGTERM', { markKilled: false, stopOutput: false })
      }
    })
    child.on('close', (code, signal) => { void finalize(code, signal) })
  })
}

export const _testing = {
  createWindowsTreeKillWorkerManager,
  windowsTreeKillWorkerScript,
  getWindowsTreeKillWorkerSnapshot: () => (
    windowsTreeKillWorkerManager?.snapshot() || {
      active: false,
      pid: null,
      ready: false,
      pending: 0,
      queued: 0,
      generation: 0,
      spawnCount: 0,
    }
  ),
  resetWindowsTreeKillWorker: () => {
    windowsTreeKillWorkerManager?.shutdown()
    windowsTreeKillWorkerManager = null
  },
  prewarmWindowsTreeKillWorker: () => getWindowsTreeKillWorkerManager().prewarm(),
  requestWindowsTreeKill: (pid) => getWindowsTreeKillWorkerManager().request(pid),
}
