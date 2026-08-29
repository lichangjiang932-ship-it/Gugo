#!/usr/bin/env node
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
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

import {
  createRunOutputFormatter,
  normalizeRunOutputFormat,
} from './cli/runOutput.js'

const HELP = `gugo — server-first CLI for Gugo (legacy alias: yma-cli)

Usage:
  gugo login --email <email>
  gugo verify --email <email> --code <code>
  gugo session list [--archived true|false|all] [--limit <n>] [--offset <n>]
  gugo session search --query <text> [--session-id <id>]
                      [--limit <n>] [--offset <n>]
  gugo session show <session-id> [--limit <n>] [--offset <n>]
  gugo model list [--provider <id>] [--search <text>]
  gugo agent list
  gugo skill list
  gugo status
  gugo doctor
  gugo run "<prompt>" [--model <name>] [--provider <id>]
                     [--mode normal|acceptEdits|plan|bypass]
                     [--cwd <dir>] [--session-id <id>]
                     [--timeout <ms>]
                     [--output jsonl|text]
  gugo run --resume <turnId> [--session-id <id>] [--cwd <dir>]
                     [--timeout <ms>]
                     [--output jsonl|text]
  echo "<prompt>" | gugo run [options]
  gugo --help
  gugo --version

Environment:
  GUGO_SERVER_URL  absolute server URL (overrides SERVER_HOST/SERVER_PORT)
  GUGO_CLI_HTTP_TIMEOUT_MS  API request timeout in milliseconds (default 10000)
  GUGO_CLI_RUN_TIMEOUT_MS   optional Turn execution timeout in milliseconds
  SERVER_PORT   server port (default 5173)
  SERVER_HOST   server host (default 127.0.0.1)

Auth tokens are isolated per server under ~/.yma-cli/tokens/ (chmod 0600).
Run defaults to durable TurnEngine JSONL; use --output text for final text only.
`

const RUN_VALUE_FLAGS = new Set([
  'model', 'provider', 'mode', 'cwd', 'session-id', 'resume', 'timeout', 'output',
])
const RUN_MODES = new Set(['normal', 'acceptEdits', 'plan', 'bypass'])
const MAX_STDIN_PROMPT_BYTES = 1024 * 1024
const DEFAULT_API_TIMEOUT_MS = 10_000
const DEFAULT_SERVER_URL = 'http://127.0.0.1:5173'
const MAX_TIMER_TIMEOUT_MS = 2_147_483_647
const SIGNAL_EXIT_CODES = Object.freeze({ SIGINT: 130, SIGTERM: 143 })
const packageMetadata = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

export const CLI_VERSION = String(packageMetadata.version || '0.0.0')

export class CliError extends Error {
  constructor(code, message, exitCode = 1, options = {}) {
    super(message)
    this.name = 'CliError'
    this.code = code
    this.exitCode = exitCode
    if (Number.isInteger(options.statusCode)) this.statusCode = options.statusCode
  }
}

export class CliUsageError extends CliError {
  constructor(code, message) {
    super(code, message, 2)
    this.name = 'CliUsageError'
  }
}

