import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { CliError, CliUsageError } from './errors.js'

const DEFAULT_API_TIMEOUT_MS = 10_000
const DEFAULT_SERVER_URL = 'http://127.0.0.1:5173'

export function parseCommandFlags(argv, { command, valueFlags = [] }) {
  const allowed = new Set(valueFlags)
  const out = Object.create(null)
  const specified = new Set()
  for (let i = 0; i < argv.length; i++) {
    const raw = String(argv[i])
    if (!raw.startsWith('--') || raw === '--') {
      throw new CliUsageError('CLI_ARGUMENT_UNEXPECTED', `unexpected argument for ${command}: ${raw}`)
    }
    const equalAt = raw.indexOf('=')
    const key = raw.slice(2, equalAt >= 0 ? equalAt : undefined)
    if (!allowed.has(key)) {
      throw new CliUsageError('CLI_OPTION_UNKNOWN', `unknown option for ${command}: --${key}`)
    }
    if (specified.has(key)) {
      throw new CliUsageError('CLI_OPTION_DUPLICATE', `--${key} may only be specified once`)
    }
    specified.add(key)
    const value = equalAt >= 0 ? raw.slice(equalAt + 1) : argv[++i]
    const normalizedValue = value === undefined ? '' : String(value).trim()
    if (!normalizedValue || String(value).startsWith('--')) {
      throw new CliUsageError('CLI_OPTION_VALUE_REQUIRED', `--${key} requires a value`)
    }
    out[key] = normalizedValue
  }
  return out
}

function parsePaginationFlags(flags, { defaultLimit, maxLimit }) {
  const parseInteger = (value, { flag, fallback, min, max }) => {
    if (value === undefined) return fallback
    if (!/^(?:0|[1-9]\d*)$/u.test(value)) {
      throw new CliUsageError(
        flag === 'limit' ? 'CLI_LIMIT_INVALID' : 'CLI_OFFSET_INVALID',
        `--${flag} must be an integer between ${min} and ${max}`,
      )
    }
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
      throw new CliUsageError(
        flag === 'limit' ? 'CLI_LIMIT_INVALID' : 'CLI_OFFSET_INVALID',
        `--${flag} must be an integer between ${min} and ${max}`,
      )
    }
    return parsed
  }
  return {
    limit: parseInteger(flags.limit, {
      flag: 'limit',
      fallback: defaultLimit,
      min: 1,
      max: maxLimit,
    }),
    offset: parseInteger(flags.offset, {
      flag: 'offset',
      fallback: 0,
      min: 0,
      max: Number.MAX_SAFE_INTEGER,
    }),
  }
}

export function sessionShowArgs(argv) {
  const sessionId = String(argv[0] || '').trim()
  if (!sessionId || sessionId.startsWith('--')) {
    throw new CliUsageError('CLI_SESSION_ID_REQUIRED', 'session show requires a session id')
  }
  const flags = parseCommandFlags(argv.slice(1), {
    command: 'session show',
    valueFlags: ['limit', 'offset'],
  })
  return { sessionId, flags }
}

function tokenDir() {
  return join(homedir(), '.yma-cli')
}
function tokenPath() {
  return join(tokenDir(), 'token')
}

function readLegacyToken() {
  const p = tokenPath()
  if (!existsSync(p)) return null
  try {
    const raw = readFileSync(p, 'utf8').trim()
    return raw || null
  } catch {
    return null
  }
}

function tokenScope(env = process.env) {
  const serverUrl = resolveServerUrl(env)
  const key = createHash('sha256').update(serverUrl, 'utf8').digest('hex')
  return {
    serverUrl,
    filePath: join(tokenDir(), 'tokens', `${key}.json`),
  }
}

