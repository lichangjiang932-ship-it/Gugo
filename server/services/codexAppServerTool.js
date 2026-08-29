import { isToolPermittedForUser } from '../db.js'
import { writeToolAudit } from '../utils/audit.js'
import { codexAppServerLimiter } from '../utils/rateLimiter.js'
import {
  CODEX_APP_SERVER_REASON,
  isCodexAppServerModelCatalogAvailable,
  listCodexAppServerModels,
} from './codexAppServerRuntime.js'

export const CODEX_MODELS_TOOL_NAME = 'codex_models'

export const CODEX_APP_SERVER_TOOL_SPECS = Object.freeze([{
  type: 'function',
  function: Object.freeze({
    name: CODEX_MODELS_TOOL_NAME,
    description:
      'List a bounded, sanitized model catalog from the already-running opt-in OpenAI Codex app-server bridge. '
      + 'Use only when the user asks about Codex models or verifies this bridge. The request may cause the external '
      + 'Codex CLI to access the network, so every call requires explicit user approval.',
    parameters: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        cursor: Object.freeze({
          type: 'string',
          maxLength: 2048,
          description: 'Opaque next_cursor returned by an earlier codex_models call.',
        }),
        limit: Object.freeze({ type: 'integer', minimum: 1, maximum: 50, default: 20 }),
        include_hidden: Object.freeze({ type: 'boolean', default: false }),
      }),
      additionalProperties: false,
    }),
  }),
}])

function publicFailure(code, { retryable = false, cancelled = false } = {}) {
  return {
    ok: false,
    code,
    error: code,
    retryable,
    ...(cancelled ? { cancelled: true } : {}),
  }
}

function auditCall({ userId, args, result, status, durationMs, enabled }) {
  if (!enabled || !userId) return
  writeToolAudit({
    userId,
    origin: 'codex_app_server',
    toolName: CODEX_MODELS_TOOL_NAME,
    args: {
      limit: args?.limit,
      includeHidden: args?.include_hidden === true,
      hasCursor: typeof args?.cursor === 'string' && args.cursor.length > 0,
    },
    result: {
      ok: result?.ok === true,
      code: result?.code,
      modelCount: Array.isArray(result?.models) ? result.models.length : undefined,
      hasNextCursor: typeof result?.next_cursor === 'string',
    },
    status,
    durationMs,
  })
}

function gateFailure({ userId, name }) {
  if (name !== CODEX_MODELS_TOOL_NAME) return publicFailure('UNKNOWN_CODEX_APP_SERVER_TOOL')
  if (typeof userId !== 'string' || !userId.trim()) {
    return publicFailure('CODEX_APP_SERVER_USER_REQUIRED')
  }
  if (!isToolPermittedForUser(userId, CODEX_MODELS_TOOL_NAME)) {
    return publicFailure('TOOL_DISABLED')
  }
  if (!isCodexAppServerModelCatalogAvailable()) {
    return publicFailure('CODEX_APP_SERVER_UNAVAILABLE', { retryable: true })
  }
  if (!codexAppServerLimiter.tryConsume(userId, CODEX_MODELS_TOOL_NAME)) {
    return publicFailure('CODEX_APP_SERVER_RATE_LIMITED', { retryable: true })
  }
  return null
}

function requestFailure(error, signal) {
  if (signal?.aborted || error?.code === CODEX_APP_SERVER_REASON.START_ABORTED) {
    return publicFailure('CODEX_APP_SERVER_REQUEST_CANCELLED', { cancelled: true })
  }
  if (error?.code === CODEX_APP_SERVER_REASON.REQUEST_TIMEOUT) {
    return publicFailure('CODEX_APP_SERVER_REQUEST_TIMEOUT', { retryable: true })
  }
  if (error?.code === CODEX_APP_SERVER_REASON.PROCESS_EXITED
    || error?.code === CODEX_APP_SERVER_REASON.NOT_STARTED) {
    return publicFailure('CODEX_APP_SERVER_UNAVAILABLE', { retryable: true })
  }
  if (error?.code === CODEX_APP_SERVER_REASON.REQUEST_REJECTED) {
    return publicFailure('CODEX_APP_SERVER_REQUEST_REJECTED')
  }
  if (error?.code === CODEX_APP_SERVER_REASON.PROTOCOL_INVALID) {
    return publicFailure('CODEX_APP_SERVER_RESPONSE_INVALID')
  }
  return publicFailure('CODEX_APP_SERVER_REQUEST_FAILED', { retryable: true })
}

export async function dispatchCodexAppServerTool(name, args = {}, {
  signal = null,
  userId = null,
  audit = true,
} = {}) {
  const startedAt = Date.now()
  const denied = gateFailure({ userId, name })
  if (denied) {
    auditCall({
      userId,
      args,
      result: denied,
      status: 'denied',
      durationMs: Date.now() - startedAt,
      enabled: audit,
    })
    return denied
  }

  let result
  try {
    const response = await listCodexAppServerModels({
      cursor: args?.cursor,
      limit: args?.limit,
      includeHidden: args?.include_hidden === true,
      signal,
    })
    result = {
      ok: true,
      models: response.models,
      next_cursor: response.nextCursor,
    }
  } catch (error) {
    result = requestFailure(error, signal)
  }
  auditCall({
    userId,
    args,
    result,
    status: result.ok ? 'ok' : result.cancelled ? 'cancelled' : 'error',
    durationMs: Date.now() - startedAt,
    enabled: audit,
  })
  return result
}
