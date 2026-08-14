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

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

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

function windowsTreeKillScript(pid) {
  const rootPid = Math.max(1, Math.floor(Number(pid) || 0))
  return `
$ErrorActionPreference = 'Stop'
$rootPid = ${rootPid}
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
}
'@
Add-Type -TypeDefinition $nativeSource
if ([GugoProcessTreeNative]::KillTree($rootPid, ${WINDOWS_TREE_KILL_INTERNAL_TIMEOUT_MS})) { exit 0 }
exit 1
`.trim()
}

function windowsTreeKillArgs(pid) {
  const encoded = Buffer.from(windowsTreeKillScript(pid), 'utf16le').toString('base64')
  return [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    encoded,
  ]
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
  overflowMode = 'kill',
  fullOutputPath = null,
  onOutput = null,
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
      totalOutputBytes: 0,
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
    let outputLogError = null
    const streamsPausedForLog = new Set()

    if (tailMode && fullOutputPath) {
      try {
        fs.mkdirSync(path.dirname(fullOutputPath), { recursive: true })
        outputLogStream = fs.createWriteStream(fullOutputPath, { flags: 'wx' })
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
    }

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
              const finish = (succeeded) => {
                if (finished) return
                finished = true
                if (hardStop) clearTimeout(hardStop)
                resolveTreeKill(Boolean(succeeded))
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
                killer = spawn(windowsPowerShellPath(), windowsTreeKillArgs(child.pid), {
                  windowsHide: true,
                  stdio: 'ignore',
                })
                // This direct handle is always available to the parent Node
                // process, even in sandboxes that deny taskkill or WMI. Stop
                // the shell immediately; the native helper follows creator
                // PID links to collect and terminate every descendant.
                try { child.kill('SIGKILL') } catch { /* process may already be gone */ }
                killer.once('error', () => {
                  fallbackActive = true
                  try {
                    const fallbackKiller = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
                      windowsHide: true,
                      stdio: 'ignore',
                    })
                    fallbackKiller.once('error', () => finish(false))
                    fallbackKiller.once('close', (code) => finish(code === 0))
                  } catch {
                    try { child.kill('SIGKILL') } catch { /* process may already be gone */ }
                    finish(false)
                  }
                })
                killer.once('close', (code) => {
                  if (!fallbackActive) finish(code === 0)
                })
              } catch {
                try { child.kill('SIGKILL') } catch { /* process may already be gone */ }
                finish(false)
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
                  finish(false)
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
      let processTreeCleanupFailed = false
      if (isWin && killed && windowsTreeKillPromise) {
        processTreeCleanupFailed = !(await windowsTreeKillPromise)
        // Even after every captured PID is gone, Windows can retain a closing
        // cwd handle for a few scheduler ticks. Keep a short bounded drain
        // before exposing cancellation as complete.
        await new Promise((resolveDrain) => {
          setTimeout(resolveDrain, WINDOWS_TREE_HANDLE_DRAIN_MS)
        })
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
      if (tailMode && truncated && fullOutputPath && !outputLogError) {
        persistedFullOutputPath = fullOutputPath
      } else if (tailMode && fullOutputPath) {
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
        ...(persistedFullOutputPath ? { fullOutputPath: persistedFullOutputPath } : {}),
        ...(outputLogError ? { outputLogError: outputLogError?.message || String(outputLogError) } : {}),
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
