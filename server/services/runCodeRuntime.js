import { createHash } from 'node:crypto'
import { isToolPermittedForUser } from '../db.js'
import { writeToolAudit } from '../utils/audit.js'
import { codeModeLimiter } from '../utils/rateLimiter.js'
import { getRuntimeEnv } from '../utils/runtimeEnv.js'
import { runCodeModeWorker } from './codeModeWorkerRuntime.js'
import { isRunCodeExecutionEnabled } from './localFileAccessService.js'

export { isRunCodeExecutionEnabled } from './localFileAccessService.js'

const RUN_CODE_NAME = 'run_code'

export const RUN_CODE_TOOL_SPECS = Object.freeze([
  {
    type: 'function',
    function: Object.freeze({
      name: RUN_CODE_NAME,
      description:
        'Run pure JavaScript computation in a fresh, resource-bounded worker. '
        + 'No file, shell, network, environment, module, or host-tool bindings are exposed. '
        + 'This is VM containment, not an operating-system security boundary, so every call requires approval. '
        + 'Use console.log for bounded diagnostics and return a JSON-compatible value.',
      parameters: Object.freeze({
        type: 'object',
        properties: Object.freeze({
          code: Object.freeze({
            type: 'string',
            minLength: 1,
            maxLength: 65536,
            description: 'JavaScript function body. Top-level await and return are supported.',
          }),
          description: Object.freeze({
            type: 'string',
            maxLength: 1024,
            description: 'Short human-readable explanation of the computation.',
          }),
        }),
        required: Object.freeze(['code']),
        additionalProperties: false,
      }),
    }),
  },
])

function publicFailure(result) {
  const kind = String(result?.error?.kind || 'execution-failed')
  const message = String(result?.error?.message || 'Code execution failed')
  return {
    ok: false,
    code: `code_mode_${kind.replace(/[^a-z0-9_-]/giu, '_')}`,
    error: message,
    logs: Array.isArray(result?.logs) ? [...result.logs] : [],
    retryable: kind === 'worker-start' || kind === 'worker-exit',
  }
}

function runCodeError(message, statusCode, code) {
  const error = new Error(message)
  error.statusCode = statusCode
  error.code = code
  error.retryable = false
  error.denied = statusCode === 403 || statusCode === 429
  error.policyDenied = error.denied
  return error
}

function runCodeAuditArgs(args = {}) {
  const code = typeof args?.code === 'string' ? args.code : ''
  return {
    description: typeof args?.description === 'string' ? args.description.slice(0, 1024) : '',
    codeBytes: Buffer.byteLength(code, 'utf8'),
    codeSha256: createHash('sha256').update(code).digest('hex'),
  }
}

function runCodeAuditStatus(result) {
  if (result?.ok === true) return 'ok'
  if (result?.cancelled === true || result?.code === 'code_mode_cancelled') return 'cancelled'
  if (result?.timedOut === true || /timeout/iu.test(String(result?.code || ''))) return 'timeout'
  return 'error'
}

function assertToolPermitted(userId, toolName) {
  if (userId && !isToolPermittedForUser(userId, toolName)) {
    throw runCodeError(`工具 ${toolName} 已被该用户在权限中心关闭`, 403, 'TOOL_DISABLED')
  }
}

function assertRunCodeExecutionPermitted({ userId, env }) {
  if (typeof userId !== 'string' || !userId.trim()) {
    throw runCodeError('本地 Code Mode 执行必须绑定已登录用户', 403, 'USER_REQUIRED')
  }
  assertToolPermitted(userId, RUN_CODE_NAME)
  if (!isRunCodeExecutionEnabled(env)) {
    throw runCodeError(
      'Code Mode 未启用；请仅在可信部署中开启 WORKSPACE_SHELL_ENABLED=1 或 LOCAL_CODE_EXECUTION_ENABLED=1',
      403,
      'CODE_MODE_DISABLED',
    )
  }
  if (!codeModeLimiter.tryConsume(userId, RUN_CODE_NAME)) {
    throw runCodeError('run_code 限流：超过 30 次/分钟，请稍后重试', 429, 'RUN_CODE_RATE_LIMITED')
  }
}

function auditRunCode({ userId, args, result, status, durationMs, enabled }) {
  if (!enabled || !userId) return
  writeToolAudit({
    userId,
    origin: 'code_mode',
    toolName: RUN_CODE_NAME,
    args: runCodeAuditArgs(args),
    result,
    status,
    durationMs,
  })
}

export async function dispatchRunCodeTool(name, args = {}, {
  signal = null,
  userId = null,
  env = getRuntimeEnv(),
  audit = true,
} = {}) {
  const startedAt = Date.now()
  if (name !== RUN_CODE_NAME) {
    const result = {
      ok: false,
      code: 'unknown_code_mode_tool',
      error: `Unknown Code Mode tool: ${name}`,
      retryable: false,
    }
    auditRunCode({
      userId,
      args,
      result,
      status: 'denied',
      durationMs: Date.now() - startedAt,
      enabled: audit,
    })
    return result
  }

  try {
    assertRunCodeExecutionPermitted({ userId, env })
  } catch (error) {
    auditRunCode({
      userId,
      args,
      result: { ok: false, code: error.code, error: error.message },
      status: 'denied',
      durationMs: Date.now() - startedAt,
      enabled: audit,
    })
    throw error
  }

  try {
    const workerResult = await runCodeModeWorker({
      code: args?.code,
      signal,
    })
    const result = workerResult.ok
      ? {
          ok: true,
          logs: [...workerResult.logs],
          ...(Object.hasOwn(workerResult, 'value') ? { value: workerResult.value } : {}),
        }
      : publicFailure(workerResult)
    auditRunCode({
      userId,
      args,
      result,
      status: runCodeAuditStatus(result),
      durationMs: Date.now() - startedAt,
      enabled: audit,
    })
    return result
  } catch (error) {
    auditRunCode({
      userId,
      args,
      result: { ok: false, code: error?.code || error?.name || 'code_mode_tool_failed' },
      status: signal?.aborted || error?.name === 'AbortError' ? 'cancelled' : 'error',
      durationMs: Date.now() - startedAt,
      enabled: audit,
    })
    throw error
  }
}