export function parseRunArgs(argv = []) {
  const options = {
    prompt: '',
    model: null,
    modelProviderId: null,
    mode: 'normal',
    cwd: process.cwd(),
    sessionId: null,
    resumeTurnId: null,
    timeoutMs: null,
    outputFormat: 'jsonl',
  }
  const positional = []
  let positionalOnly = false
  let modeSpecified = false
  const specifiedValueFlags = new Set()
  for (let i = 0; i < argv.length; i++) {
    const raw = String(argv[i])
    if (!positionalOnly && raw === '--') {
      positionalOnly = true
      continue
    }
    if (!positionalOnly && raw.startsWith('--')) {
      const equalAt = raw.indexOf('=')
      const key = raw.slice(2, equalAt >= 0 ? equalAt : undefined)
      if (!RUN_VALUE_FLAGS.has(key)) throw new CliUsageError('CLI_OPTION_UNKNOWN', `unknown run option: --${key}`)
      if (specifiedValueFlags.has(key)) {
        throw new CliUsageError('CLI_OPTION_DUPLICATE', `--${key} may only be specified once`)
      }
      specifiedValueFlags.add(key)
      const value = equalAt >= 0 ? raw.slice(equalAt + 1) : argv[++i]
      const normalizedValue = value === undefined ? '' : String(value).trim()
      if (!normalizedValue || String(value).startsWith('--')) {
        throw new CliUsageError('CLI_OPTION_VALUE_REQUIRED', `--${key} requires a value`)
      }
      if (key === 'model') options.model = normalizedValue
      if (key === 'provider') options.modelProviderId = normalizedValue
      if (key === 'mode') {
        options.mode = normalizedValue
        modeSpecified = true
      }
      if (key === 'cwd') options.cwd = resolve(normalizedValue)
      if (key === 'session-id') options.sessionId = normalizedValue
      if (key === 'resume') options.resumeTurnId = normalizedValue
      if (key === 'timeout') options.timeoutMs = resolveRunTimeoutMs(normalizedValue, {})
      if (key === 'output') options.outputFormat = normalizeRunOutputFormat(normalizedValue)
      continue
    }
    positional.push(raw)
  }
  options.prompt = positional.join(' ').trim()
  if (!RUN_MODES.has(options.mode)) {
    throw new CliUsageError('CLI_MODE_INVALID', 'mode must be one of normal, acceptEdits, plan, bypass')
  }
  if (options.resumeTurnId && options.prompt) {
    throw new CliUsageError('CLI_RESUME_PROMPT_CONFLICT', 'prompt cannot be combined with --resume')
  }
  if (options.resumeTurnId && modeSpecified) {
    throw new CliUsageError(
      'CLI_RESUME_MODE_CONFLICT',
      '--mode cannot be combined with --resume; the persisted turn permission mode is restored',
    )
  }
  if (options.resumeTurnId && options.modelProviderId) {
    throw new CliUsageError(
      'CLI_RESUME_PROVIDER_CONFLICT',
      '--provider cannot be combined with --resume; the persisted model Provider is restored',
    )
  }
  if (options.resumeTurnId && options.model) {
    throw new CliUsageError(
      'CLI_RESUME_MODEL_CONFLICT',
      '--model cannot be combined with --resume; the persisted model is restored',
    )
  }
  if (options.resumeTurnId && !modeSpecified) options.mode = null
  return options
}

export function resolveRunTimeoutMs(optionValue = null, env = process.env) {
  const value = optionValue == null
    ? String(env.GUGO_CLI_RUN_TIMEOUT_MS || '').trim()
    : String(optionValue).trim()
  if (!value) return 0
  if (!/^[1-9]\d*$/u.test(value)) {
    throw new CliUsageError(
      'CLI_RUN_TIMEOUT_INVALID',
      `run timeout must be an integer between 1 and ${MAX_TIMER_TIMEOUT_MS} milliseconds`,
    )
  }
  const timeoutMs = Number(value)
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs > MAX_TIMER_TIMEOUT_MS) {
    throw new CliUsageError(
      'CLI_RUN_TIMEOUT_INVALID',
      `run timeout must be an integer between 1 and ${MAX_TIMER_TIMEOUT_MS} milliseconds`,
    )
  }
  return timeoutMs
}

function requestedRunOutputFormat(argv = []) {
  for (let i = 0; i < argv.length; i++) {
    const raw = String(argv[i])
    if (raw === '--') break
    if (raw === '--output') {
      if (String(argv[i + 1] || '').trim().toLowerCase() === 'text') return 'text'
      i += 1
      continue
    }
    if (raw.startsWith('--output=')) {
      if (raw.slice('--output='.length).trim().toLowerCase() === 'text') return 'text'
    }
  }
  return 'jsonl'
}

export async function readPromptFromStdin(input = process.stdin) {
  let prompt = ''
  for await (const chunk of input) {
    prompt += String(chunk)
    if (Buffer.byteLength(prompt, 'utf8') > MAX_STDIN_PROMPT_BYTES) {
      throw new CliUsageError('CLI_STDIN_TOO_LARGE', 'stdin prompt exceeds 1 MiB')
    }
  }
  return prompt.trim()
}

