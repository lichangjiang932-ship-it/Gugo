import path from 'node:path'
import { execFile } from 'node:child_process'

import { getRuntimeEnv } from '../utils/runtimeEnv.js'
import { sanitizeChildEnv } from '../utils/sensitiveEnv.js'

/**
 * Running the external commands the Git workbench depends on.
 *
 * Split out of `gitWorkbench.js`, which had grown past its implementation size
 * budget: this is the whole "how a child process is started, bounded and
 * retried" concern, and that file can stay about Git itself.
 */

export const MAX_OUTPUT = 1024 * 1024
const DEFAULT_TIMEOUT = 60_000

export function httpError(message, statusCode = 400) {
  const err = new Error(message)
  err.statusCode = statusCode
  return err
}

export function workspaceRoot(env = getRuntimeEnv()) {
  return path.resolve(env.WORKSPACE_ROOT?.trim() || process.cwd())
}

// ★ P0:统一从 sanitizeChildEnv 取,自动覆盖所有 *_API_KEY / *_TOKEN / *_SECRET / *_PASSWORD
// 老实现只屏蔽 3 个固定 key,换用户配 ANTHROPIC_API_KEY/GITHUB_TOKEN 就漏了
export function commandEnv() {
  return sanitizeChildEnv()
}

// Windows can return EBUSY right after another process tree was force-killed
// (taskkill /T /F in the test runner, a closing desktop terminal): the binary's
// image section is still being released, so the very next spawn of `git` fails
// even though nothing is wrong. A short bounded retry turns that transient
// state into a non-event without masking real failures.
const EBUSY_RETRY_DELAYS_MS = [150, 400]

function runFileOnce(file, args, options, callback) {
  execFile(file, args, options, callback)
}

export function runFile(file, args, {
  cwd = workspaceRoot(),
  timeout = DEFAULT_TIMEOUT,
  rejectOnError = true,
  // Injectable for the same reason the terminal host injects its pty: the retry
  // policy is the interesting part, and a real EBUSY cannot be summoned on demand.
  execFileImpl = runFileOnce,
  platform = process.platform,
} = {}) {
  const options = {
    cwd,
    timeout,
    maxBuffer: MAX_OUTPUT,
    windowsHide: true,
    env: commandEnv(),
  }
  const maxAttempts = 1 + (platform === 'win32' ? EBUSY_RETRY_DELAYS_MS.length : 0)

  function attempt(remaining, delayIndex) {
    return new Promise((resolve, reject) => {
      execFileImpl(file, args, options, (err, stdout, stderr) => {
        if (err && err.code === 'EBUSY' && remaining > 0) {
          const delay = EBUSY_RETRY_DELAYS_MS[Math.min(delayIndex, EBUSY_RETRY_DELAYS_MS.length - 1)]
          setTimeout(() => {
            attempt(remaining - 1, delayIndex + 1).then(resolve, reject)
          }, delay)
          return
        }
        const result = {
          ok: !err,
          exitCode: err ? (typeof err.code === 'number' ? err.code : -1) : 0,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
          timedOut: !!err?.killed,
        }
        if (err && rejectOnError) {
          const e = httpError(
            String(stderr || err.message || 'command failed').trim() || 'command failed',
            err.killed ? 408 : 500,
          )
          e.result = result
          reject(e)
          return
        }
        resolve(result)
      })
    })
  }

  return attempt(maxAttempts - 1, 0)
}
