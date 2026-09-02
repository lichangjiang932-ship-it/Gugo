import { isToolPermittedForUser } from '../db.js'

export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 2 * 60 * 1000
export const MAX_DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000
export const DEFAULT_DOWNLOAD_MAX_BYTES = 512 * 1024 * 1024
export const HARD_DOWNLOAD_MAX_BYTES = 4 * 1024 * 1024 * 1024
export const DEFAULT_TEST_TIMEOUT_MS = 10 * 60 * 1000
export const MAX_TEST_TIMEOUT_MS = 30 * 60 * 1000
export const DEFAULT_DOCKER_TIMEOUT_MS = 5 * 60 * 1000
export const MAX_DOCKER_TIMEOUT_MS = 30 * 60 * 1000

export function toolError(message, statusCode = 400, code = 'CODING_TOOL_FAILED', hint = null) {
  const error = new Error(message)
  error.statusCode = statusCode
  error.code = code
  if (hint) error.hint = hint
  return error
}

export function assertToolPermitted(userId, toolName) {
  if (userId && !isToolPermittedForUser(userId, toolName)) {
    throw toolError(`工具 ${toolName} 已被该用户在权限中心关闭`, 403, 'TOOL_DISABLED')
  }
}

export function clampInteger(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.floor(parsed)))
}

export function redactForwardedEnvValues(result, envKeys, sourceEnv = process.env) {
  const secrets = [...new Set((Array.isArray(envKeys) ? envKeys : [])
    .map((key) => sourceEnv[String(key || '')])
    .filter((value) => typeof value === 'string' && value.length > 0))]
    .sort((left, right) => right.length - left.length)
  if (secrets.length === 0) return result

  const seen = new WeakMap()
  const redact = (value) => {
    if (typeof value === 'string') {
      return secrets.reduce(
        (text, secret) => text.split(secret).join('[REDACTED_ENV]'),
        value,
      )
    }
    if (!value || typeof value !== 'object' || Buffer.isBuffer(value)) return value
    if (seen.has(value)) return seen.get(value)
    const copy = Array.isArray(value) ? [] : {}
    seen.set(value, copy)
    for (const [key, nested] of Object.entries(value)) copy[key] = redact(nested)
    return copy
  }
  return redact(result)
}

export function quoteCommandArg(value, platform = process.platform) {
  const text = String(value ?? '')
  if (platform === 'win32') return `"${text.replace(/"/g, '""')}"`
  return `'${text.replace(/'/g, `'"'"'`)}'`
}
