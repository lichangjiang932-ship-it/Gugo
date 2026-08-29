import fs from 'node:fs'
import path from 'node:path'

import { createLspService } from './lspService.js'
import { isRuntimeInjectionEnvKey } from '../utils/sensitiveEnv.js'

const MAX_PROVIDERS = 8
const MAX_ALLOWLIST = 16
const MAX_ARGS = 32
const MAX_ENV_ENTRIES = 16
const MAX_EXTENSIONS = 32
const MAX_CONFIG_BYTES = 64 * 1024

export const LSP_RUNTIME_REASON = Object.freeze({
  NOT_STARTED: 'not_started',
  NOT_CONFIGURED: 'not_configured',
  INVALID_CONFIG: 'invalid_config',
  PROVIDER_INITIALIZATION_FAILED: 'provider_initialization_failed',
  CONFIGURED: 'configured',
  QUERY_FAILED: 'query_failed',
  CLOSED: 'closed',
})

export const LSP_RUNTIME_CODE = Object.freeze({
  CONFIG_INVALID: 'LSP_CONFIG_INVALID',
  COMMAND_NOT_ALLOWED: 'LSP_COMMAND_NOT_ALLOWED',
  PROVIDER_FACTORY_INVALID: 'LSP_PROVIDER_FACTORY_INVALID',
  PROVIDER_INIT_FAILED: 'LSP_PROVIDER_INIT_FAILED',
  CONFLICT: 'LSP_CONFLICT',
  INVALID_PROVIDER: 'LSP_INVALID_PROVIDER',
  PROCESS_FAILED: 'LSP_PROCESS_FAILED',
  PROCESS_EXITED: 'LSP_PROCESS_EXITED',
  TRANSPORT_FAILED: 'LSP_TRANSPORT_FAILED',
  TIMEOUT: 'LSP_TIMEOUT',
  SERVER_ERROR: 'LSP_SERVER_ERROR',
  RESPONSE_TOO_LARGE: 'LSP_RESPONSE_TOO_LARGE',
  MALFORMED_RESPONSE: 'LSP_MALFORMED_RESPONSE',
  PROVIDER_FAILED: 'LSP_PROVIDER_FAILED',
})

const CONFIG_FAILURE_CODES = new Set([
  LSP_RUNTIME_CODE.CONFIG_INVALID,
  LSP_RUNTIME_CODE.COMMAND_NOT_ALLOWED,
])
const INITIALIZATION_FAILURE_CODES = new Set([
  LSP_RUNTIME_CODE.PROVIDER_FACTORY_INVALID,
  LSP_RUNTIME_CODE.PROVIDER_INIT_FAILED,
  LSP_RUNTIME_CODE.CONFLICT,
  LSP_RUNTIME_CODE.INVALID_PROVIDER,
])
const QUERY_FAILURE_CODES = new Set([
  LSP_RUNTIME_CODE.PROCESS_FAILED,
  LSP_RUNTIME_CODE.PROCESS_EXITED,
  LSP_RUNTIME_CODE.TRANSPORT_FAILED,
  LSP_RUNTIME_CODE.TIMEOUT,
  LSP_RUNTIME_CODE.SERVER_ERROR,
  LSP_RUNTIME_CODE.RESPONSE_TOO_LARGE,
  LSP_RUNTIME_CODE.MALFORMED_RESPONSE,
  LSP_RUNTIME_CODE.PROVIDER_FAILED,
])

let activeService = null
let activeStatus = runtimeStatus({ reason: LSP_RUNTIME_REASON.NOT_STARTED })
let startPromise = null