function readScopedToken(scope) {
  if (!existsSync(scope.filePath)) return Object.freeze({ exists: false, token: null })
  try {
    const document = JSON.parse(readFileSync(scope.filePath, 'utf8'))
    if (document?.version !== 1 || document?.serverUrl !== scope.serverUrl) {
      return Object.freeze({ exists: true, token: null })
    }
    const token = String(document?.token || '').trim()
    return Object.freeze({ exists: true, token: token || null })
  } catch {
    return Object.freeze({ exists: true, token: null })
  }
}

function mayMigrateLegacyToken(serverUrl) {
  return serverUrl === DEFAULT_SERVER_URL
}

function readToken({ env = process.env } = {}) {
  const scope = tokenScope(env)
  const scoped = readScopedToken(scope)
  if (scoped.exists) return scoped.token
  if (!mayMigrateLegacyToken(scope.serverUrl)) return null
  const legacy = readLegacyToken()
  if (!legacy) return null
  writeToken(legacy, { env })
  return legacy
}

function writeToken(token, { env = process.env } = {}) {
  const normalizedToken = String(token || '').trim()
  if (!normalizedToken) throw new CliError('AUTH_TOKEN_INVALID', 'authentication token is empty')
  const scope = tokenScope(env)
  const dir = join(tokenDir(), 'tokens')
  mkdirSync(tokenDir(), { recursive: true, mode: 0o700 })
  chmodSync(tokenDir(), 0o700)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  const temporaryPath = join(dir, `.${randomUUID()}.tmp`)
  const content = `${JSON.stringify({
    version: 1,
    serverUrl: scope.serverUrl,
    token: normalizedToken,
  })}\n`
  try {
    writeFileSync(temporaryPath, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    chmodSync(temporaryPath, 0o600)
    renameSync(temporaryPath, scope.filePath)
    chmodSync(scope.filePath, 0o600)
  } catch (error) {
    try {
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath)
    } catch {
      // Preserve the original credential write failure.
    }
    throw error
  }
}

export function resolveServerUrl(env = process.env) {
  const explicit = String(env.GUGO_SERVER_URL || '').trim()
  if (explicit) {
    let parsed
    try {
      parsed = new URL(explicit)
    } catch {
      throw new CliUsageError('CLI_SERVER_URL_INVALID', 'GUGO_SERVER_URL must be an absolute HTTP(S) URL')
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new CliUsageError(
        'CLI_SERVER_URL_INVALID',
        'GUGO_SERVER_URL must use HTTP(S) and must not contain credentials',
      )
    }
    parsed.hash = ''
    parsed.search = ''
    return parsed.href.replace(/\/$/u, '')
  }
  const rawHost = String(env.SERVER_HOST || '127.0.0.1').trim()
  const host = rawHost.includes(':') && !rawHost.startsWith('[') ? `[${rawHost}]` : rawHost
  const port = String(env.SERVER_PORT || '5173').trim()
  return `http://${host}:${port}`
}

function apiTimeoutMs(env = process.env) {
  const raw = String(env.GUGO_CLI_HTTP_TIMEOUT_MS || '').trim()
  if (!raw) return DEFAULT_API_TIMEOUT_MS
  const timeoutMs = Number(raw)
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new CliUsageError(
      'CLI_HTTP_TIMEOUT_INVALID',
      'GUGO_CLI_HTTP_TIMEOUT_MS must be a positive integer',
    )
  }
  return timeoutMs
}

function responseError(result) {
  const nested = result.json?.error
  const nestedObject = nested && typeof nested === 'object' && !Array.isArray(nested)
    ? nested
    : null
  const code = String(
    nestedObject?.code
      || result.json?.code
      || (result.status === 401 ? 'AUTH_REQUIRED' : `HTTP_${result.status}`),
  )
  const message = String(
    nestedObject?.message
      || (typeof nested === 'string' ? nested : '')
      || result.json?.message
      || result.text
      || `HTTP ${result.status}`,
  )
  const error = new CliError(code, message, 1, { statusCode: result.status })
  if (nestedObject) error.serverFailure = { ...nestedObject }
  for (const field of [
    'action',
    'reason',
    'incompleteReason',
    'missingRequirements',
    'nextAction',
    'taskVerification',
    'artifactIds',
    'deliveryArtifactIds',
    'verifiedLocalFiles',
    'retainedLocalFiles',
    'retryable',
    'manualRetryable',
  ]) {
    // Structured `error` is authoritative. Top-level fields only remain for
    // responses emitted by older servers and must not replace newer details.
    const value = nestedObject?.[field] ?? result.json?.[field]
    if (value !== undefined) error[field] = value
  }
  if (result.json?.recovery && typeof result.json.recovery === 'object') {
    error.recovery = result.json.recovery
  }
  return error
}

