import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  isProtectedExecutionEnvKey,
  sanitizeChildEnv,
} from '../utils/sensitiveEnv.js'
import {
  infrastructureFailureFields,
  processExecutionBoundaryFailure,
} from '../utils/processExecutionFailure.js'
import {
  buildCodeExecutionEnv,
  codeExecutionFailureHint,
  inferCodeExecutionOutputPaths,
} from '../utils/codeExecutionRuntime.js'
import { runProcessWithGroup } from '../utils/processGroup.js'
import { bashLimiter } from '../utils/rateLimiter.js'
import { writeToolAudit } from '../utils/audit.js'
import { checkBashCommandDanger } from '../utils/bashGuard.js'
import { checkShellNetworkPolicy } from '../utils/shellPolicy.js'
import { runShellSessionCommand } from '../services/shellSessionStore.js'
import {
  SHELL_DEFAULT_TIMEOUT_MS,
  SHELL_MAX_ENV_KEYS,
  SHELL_MAX_OUTPUT,
  SHELL_MAX_TIMEOUT_MS,
  assertToolPermitted,
  badReq,
  effectivePermissionToolName,
  resolveShellCwdForCommand,
} from './fsShellSupport.js'
import {
  assertShellCommandPathsAuthorized,
  prepareExpectedOutputs,
  verifyExpectedOutputs,
} from './fsShellOutputVerification.js'

function createShellOutputLogPath() {
  const dataRoot = path.resolve(process.env.APP_DATA_DIR || path.join(process.cwd(), 'server-data'))
  return path.join(
    dataRoot,
    'tool-logs',
    `command-${Date.now()}-${randomBytes(8).toString('hex')}.log`,
  )
}

function normalizeShellEnvKeys(value) {
  if (value == null) return []
  if (!Array.isArray(value)) {
    const error = badReq('env_keys 必须是环境变量名称数组')
    error.code = 'SHELL_ENV_KEYS_INVALID'
    throw error
  }
  if (value.length > SHELL_MAX_ENV_KEYS) {
    const error = badReq(`env_keys 最多允许 ${SHELL_MAX_ENV_KEYS} 项`, 413)
    error.code = 'SHELL_ENV_KEYS_LIMIT'
    throw error
  }
  const keys = []
  for (const rawKey of value) {
    const key = typeof rawKey === 'string' ? rawKey.trim() : ''
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) {
      const error = badReq(`无效的环境变量名称: ${String(rawKey ?? '')}`)
      error.code = 'SHELL_ENV_KEY_INVALID'
      throw error
    }
    if (isProtectedExecutionEnvKey(key)) {
      const error = badReq(`环境变量 ${key} 属于 Gugo 服务凭据或运行时注入变量，禁止注入工作区命令`, 403)
      error.code = 'SHELL_ENV_KEY_PROTECTED'
      throw error
    }
    if (process.env[key] == null) {
      const error = badReq(`宿主环境变量不存在: ${key}`)
      error.code = 'SHELL_ENV_KEY_NOT_FOUND'
      throw error
    }
    if (!keys.includes(key)) keys.push(key)
  }
  return keys
}

function requestedEnvValues(keys) {
  return [...new Set(keys
    .map((key) => String(process.env[key] || ''))
    .filter(Boolean))]
}

function normalizeShellSession(value) {
  const session = value == null || value === '' ? 'new' : String(value).trim().toLowerCase()
  if (session === 'new' || session === 'reuse') return session
  const error = badReq('session 必须是 new 或 reuse')
  error.code = 'SHELL_SESSION_INVALID'
  throw error
}

function displayShellCwd(resolvedCwd, currentCwd) {
  if (resolvedCwd.source !== 'workspace') return currentCwd
  return path.relative(resolvedCwd.rootPath, currentCwd).split(path.sep).join('/')
}

function redactSensitiveValues(value, secrets) {
  let output = String(value ?? '')
  for (const secret of secrets) output = output.split(secret).join('[REDACTED]')
  return output
}

function redactProcessOutput(result, secrets) {
  if (!secrets.length) return result
  return {
    ...result,
    stdout: redactSensitiveValues(result?.stdout, secrets),
    stderr: redactSensitiveValues(result?.stderr, secrets),
    ...(result?.error ? { error: redactSensitiveValues(result.error, secrets) } : {}),
    sensitiveOutputRedacted: true,
  }
}

function auditExecution(userId, args, status, durationMs) {
  if (!userId) return
  writeToolAudit({
    userId,
    origin: 'bash',
    toolName: 'bash_exec',
    args,
    status,
    ...(durationMs == null ? {} : { durationMs }),
  })
}