function runtimeError(code, message, cause = undefined) {
  const result = new Error(message, cause === undefined ? undefined : { cause })
  result.code = code
  result.retryable = false
  return result
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function parseJsonArray(raw, label, { allowEmpty = true } = {}) {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (!text) return []
  if (Buffer.byteLength(text, 'utf8') > MAX_CONFIG_BYTES) {
    throw runtimeError('LSP_CONFIG_INVALID', `${label} exceeds its size limit`)
  }
  let value
  try { value = JSON.parse(text) } catch (cause) {
    throw runtimeError('LSP_CONFIG_INVALID', `${label} must be valid JSON`, cause)
  }
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw runtimeError('LSP_CONFIG_INVALID', `${label} must be a JSON array`)
  }
  return value
}

function canonicalFile(raw, label) {
  if (typeof raw !== 'string' || !raw.trim() || !path.isAbsolute(raw.trim()) || raw.includes('\0')) {
    throw runtimeError('LSP_CONFIG_INVALID', `${label} must be an absolute file path`)
  }
  let resolved
  try { resolved = fs.realpathSync.native(raw.trim()) } catch (cause) {
    throw runtimeError('LSP_CONFIG_INVALID', `${label} is unavailable`, cause)
  }
  let info
  try { info = fs.statSync(resolved) } catch (cause) {
    throw runtimeError('LSP_CONFIG_INVALID', `${label} cannot be inspected`, cause)
  }
  if (!info.isFile()) throw runtimeError('LSP_CONFIG_INVALID', `${label} must name a file`)
  return resolved
}

function pathIdentity(value) {
  return process.platform === 'win32' ? value.toLowerCase() : value
}

function normalizeAllowlist(raw) {
  const values = parseJsonArray(raw, 'LSP_STDIO_COMMAND_ALLOWLIST')
  if (values.length > MAX_ALLOWLIST) {
    throw runtimeError('LSP_CONFIG_INVALID', `LSP command allowlist cannot exceed ${MAX_ALLOWLIST} entries`)
  }
  const result = new Map()
  for (const value of values) {
    const command = canonicalFile(value, 'LSP allowlisted command')
    result.set(pathIdentity(command), command)
  }
  return result
}

function limitedString(value, label, maxLength = 512) {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength || value.includes('\0')) {
    throw runtimeError('LSP_CONFIG_INVALID', `${label} is invalid`)
  }
  return value.trim()
}

function normalizeArgs(value, id) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_ARGS) {
    throw runtimeError('LSP_CONFIG_INVALID', `LSP provider ${id} args are invalid`)
  }
  let total = 0
  return value.map((entry) => {
    if (typeof entry !== 'string' || entry.length > 2_048 || entry.includes('\0')) {
      throw runtimeError('LSP_CONFIG_INVALID', `LSP provider ${id} args are invalid`)
    }
    total += Buffer.byteLength(entry, 'utf8')
    if (total > 8_192) throw runtimeError('LSP_CONFIG_INVALID', `LSP provider ${id} args exceed their size limit`)
    return entry
  })
}

function normalizeEnv(value, id) {
  if (value === undefined) return {}
  if (!isRecord(value) || Object.keys(value).length > MAX_ENV_ENTRIES) {
    throw runtimeError('LSP_CONFIG_INVALID', `LSP provider ${id} env is invalid`)
  }
  const result = {}
  let total = 0
  for (const [key, entry] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(key)
      || isRuntimeInjectionEnvKey(key)
      || typeof entry !== 'string'
      || entry.length > 2_048
      || entry.includes('\0')) {
      throw runtimeError('LSP_CONFIG_INVALID', `LSP provider ${id} env is invalid`)
    }
    total += Buffer.byteLength(key, 'utf8') + Buffer.byteLength(entry, 'utf8')
    if (total > 8_192) throw runtimeError('LSP_CONFIG_INVALID', `LSP provider ${id} env exceeds its size limit`)
    result[key] = entry
  }
  return result
}

