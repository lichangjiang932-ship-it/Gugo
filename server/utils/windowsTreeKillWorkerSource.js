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
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

public static class GugoProcessTreeNative {
  private const uint TH32CS_SNAPPROCESS = 0x00000002;
  private const uint PROCESS_TERMINATE = 0x00000001;
  private const uint PROCESS_SET_QUOTA = 0x00000100;
  private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x00001000;
  private const uint SYNCHRONIZE = 0x00100000;
  private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
  private const int JobObjectBasicAccountingInformation = 1;
  private const int JobObjectExtendedLimitInformation = 9;
  private const uint WAIT_TIMEOUT = 258;
  private const int ERROR_ACCESS_DENIED = 5;
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

  private sealed class ProcessLease {
    public readonly string Id;
    public readonly ProcessIdentity Root;
    public readonly IntPtr Job;
    public int State;

    public ProcessLease(string id, ProcessIdentity root, IntPtr job) {
      Id = id;
      Root = root;
      Job = job;
      State = 0;
    }

    public void Dispose() {
      if (Job != IntPtr.Zero) CloseHandle(Job);
      Root.Dispose();
    }
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit;
    public long PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize;
    public UIntPtr MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass;
    public uint SchedulingClass;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct IO_COUNTERS {
    public ulong ReadOperationCount;
    public ulong WriteOperationCount;
    public ulong OtherOperationCount;
    public ulong ReadTransferCount;
    public ulong WriteTransferCount;
    public ulong OtherTransferCount;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
    public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit;
    public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed;
    public UIntPtr PeakJobMemoryUsed;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION {
    public long TotalUserTime;
    public long TotalKernelTime;
    public long ThisPeriodTotalUserTime;
    public long ThisPeriodTotalKernelTime;
    public uint TotalPageFaultCount;
    public uint TotalProcesses;
    public uint ActiveProcesses;
    public uint TotalTerminatedProcesses;
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
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern IntPtr CreateJobObject(IntPtr jobAttributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool SetInformationJobObject(
    IntPtr job,
    int informationClass,
    ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION information,
    uint informationLength
  );
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool QueryInformationJobObject(
    IntPtr job,
    int informationClass,
    out JOBOBJECT_BASIC_ACCOUNTING_INFORMATION information,
    uint informationLength,
    out uint returnLength
  );
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

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

  private static IntPtr CreateKillOnCloseJob() {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    try {
      var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
      limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
      uint size = (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
      if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref limits, size)) {
        throw new Win32Exception(Marshal.GetLastWin32Error());
      }
      return job;
    } catch {
      CloseHandle(job);
      throw;
    }
  }

  private static uint ActiveJobProcessCount(IntPtr job) {
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting;
    uint returned;
    uint size = (uint)Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION));
    if (!QueryInformationJobObject(
      job,
      JobObjectBasicAccountingInformation,
      out accounting,
      size,
      out returned
    )) {
      throw new Win32Exception(Marshal.GetLastWin32Error());
    }
    return accounting.ActiveProcesses;
  }