function createApprovalPrompt(input, diagnostics, signal = null) {
  return async (event) => {
    if (signal?.aborted) return { decision: 'deny' }
    const tool = event?.payload?.toolName || 'unknown'
    const args = JSON.stringify(event?.payload?.args || {})
    const rl = createInterface({ input, output: diagnostics })
    try {
      const answer = await new Promise((done) => {
        let settled = false
        const finish = (value = '') => {
          if (settled) return
          settled = true
          signal?.removeEventListener('abort', abort)
          done(value)
        }
        const abort = () => {
          finish('')
          rl.close()
        }
        signal?.addEventListener('abort', abort, { once: true })
        rl.once('close', () => finish(''))
        rl.question(`[approval] tool=${tool} args=${args} [y/N] `, finish)
      })
      return { decision: /^y(?:es)?$/i.test(String(answer).trim()) ? 'approve' : 'deny' }
    } finally {
      rl.close()
    }
  }
}

async function loadBuiltinHeadlessRuntime({
  runtimeCwd = process.cwd(),
  env = process.env,
} = {}) {
  // Keep the CLI entry free of eager backend imports. Trusted persistence is
  // selected before preflight can open the distribution's remaining SQLite
  // stores, and ordinary runtime plugin state cannot influence this choice.
  // A CLI may be launched inside an untrusted project, so cwd/.env must never
  // select executable host code. Deployment-owned process env remains explicit.
  const persistenceEnv = Object.freeze({ ...env })
  const { resolveBuiltinSqliteTurnPersistenceBootstrap } = await import(
    '../server/adapters/builtinSqliteTurnPersistenceBootstrap.js'
  )
  const persistenceBootstrap = await resolveBuiltinSqliteTurnPersistenceBootstrap({
    cwd: runtimeCwd,
    env: persistenceEnv,
  })
  const { runRuntimeConfigStartupPreflight } = await import(
    '../server/services/runtimeConfigStartupService.js'
  )
  const { runtimeEnv } = runRuntimeConfigStartupPreflight({ cwd: runtimeCwd, env })
  const { runBuiltinHeadlessTurn } = await import('../server/adapters/headlessTurnHost.js')
  return (options) => runBuiltinHeadlessTurn({
    ...options,
    runtimeCwd,
    runtimeEnv,
    env: runtimeEnv,
    turnPersistenceAdapter: persistenceBootstrap.adapter,
    turnPersistenceProvenance: persistenceBootstrap.provenance,
  })
}

export async function cmdRun(argv, {
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  runTurn = null,
  runtimeCwd = process.cwd(),
  env = process.env,
  signal = null,
} = {}) {
  const output = createRunOutputFormatter({
    format: requestedRunOutputFormat(argv),
    stdout,
    stderr,
  })
  let timeoutTimer = null
  let timeoutTriggered = false
  let timeoutError = null
  try {
    const options = parseRunArgs(argv)
    const stdinPrompt = stdin.isTTY === true ? '' : await readPromptFromStdin(stdin)
    if (options.resumeTurnId && stdinPrompt) {
      throw new CliUsageError(
        'CLI_RESUME_PROMPT_CONFLICT',
        'piped prompt cannot be combined with --resume',
      )
    }
    if (!options.resumeTurnId) {
      options.prompt = [options.prompt, stdinPrompt].filter(Boolean).join('\n\n')
      if (!options.prompt) throw new CliUsageError('PROMPT_REQUIRED', 'prompt is required')
    }
    const timeoutMs = options.timeoutMs ?? resolveRunTimeoutMs(null, env)
    const timeoutController = timeoutMs > 0 ? new AbortController() : null
    if (timeoutController) {
      timeoutError = new CliError(
        'CLI_RUN_TIMEOUT',
        `run timed out after ${timeoutMs}ms`,
        124,
      )
      timeoutTimer = setTimeout(() => {
        if (signal?.aborted) return
        timeoutTriggered = true
        timeoutController.abort(timeoutError)
      }, timeoutMs)
    }
    const runtimeSignal = timeoutController
      ? (signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal)
      : signal
    const runtime = runTurn || await loadBuiltinHeadlessRuntime({ runtimeCwd, env })
    const interactive = stdin.isTTY === true && stderr.isTTY === true
    const runtimeOptions = { ...options }
    delete runtimeOptions.outputFormat
    delete runtimeOptions.timeoutMs
    const result = await runtime({
      ...runtimeOptions,
      // HTTP credentials belong to a server URL. Headless execution binds to
      // the local runtime/database and must never consume a remote token.
      token: '',
      interactive,
      signal: runtimeSignal,
      onEvent: output.onEvent,
      onToken: () => {},
      onDiagnostic: (message) => stderr.write(`${message}\n`),
      onApproval: createApprovalPrompt(stdin, stderr, runtimeSignal),
    })
    if (timeoutTriggered) {
      await output.writeError(timeoutError)
      return timeoutError.exitCode
    }
    await output.finish(result)
    return Number.isInteger(result?.exitCode) ? result.exitCode : 0
  } catch (error) {
    const resolvedError = timeoutTriggered ? timeoutError : error
    await output.writeError(resolvedError)
    return Number.isInteger(resolvedError?.exitCode) ? resolvedError.exitCode : 1
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer)
  }
}