async function requestApi(path, {
  method = 'GET',
  body,
  token = '',
  env = process.env,
} = {}) {
  const headers = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  const timeoutMs = apiTimeoutMs(env)
  const controller = new AbortController()
  const timeout = setTimeout(() => {
    controller.abort(Object.assign(new Error(`request timed out after ${timeoutMs}ms`), {
      code: 'REQUEST_TIMEOUT',
    }))
  }, timeoutMs)
  timeout.unref?.()
  let res
  let text
  try {
    res = await fetch(`${resolveServerUrl(env)}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
      redirect: 'manual',
    })
    text = await res.text()
  } catch (err) {
    if (controller.signal.aborted) {
      throw new CliError('REQUEST_TIMEOUT', `request timed out after ${timeoutMs}ms`)
    }
    throw new CliError('REQUEST_FAILED', err?.message || String(err))
  } finally {
    clearTimeout(timeout)
  }
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    /* not json */
  }
  return {
    ok: res.ok,
    status: res.status,
    json,
    text,
  }
}

function authRequiredError() {
  return new CliError(
    'AUTH_REQUIRED',
    'authentication required; run gugo login --email <email> and gugo verify first',
  )
}

async function bootstrapAuthToken({ token = '', env = process.env } = {}) {
  const result = await requestApi('/api/auth/bootstrap', {
    method: 'POST',
    token,
    env,
  })
  if (!result.ok) throw responseError(result)
  if (!result.json?.authenticated) throw authRequiredError()
  const resolvedToken = String(result.json?.token || token || '').trim()
  if (!resolvedToken) throw authRequiredError()
  writeToken(resolvedToken, { env })
  return resolvedToken
}

async function apiFetch(path, {
  method = 'GET',
  body,
  auth = true,
  preserveHttpError = false,
  env = process.env,
} = {}) {
  let token = auth ? (readToken({ env }) || '') : ''
  if (auth && !token) token = await bootstrapAuthToken({ env })

  let result = await requestApi(path, { method, body, token, env })
  if (auth && result.status === 401) {
    token = await bootstrapAuthToken({ token, env })
    result = await requestApi(path, { method, body, token, env })
  }
  if (result.status === 401) throw authRequiredError()
  if (!result.ok && !preserveHttpError) throw responseError(result)
  return preserveHttpError ? result : result.json
}

export async function cmdLogin(flags) {
  const email = flags.email
  const res = await apiFetch('/api/auth/send-code', {
    method: 'POST',
    body: { email },
    auth: false,
  })
  process.stdout.write(`Sent code to ${email}.\n`)
  if (res?.devCode) {
    process.stdout.write(`devCode: ${res.devCode}\n`)
  }
  process.stdout.write(`Next: gugo verify --email ${email} --code <code>\n`)
}

export async function cmdVerify(flags) {
  const email = flags.email
  const code = flags.code
  const res = await apiFetch('/api/auth/verify', {
    method: 'POST',
    body: { email, code: String(code) },
    auth: false,
  })
  if (!res?.token) {
    throw new CliError('AUTH_VERIFY_FAILED', 'verify failed: no token in response')
  }
  writeToken(res.token, { env: process.env })
  process.stdout.write(`Logged in as ${res.user?.email || email}.\n`)
}

export async function cmdSessionList(flags) {
  const archived = flags.archived ?? 'false'
  if (!['true', 'false', 'all'].includes(archived)) {
    throw new CliUsageError('CLI_ARCHIVED_INVALID', '--archived must be true, false, or all')
  }
  const { limit, offset } = parsePaginationFlags(flags, { defaultLimit: 100, maxLimit: 200 })
  const query = new URLSearchParams({ archived, limit: String(limit), offset: String(offset) })
  const res = await apiFetch(`/api/sessions?${query}`)
  process.stdout.write(JSON.stringify(res, null, 2) + '\n')
}

export async function cmdSessionSearch(flags) {
  if (!flags.query) {
    throw new CliUsageError('CLI_OPTION_VALUE_REQUIRED', '--query is required')
  }
  const { limit, offset } = parsePaginationFlags(flags, { defaultLimit: 20, maxLimit: 100 })
  const query = new URLSearchParams({
    q: flags.query,
    limit: String(limit),
    offset: String(offset),
  })
  if (flags['session-id']) query.set('sessionId', flags['session-id'])
  const res = await apiFetch(`/api/sessions/search?${query}`)
  process.stdout.write(JSON.stringify(res, null, 2) + '\n')
}

export async function cmdSessionShow(sessionId, flags) {
  const { limit, offset } = parsePaginationFlags(flags, { defaultLimit: 2000, maxLimit: 2000 })
  const query = new URLSearchParams({ limit: String(limit), offset: String(offset) })
  const res = await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/snapshot?${query}`)
  process.stdout.write(JSON.stringify(res, null, 2) + '\n')
}

export async function cmdModelList(flags) {
  const response = await apiFetch('/api/model/providers')
  if (!Array.isArray(response?.providers)) {
    throw new CliError(
      'MODEL_LIST_INVALID_RESPONSE',
      'server returned an invalid model provider list',
    )
  }
  const providerId = String(flags.provider || '').trim()
  const search = String(flags.search || '').trim().toLocaleLowerCase()
  const models = response.providers
    .filter((provider) => !providerId || String(provider?.id || '') === providerId)
    .flatMap((provider) => {
      const names = Array.isArray(provider?.models) ? provider.models : []
      return names
        .map((name) => String(name || '').trim())
        .filter(Boolean)
        .filter((name) => {
          if (!search) return true
          return [name, provider?.label, provider?.key, provider?.id]
            .some((value) => String(value || '').toLocaleLowerCase().includes(search))
        })
        .map((name) => ({
          name,
          providerId: String(provider?.id || ''),
          providerKey: String(provider?.key || ''),
          providerLabel: String(provider?.label || provider?.key || provider?.id || ''),
          enabled: provider?.enabled === true,
          isProviderDefault: String(provider?.defaultModel || '') === name,
          isDefault: provider?.isDefault === true && String(provider?.defaultModel || '') === name,
          readiness: provider?.modelReadiness?.[name] || null,
          profile: provider?.modelProfiles?.[name] || null,
        }))
    })
  process.stdout.write(`${JSON.stringify({ models }, null, 2)}\n`)
}

export async function cmdAgentList() {
  const res = await apiFetch('/api/agents')
  process.stdout.write(JSON.stringify(res, null, 2) + '\n')
}

export async function cmdSkillList() {
  const res = await apiFetch('/api/skills')
  process.stdout.write(JSON.stringify(res, null, 2) + '\n')
}

function writeApiResult(result) {
  if (result.json !== null) {
    process.stdout.write(`${JSON.stringify(result.json, null, 2)}\n`)
    return
  }
  process.stdout.write(`${result.text}\n`)
}

export async function cmdStatus() {
  const result = await apiFetch('/api/health', {
    auth: false,
    preserveHttpError: true,
  })
  writeApiResult(result)
  return result.ok ? 0 : 1
}

export async function cmdDoctor() {
  const result = await apiFetch('/api/health/full', {
    preserveHttpError: true,
  })
  writeApiResult(result)
  return result.ok && result.json?.ok !== false ? 0 : 1
}
