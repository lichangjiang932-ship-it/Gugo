/** Pure source builder for the persistent Windows process-tree worker. */
export function windowsPowerShellPath() {
  const systemRoot = String(process.env.SystemRoot || process.env.WINDIR || '').trim()
  return systemRoot
    ? `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
    : 'powershell.exe'
}

export function windowsTreeKillWorkerBootstrapScript() {
  return `
$ErrorActionPreference = 'Stop'
$payload = [Console]::In.ReadLine()
if ([String]::IsNullOrWhiteSpace($payload)) {
  throw 'Windows process-tree worker payload is missing.'
}
$source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($payload))
& ([ScriptBlock]::Create($source))
`.trim()
}

export function windowsTreeKillWorkerScript() {
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
  private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x00001000;
  private const uint SYNCHRONIZE = 0x00100000;
  private const uint WAIT_TIMEOUT = 258;
  private const int ERROR_NO_MORE_FILES = 18;
  private const long WINDOWS_EPOCH_OFFSET = 116444736000000000L;
  private static readonly IntPtr INVALID_HANDLE_VALUE = new IntPtr(-1);
  private static readonly object ResponseLock = new object();
  private static readonly object LeaseLock = new object();
  private static readonly Dictionary<string, ProcessLease> Leases =
    new Dictionary<string, ProcessLease>(StringComparer.Ordinal);

  private sealed class ProcessIdentity : IDisposable {
    public readonly uint Pid;
    public readonly IntPtr Handle;
    public readonly long CreatedAt;

    public ProcessIdentity(uint pid, IntPtr handle, long createdAt) {
      Pid = pid;
      Handle = handle;
      CreatedAt = createdAt;
    }

    public void Dispose() {
      if (Handle != IntPtr.Zero) CloseHandle(Handle);
    }
  }

  private sealed class ProcessLease {
    public readonly string Id;
    public readonly ProcessIdentity Root;
    public int State;

    public ProcessLease(string id, ProcessIdentity root) {
      Id = id;
      Root = root;
      State = 0;
    }
  }

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
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool GetProcessTimes(
    IntPtr process,
    out System.Runtime.InteropServices.ComTypes.FILETIME creationTime,
    out System.Runtime.InteropServices.ComTypes.FILETIME exitTime,
    out System.Runtime.InteropServices.ComTypes.FILETIME kernelTime,
    out System.Runtime.InteropServices.ComTypes.FILETIME userTime
  );

  private static long FileTimeValue(System.Runtime.InteropServices.ComTypes.FILETIME value) {
    return ((long)(uint)value.dwHighDateTime << 32) | (uint)value.dwLowDateTime;
  }

  private static long UnixMillisecondsToFileTime(long value) {
    return checked(value * 10000L + WINDOWS_EPOCH_OFFSET);
  }

  private static List<PROCESSENTRY32> Snapshot() {
    IntPtr snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snapshot == INVALID_HANDLE_VALUE) {
      throw new Win32Exception(Marshal.GetLastWin32Error());
    }
    try {
      var rows = new List<PROCESSENTRY32>();
      var entry = new PROCESSENTRY32();
      entry.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
      if (!Process32First(snapshot, ref entry)) {
        int firstError = Marshal.GetLastWin32Error();
        if (firstError == ERROR_NO_MORE_FILES) return rows;
        throw new Win32Exception(firstError);
      }
      while (true) {
        rows.Add(entry);
        entry.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
        if (Process32Next(snapshot, ref entry)) continue;
        int nextError = Marshal.GetLastWin32Error();
        if (nextError != ERROR_NO_MORE_FILES) throw new Win32Exception(nextError);
        break;
      }
      return rows;
    } finally {
      CloseHandle(snapshot);
    }
  }

  private static bool SnapshotContains(uint processId, uint parentProcessId) {
    foreach (var row in Snapshot()) {
      if (row.th32ProcessID == processId
          && row.th32ParentProcessID == parentProcessId) return true;
    }
    return false;
  }

  private static ProcessIdentity OpenIdentity(uint processId) {
    IntPtr process = OpenProcess(
      PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE,
      false,
      processId
    );
    if (process == IntPtr.Zero) return null;
    try {
      System.Runtime.InteropServices.ComTypes.FILETIME created;
      System.Runtime.InteropServices.ComTypes.FILETIME exited;
      System.Runtime.InteropServices.ComTypes.FILETIME kernel;
      System.Runtime.InteropServices.ComTypes.FILETIME user;
      if (!GetProcessTimes(process, out created, out exited, out kernel, out user)) {
        throw new Win32Exception(Marshal.GetLastWin32Error());
      }
      return new ProcessIdentity(processId, process, FileTimeValue(created));
    } catch {
      CloseHandle(process);
      throw;
    }
  }

  private static bool IsAlive(ProcessIdentity identity) {
    return WaitForSingleObject(identity.Handle, 0) == WAIT_TIMEOUT;
  }

  private static long IdentityExitTime(ProcessIdentity identity) {
    if (IsAlive(identity)) return long.MaxValue;
    System.Runtime.InteropServices.ComTypes.FILETIME created;
    System.Runtime.InteropServices.ComTypes.FILETIME exited;
    System.Runtime.InteropServices.ComTypes.FILETIME kernel;
    System.Runtime.InteropServices.ComTypes.FILETIME user;
    if (!GetProcessTimes(identity.Handle, out created, out exited, out kernel, out user)) {
      throw new Win32Exception(Marshal.GetLastWin32Error());
    }
    long value = FileTimeValue(exited);
    return value > 0 ? value : identity.CreatedAt;
  }

  public static bool Bind(string leaseId, int rootPid, long identityCutoffUnixMs) {
    if (String.IsNullOrWhiteSpace(leaseId) || rootPid <= 0 || identityCutoffUnixMs <= 0) {
      return false;
    }
    ProcessIdentity root = OpenIdentity((uint)rootPid);
    if (root == null) return false;
    bool owned = false;
    try {
      // The root may exit after the caller validates its ChildProcess handle
      // but before this request is handled. Its retained creation/exit times
      // still define the descendant identity boundary.
      if (root.CreatedAt > UnixMillisecondsToFileTime(identityCutoffUnixMs)) return false;
      lock (LeaseLock) {
        if (Leases.ContainsKey(leaseId)) return false;
        Leases.Add(leaseId, new ProcessLease(leaseId, root));
        owned = true;
      }
      return true;
    } finally {
      if (!owned) root.Dispose();
    }
  }

  public static bool Release(string leaseId) {
    ProcessLease lease = null;
    lock (LeaseLock) {
      if (!Leases.TryGetValue(leaseId, out lease) || lease.State != 0) return false;
      lease.State = 2;
      Leases.Remove(leaseId);
    }
    lease.Root.Dispose();
    return true;
  }

  private static ProcessLease TakeLease(string leaseId) {
    lock (LeaseLock) {
      ProcessLease lease;
      if (!Leases.TryGetValue(leaseId, out lease) || lease.State != 0) return null;
      lease.State = 1;
      return lease;
    }
  }

  private static void FinishLease(ProcessLease lease) {
    lock (LeaseLock) {
      ProcessLease current;
      if (Leases.TryGetValue(lease.Id, out current) && Object.ReferenceEquals(current, lease)) {
        Leases.Remove(lease.Id);
      }
      lease.State = 2;
    }
  }

  private static void ExpandDescendants(
    Dictionary<uint, ProcessIdentity> tracked,
    List<PROCESSENTRY32> rows
  ) {
    bool changed;
    do {
      changed = false;
      foreach (var row in rows) {
        uint processId = row.th32ProcessID;
        ProcessIdentity parent;
        if (processId == 0 || tracked.ContainsKey(processId)
            || !tracked.TryGetValue(row.th32ParentProcessID, out parent)) continue;
        ProcessIdentity candidate = OpenIdentity(processId);
        if (candidate == null) {
          if (SnapshotContains(processId, row.th32ParentProcessID)) {
            throw new Win32Exception("A descendant process could not be identity-checked.");
          }
          continue;
        }
        long parentExitedAt = IdentityExitTime(parent);
        if (!SnapshotContains(processId, row.th32ParentProcessID)
            || candidate.CreatedAt < parent.CreatedAt
            || candidate.CreatedAt > parentExitedAt) {
          candidate.Dispose();
          continue;
        }
        tracked.Add(processId, candidate);
        changed = true;
      }
    } while (changed);
  }

  private static void Terminate(ProcessIdentity identity) {
    if (!IsAlive(identity)) return;
    if (!TerminateProcess(identity.Handle, 1) && IsAlive(identity)) {
      throw new Win32Exception(Marshal.GetLastWin32Error());
    }
  }

  private static bool AnyTrackedProcessAlive(Dictionary<uint, ProcessIdentity> tracked) {
    foreach (var identity in tracked.Values) {
      if (IsAlive(identity)) return true;
    }
    return false;
  }

  private static bool KillBoundTree(ProcessLease lease, int timeoutMs) {
    var tracked = new Dictionary<uint, ProcessIdentity>();
    tracked.Add(lease.Root.Pid, lease.Root);
    DateTime deadline = DateTime.UtcNow.AddMilliseconds(Math.Max(250, timeoutMs));
    int stableEmptySnapshots = 0;
    try {
      while (DateTime.UtcNow < deadline) {
        ExpandDescendants(tracked, Snapshot());
        foreach (var identity in tracked.Values) {
          if (DateTime.UtcNow >= deadline) break;
          Terminate(identity);
        }
        if (DateTime.UtcNow >= deadline) break;
        Thread.Sleep((int)Math.Min(50, Math.Max(1, (deadline - DateTime.UtcNow).TotalMilliseconds)));
        ExpandDescendants(tracked, Snapshot());
        if (AnyTrackedProcessAlive(tracked)) {
          stableEmptySnapshots = 0;
          continue;
        }
        stableEmptySnapshots++;
        if (stableEmptySnapshots >= 2) return true;
        Thread.Sleep((int)Math.Min(50, Math.Max(1, (deadline - DateTime.UtcNow).TotalMilliseconds)));
      }
      return false;
    } finally {
      foreach (var identity in tracked.Values) identity.Dispose();
    }
  }

  private static bool Kill(ProcessLease lease, int timeoutMs) {
    try {
      return KillBoundTree(lease, timeoutMs);
    } finally {
      FinishLease(lease);
    }
  }

  public static void WriteResponse(string requestId, bool succeeded) {
    lock (ResponseLock) {
      Console.Out.WriteLine(requestId + "\\t" + (succeeded ? "1" : "0"));
      Console.Out.Flush();
    }
  }

  public static bool QueueKill(string requestId, string leaseId, int timeoutMs) {
    // Claim the lease on the protocol thread. This is the linearization point:
    // a following RELEASE can no longer close a handle used by this worker.
    ProcessLease lease = TakeLease(leaseId);
    if (lease == null) return false;
    try {
      var thread = new Thread(delegate() {
        bool succeeded = false;
        try {
          succeeded = Kill(lease, timeoutMs);
        } catch {
          succeeded = false;
        }
        WriteResponse(requestId, succeeded);
      });
      thread.IsBackground = true;
      thread.Start();
      return true;
    } catch {
      FinishLease(lease);
      lease.Root.Dispose();
      return false;
    }
  }
}
'@
$null = Add-Type -TypeDefinition $nativeSource
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::Out.WriteLine("READY" + [char]9 + "2")
[Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $parts = $line.Split([char]9)
  if ($parts.Length -lt 3 -or [string]::IsNullOrWhiteSpace($parts[1])) { continue }
  $operation = $parts[0]
  $requestId = $parts[1]
  if ($operation -eq 'BIND' -and $parts.Length -eq 5) {
    $rootPid = 0
    $identityCutoffUnixMs = 0L
    $valid = [int]::TryParse($parts[3], [ref]$rootPid) -and [long]::TryParse($parts[4], [ref]$identityCutoffUnixMs)
    $bound = $valid -and [GugoProcessTreeNative]::Bind($parts[2], $rootPid, $identityCutoffUnixMs)
    [GugoProcessTreeNative]::WriteResponse($requestId, $bound)
    continue
  }
  if ($operation -eq 'KILL' -and $parts.Length -eq 4) {
    $timeoutMs = 0
    if (-not [int]::TryParse($parts[3], [ref]$timeoutMs)) {
      [GugoProcessTreeNative]::WriteResponse($requestId, $false)
      continue
    }
    if (-not [GugoProcessTreeNative]::QueueKill($requestId, $parts[2], $timeoutMs)) {
      [GugoProcessTreeNative]::WriteResponse($requestId, $false)
    }
    continue
  }
  if ($operation -eq 'RELEASE' -and $parts.Length -eq 3) {
    [GugoProcessTreeNative]::WriteResponse($requestId, [GugoProcessTreeNative]::Release($parts[2]))
    continue
  }
  [GugoProcessTreeNative]::WriteResponse($requestId, $false)
}
`.trim()
}

export function windowsTreeKillWorkerPayload() {
  return Buffer.from(windowsTreeKillWorkerScript(), 'utf8').toString('base64')
}

export function windowsTreeKillWorkerArgs() {
  // Keep CreateProcess far below Windows' 32,767-character command-line
  // limit. The full worker arrives as the first stdin frame.
  const encoded = Buffer.from(windowsTreeKillWorkerBootstrapScript(), 'utf16le').toString('base64')
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded]
}