function normalizeExtensions(value, id) {
  if (!isRecord(value)) {
    throw runtimeError('LSP_CONFIG_INVALID', `LSP provider ${id} extensions must be an object`)
  }
  const entries = Object.entries(value)
  if (entries.length === 0 || entries.length > MAX_EXTENSIONS) {
    throw runtimeError('LSP_CONFIG_INVALID', `LSP provider ${id} extensions are invalid`)
  }
  const result = {}
  for (const [rawExtension, rawLanguage] of entries) {
    const extension = limitedString(rawExtension, `LSP provider ${id} extension`, 32).toLowerCase()
    const normalizedExtension = extension.startsWith('.') ? extension : `.${extension}`
    if (!/^\.[A-Za-z0-9][A-Za-z0-9._+-]{0,30}$/u.test(normalizedExtension)) {
      throw runtimeError('LSP_CONFIG_INVALID', `LSP provider ${id} extension is invalid`)
    }
    if (Object.hasOwn(result, normalizedExtension)) {
      throw runtimeError('LSP_CONFIG_INVALID', `LSP provider ${id} repeats extension ${normalizedExtension}`)
    }
    result[normalizedExtension] = limitedString(rawLanguage, `LSP provider ${id} language id`, 128)
  }
  return result
}

function normalizeCwd(value, id) {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !path.isAbsolute(value.trim()) || value.includes('\0')) {
    throw runtimeError('LSP_CONFIG_INVALID', `LSP provider ${id} cwd must be an absolute directory`)
  }
  let resolved
  try { resolved = fs.realpathSync.native(value.trim()) } catch (cause) {
    throw runtimeError('LSP_CONFIG_INVALID', `LSP provider ${id} cwd is unavailable`, cause)
  }
  if (!fs.statSync(resolved).isDirectory()) {
    throw runtimeError('LSP_CONFIG_INVALID', `LSP provider ${id} cwd must be a directory`)
  }
  return resolved
}

function normalizeProviders(raw, allowlist) {
  const values = parseJsonArray(raw, 'LSP_STDIO_PROVIDERS')
  if (values.length > MAX_PROVIDERS) {
    throw runtimeError('LSP_CONFIG_INVALID', `LSP provider count cannot exceed ${MAX_PROVIDERS}`)
  }
  const ids = new Set()
  return values.map((value, index) => {
    if (!isRecord(value)) throw runtimeError('LSP_CONFIG_INVALID', `LSP provider ${index} must be an object`)
    const id = limitedString(value.id, `LSP provider ${index} id`, 128)
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(id) || ids.has(id)) {
      throw runtimeError('LSP_CONFIG_INVALID', `LSP provider id is invalid or repeated: ${id}`)
    }
    ids.add(id)
    const requestedCommand = canonicalFile(value.command, `LSP provider ${id} command`)
    const command = allowlist.get(pathIdentity(requestedCommand))
    if (!command) throw runtimeError('LSP_COMMAND_NOT_ALLOWED', `LSP provider ${id} command is not allowlisted`)
    const timeoutMs = value.timeout_ms === undefined ? undefined : Number(value.timeout_ms)
    if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000)) {
      throw runtimeError('LSP_CONFIG_INVALID', `LSP provider ${id} timeout_ms is invalid`)
    }
    const cwd = normalizeCwd(value.cwd, id)
    return Object.freeze({
      id,
      command,
      args: Object.freeze(normalizeArgs(value.args, id)),
      env: Object.freeze(normalizeEnv(value.env, id)),
      extensionToLanguage: Object.freeze(normalizeExtensions(
        value.extensionToLanguage ?? value.extensions,
        id,
      )),
      ...(cwd ? { cwd } : {}),
      ...(timeoutMs ? { timeoutMs } : {}),
    })
  })
}

function stableFailureCode(cause, allowedCodes, fallback) {
  return allowedCodes.has(cause?.code) ? cause.code : fallback
}

function runtimeStatus({
  enabled = false,
  providerCount = 0,
  reason,
  code = null,
}) {
  return Object.freeze({ enabled, providerCount, reason, code })
}