  private static ProcessIdentity OpenIdentity(uint processId, bool forJobAssignment = false) {
    uint access = PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE;
    if (forJobAssignment) access |= PROCESS_SET_QUOTA;
    IntPtr process = OpenProcess(
      access,
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
    ProcessIdentity root = OpenIdentity((uint)rootPid, true);
    if (root == null) return false;
    IntPtr job = IntPtr.Zero;
    bool owned = false;
    try {
      long cutoffFileTime;
      try {
        cutoffFileTime = UnixMillisecondsToFileTime(identityCutoffUnixMs);
      } catch (OverflowException) {
        return false;
      }
      if (root.CreatedAt > cutoffFileTime || !IsAlive(root)) return false;
      job = CreateKillOnCloseJob();
      if (!AssignProcessToJobObject(job, root.Handle)) return false;
      lock (LeaseLock) {
        if (Leases.ContainsKey(leaseId)) return false;
        Leases.Add(leaseId, new ProcessLease(leaseId, root, job));
        owned = true;
      }
      return true;
    } finally {
      if (!owned) {
        if (job != IntPtr.Zero) CloseHandle(job);
        root.Dispose();
      }
    }
  }

  public static bool Release(string leaseId) {
    ProcessLease lease = null;
    lock (LeaseLock) {
      if (!Leases.TryGetValue(leaseId, out lease) || lease.State != 0) return false;
      lease.State = 2;
      Leases.Remove(leaseId);
    }
    lease.Dispose();
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
    if (TerminateProcess(identity.Handle, 1)) return;
    int error = Marshal.GetLastWin32Error();
    if (!IsAlive(identity)) return;
    // TerminateJobObject can put a process into its irreversible terminating
    // state before the process handle becomes signalled. During that narrow
    // window a redundant TerminateProcess call returns ERROR_ACCESS_DENIED.
    // Keep polling: success is still gated on two stable snapshots where the
    // job is empty and every retained identity handle is signalled.
    if (error == ERROR_ACCESS_DENIED) return;
    throw new Win32Exception(error);
  }

  private static bool AnyTrackedProcessAlive(Dictionary<uint, ProcessIdentity> tracked) {
    foreach (var identity in tracked.Values) {
      if (IsAlive(identity)) return true;
    }
    return false;
  }

  private static int RemainingBudgetMilliseconds(Stopwatch elapsed, int budgetMs) {
    long remaining = (long)budgetMs - elapsed.ElapsedMilliseconds;
    if (remaining <= 0) return 0;
    return (int)Math.Min((long)Int32.MaxValue, remaining);
  }

  private static bool IsBoundTreeEmpty(
    ProcessLease lease,
    Dictionary<uint, ProcessIdentity> tracked
  ) {
    ExpandDescendants(tracked, Snapshot());
    return ActiveJobProcessCount(lease.Job) == 0 && !AnyTrackedProcessAlive(tracked);
  }

  private static bool ConfirmBoundTreeEmpty(
    ProcessLease lease,
    Dictionary<uint, ProcessIdentity> tracked
  ) {
    // A busy Windows runner can resume this worker exactly at the cleanup
    // deadline. Do not turn an already-finished cleanup into a false failure,
    // but keep success fail-closed: two identity-safe empty observations are
    // still required across the same bounded 50 ms quiescence window used by
    // the normal polling loop.
    if (!IsBoundTreeEmpty(lease, tracked)) return false;
    Thread.Sleep(50);
    return IsBoundTreeEmpty(lease, tracked);
  }

  private static bool KillBoundTree(ProcessLease lease, int timeoutMs) {
    var tracked = new Dictionary<uint, ProcessIdentity>();
    tracked.Add(lease.Root.Pid, lease.Root);
    int budgetMs = Math.Max(250, timeoutMs);
    Stopwatch elapsed = Stopwatch.StartNew();
    int stableEmptySnapshots = 0;
    bool jobTerminated = false;
    try {
      while (RemainingBudgetMilliseconds(elapsed, budgetMs) > 0) {
        // AssignProcessToJobObject is not retroactive. Capture any descendants
        // that existed before the late bind before terminating the job root.
        ExpandDescendants(tracked, Snapshot());
        if (!jobTerminated) {
          bool terminated = TerminateJobObject(lease.Job, 1);
          int terminateError = terminated ? 0 : Marshal.GetLastWin32Error();
          if (!terminated && ActiveJobProcessCount(lease.Job) > 0) {
            throw new Win32Exception(terminateError);
          }
          jobTerminated = true;
        }
        foreach (var identity in tracked.Values) {
          if (RemainingBudgetMilliseconds(elapsed, budgetMs) <= 0) break;
          Terminate(identity);
        }
        int remainingMs = RemainingBudgetMilliseconds(elapsed, budgetMs);
        if (remainingMs <= 0) break;
        Thread.Sleep(Math.Min(50, remainingMs));
        if (!IsBoundTreeEmpty(lease, tracked)) {
          stableEmptySnapshots = 0;
          continue;
        }
        stableEmptySnapshots++;
        if (stableEmptySnapshots >= 2) return true;
        remainingMs = RemainingBudgetMilliseconds(elapsed, budgetMs);
        if (remainingMs > 0) Thread.Sleep(Math.Min(50, remainingMs));
      }
      return ConfirmBoundTreeEmpty(lease, tracked);
    } finally {
      foreach (var pair in tracked) {
        if (pair.Key != lease.Root.Pid) pair.Value.Dispose();
      }
    }
  }

  private static bool Kill(ProcessLease lease, int timeoutMs) {
    try {
      return KillBoundTree(lease, timeoutMs);
    } finally {
      FinishLease(lease);
      lease.Dispose();
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
      bool queued = ThreadPool.QueueUserWorkItem(delegate(object ignored) {
        bool succeeded = false;
        try {
          succeeded = Kill(lease, timeoutMs);
        } catch {
          succeeded = false;
        }
        WriteResponse(requestId, succeeded);
      });
      if (queued) return true;
      FinishLease(lease);
      lease.Dispose();
      return false;
    } catch {
      FinishLease(lease);
      lease.Dispose();
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
