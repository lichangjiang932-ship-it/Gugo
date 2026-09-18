#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { CliError, CliUsageError } from './cli/errors.js'
import { cmdDoctorHeadless, parseDoctorArgs } from './cli/headlessDoctor.js'
import { cmdTrace } from './cli/traceCommand.js'
import { cmdGoal } from './cli/goalCommand.js'
import { cmdMemory } from './cli/memoryCommand.js'
import { startInteractiveSession } from './cli/interactiveSession.js'
import { loadBuiltinHeadlessRuntime } from './cli/headlessRuntimeLoader.js'
import { createRunInteractionPorts } from './cli/runInteractionPorts.js'
import { createRunTerminalObserver } from './cli/runDiagnostics.js'
import { resolveRunDeadlineOutcome } from './cli/runDeadline.js'
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
import { collectAttachmentRequests } from './cli/cliAttachments.js'

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
  gugo doctor [--json]
  gugo doctor --headless [--model <name>] [--provider <id>]
                      [--cwd <dir>] [--probe] [--integrity] [--json]
  gugo trace <turnId> [--session-id <id>] [--limit <n>]
                      [--export text|json|otel] [--json]
  gugo goal create "<objective>" --steps <json> [--steps-file <path>]
                      [--session-id <id>] [--no-approval]
  gugo goal list [--status <status>] [--limit <n>]
  gugo goal show <planId>
  gugo goal approve <planId>
  gugo goal step <planId> <stepId> --status <status>
                      [--turn <turnId>] [--tool-call <id>] [--note <text>]
                      [--manual-confirm] [--confirmed-by <who>]
                      [--expect-version <n>]
  gugo goal rewrite <planId> --steps <json> [--objective <text>] [--no-approval]
                      [--expect-version <n>]
  gugo goal prune [<planId>] [--keep <n>]
  gugo memory reindex [--limit <n>] [--batch <n>]
                      [--all-agents | --agent <agentId>]
  gugo run "<prompt>" [--model <name>] [--provider <id>]
                     [--mode normal|acceptEdits|plan|bypass]
                     [--cwd <dir>] [--session-id <id>]
                     [--timeout <ms>]
                     [--output jsonl|text] [--progress]
                     [--file <path>] [--image <path>] (repeatable, 8 total)
  gugo run --resume <turnId> [--session-id <id>] [--cwd <dir>]
                     [--timeout <ms>]
                     [--output jsonl|text]
  gugo chat [--model <name>] [--provider <id>]
                     [--mode normal|acceptEdits|plan|bypass]
                     [--cwd <dir>] [--session-id <id>]
                     [--timeout <ms>] (per turn)
                     [--file <path>] [--image <path>] (next turn only)
  echo "<prompt>" | gugo run [options]
  gugo --help
  gugo --version

Environment:
  GUGO_SERVER_URL  absolute server URL (overrides SERVER_HOST/SERVER_PORT)
  GUGO_CLI_HTTP_TIMEOUT_MS  API request timeout in milliseconds (default 10000)
  GUGO_CLI_RUN_TIMEOUT_MS   optional Turn execution timeout in milliseconds
  GUGO_CLI_INPUT    readline (default) or optional ink on Node 22+
                   auto is a legacy alias for readline; no automatic selection
  GUGO_CLI_HISTORY  set 0 to disable persisted input history
  SERVER_PORT   server port (default 5173)
  SERVER_HOST   server host (default 127.0.0.1)