async function startInternal({ env, createProvider }) {
  const rawProviders = typeof env?.LSP_STDIO_PROVIDERS === 'string'
    ? env.LSP_STDIO_PROVIDERS.trim()
    : ''
  if (!rawProviders) {
    activeStatus = runtimeStatus({ reason: LSP_RUNTIME_REASON.NOT_CONFIGURED })
    return activeStatus
  }

  let configs
  try {
    const allowlist = normalizeAllowlist(env?.LSP_STDIO_COMMAND_ALLOWLIST)
    configs = normalizeProviders(rawProviders, allowlist)
    if (configs.length === 0) {
      activeStatus = runtimeStatus({ reason: LSP_RUNTIME_REASON.NOT_CONFIGURED })
      return activeStatus
    }
  } catch (cause) {
    activeStatus = runtimeStatus({
      reason: LSP_RUNTIME_REASON.INVALID_CONFIG,
      code: stableFailureCode(cause, CONFIG_FAILURE_CODES, LSP_RUNTIME_CODE.CONFIG_INVALID),
    })
    return activeStatus
  }

  const service = createLspService()
  const providers = []
  try {
    const factory = createProvider || (await import('../adapters/lspStdioProvider.js')).createLspStdioProvider
    if (typeof factory !== 'function') throw runtimeError('LSP_PROVIDER_FACTORY_INVALID', 'LSP provider factory is unavailable')
    for (const config of configs) providers.push(await factory(config))
    for (const provider of providers) service.registerProvider(provider)
  } catch (cause) {
    await Promise.allSettled(providers.map((provider) => provider?.close?.()))
    await service.close()
    activeStatus = runtimeStatus({
      reason: LSP_RUNTIME_REASON.PROVIDER_INITIALIZATION_FAILED,
      code: stableFailureCode(
        cause,
        INITIALIZATION_FAILURE_CODES,
        LSP_RUNTIME_CODE.PROVIDER_INIT_FAILED,
      ),
    })
    return activeStatus
  }

  const configuredStatus = () => runtimeStatus({
    enabled: true,
    providerCount: providers.length,
    reason: LSP_RUNTIME_REASON.CONFIGURED,
  })
  let runtimeService
  runtimeService = Object.freeze({
    ...service,
    async query(input, signal = undefined) {
      try {
        const result = await service.query(input, signal)
        if (activeService === runtimeService) activeStatus = configuredStatus()
        return result
      } catch (cause) {
        if (activeService === runtimeService && QUERY_FAILURE_CODES.has(cause?.code)) {
          activeStatus = runtimeStatus({
            enabled: true,
            providerCount: providers.length,
            reason: LSP_RUNTIME_REASON.QUERY_FAILED,
            code: cause.code,
          })
        }
        throw cause
      }
    },
  })
  activeService = runtimeService
  activeStatus = configuredStatus()
  return activeStatus
}

export function getLspService() {
  return activeService
}

export function getLspRuntimeStatus() {
  return activeStatus
}

export function hasConfiguredLspProvider(filePath = undefined) {
  if (!activeService) return false
  return filePath === undefined ? true : activeService.hasProviderForFile(filePath)
}

export function startLspRuntime({
  env = process.env,
  createProvider = null,
} = {}) {
  if (activeService) return Promise.resolve(activeStatus)
  if (startPromise) return startPromise
  startPromise = startInternal({ env, createProvider })
    .finally(() => { startPromise = null })
  return startPromise
}

export async function closeLspRuntime() {
  if (startPromise) await startPromise.catch(() => {})
  const service = activeService
  activeService = null
  activeStatus = runtimeStatus({ reason: LSP_RUNTIME_REASON.CLOSED })
  if (service) await service.close()
}

export const _testing = Object.freeze({
  MAX_PROVIDERS,
  MAX_ALLOWLIST,
  normalizeAllowlist,
  normalizeProviders,
})
