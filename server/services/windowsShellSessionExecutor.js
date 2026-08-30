import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { runProcessWithGroup } from '../utils/processGroup.js'
import { commandToken } from './shellSessionRuntime.js'
import {
  buildWindowsTrustedInvocation,
  buildWindowsUserCommandFile,
  canonicalizeWindowsSessionCwd,
  filterWindowsPersistentEnvironment,
  mergeWindowsEnvironment,
  normalizeWindowsEphemeralEnvironment,
  parseWindowsControlFrame,
  restoreWindowsEphemeralEnvironment,
} from './windowsShellSessionProtocol.js'

const TEMP_COMMAND_DIRECTORY_PREFIX = 'gugo-shell-command-'
const TEMP_COMMAND_CLEANUP_RETRY_DELAYS_MS = [250, 1_000, 5_000]
const pendingTempCommandCleanups = new Set()

function pathIdentity(value) {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function isOwnedTempCommandDirectory(directory) {
  const resolved = path.resolve(directory)
  return pathIdentity(path.dirname(resolved)) === pathIdentity(os.tmpdir())
    && path.basename(resolved).startsWith(TEMP_COMMAND_DIRECTORY_PREFIX)
}

async function removeTempCommandDirectory(directory) {
  if (!isOwnedTempCommandDirectory(directory)) return false
  try {
    await fs.promises.rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 50,
    })
    pendingTempCommandCleanups.delete(directory)
    return true
  } catch {
    return false
  }
}

function scheduleTempCommandDirectoryCleanup(directory) {
  if (!isOwnedTempCommandDirectory(directory) || pendingTempCommandCleanups.has(directory)) return
  pendingTempCommandCleanups.add(directory)
  let retryIndex = 0
  const retry = async () => {
    if (await removeTempCommandDirectory(directory)) return
    if (retryIndex >= TEMP_COMMAND_CLEANUP_RETRY_DELAYS_MS.length) {
      pendingTempCommandCleanups.delete(directory)
      return
    }
    const timer = setTimeout(retry, TEMP_COMMAND_CLEANUP_RETRY_DELAYS_MS[retryIndex])
    retryIndex += 1
    timer.unref?.()
  }
  void retry()
}

function sessionClosedError() {
  const error = new Error('持久 Shell 会话已关闭')
  error.code = 'SHELL_SESSION_CLOSED'
  return error
}

function assertSessionOpen(record) {
  if (record.closed) throw sessionClosedError()
}

function abortedBeforeExecutionResult(record) {
  return {
    stdout: '',
    stderr: '',
    code: null,
    signal: null,
    timedOut: false,
    killed: false,
    truncated: false,
    aborted: true,
    totalOutputBytes: 0,
    currentCwd: record.currentCwd,
    sessionRecovered: false,
  }
}

function isSessionExitCommand(command) {
  return /^\s*exit(?:\s+\/b)?(?:\s+-?\d+)?\s*$/iu.test(String(command || ''))
}

function publicProcessResult(processResult) {
  const result = { ...(processResult || {}) }
  delete result.control
  delete result.controlError
  delete result.controlTruncated
  delete result.controlTotalBytes
  return result
}

function failureResult(record, current, processResult, {
  boundaryViolation = false,
  error = null,
} = {}) {
  const result = publicProcessResult(processResult)
  record.recoveryPending = true
  return {
    ...result,
    code: null,
    currentCwd: record.currentCwd,
    sessionRecovered: false,
    ...(boundaryViolation
      ? {
          sessionBoundaryViolation: true,
          error: error || '持久 Shell 当前目录越出授权根，已恢复上次已提交状态',
        }
      : (!result.timedOut && !result.aborted
          ? {
              sessionCrashed: true,
              error: error || '持久 Shell 状态回执无效；已恢复上次已提交状态',
            }
          : {})),
    ...(current.context === undefined ? {} : { context: current.context }),
  }
}

async function writeRequestFile(commandFile, command) {
  await fs.promises.writeFile(commandFile, buildWindowsUserCommandFile(command), 'utf8')
}

/**
 * Execute one Windows logical-session request in an isolated process. Session
 * cwd/environment are committed only after the authenticated control frame is
 * fully validated; every failure path retains the last committed snapshot.
 */
