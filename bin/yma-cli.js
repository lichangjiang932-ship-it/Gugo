#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

import { CliError, CliUsageError } from './cli/errors.js'
import {
  createRunOutputFormatter,
  formatRunError,
  normalizeRunOutputFormat,
} from './cli/runOutput.js'
import {
  cmdAgentList,
  cmdDoctor,
  cmdLogin,
  cmdModelList,
  cmdSessionList,
  cmdSessionSearch,
  cmdSessionShow,
  cmdSkillList,
  cmdStatus,
  cmdVerify,
  parseCommandFlags,
  sessionShowArgs,
} from './cli/serverCommands.js'

export { CliError, CliUsageError }
export { resolveServerUrl } from './cli/serverCommands.js'

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
const MAX_TIMER_TIMEOUT_MS = 2_147_483_647
const SIGNAL_EXIT_CODES = Object.freeze({ SIGINT: 130, SIGTERM: 143 })
const packageMetadata = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

export const CLI_VERSION = String(packageMetadata.version || '0.0.0')

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
    return output.resolveExitCode(result)
  } catch (error) {
    const resolvedError = timeoutTriggered ? timeoutError : error
    await output.writeError(resolvedError)
    return Number.isInteger(resolvedError?.exitCode) ? resolvedError.exitCode : 1
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer)
  }
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
      const output = formatRunError(error, { format: 'text' })
      process.stderr.write(output.stderr)
      process.exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1
    })
}
