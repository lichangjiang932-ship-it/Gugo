import assert from 'node:assert/strict'
import test, { after, before, beforeEach } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { bashExecTool, FS_SHELL_TOOL_SPECS } from '../server/adapters/fsShellTools.js'
import {
  _testing,
  closeAllShellSessions,
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
  const startedAt = Date.now()
  const parallelResults = await Promise.all([
    runShellSessionCommand({
      userId: 'parallel-a',
      rootPath: workspace,
      cwd: workspace,
      command: waitCommand(500, 'a'),
    }),
    runShellSessionCommand({
      userId: 'parallel-b',
      rootPath: workspace,
      cwd: workspace,
      command: waitCommand(500, 'b'),
    }),
  ])
  const elapsed = Date.now() - startedAt
  assert.ok(elapsed < 1_100, `跨会话应并行，实际 ${elapsed}ms`)
  assert.match(parallelResults[0].stdout, /a/u)
  assert.match(parallelResults[1].stdout, /b/u)
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
  const result = await runShellSessionCommand({
    userId: 'idle-user',
    rootPath: workspace,
    cwd: workspace,
    command: shellEcho('idle'),
    idleTimeoutMs: 40,
  })
  assert.equal(result.code, 0)
  assert.equal(_testing.getSessionCount(), 1)
  await new Promise((resolve) => setTimeout(resolve, 120))
  assert.equal(_testing.getSessionCount(), 0)
})

test('bash_exec schema advertises new and reuse with a compatible default', () => {
  const spec = FS_SHELL_TOOL_SPECS.find((entry) => entry?.function?.name === 'bash_exec')
  const session = spec?.function?.parameters?.properties?.session
  assert.deepEqual(session?.enum, ['new', 'reuse'])
  assert.equal(session?.default, 'new')
})
