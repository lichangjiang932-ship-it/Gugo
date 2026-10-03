import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { after } from 'node:test'

const CLI = fileURLToPath(new URL('../../bin/yma-cli.js', import.meta.url))
const directory = mkdtempSync(join(tmpdir(), 'gugo-command-help-'))
after(() => rmSync(directory, { recursive: true, force: true }))

const commands = [
  ['login'], ['verify'], ['run'], ['chat'], ['i'], ['status'], ['config'], ['doctor'], ['trace'],
  ['session', 'list'], ['session', 'search'], ['session', 'show'],
  ['model', 'list'], ['agent', 'list'], ['skill', 'list'],
  ['goal', 'create'], ['goal', 'list'], ['goal', 'show'], ['goal', 'approve'],
  ['goal', 'rewrite'], ['goal', 'step'], ['goal', 'prune'], ['memory', 'reindex'],
]
const groups = ['session', 'model', 'agent', 'skill', 'goal', 'memory']
const dataUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`

// The real entrypoint is exercised with runtime imports and outbound I/O denied.
// goalPlanEvidence is a pure schema/evidence module, not a runtime service.
// Unlike a closed pipe, the stdin guard also detects accidentally reading EOF.
const importGuard = dataUrl(`
  export async function resolve(specifier, context, nextResolve) {
    const resolved = await nextResolve(specifier, context)
    if (/\\/server\\/(?:db\\.js|services\\/(?!goalPlanEvidence\\.js$)|utils\\/runtimeEnv\\.js|adapters\\/(?!modelProviderConfig\\.js))/.test(resolved.url)
        || /(?:better-sqlite3|node:sqlite)/.test(resolved.url)) {
      throw Object.assign(new Error('CLI_HELP_RUNTIME_TOUCHED: ' + resolved.url), { code: 'CLI_HELP_RUNTIME_TOUCHED' })
    }
    return resolved
  }
`)
const preload = dataUrl(`
  import { register } from 'node:module'
  import { Socket } from 'node:net'
  register(${JSON.stringify(importGuard)}, import.meta.url)
  const denied = (code) => { throw Object.assign(new Error(code), { code }) }
  globalThis.fetch = () => denied('CLI_HELP_NETWORK_TOUCHED')
  Socket.prototype.connect = () => denied('CLI_HELP_NETWORK_TOUCHED')
  process.stdin[Symbol.asyncIterator] = () => denied('CLI_HELP_STDIN_TOUCHED')
`)
const env = {
  ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  HOME: join(directory, 'home'), USERPROFILE: join(directory, 'home'),
  TMP: directory, TEMP: directory, TMPDIR: directory,
  APP_DATA_DIR: join(directory, 'data'), APP_DB_PATH: join(directory, 'data', 'app.db'),
  ARTIFACT_DIR: join(directory, 'artifacts'), GUGO_LOAD_DOTENV: '0', AUTH_MODE: 'local',
  GUGO_SERVER_URL: 'http://127.0.0.1:1',
}

function runCli(args) {
  const result = spawnSync(process.execPath, ['--import', preload, CLI, ...args], {
    cwd: directory, env, encoding: 'utf8', timeout: 15_000, windowsHide: true,
  })
  assert.equal(result.error, undefined, `${args.join(' ')}\n${result.stderr}`)
  assert.deepEqual(readdirSync(directory), [], 'help must not create runtime, credentials, or history')
  return result
}

function assertHelp(args, command = '') {
  const result = runCli(args)
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`)
  assert.equal(result.stderr, '', args.join(' '))
  assert.match(result.stdout, /Usage:/u)
  assert.ok(result.stdout.includes(`gugo ${command === 'i' ? 'chat' : command}`), result.stdout)
  return result.stdout
}