Auth tokens are isolated per server under ~/.yma-cli/tokens/ (chmod 0600).
Run defaults to durable TurnEngine JSONL; use --output text for final text only.
Chat: /sessions lists local history; /resume <session-id> selects a conversation.
Use run --resume <turnId> only to recover a persisted turn, not to start a new reply.
`

const RUN_VALUE_FLAGS = new Set([
  'model', 'provider', 'mode', 'cwd', 'session-id', 'resume', 'timeout', 'output',
  'file', 'image',
])
/** Value flags that may be repeated; every other one is single-use. */
const RUN_REPEATABLE_VALUE_FLAGS = new Set(['file', 'image'])
const RUN_BOOLEAN_FLAGS = new Set(['progress'])
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
    cwdExplicit: false,
    sessionId: null,
    resumeTurnId: null,
    timeoutMs: null,
    outputFormat: 'jsonl',
    progress: false,
    files: [],
    images: [],
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
      if (!RUN_VALUE_FLAGS.has(key) && !RUN_BOOLEAN_FLAGS.has(key)) throw new CliUsageError('CLI_OPTION_UNKNOWN', `unknown run option: --${key}`)
      if (specifiedValueFlags.has(key) && !RUN_REPEATABLE_VALUE_FLAGS.has(key)) {
        throw new CliUsageError('CLI_OPTION_DUPLICATE', `--${key} may only be specified once`)
      }
      specifiedValueFlags.add(key)
      if (RUN_BOOLEAN_FLAGS.has(key)) {
        if (equalAt >= 0) throw new CliUsageError('CLI_OPTION_VALUE_REQUIRED', `--${key} does not take a value`)
        options[key] = true
        continue
      }
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
      if (key === 'cwd') {
        options.cwd = resolve(normalizedValue)
        options.cwdExplicit = true
      }
      if (key === 'session-id') options.sessionId = normalizedValue
      if (key === 'resume') options.resumeTurnId = normalizedValue
      if (key === 'timeout') options.timeoutMs = resolveRunTimeoutMs(normalizedValue, {})
      if (key === 'output') options.outputFormat = normalizeRunOutputFormat(normalizedValue)
      if (key === 'file') options.files.push(normalizedValue)
      if (key === 'image') options.images.push(normalizedValue)
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
  if (options.resumeTurnId && (options.files.length || options.images.length)) {
    throw new CliUsageError('CLI_RESUME_ATTACHMENT_CONFLICT', 'attachments cannot be combined with --resume')
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

export async function cmdChat(options, {
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  runTurn = null,
  runtimeCwd = process.cwd(),
  env = process.env,
  signal = null,
  lines = null,
} = {}) {
  if (options.resumeTurnId) {
    throw new CliUsageError(
      'CLI_CHAT_RESUME_CONFLICT',
      'gugo chat keeps its own session; use `gugo run --resume <turnId>` to continue a specific turn',
    )
  }
  if (options.prompt) {
    throw new CliUsageError(
      'CLI_CHAT_PROMPT_CONFLICT',
      `gugo chat takes no prompt argument; drop "${String(options.prompt).slice(0, 40)}" and type it inside the session`,
    )
  }
  return startInteractiveSession({
    options: { ...options, timeoutMs: options.timeoutMs ?? resolveRunTimeoutMs(null, env) },
    stdin, stdout, stderr, runTurn, runtimeCwd, env, signal, lines,
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
    progress: argv.includes('--progress'),
    stdout,
    stderr,
  })
  let timeoutTimer = null
  let timeoutTriggered = false
  let timeoutError = null
  const terminalObserver = createRunTerminalObserver()
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
      if (!options.prompt && !options.files.length && !options.images.length) throw new CliUsageError('PROMPT_REQUIRED', 'prompt is required')
    }
    if (options.files.length > 0 || options.images.length > 0) {
      // A resumed turn replays its own prompt; folding attachments in would invent one.
      if (options.resumeTurnId) {
        throw new CliUsageError(
          'CLI_RESUME_ATTACHMENT_CONFLICT',
          'attachments cannot be combined with --resume',
        )
      }
      // Only the trusted headless host reads files, after establishing the local
      // identity. Bytes become managed attachment IDs, never giant prompt strings.
      options.attachmentRequests = collectAttachmentRequests({ files: options.files, images: options.images })
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
    const interactionPorts = createRunInteractionPorts({
      stdin, diagnostics: stderr, signal: runtimeSignal,
    })
    const runtimeOptions = { ...options }
    runtimeOptions.workspaceExplicit = options.cwdExplicit === true
    delete runtimeOptions.cwdExplicit
    delete runtimeOptions.progress
    delete runtimeOptions.outputFormat
    delete runtimeOptions.timeoutMs
    // Raw flags are replaced by the bounded, explicit attachment request list.
    delete runtimeOptions.files
    delete runtimeOptions.images
    let result = await runtime({
      ...runtimeOptions,
      // HTTP credentials belong to a server URL. Headless execution binds to
      // the local runtime/database and must never consume a remote token.
      token: '',
      interactive,
      signal: runtimeSignal,
      onEvent: (event) => {
        terminalObserver.observe(event)
        return output.onEvent(event)
      },
      onToken: () => {},
      onDiagnostic: (message) => stderr.write(`${message}\n`),
      ...interactionPorts,
    })
    if (timeoutTimer) clearTimeout(timeoutTimer)
    if (timeoutTriggered) {
      const outcome = resolveRunDeadlineOutcome({ result, timeoutError,
        observedTerminal: terminalObserver.terminal, terminalConflict: terminalObserver.conflict })
      if (Object.hasOwn(outcome, 'error')) throw outcome.error
      result = outcome.result
    }
    if (timeoutTriggered) stderr.write('[deadline elapsed; preserving the runtime outcome]\n')
    await output.finish(result)
    return output.resolveExitCode(result)
  } catch (error) {
    if (timeoutTimer) clearTimeout(timeoutTimer)
    // A deadline requests cooperative cancellation; it cannot prove that a
    // concurrent persistence, output or unknown-result failure was cancelled.
    const outcome = timeoutTriggered
      ? resolveRunDeadlineOutcome({ error, didThrow: true, timeoutError,
        observedTerminal: terminalObserver.terminal, terminalConflict: terminalObserver.conflict }) : { error }
    if (Object.hasOwn(outcome, 'result')) {
      stderr.write('[deadline elapsed; preserving the runtime outcome]\n')
      await output.finish(outcome.result)
      return output.resolveExitCode(outcome.result)
    }
    await output.writeError(outcome.error)
    return Number.isInteger(outcome.error?.exitCode) ? outcome.error.exitCode : 1
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer)
    await output.dispose()
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
  if (cmd === 'chat' || cmd === 'i') {
    const options = parseRunArgs(argv.slice(1))
    return await cmdChat(options)
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
    const options = parseDoctorArgs(argv.slice(1))
    if (!options.headless) return cmdDoctor()
    return cmdDoctorHeadless(options)
  }

  if (cmd === 'trace') {
    return cmdTrace(argv.slice(1))
  }
  if (cmd === 'goal') {
    return cmdGoal(argv.slice(1))
  }
  if (cmd === 'memory') {
    return cmdMemory(argv.slice(1))
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
