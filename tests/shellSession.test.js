import assert from 'node:assert/strict'
import test, { after, before, beforeEach } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'

import { bashExecTool, FS_SHELL_TOOL_SPECS } from '../server/adapters/fsShellTools.js'
import { setChildReferenced } from '../server/services/shellSessionRuntime.js'
import {
  buildWindowsTrustedInvocation,
  mergeWindowsEnvironment,
} from '../server/services/windowsShellSessionProtocol.js'
import {
  _testing,
  closeAllShellSessions,
  closeShellSession,
  runShellSessionCommand,
} from '../server/services/shellSessionStore.js'

let workspace
const savedEnv = {
  APP_DATA_DIR: process.env.APP_DATA_DIR,
  WORKSPACE_ROOT: process.env.WORKSPACE_ROOT,
  WORKSPACE_SHELL_ENABLED: process.env.WORKSPACE_SHELL_ENABLED,
  WORKSPACE_SHARED_TRUSTED: process.env.WORKSPACE_SHARED_TRUSTED,
  GH_TOKEN: process.env.GH_TOKEN,
}

function restoreEnv() {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

function shellEcho(value) {
  return process.platform === 'win32' ? `echo ${value}` : `printf '%s\\n' '${value}'`
}

function shellSet(key, value) {
  return process.platform === 'win32'
    ? `set ${key}=${value}`
    : `export ${key}='${value}'`
}

function shellRead(key) {
  return process.platform === 'win32' ? `echo %${key}%` : `printf '%s' "$${key}"`
}

function envDigest(value) {
  return createHash('sha256').update(String(value)).digest('hex')
}

function shellEnvDigest(key) {
  return `node -e "const c=require('node:crypto');process.stdout.write(c.createHash('sha256').update(process.env.${key}||'').digest('hex'))"`
}

function waitCommand(milliseconds, output = '') {
  const source = output
    ? `setTimeout(() => process.stdout.write('${output}'), ${milliseconds})`
    : `setTimeout(() => {}, ${milliseconds})`
  return `node -e "${source}"`
}

async function closeSessions() {
  await closeAllShellSessions()
  if (process.platform === 'win32') {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

async function waitForCondition(predicate, {
  timeoutMs = 5_000,
  intervalMs = 10,
  message = 'condition was not satisfied before the deadline',
} = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  assert.equal(predicate(), true, message)
}

before(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-shell-session-'))
  process.env.APP_DATA_DIR = path.join(workspace, '.data')
  process.env.WORKSPACE_ROOT = workspace
  process.env.WORKSPACE_SHELL_ENABLED = '1'
  process.env.WORKSPACE_SHARED_TRUSTED = '1'
})

beforeEach(async () => {
  await closeSessions()
  delete process.env.GH_TOKEN
})

after(async () => {
  await closeSessions()
  restoreEnv()
  try { fs.rmSync(workspace, { recursive: true, force: true }) } catch { /* best-effort */ }
})

test('bash_exec reuse keeps cwd, shell env, and virtual-environment activation', async () => {
  const nested = path.join(workspace, 'persistent-cwd')
  const venvRoot = path.join(nested, 'fake-venv')
  fs.mkdirSync(nested, { recursive: true })
  if (process.platform === 'win32') {
    const scripts = path.join(venvRoot, 'Scripts')
    fs.mkdirSync(scripts, { recursive: true })
    fs.writeFileSync(
      path.join(scripts, 'activate.bat'),
      '@set "VIRTUAL_ENV=%CD%\\fake-venv"\r\n@set "PATH=%VIRTUAL_ENV%\\Scripts;%PATH%"\r\n',
      'utf8',
    )
  } else {
    const bin = path.join(venvRoot, 'bin')
    fs.mkdirSync(bin, { recursive: true })
    fs.writeFileSync(
      path.join(bin, 'activate'),
      'VIRTUAL_ENV="$PWD/fake-venv"\nexport VIRTUAL_ENV\nPATH="$VIRTUAL_ENV/bin:$PATH"\nexport PATH\n',
      'utf8',
    )
  }

  const changed = await bashExecTool({
    session: 'reuse',
    command: process.platform === 'win32' ? 'cd persistent-cwd' : 'cd persistent-cwd',
  })
  assert.equal(changed.ok, true, JSON.stringify(changed))
  assert.equal(changed.cwd, 'persistent-cwd')

  const envSet = await bashExecTool({
    session: 'reuse',
    command: shellSet('GUGO_REPL_STATE', 'retained'),
  })
  assert.equal(envSet.ok, true, JSON.stringify(envSet))

  const activated = await bashExecTool({
    session: 'reuse',
    command: process.platform === 'win32'
      ? 'call fake-venv\\Scripts\\activate.bat'
      : '. fake-venv/bin/activate',
  })
  assert.equal(activated.ok, true, JSON.stringify(activated))

  const observed = await bashExecTool({
    session: 'reuse',
    command: process.platform === 'win32'
      ? 'echo %CD% & echo %GUGO_REPL_STATE% & echo %VIRTUAL_ENV%'
      : 'pwd -P; printf "%s\\n" "$GUGO_REPL_STATE"; printf "%s\\n" "$VIRTUAL_ENV"',
  })
  assert.equal(observed.ok, true, JSON.stringify(observed))
  assert.match(observed.stdout, /persistent-cwd/u)
  assert.match(observed.stdout, /retained/u)
  assert.match(observed.stdout, /fake-venv/u)
})

test('bash_exec defaults to a fresh shell and validates the session enum', async () => {
  const first = await bashExecTool({ command: shellSet('GUGO_NEW_STATE', 'must-not-persist') })
  assert.equal(first.ok, true)
  const second = await bashExecTool({ command: shellRead('GUGO_NEW_STATE') })
  assert.equal(second.ok, true)
  assert.doesNotMatch(second.stdout, /must-not-persist/u)
  await assert.rejects(
    () => bashExecTool({ command: shellEcho('no'), session: 'shared' }),
    (error) => error?.code === 'SHELL_SESSION_INVALID',
  )
})

test('reuse resolves relative expected_outputs from the live session cwd', async () => {
  const nested = path.join(workspace, 'expected-live-cwd')
  fs.mkdirSync(nested, { recursive: true })
  const cdResult = await bashExecTool({ session: 'reuse', command: 'cd expected-live-cwd' })
  assert.equal(cdResult.ok, true, JSON.stringify(cdResult))

  const result = await bashExecTool({
    session: 'reuse',
    command: process.platform === 'win32'
      ? 'echo generated>artifact.txt'
      : "printf generated > artifact.txt",
    expected_outputs: ['artifact.txt'],
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.deepEqual(result.changedPaths, ['expected-live-cwd/artifact.txt'])
  assert.equal(fs.readFileSync(path.join(nested, 'artifact.txt'), 'utf8').trim(), 'generated')
})

test('reuse still applies bashGuard before the persistent process receives a command', async () => {
  await assert.rejects(
    () => bashExecTool({ session: 'reuse', command: 'rm -rf /' }),
    /命令被安全策略拦截/u,
  )
  const result = await bashExecTool({ session: 'reuse', command: shellEcho('still-safe') })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.match(result.stdout, /still-safe/u)
})

test('approved env_keys are temporary and cannot leak into a later reuse call', async () => {
  process.env.GH_TOKEN = 'gugo-session-secret-value'
  const approved = await bashExecTool({
    session: 'reuse',
    command: shellRead('GH_TOKEN'),
    env_keys: ['GH_TOKEN'],
  })
  assert.equal(approved.ok, true, JSON.stringify(approved))
  assert.equal(approved.sensitiveOutputRedacted, true)
  assert.match(approved.stdout, /\[REDACTED\]/u)

  const later = await bashExecTool({ session: 'reuse', command: shellRead('GH_TOKEN') })
  assert.equal(later.ok, true, JSON.stringify(later))
  assert.doesNotMatch(JSON.stringify(later), /gugo-session-secret-value/u)
})

test('Windows reuse transports approved env values as data without cmd injection or corruption', {
  skip: process.platform !== 'win32',
}, async () => {
  const persistentValue = 'persistent-original'
  const initialized = await bashExecTool({
    session: 'reuse',
    command: `set "GH_TOKEN=${persistentValue}"`,
  })
  assert.equal(initialized.ok, true, JSON.stringify(initialized))

  const rawValue = ` leading " & echo GUGO_ENV_INJECTION_PROBE & rem | < > % ! ^ 中文🙂\r\ntrailing ${'x'.repeat(4_000)} `
  const normalizedValue = rawValue.replace(/[\r\n]+/gu, ' ')
  process.env.GH_TOKEN = rawValue
  const approved = await bashExecTool({
    session: 'reuse',
    command: `echo TARGET & ${shellEnvDigest('GH_TOKEN')}`,
    env_keys: ['GH_TOKEN'],
  })
  assert.equal(approved.ok, true, JSON.stringify(approved))
  assert.match(approved.stdout, /TARGET/u)
  assert.match(approved.stdout, new RegExp(envDigest(normalizedValue), 'u'))
  assert.doesNotMatch(approved.stdout, /GUGO_ENV_INJECTION_PROBE/u)
  assert.doesNotMatch(approved.stdout, /__GUGO_ENV_INPUT__/u)

  delete process.env.GH_TOKEN
  const restored = await bashExecTool({
    session: 'reuse',
    command: shellEnvDigest('GH_TOKEN'),
  })
  assert.equal(restored.ok, true, JSON.stringify(restored))
  assert.match(restored.stdout, new RegExp(envDigest(persistentValue), 'u'))
})

test('Windows reuse accepts an explicitly empty approved env value', {
  skip: process.platform !== 'win32',
}, async () => {
  process.env.GH_TOKEN = ''
  const result = await bashExecTool({
    session: 'reuse',
    command: shellEnvDigest('GH_TOKEN'),
    env_keys: ['GH_TOKEN'],
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.match(result.stdout, new RegExp(envDigest(''), 'u'))
})

test('Windows reuse rejects oversized env values before execution and keeps the session usable', {
  skip: process.platform !== 'win32',
}, async () => {
  process.env.GH_TOKEN = 'x'.repeat(8_001)
  await assert.rejects(
    () => bashExecTool({
      session: 'reuse',
      command: 'echo MUST_NOT_RUN',
      env_keys: ['GH_TOKEN'],
    }),
    (error) => error?.code === 'SHELL_ENV_VALUE_TOO_LONG',
  )
  delete process.env.GH_TOKEN
  const next = await bashExecTool({ session: 'reuse', command: 'echo after-rejection' })
  assert.equal(next.ok, true, JSON.stringify(next))
  assert.match(next.stdout, /after-rejection/u)
})

test('Windows reuse accepts an env value at the exact 8000-character boundary', {
  skip: process.platform !== 'win32',
}, async () => {
  const boundaryValue = 'x'.repeat(8_000)
  process.env.GH_TOKEN = boundaryValue
  const result = await bashExecTool({
    session: 'reuse',
    command: shellEnvDigest('GH_TOKEN'),
    env_keys: ['GH_TOKEN'],
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.match(result.stdout, new RegExp(envDigest(boundaryValue), 'u'))
})

test('Windows logical sessions reset every request to UTF-8 after code-page changes', {
  skip: process.platform !== 'win32',
}, async () => {
  const switched = await runShellSessionCommand({
    userId: 'code-page-restore-user',
    rootPath: workspace,
    cwd: workspace,
    command: 'chcp 437 > nul',
  })
  assert.equal(switched.code, 0, JSON.stringify(switched))

  const transferred = await runShellSessionCommand({
    userId: 'code-page-restore-user',
    rootPath: workspace,
    cwd: workspace,
    command: 'echo %GUGO_CODE_PAGE_VALUE%',
    beforeExecute: async () => ({ ephemeralEnv: { GUGO_CODE_PAGE_VALUE: '传输值' } }),
  })
  assert.equal(transferred.code, 0, JSON.stringify(transferred))

  const observed = await runShellSessionCommand({
    userId: 'code-page-restore-user',
    rootPath: workspace,
    cwd: workspace,
    command: 'chcp',
  })
  assert.equal(observed.code, 0, JSON.stringify(observed))
  assert.match(observed.stdout, /65001/u)
})

test('Windows env transfer restores a persistent shell value containing exclamation marks', {
  skip: process.platform !== 'win32',
}, async () => {
  const key = 'GUGO_PERSISTENT_BANG_VALUE'
  const persistentValue = 'left!middle!right'
  const temporaryValue = 'temporary-value'
  const options = {
    userId: 'bang-value-restore-user',
    rootPath: workspace,
    cwd: workspace,
    env: { ...process.env, [key]: persistentValue },
  }

  const initial = await runShellSessionCommand({
    ...options,
    command: shellEnvDigest(key),
  })
  assert.equal(initial.code, 0, JSON.stringify(initial))
  assert.match(initial.stdout, new RegExp(envDigest(persistentValue), 'u'))

  const temporary = await runShellSessionCommand({
    ...options,
    command: shellEnvDigest(key),
    beforeExecute: async () => ({ ephemeralEnv: { [key]: temporaryValue } }),
  })
  assert.equal(temporary.code, 0, JSON.stringify(temporary))
  assert.match(temporary.stdout, new RegExp(envDigest(temporaryValue), 'u'))

  const restored = await runShellSessionCommand({
    ...options,
    command: shellEnvDigest(key),
  })
  assert.equal(restored.code, 0, JSON.stringify(restored))
  assert.match(restored.stdout, new RegExp(envDigest(persistentValue), 'u'))
})

test('Windows env transfer payload never embeds the approved value in command text', {
  skip: process.platform !== 'win32',
}, () => {
  const secret = 'safe" & echo GUGO_ENV_INJECTION_PROBE & rem %PATH% !PATH! ^ | < >'
  const token = '0123456789abcdef'
  const invocation = buildWindowsTrustedInvocation({
    commandFile: 'C:\\gugo\\command.cmd',
    token,
  })
  const executionEnv = mergeWindowsEnvironment({ Path: 'C:\\Windows' }, { GH_TOKEN: secret })
  const trustedCommandText = [...invocation.shellArgs, invocation.stdinInput].join('\n')

  assert.equal(executionEnv.GH_TOKEN, secret)
  assert.doesNotMatch(trustedCommandText, /GUGO_ENV_INJECTION_PROBE/u)
  assert.doesNotMatch(trustedCommandText, /GH_TOKEN/u)
})

test('a pre-aborted reuse request never runs its command or preparation callback', async () => {
  const probe = path.join(workspace, 'pre-aborted-probe.txt')
  const controller = new AbortController()
  let prepared = false
  controller.abort()

  const result = await runShellSessionCommand({
    userId: 'pre-aborted-user',
    rootPath: workspace,
    cwd: workspace,
    command: `node -e "require('node:fs').writeFileSync('pre-aborted-probe.txt','must-not-run')"`,
    signal: controller.signal,
    beforeExecute: async () => {
      prepared = true
      return { ephemeralEnv: { GUGO_ABORT_PROBE: 'must-not-transfer' } }
    },
  })

  assert.equal(result.aborted, true, JSON.stringify(result))
  assert.equal(result.killed, false, JSON.stringify(result))
  assert.equal(prepared, false)
  assert.equal(fs.existsSync(probe), false)

  const next = await runShellSessionCommand({
    userId: 'pre-aborted-user',
    rootPath: workspace,
    cwd: workspace,
    command: shellEcho('after-pre-abort'),
  })
  assert.equal(next.code, 0, JSON.stringify(next))
  assert.match(next.stdout, /after-pre-abort/u)
})

test('a reuse request aborted while queued never reaches the persistent shell', async () => {
  const probe = path.join(workspace, 'queued-abort-probe.txt')
  const controller = new AbortController()
  const first = runShellSessionCommand({
    userId: 'queued-abort-user',
    rootPath: workspace,
    cwd: workspace,
    command: waitCommand(300, 'queue-blocker'),
  })
  const queued = runShellSessionCommand({
    userId: 'queued-abort-user',
    rootPath: workspace,
    cwd: workspace,
    command: `node -e "require('node:fs').writeFileSync('queued-abort-probe.txt','must-not-run')"`,
    signal: controller.signal,
  })
  controller.abort()

  const [firstResult, queuedResult] = await Promise.all([first, queued])
  assert.equal(firstResult.code, 0, JSON.stringify(firstResult))
  assert.equal(queuedResult.aborted, true, JSON.stringify(queuedResult))
  assert.equal(queuedResult.killed, false, JSON.stringify(queuedResult))
  assert.equal(fs.existsSync(probe), false)
})

test('closing a session fences a request paused in beforeExecute', async () => {
  const probe = path.join(workspace, 'close-during-prepare-probe.txt')
  let releasePrepare
  let markPreparing
  const preparing = new Promise((resolve) => { markPreparing = resolve })
  const prepareGate = new Promise((resolve) => { releasePrepare = resolve })
  const pending = runShellSessionCommand({
    userId: 'close-during-prepare-user',
    rootPath: workspace,
    cwd: workspace,
    command: `node -e "require('node:fs').writeFileSync('close-during-prepare-probe.txt','must-not-run')"`,
    beforeExecute: async () => {
      markPreparing()
      await prepareGate
      return null
    },
  })

  await preparing
  let closeSettled = false
  const closing = closeShellSession({
    userId: 'close-during-prepare-user',
    rootPath: workspace,
  }).then((closed) => {
    closeSettled = true
    return closed
  })
  await assert.rejects(pending, (error) => error?.code === 'SHELL_SESSION_CLOSED')
  await new Promise((resolve) => setTimeout(resolve, 25))
  assert.equal(closeSettled, false, 'close must wait for the preparing pump to cross its shutdown fence')
  releasePrepare()
  assert.equal(await closing, true)
  assert.equal(fs.existsSync(probe), false)
  assert.equal(_testing.getSessionCount(), 0)
  assert.deepEqual(_testing.getSessionSnapshot(), [])
})

test('closeAll fences every request paused in beforeExecute', async () => {
  const probes = ['close-all-prepare-a.txt', 'close-all-prepare-b.txt']
  const releases = []
  const preparing = []
  const pending = probes.map((probe, index) => {
    let markPreparing
    preparing.push(new Promise((resolve) => { markPreparing = resolve }))
    let releasePrepare
    const prepareGate = new Promise((resolve) => { releasePrepare = resolve })
    releases.push(releasePrepare)
    return runShellSessionCommand({
      userId: `close-all-prepare-${index}`,
      rootPath: workspace,
      cwd: workspace,
      command: `node -e "require('node:fs').writeFileSync('${probe}','must-not-run')"`,
      beforeExecute: async () => {
        markPreparing()
        await prepareGate
        return null
      },
    })
  })

  await Promise.all(preparing)
  const closing = closeAllShellSessions()
  await Promise.all(pending.map((request) => (
    assert.rejects(request, (error) => error?.code === 'SHELL_SESSION_CLOSED')
  )))
  for (const release of releases) release()
  await closing
  assert.equal(probes.some((probe) => fs.existsSync(path.join(workspace, probe))), false)
  assert.equal(_testing.getSessionCount(), 0)
  assert.deepEqual(_testing.getSessionSnapshot(), [])
})

test('same-session commands serialize while different user sessions run in parallel', async () => {
  const order = []
  const first = runShellSessionCommand({
    userId: 'serial-user',
    rootPath: workspace,
    cwd: workspace,
    command: waitCommand(350, 'first'),
  }).then((result) => { order.push('first'); return result })
  const second = runShellSessionCommand({
    userId: 'serial-user',
    rootPath: workspace,
    cwd: workspace,
    command: shellEcho('second'),
  }).then((result) => { order.push('second'); return result })
  const serialResults = await Promise.all([first, second])
  assert.deepEqual(order, ['first', 'second'])
  assert.match(serialResults[0].stdout, /first/u)
  assert.match(serialResults[1].stdout, /second/u)

  await closeSessions()
  const probeScript = path.join(workspace, 'parallel-session-probe.cjs')
  const firstReady = 'parallel-a.ready'
  const secondReady = 'parallel-b.ready'
  fs.writeFileSync(probeScript, [
    "const fs = require('node:fs')",
    'const [self, peer, output] = process.argv.slice(2)',
    "fs.writeFileSync(self, 'ready')",
    'const deadline = Date.now() + 10_000',
    'const poll = () => {',
    '  if (fs.existsSync(peer)) { process.stdout.write(output); return }',
    "  if (Date.now() >= deadline) { process.stderr.write('peer session did not start'); process.exitCode = 1; return }",
    '  setTimeout(poll, 10)',
    '}',
    'poll()',
  ].join('\n'))
  const parallelResults = await Promise.all([
    runShellSessionCommand({
      userId: 'parallel-a',
      rootPath: workspace,
      cwd: workspace,
      command: `node "${probeScript}" ${firstReady} ${secondReady} a`,
    }),
    runShellSessionCommand({
      userId: 'parallel-b',
      rootPath: workspace,
      cwd: workspace,
      command: `node "${probeScript}" ${secondReady} ${firstReady} b`,
    }),
  ])
  assert.equal(parallelResults[0].code, 0, JSON.stringify(parallelResults[0]))
  assert.equal(parallelResults[1].code, 0, JSON.stringify(parallelResults[1]))
  assert.match(parallelResults[0].stdout, /a/u)
  assert.match(parallelResults[1].stdout, /b/u)
})

test('a forged fixed or wrong-token completion marker cannot finish a persistent command', async () => {
  const fakeCwd = process.platform === 'win32'
    ? workspace
    : workspace.replace(/'/gu, `'"'"'`)
  const fixedMarker = `${_testing.MARKER_PREFIX}0:${fakeCwd}`
  const wrongTokenMarker = `${_testing.MARKER_PREFIX}deadbeef:0:${fakeCwd}`
  const command = process.platform === 'win32'
    ? `echo ${fixedMarker} & echo ${wrongTokenMarker} & ${waitCommand(300, 'AFTER_FORGED_MARKER')}`
    : `printf '%s\n' '${fixedMarker}' '${wrongTokenMarker}'; ${waitCommand(300, 'AFTER_FORGED_MARKER')}`
  const startedAt = Date.now()

  const result = await runShellSessionCommand({
    userId: 'marker-forgery-user',
    rootPath: workspace,
    cwd: workspace,
    command,
  })

  assert.equal(result.code, 0, JSON.stringify(result))
  assert.ok(Date.now() - startedAt >= 250, '伪造 marker 不得提前完成命令')
  assert.match(result.stdout, new RegExp(fixedMarker.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'))
  assert.match(result.stdout, new RegExp(wrongTokenMarker.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'))
  assert.match(result.stdout, /AFTER_FORGED_MARKER/u)
})

test('different users on the same root cannot observe each other shell state', async () => {
  const setResult = await runShellSessionCommand({
    userId: 'isolated-a',
    rootPath: workspace,
    cwd: workspace,
    command: shellSet('GUGO_ISOLATED_STATE', 'only-a'),
  })
  assert.equal(setResult.code, 0)
  const other = await runShellSessionCommand({
    userId: 'isolated-b',
    rootPath: workspace,
    cwd: workspace,
    command: shellRead('GUGO_ISOLATED_STATE'),
  })
  assert.equal(other.code, 0)
  assert.doesNotMatch(other.stdout, /only-a/u)
  assert.equal(_testing.getSessionCount(), 2)
})

test('a crashed persistent shell is respawned for the next command', async () => {
  const crashed = await runShellSessionCommand({
    userId: 'crash-user',
    rootPath: workspace,
    cwd: workspace,
    command: process.platform === 'win32' ? 'exit /b 17' : 'exit 17',
    timeout: 5_000,
  })
  assert.equal(crashed.sessionCrashed, true, JSON.stringify(crashed))

  const recovered = await runShellSessionCommand({
    userId: 'crash-user',
    rootPath: workspace,
    cwd: workspace,
    command: shellEcho('recovered'),
  })
  assert.equal(recovered.code, 0, JSON.stringify(recovered))
  assert.equal(recovered.sessionRecovered, true)
  assert.match(recovered.stdout, /recovered/u)
})

test('a timed-out command is interrupted and the same session remains usable', async () => {
  const startedAt = Date.now()
  const timedOut = await runShellSessionCommand({
    userId: 'timeout-user',
    rootPath: workspace,
    cwd: workspace,
    command: waitCommand(10_000),
    timeout: 250,
  })
  const elapsed = Date.now() - startedAt
  assert.equal(timedOut.timedOut, true, JSON.stringify(timedOut))
  assert.ok(elapsed < 6_000, `超时中断耗时过长: ${elapsed}ms`)

  const next = await runShellSessionCommand({
    userId: 'timeout-user',
    rootPath: workspace,
    cwd: workspace,
    command: shellEcho('after-timeout'),
  })
  assert.equal(next.code, 0, JSON.stringify(next))
  assert.match(next.stdout, /after-timeout/u)
})

test('idle sessions are removed automatically', async () => {
  const idleTimeoutMs = 40
  const result = await runShellSessionCommand({
    userId: 'idle-user',
    rootPath: workspace,
    cwd: workspace,
    command: shellEcho('idle'),
    idleTimeoutMs,
  })
  assert.equal(result.code, 0)
  assert.equal(_testing.getSessionCount(), 1)
  await waitForCondition(() => _testing.getSessionCount() === 0, {
    timeoutMs: idleTimeoutMs + _testing.INTERRUPT_GRACE_MS + 5_000,
    message: 'idle shell session was not removed after its shutdown grace period',
  })
  assert.equal(_testing.getSessionCount(), 0)
})

test('bash_exec schema advertises new and reuse with a compatible default', () => {
  const spec = FS_SHELL_TOOL_SPECS.find((entry) => entry?.function?.name === 'bash_exec')
  const session = spec?.function?.parameters?.properties?.session
  assert.deepEqual(session?.enum, ['new', 'reuse'])
  assert.equal(session?.default, 'new')
})

test('persistent shell reference toggling includes auxiliary protocol pipes', () => {
  const calls = []
  const stream = (name) => ({
    ref: () => calls.push(`ref:${name}`),
    unref: () => calls.push(`unref:${name}`),
  })
  const stdin = stream('stdin')
  const stdout = stream('stdout')
  const stderr = stream('stderr')
  const protocol = stream('protocol')
  const child = {
    ref: () => calls.push('ref:child'),
    unref: () => calls.push('unref:child'),
    stdin,
    stdout,
    stderr,
    stdio: [stdin, stdout, stderr, protocol],
  }

  setChildReferenced(child, false)
  assert.deepEqual(calls, [
    'unref:child',
    'unref:stdin',
    'unref:stdout',
    'unref:stderr',
    'unref:protocol',
  ])

  calls.length = 0
  setChildReferenced(child, true)
  assert.deepEqual(calls, [
    'ref:child',
    'ref:stdin',
    'ref:stdout',
    'ref:stderr',
    'ref:protocol',
  ])
})