function assertUsageError(args, code) {
  const result = runCli(args)
  assert.equal(result.status, 2, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`)
  assert.ok(`${result.stdout}${result.stderr}`.includes(code), `${args.join(' ')}\n${result.stdout}\n${result.stderr}`)
  assert.doesNotMatch(result.stdout, /Usage:/u)
}

test('every real command and chat alias has side-effect-free --help', () => {
  for (const command of commands) assertHelp([...command, '--help'], command.join(' '))
})

test('all command groups have side-effect-free --help', () => {
  for (const group of groups) assertHelp([group, '--help'], group)
})

test('short help and explicit help paths cover every real command', () => {
  for (const command of commands) {
    assertHelp([...command, '-h'], command.join(' '))
    assertHelp(['help', ...command], command.join(' '))
  }
})

test('group help can select a nested command without executing it', () => {
  for (const command of commands.filter((path) => path.length === 2)) {
    assertHelp([command[0], 'help', command[1]], command.join(' '))
  }
  for (const group of groups) assertHelp(['help', group], group)
  for (const args of [[], ['help'], ['--help'], ['-h']]) assertHelp(args)
})

test('valid options with help do not read attachment or steps files, start probes, or mutate plans', () => {
  const cases = [
    ['login', '--email', 'help@example.invalid', '--help'],
    ['verify', '--email', 'help@example.invalid', '--code', '123456', '--help'],
    ['run', '--file', 'missing.txt', '--image=missing.png', '--progress', '--help'],
    ['run', '--help', '--output', 'text', '--timeout', '1234'],
    ['chat', '--cwd', 'missing-workspace', '--help'],
    ['doctor', '--headless', '--probe', '--integrity', '--json', '--help'],
    ['trace', 'turn-1', '--export', 'otel', '--limit', '10', '--help'],
    ['goal', 'create', 'Example', '--steps-file', 'missing.json', '--no-approval', '--help'],
    ['goal', 'rewrite', 'plan-1', '--steps', 'not parsed by help', '--help'],
    ['goal', 'step', 'plan-1', 'step-1', '--status', 'done', '--manual-confirm', '--help'],
    ['memory', 'reindex', '--all-agents', '--batch', '2', '--help'],
  ]
  for (const args of cases) assertHelp(args, args.slice(0, ['goal', 'memory'].includes(args[0]) ? 2 : 1).join(' '))
})

test('unknown commands and subcommands cannot become successful help', () => {
  for (const args of [['nonsense', '--help'], ['help', 'nonsense'], ['session', 'typo', '--help'], ['help', 'session', 'typo']]) {
    assertUsageError(args, 'CLI_COMMAND_UNKNOWN')
  }
  for (const [group, code] of [['goal', 'CLI_GOAL_SUBCOMMAND_UNKNOWN'], ['memory', 'CLI_MEMORY_SUBCOMMAND_UNKNOWN']]) {
    assertUsageError([group, 'typo', '--help'], code)
    assertUsageError(['help', group, 'typo'], code)
    assertUsageError([group, 'help', 'typo'], code)
  }
})

test('help keeps unknown, duplicate, missing-value and unexpected arguments fail-closed', () => {
  for (const args of [
    ['status', '--typo', '--help'], ['status', '--help', '--typo'],
    ['run', '--help', '--typo'], ['help', 'run', '--typo'],
    ['goal', 'list', '--help', '--typo'], ['memory', 'reindex', '--help', '--typo'],
    ['trace', '--help', '--typo'], ['doctor', '--help', '--typo'],
    ['--help', '--typo'], ['help', '--typo'],
    ['run', '--help=yes'], ['run', '--help', '--help=yes'],
  ]) assertUsageError(args, 'CLI_OPTION_UNKNOWN')
  assertUsageError(['run', '--model', 'one', '--model', 'two', '--help'], 'CLI_OPTION_DUPLICATE')
  assertUsageError(['status', '--help', 'extra'], 'CLI_ARGUMENT_UNEXPECTED')
  assertUsageError(['login', '--help', '--email'], 'CLI_OPTION_VALUE_REQUIRED')
})

test('help-looking values and the run separator keep the real parser contract', () => {
  for (const args of [
    ['run', '--model', '--help'], ['run', '--model=--help'],
    ['doctor', '--headless', '--model', '--help'],
    ['goal', 'step', 'p', 's', '--note', '--help'],
    ['memory', 'reindex', '--agent', '--help'], ['trace', '--session-id', '--help'],
  ]) assertUsageError(args, 'CLI_OPTION_VALUE_REQUIRED')
  for (const args of [
    ['run', '--', '--help'], ['run', '--', '-h'], ['run', '--', 'help'],
    ['run', 'help'], ['run', '--model', '-h'], ['run', '--model=-h'],
  ]) {
    const result = runCli(args)
    assert.equal(result.status, 1, `${args.join(' ')}\n${result.stderr}`)
    assert.match(result.stdout, /CLI_HELP_STDIN_TOUCHED/u, 'the literal prompt/value must reach run, not the help path')
    assert.doesNotMatch(result.stdout, /Usage:/u)
  }
})

test('run error output still honors JSONL and text when help arguments are invalid', () => {
  const json = runCli(['run', '--output', 'jsonl', '--help', '--typo'])
  assert.equal(json.status, 2)
  assert.equal(JSON.parse(json.stdout).error.code, 'CLI_OPTION_UNKNOWN')
  const text = runCli(['run', '--output', 'text', '--help', '--typo'])
  assert.equal(text.status, 2)
  assert.equal(text.stdout, '')
  assert.match(text.stderr, /CLI_OPTION_UNKNOWN/u)
})

test('usage distinguishes steps alternatives, chat alias, resume, and memory scope', () => {
  const goal = assertHelp(['goal', 'create', '--help'], 'goal create')
  assert.match(goal, /--steps <json> \| --steps-file <path>/u)
  const chat = assertHelp(['i', '--help'], 'chat')
  assert.match(chat, /alias.*gugo i|gugo i.*alias/iu)
  const run = assertHelp(['run', '--help'], 'run')
  assert.match(run, /--resume <turnId>/u)
  assert.match(run, /-- <prompt>/u)
  const memory = assertHelp(['memory', 'reindex', '--help'], 'memory reindex')
  assert.match(memory, /global/iu)
  assert.match(memory, /--all-agents \| --agent <agentId>/u)
})

test('a help write failure is propagated once without attempting a second run error write', () => {
  const script = `
    const { main } = await import(${JSON.stringify(new URL('../../bin/yma-cli.js', import.meta.url).href)})
    const originalWrite = process.stdout.write
    const failure = Object.assign(new Error('closed help output'), { code: 'EPIPE' })
    let writes = 0
    let caught
    process.stdout.write = () => { writes++; throw failure }
    try { await main(['run', '--help']) } catch (error) { caught = error }
    process.stdout.write = originalWrite
    process.stdout.write(JSON.stringify({ writes, sameFailure: caught === failure }))
  `
  const result = spawnSync(process.execPath, ['--import', preload, '--input-type=module', '--eval', script], {
    cwd: directory, env, encoding: 'utf8', timeout: 15_000, windowsHide: true,
  })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stderr, '')
  assert.deepEqual(JSON.parse(result.stdout), { writes: 1, sameFailure: true })
  assert.deepEqual(readdirSync(directory), [])
})

test('help exits naturally even when the real stdin pipe remains open', async () => {
  const child = spawn(process.execPath, [CLI, 'run', '--help'], {
    cwd: directory, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const status = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill()
      reject(new Error('help waited for stdin to close'))
    }, 15_000)
    child.once('error', (error) => { clearTimeout(timeout); reject(error) })
    child.once('close', (code) => { clearTimeout(timeout); resolve(code) })
  })
  child.stdin.destroy()
  assert.equal(status, 0, `${stdout}\n${stderr}`)
  assert.equal(stderr, '')
  assert.match(stdout, /Usage:/u)
  assert.deepEqual(readdirSync(directory), [])
})