function parseCommandFlags(argv, { command, valueFlags = [] }) {
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

function sessionShowArgs(argv) {
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

export function createRunShutdownController({
  target = process,
  diagnostics = process.stderr,
  timeoutMs = 5_000,
  forceExit = (exitCode) => target.exit(exitCode),
} = {}) {
  const controller = new AbortController()
  const handlers = new Map()
  let requestedExitCode = null
  let signalCount = 0
  let timer = null
  let disposed = false

  const force = () => forceExit(requestedExitCode || 1)
  const handleSignal = (signalName) => {
    signalCount += 1
    if (signalCount > 1) {
      force()
      return
    }
    requestedExitCode = SIGNAL_EXIT_CODES[signalName] || 1
    target.exitCode = requestedExitCode
    diagnostics.write(`Received ${signalName}; cancelling the active turn...\n`)
    const reason = Object.assign(new Error(`received ${signalName}`), {
      code: 'CLI_INTERRUPTED',
      signal: signalName,
      exitCode: requestedExitCode,
    })
    controller.abort(reason)
    timer = setTimeout(force, timeoutMs)
    timer.unref?.()
  }

  for (const signalName of Object.keys(SIGNAL_EXIT_CODES)) {
    const handler = () => handleSignal(signalName)
    handlers.set(signalName, handler)
    target.on(signalName, handler)
  }

  return Object.freeze({
    signal: controller.signal,
    get exitCode() { return requestedExitCode },
    dispose() {
      if (disposed) return
      disposed = true
      if (timer) clearTimeout(timer)
      for (const [signalName, handler] of handlers) target.removeListener(signalName, handler)
    },
  })
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
  return new CliError(code, message, 1, { statusCode: result.status })
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

async function cmdLogin(flags) {
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

async function cmdVerify(flags) {
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

async function cmdSessionList(flags) {
  const archived = flags.archived ?? 'false'
  if (!['true', 'false', 'all'].includes(archived)) {
    throw new CliUsageError('CLI_ARCHIVED_INVALID', '--archived must be true, false, or all')
  }
  const { limit, offset } = parsePaginationFlags(flags, { defaultLimit: 100, maxLimit: 200 })
  const query = new URLSearchParams({ archived, limit: String(limit), offset: String(offset) })
  const res = await apiFetch(`/api/sessions?${query}`)
  process.stdout.write(JSON.stringify(res, null, 2) + '\n')
}

async function cmdSessionSearch(flags) {
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

async function cmdSessionShow(sessionId, flags) {
  const { limit, offset } = parsePaginationFlags(flags, { defaultLimit: 2000, maxLimit: 2000 })
  const query = new URLSearchParams({ limit: String(limit), offset: String(offset) })
  const res = await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/snapshot?${query}`)
  process.stdout.write(JSON.stringify(res, null, 2) + '\n')
}

async function cmdModelList(flags) {
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

async function cmdAgentList() {
  const res = await apiFetch('/api/agents')
  process.stdout.write(JSON.stringify(res, null, 2) + '\n')
}

async function cmdSkillList() {
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

async function cmdStatus() {
  const result = await apiFetch('/api/health', {
    auth: false,
    preserveHttpError: true,
  })
  writeApiResult(result)
  return result.ok ? 0 : 1
}

async function cmdDoctor() {
  const result = await apiFetch('/api/health/full', {
    preserveHttpError: true,
  })
  writeApiResult(result)
  return result.ok && result.json?.ok !== false ? 0 : 1
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length === 0) {
    process.stdout.write(HELP)
    return 0
  }
  if (argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
    parseCommandFlags(argv.slice(1), { command: 'help' })
    process.stdout.write(HELP)
    return 0
  }
  if (argv[0] === '--version' || argv[0] === '-V') {
    parseCommandFlags(argv.slice(1), { command: 'version' })
    process.stdout.write(`${CLI_VERSION}\n`)
    return 0
  }

  const [cmd, sub, ...rest] = argv

  if (cmd === 'login') {
    const flags = parseCommandFlags(argv.slice(1), { command: 'login', valueFlags: ['email'] })
    if (!flags.email) throw new CliUsageError('CLI_OPTION_VALUE_REQUIRED', '--email is required')
    await cmdLogin(flags)
    return 0
  }
  if (cmd === 'verify') {
    const flags = parseCommandFlags(argv.slice(1), { command: 'verify', valueFlags: ['email', 'code'] })
    if (!flags.email || !flags.code) {
      throw new CliUsageError('CLI_OPTION_VALUE_REQUIRED', '--email and --code are required')
    }
    await cmdVerify(flags)
    return 0
  }
  if (cmd === 'run') {
    const shutdown = createRunShutdownController()
    try {
      const exitCode = await cmdRun(argv.slice(1), { signal: shutdown.signal })
      return shutdown.exitCode ?? exitCode
    } finally {
      shutdown.dispose()
    }
  }
  if (cmd === 'session' && sub === 'list') {
    const flags = parseCommandFlags(rest, {
      command: 'session list',
      valueFlags: ['archived', 'limit', 'offset'],
    })
    await cmdSessionList(flags)
    return 0
  }
  if (cmd === 'session' && sub === 'search') {
    const flags = parseCommandFlags(rest, {
      command: 'session search',
      valueFlags: ['query', 'session-id', 'limit', 'offset'],
    })
    await cmdSessionSearch(flags)
    return 0
  }
  if (cmd === 'session' && sub === 'show') {
    const { sessionId, flags } = sessionShowArgs(rest)
    await cmdSessionShow(sessionId, flags)
    return 0
  }
  if (cmd === 'model' && sub === 'list') {
    const flags = parseCommandFlags(rest, {
      command: 'model list',
      valueFlags: ['provider', 'search'],
    })
    await cmdModelList(flags)
    return 0
  }
  if (cmd === 'agent' && sub === 'list') {
    parseCommandFlags(rest, { command: 'agent list' })
    await cmdAgentList()
    return 0
  }
  if (cmd === 'skill' && sub === 'list') {
    parseCommandFlags(rest, { command: 'skill list' })
    await cmdSkillList()
    return 0
  }
  if (cmd === 'status') {
    parseCommandFlags(argv.slice(1), { command: 'status' })
    return cmdStatus()
  }
  if (cmd === 'doctor') {
    parseCommandFlags(argv.slice(1), { command: 'doctor' })
    return cmdDoctor()
  }

  throw new CliUsageError('CLI_COMMAND_UNKNOWN', `Unknown command: ${argv.join(' ')}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then((exitCode) => {
      process.exitCode = Number.isInteger(exitCode) ? exitCode : 0
    })
    .catch((error) => {
      const code = error?.code || 'CLI_FAILED'
      process.stderr.write(`Error [${code}]: ${error?.message || error}\n`)
      process.exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1
    })
}