export async function bashExecTool({
  command,
  cwd: rawCwd,
  session,
  timeout_ms,
  expected_outputs,
  env_keys,
  userId = null,
  signal = null,
  onOutput = null,
}, {
  permissionToolName = 'bash_exec', runProcessWithGroupFn = runProcessWithGroup,
} = {}) {
  assertToolPermitted(userId, effectivePermissionToolName(permissionToolName, 'bash_exec'))
  if (typeof command !== 'string' || !command.trim()) throw badReq('command 必填')
  if (command.length > 10_000) throw badReq('command 过长', 413)
  const sessionMode = normalizeShellSession(session)
  const inheritedEnvKeys = normalizeShellEnvKeys(env_keys)
  const sensitiveEnvValues = requestedEnvValues(inheritedEnvKeys)

  const danger = checkBashCommandDanger(command)
  if (danger) {
    auditExecution(userId, { command }, 'denied')
    throw badReq(`命令被安全策略拦截:${danger.reason}`, 403)
  }
  const networkDenial = checkShellNetworkPolicy(command)
  if (networkDenial) {
    auditExecution(userId, { command }, 'denied')
    throw badReq(`命令被网络策略拦截:${networkDenial.reason}`, 403)
  }
  if (userId && !bashLimiter.tryConsume(userId, 'bash_exec')) {
    auditExecution(userId, { command }, 'denied')
    throw badReq('bash_exec 限流:超过 30 次/分钟,请稍后重试', 429)
  }

  const resolvedCwd = resolveShellCwdForCommand(rawCwd, { command, userId })
  const cwd = resolvedCwd.fullPath
  let displayCwd = resolvedCwd.displayPath
  if (!fs.statSync(cwd).isDirectory()) throw badReq('cwd 不是目录')
  let expectedTargets = []
  let inferredTargets = []

  const prepareExecution = async (effectiveCwd) => {
    if (!fs.statSync(effectiveCwd).isDirectory()) throw badReq('持久 Shell 当前 cwd 不是目录')
    expectedTargets = await prepareExpectedOutputs(expected_outputs, { cwd: effectiveCwd, userId })
    inferredTargets = expectedTargets.length === 0
      ? await prepareExpectedOutputs(inferCodeExecutionOutputPaths(command), { cwd: effectiveCwd, userId })
      : []
    assertShellCommandPathsAuthorized(command, {
      userId,
      expectedTargets: [...expectedTargets, ...inferredTargets],
    })
  }

  const timeout = Math.min(
    Math.max(Number(timeout_ms) || SHELL_DEFAULT_TIMEOUT_MS, 1000),
    SHELL_MAX_TIMEOUT_MS,
  )
  const isWin = process.platform === 'win32'
  const startedAt = Date.now()
  const outputLogPath = sensitiveEnvValues.length > 0 ? null : createShellOutputLogPath()
  let rawResult
  if (sessionMode === 'reuse') {
    rawResult = await runShellSessionCommand({
      userId,
      rootPath: resolvedCwd.rootPath || cwd,
      cwd,
      command,
      env: buildCodeExecutionEnv(sanitizeChildEnv()),
      timeout,
      maxBuffer: SHELL_MAX_OUTPUT,
      signal,
      fullOutputPath: outputLogPath,
      onOutput,
      beforeExecute: async ({ cwd: effectiveCwd }) => {
        await prepareExecution(effectiveCwd)
        return {
          ephemeralEnv: Object.fromEntries(inheritedEnvKeys.map((key) => [key, process.env[key]])),
        }
      },
    })
    if (rawResult.currentCwd) displayCwd = displayShellCwd(resolvedCwd, rawResult.currentCwd)
  } else {
    await prepareExecution(cwd)
    const shellPath = isWin ? (process.env.COMSPEC || 'cmd.exe') : '/bin/sh'
    const shellArgs = isWin ? ['/d', '/s', '/c', command] : ['-c', command]
    rawResult = await runProcessWithGroupFn({
      shellPath,
      shellArgs,
      cwd,
      env: buildCodeExecutionEnv(sanitizeChildEnv({}, { inheritKeys: inheritedEnvKeys })),
      inheritEnvKeys: inheritedEnvKeys,
      timeout,
      maxBuffer: SHELL_MAX_OUTPUT,
      windowsHide: true,
      windowsVerbatimArguments: isWin,
      signal,
      overflowMode: 'tail',
      fullOutputPath: outputLogPath,
      onOutput,
    })
  }
  const result = redactProcessOutput(rawResult, sensitiveEnvValues)
  const durationMs = Date.now() - startedAt
  const auditArgs = {
    command,
    cwd: displayCwd,
    ...(sessionMode === 'reuse' ? { session: 'reuse' } : {}),
    ...(inheritedEnvKeys.length > 0 ? { env_keys: inheritedEnvKeys } : {}),
    ...(expectedTargets.length > 0
      ? { expected_outputs: expectedTargets.map((target) => target.path) }
      : {}),
  }
  const outputVerification = expectedTargets.length > 0
    ? await verifyExpectedOutputs(expectedTargets)
    : null
  const inferredVerification = inferredTargets.length > 0
    ? await verifyExpectedOutputs(inferredTargets)
    : null
  const inferredChanges = inferredVerification?.changedPaths?.length > 0
    ? {
        verifiedOutputs: inferredVerification.verifiedOutputs,
        changedPaths: inferredVerification.changedPaths,
      }
    : null
  const verificationFields = outputVerification || inferredChanges || {}
  const failureHint = codeExecutionFailureHint(command, {
    platform: process.platform,
    stderr: result.stderr,
  })
  const executionMetadata = {
    durationMs,
    ...(sessionMode === 'reuse' ? {
      session: 'reuse',
      ...(result.sessionRecovered ? { sessionRecovered: true } : {}),
    } : {}),
    ...(result.truncated ? {
      truncated: true,
      totalOutputBytes: result.totalOutputBytes,
      ...(result.fullOutputPath ? { fullOutputPath: result.fullOutputPath } : {}),
      outputNotice: result.fullOutputPath
        ? '输出过长，已保留尾部；完整日志已写入 fullOutputPath。'
        : sensitiveEnvValues.length > 0
          ? '输出过长，已保留并脱敏尾部；为避免凭据写入磁盘，完整日志未落盘。'
          : '输出过长，已保留尾部；完整日志写入失败。',
    } : {}),
    ...(result.sensitiveOutputRedacted ? { sensitiveOutputRedacted: true } : {}),
    ...(result.outputLogError ? { outputLogError: result.outputLogError } : {}),
  }

  const boundaryFailure = processExecutionBoundaryFailure(
    result, { cwd: displayCwd, executionMetadata, verificationFields },
  )
  if (boundaryFailure) {
    auditExecution(userId, auditArgs, 'error', durationMs)
    return boundaryFailure
  }
  if (result.sessionBoundaryViolation) {
    auditExecution(userId, auditArgs, 'error', durationMs)
    return {
      ok: false,
      ...infrastructureFailureFields('SHELL_SESSION_BOUNDARY_VIOLATION'),
      error: result.error || '持久 Shell 当前目录越出授权根，会话已重置',
      stdout: result.stdout,
      stderr: result.stderr,
      cwd: displayCwd,
      ...executionMetadata,
      ...verificationFields,
    }
  }
  if (result.aborted) {
    auditExecution(userId, auditArgs, 'cancelled', durationMs)
    return {
      ok: false,
      cancelled: true,
      error: sessionMode === 'reuse' ? '命令已取消，持久 Shell 可继续使用' : '命令已取消，进程组已清理',
      stdout: result.stdout,
      stderr: result.stderr,
      cwd: displayCwd,
      ...executionMetadata,
      ...(failureHint ? { hint: failureHint } : {}),
      ...verificationFields,
    }
  }
  if (result.timedOut) {
    auditExecution(userId, auditArgs, 'timeout', durationMs)
    return {
      ok: false,
      timedOut: true,
      error: sessionMode === 'reuse'
        ? `命令超时(${timeout}ms)，当前命令已中断，持久 Shell 可继续使用`
        : `命令超时(${timeout}ms),进程组已被清理`,
      stdout: result.stdout,
      stderr: result.stderr,
      cwd: displayCwd,
      ...executionMetadata,
      ...(failureHint ? { hint: failureHint } : {}),
      ...verificationFields,
    }
  }
  if (result.sessionCrashed) {
    auditExecution(userId, auditArgs, 'error', durationMs)
    return {
      ok: false,
      ...infrastructureFailureFields('SHELL_SESSION_CRASHED'),
      exitCode: result.code,
      signal: result.signal,
      error: result.error || '持久 Shell 已退出；下次调用将自动重建',
      stdout: result.stdout,
      stderr: result.stderr,
      cwd: displayCwd,
      ...executionMetadata,
      ...verificationFields,
    }
  }
  if (result.code !== 0) {
    auditExecution(userId, auditArgs, 'error', durationMs)
    return {
      ok: false,
      exitCode: result.code,
      signal: result.signal,
      error: `命令退出码 ${result.code}${result.signal ? ` (signal=${result.signal})` : ''}`,
      stdout: result.stdout,
      stderr: result.stderr,
      cwd: displayCwd,
      ...executionMetadata,
      ...verificationFields,
    }
  }
  if (outputVerification?.unverifiedOutputs.length > 0) {
    auditExecution(userId, auditArgs, 'error', durationMs)
    const failures = outputVerification.unverifiedOutputs
      .map((output) => `${output.path} (${output.status})`)
      .join('、')
    return {
      ok: false,
      exitCode: 0,
      code: 'EXPECTED_OUTPUT_VERIFICATION_FAILED',
      verificationFailed: true,
      retryable: true,
      error: `命令退出成功，但 expected_outputs 未创建或未发生变化：${failures}`,
      stdout: result.stdout,
      stderr: result.stderr,
      cwd: displayCwd,
      ...executionMetadata,
      ...verificationFields,
    }
  }
  auditExecution(userId, auditArgs, 'ok', durationMs)
  return {
    ok: true,
    exitCode: 0,
    stdout: result.stdout,
    stderr: result.stderr,
    cwd: displayCwd,
    ...executionMetadata,
    ...verificationFields,
  }
}
