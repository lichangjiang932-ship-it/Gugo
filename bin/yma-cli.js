#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const HELP = `gugo — server-first CLI for Gugo (legacy alias: yma-cli)

Usage:
  gugo login --email <email>
  gugo verify --email <email> --code <code>
  gugo session list [--archived true|false|all]
  gugo agent list
  gugo skill list
  gugo run "<prompt>" [--model <name>] [--provider <id>]
                     [--mode normal|acceptEdits|plan|bypass]
                     [--cwd <dir>] [--session-id <id>]
  gugo run --resume <turnId> [--session-id <id>] [--cwd <dir>]
  echo "<prompt>" | gugo run [options]
  gugo --help

Environment:
  SERVER_PORT   server port (default 5173)
  SERVER_HOST   server host (default 127.0.0.1)

Auth token is stored at ~/.yma-cli/token (chmod 0600).
Run emits durable TurnEngine events as one JSON object per stdout line (JSONL).
`

const RUN_VALUE_FLAGS = new Set(['model', 'provider', 'mode', 'cwd', 'session-id', 'resume'])
const RUN_MODES = new Set(['normal', 'acceptEdits', 'plan', 'bypass'])
const MAX_STDIN_PROMPT_BYTES = 1024 * 1024

export class CliUsageError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'CliUsageError'
    this.code = code
    this.exitCode = 2
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

function writeJsonLine(output, value) {
  output.write(`${JSON.stringify(value)}\n`)
}

function createApprovalPrompt(input, diagnostics) {
  return async (event) => {
    const tool = event?.payload?.toolName || 'unknown'
    const args = JSON.stringify(event?.payload?.args || {})
    const rl = createInterface({ input, output: diagnostics })
    try {
      const answer = await new Promise((done) => rl.question(`[approval] tool=${tool} args=${args} [y/N] `, done))
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
} = {}) {
  try {
    const options = parseRunArgs(argv)
    if (!options.resumeTurnId && !options.prompt) {
      if (stdin.isTTY) throw new CliUsageError('PROMPT_REQUIRED', 'prompt is required')
      options.prompt = await readPromptFromStdin(stdin)
      if (!options.prompt) throw new CliUsageError('PROMPT_REQUIRED', 'prompt is required')
    }
    const runtime = runTurn || await loadBuiltinHeadlessRuntime({ runtimeCwd, env })
    const interactive = stdin.isTTY === true && stderr.isTTY === true
    const result = await runtime({
      ...options,
      token: readToken() || '',
      interactive,
      onEvent: (event) => writeJsonLine(stdout, event),
      onToken: (token) => writeToken(token),
      onDiagnostic: (message) => stderr.write(`${message}\n`),
      onApproval: createApprovalPrompt(stdin, stderr),
    })
    return Number.isInteger(result?.exitCode) ? result.exitCode : 0
  } catch (error) {
    const code = error?.code || 'CLI_RUN_FAILED'
    const message = error?.message || String(error)
    const action = String(error?.action || '').trim()
    writeJsonLine(stdout, {
      type: 'cli.error',
      error: { code, message, ...(action ? { action } : {}) },
    })
    stderr.write(`Error [${code}]: ${message}\n`)
    return Number.isInteger(error?.exitCode) ? error.exitCode : 1
  }
}

function parseFlags(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) {
        out[key] = next
        i++
      } else {
        out[key] = true
      }
    }
  }
  return out
}

function tokenDir() {
  return join(homedir(), '.yma-cli')
}
function tokenPath() {
  return join(tokenDir(), 'token')
}

function readToken() {
  const p = tokenPath()
  if (!existsSync(p)) return null
  const raw = readFileSync(p, 'utf8').trim()
  return raw || null
}

function writeToken(token) {
  const dir = tokenDir()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(tokenPath(), token, { mode: 0o600 })
  chmodSync(tokenPath(), 0o600)
}

function baseUrl() {
  const host = process.env.SERVER_HOST || '127.0.0.1'
  const port = process.env.SERVER_PORT || '5173'
  return `http://${host}:${port}`
}

function requireToken() {
  const token = readToken()
  if (!token) {
    process.stderr.write('Not logged in. Run: gugo login --email <email>\n')
    process.exit(2)
  }
  return token
}

async function apiFetch(path, { method = 'GET', body, auth = true } = {}) {
  const headers = { 'content-type': 'application/json' }
  if (auth) headers.authorization = `Bearer ${requireToken()}`
  let res
  try {
    res = await fetch(`${baseUrl()}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    })
  } catch (err) {
    process.stderr.write(`Request failed: ${err.message}\n`)
    process.exit(1)
  }
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    /* not json */
  }
  if (!res.ok) {
    const msg = json?.error || text || `HTTP ${res.status}`
    process.stderr.write(`Error: ${msg}\n`)
    process.exit(1)
  }
  return json
}

async function cmdLogin(flags) {
  const email = flags.email
  if (!email || email === true) {
    process.stderr.write('Missing --email\n')
    process.exit(2)
  }
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
  if (!email || email === true || !code || code === true) {
    process.stderr.write('Missing --email or --code\n')
    process.exit(2)
  }
  const res = await apiFetch('/api/auth/verify', {
    method: 'POST',
    body: { email, code: String(code) },
    auth: false,
  })
  if (!res?.token) {
    process.stderr.write('Verify failed: no token in response\n')
    process.exit(1)
  }
  writeToken(res.token)
  process.stdout.write(`Logged in as ${res.user?.email || email}.\n`)
}

async function cmdSessionList(flags) {
  const archived = flags.archived ?? 'false'
  const res = await apiFetch(`/api/sessions?archived=${encodeURIComponent(archived)}`)
  process.stdout.write(JSON.stringify(res, null, 2) + '\n')
}

async function cmdAgentList() {
  const res = await apiFetch('/api/agents')
  process.stdout.write(JSON.stringify(res, null, 2) + '\n')
}

async function cmdSkillList() {
  const res = await apiFetch('/api/skills')
  process.stdout.write(JSON.stringify(res, null, 2) + '\n')
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
    process.stdout.write(HELP)
    return
  }

  const [cmd, sub, ...rest] = argv
  const flags = parseFlags([sub, ...rest].filter((x) => x !== undefined))

  if (cmd === 'login') {
    return cmdLogin(parseFlags(argv.slice(1)))
  }
  if (cmd === 'verify') {
    return cmdVerify(parseFlags(argv.slice(1)))
  }
  if (cmd === 'run') {
    process.exitCode = await cmdRun(argv.slice(1))
    return
  }
  if (cmd === 'session' && sub === 'list') return cmdSessionList(flags)
  if (cmd === 'agent' && sub === 'list') return cmdAgentList()
  if (cmd === 'skill' && sub === 'list') return cmdSkillList()

  process.stderr.write(`Unknown command: ${argv.join(' ')}\n\n${HELP}`)
  process.exit(2)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`Fatal: ${err?.message || err}\n`)
    process.exitCode = 1
  })
}