export async function executeWindowsShellRequest(record, request, prepared, {
  runProcessWithGroupFn = runProcessWithGroup,
} = {}) {
  const ephemeralEnv = normalizeWindowsEphemeralEnvironment(prepared?.ephemeralEnv || {})
  const snapshotEnv = record.persistentEnv
  const executionEnv = mergeWindowsEnvironment(snapshotEnv, ephemeralEnv)
  const token = commandToken()
  const tempDirectory = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), TEMP_COMMAND_DIRECTORY_PREFIX),
  )
  const commandFile = path.join(tempDirectory, `${token}.command.cmd`)
  const internalAbortController = new AbortController()
  let externalAbortListener = null
  let current = null

  try {
    await writeRequestFile(commandFile, request.command)
    assertSessionOpen(record)
    if (request.signal?.aborted) return abortedBeforeExecutionResult(record)
    if (request.signal) {
      externalAbortListener = () => internalAbortController.abort()
      request.signal.addEventListener('abort', externalAbortListener, { once: true })
      if (request.signal.aborted) internalAbortController.abort()
    }

    current = {
      ...request,
      context: prepared?.context,
      internalAbortController,
    }
    record.current = current
    const processResult = await runProcessWithGroupFn({
      ...buildWindowsTrustedInvocation({ commandFile, token }),
      cwd: record.currentCwd,
      env: executionEnv,
      inheritEnvKeys: Object.keys(executionEnv),
      timeout: request.timeout,
      maxBuffer: request.maxBuffer,
      signal: internalAbortController.signal,
      overflowMode: 'tail',
      fullOutputPath: request.fullOutputPath,
      onOutput: request.onOutput,
      onSpawn: (child) => {
        current.child = child
        record.child = child
        record.spawnCount += 1
      },
      cleanupWindowsTreeOnExit: true,
      controlPipe: true,
    })

    assertSessionOpen(record)
    if (processResult.timedOut || processResult.aborted || processResult.processTreeCleanupFailed) {
      return failureResult(record, current, processResult)
    }
    if (processResult.processIsolationFailed) {
      return failureResult(record, current, processResult, {
        error: `持久 Shell 进程隔离建立失败：${processResult.processIsolationError || '未知错误'}`,
      })
    }
    if (processResult.processStartFailed) {
      return failureResult(record, current, processResult, {
        error: `持久 Shell 启动失败：${processResult.processStartError || '未知错误'}`,
      })
    }
    if (isSessionExitCommand(request.command)) {
      return failureResult(record, current, processResult, {
        error: '持久 Shell 已按命令退出；已恢复上次已提交状态',
      })
    }
    if (processResult.controlError || processResult.controlTruncated) {
      return failureResult(record, current, processResult, {
        error: processResult.controlError
          ? `持久 Shell 控制管道失败：${processResult.controlError}`
          : '持久 Shell 控制帧超过安全上限或被截断',
      })
    }

    let payload
    try {
      payload = parseWindowsControlFrame(processResult.control, {
        expectedToken: token,
        expectedExitCode: processResult.code,
      })
    } catch (error) {
      return failureResult(record, current, processResult, {
        error: error?.message || String(error),
      })
    }

    let nextCwd
    try {
      nextCwd = canonicalizeWindowsSessionCwd(record.rootPath, payload.cwd)
    } catch (error) {
      return failureResult(record, current, processResult, {
        boundaryViolation: true,
        error: error?.message || String(error),
      })
    }
    const nextEnv = filterWindowsPersistentEnvironment(
      restoreWindowsEphemeralEnvironment(payload.env, snapshotEnv, ephemeralEnv),
    )
    const sessionRecovered = Boolean(record.recoveryPending)
    record.currentCwd = nextCwd
    record.persistentEnv = nextEnv
    record.recoveryPending = false
    return {
      ...publicProcessResult(processResult),
      code: payload.exitCode,
      currentCwd: nextCwd,
      sessionRecovered,
      ...(current.context === undefined ? {} : { context: current.context }),
    }
  } finally {
    if (externalAbortListener) request.signal?.removeEventListener('abort', externalAbortListener)
    if (record.child === current?.child) record.child = null
    if (record.current === current) record.current = null
    if (!(await removeTempCommandDirectory(tempDirectory))) {
      scheduleTempCommandDirectoryCleanup(tempDirectory)
    }
  }
}
