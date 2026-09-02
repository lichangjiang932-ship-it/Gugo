import { performance } from 'node:perf_hooks'
import { terminateWindowsProcessTree } from './windowsTreeKillRuntime.js'

const GRACE_MS = 2_000
const POSIX_EXIT_POLL_MS = 25

function signalPosixTarget(pid, signal, preferredTarget = null) {
  const targets = preferredTarget === null ? [-pid, pid] : [preferredTarget]
  for (const target of targets) {
    try {
      process.kill(target, signal)
      return target
    } catch (cause) {
      // Only ESRCH proves that the detached group does not exist. Permission
      // and other failures must not silently downgrade cleanup to the root.
      if (target < 0 && preferredTarget === null && cause?.code === 'ESRCH') continue
      return null
    }
  }
  return null
}

function posixTargetExists(target) {
  try {
    process.kill(target, 0)
    return true
  } catch (cause) {
    // Unknown probe failures cannot prove cleanup and therefore fail closed.
    return cause?.code !== 'ESRCH'
  }
}

function waitForPosixExit(target, timeoutMs) {
  return new Promise((resolve) => {
    const deadline = performance.now() + timeoutMs
    const poll = () => {
      if (!posixTargetExists(target)) return resolve(true)
      if (performance.now() >= deadline) return resolve(false)
      setTimeout(poll, POSIX_EXIT_POLL_MS)
    }
    poll()
  })
}

async function terminatePosixProcessTree(pid) {
  const target = signalPosixTarget(pid, 'SIGTERM')
  if (target === null) {
    // A concurrent natural exit is already a successful cleanup.
    return !posixTargetExists(-pid) && !posixTargetExists(pid)
  }
  if (await waitForPosixExit(target, GRACE_MS)) return true
  if (signalPosixTarget(pid, 'SIGKILL', target) === null) return !posixTargetExists(target)
  return waitForPosixExit(target, GRACE_MS)
}

/** Terminate one process tree and wait for platform-specific cleanup proof. */
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
  return terminatePosixProcessTree(pid)
}
