import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after, before, beforeEach } from 'node:test'

import {
  closeAllShellSessions,
  runShellSessionCommand,
} from '../server/services/shellSessionStore.js'

const windowsOnly = { skip: process.platform !== 'win32' }
let workspace
let junctionOutside

function canonical(value) {
  return fs.realpathSync.native(value).toLowerCase()
}

function run(userId, command, options = {}) {
  return runShellSessionCommand({
    userId,
    rootPath: workspace,
    cwd: workspace,
    command,
    timeout: 5_000,
    ...options,
  })
}

async function observeState(userId, expectedCwd, expectedEnv) {
  const result = await run(
    userId,
    `cd\r\nnode -e "process.stdout.write(process.env.GUGO_STABLE_STATE||'MISSING')"`,
  )
  assert.equal(result.code, 0, JSON.stringify(result))
  assert.equal(canonical(result.currentCwd), canonical(expectedCwd))
  assert.match(result.stdout, new RegExp(expectedEnv, 'u'))
  return result
}

before(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-win-shell-security-'))
})

beforeEach(async () => {
  await closeAllShellSessions()
})

after(async () => {
  await closeAllShellSessions()
  try { fs.rmSync(workspace, { recursive: true, force: true }) } catch { /* best-effort */ }
  if (junctionOutside) {
    try { fs.rmSync(junctionOutside, { recursive: true, force: true }) } catch { /* best-effort */ }
  }
})

test('Windows logical session gives set /p EOF and remains usable', windowsOnly, async () => {
  const startedAt = Date.now()
  const first = await run(
    'stdin-eof',
    [
      'set "GUGO_STDIN_VALUE=EOF"',
      'set /p "GUGO_STDIN_VALUE=SHOULD_NOT_BE_READ"',
      'echo AFTER_STDIN_EOF:%GUGO_STDIN_VALUE%',
      'ver > nul',
    ].join('\r\n'),
  )
  const next = await run('stdin-eof', 'echo AFTER_SET_P_NEXT_REQUEST')

  assert.equal(first.timedOut, false, JSON.stringify(first))
  assert.equal(first.code, 0, JSON.stringify(first))
  assert.ok(Date.now() - startedAt < 5_000, 'set /p 应从 EOF 立即返回')
  assert.match(first.stdout, /AFTER_STDIN_EOF:EOF/u)
  assert.equal(next.code, 0, JSON.stringify(next))
  assert.match(next.stdout, /AFTER_SET_P_NEXT_REQUEST/u)
})

test('Windows logical session preserves Chinese and emoji command output', windowsOnly, async () => {
  const result = await run('unicode-output', 'echo GUGO_UNICODE:中文🙂')
  assert.equal(result.code, 0, JSON.stringify(result))
  assert.match(result.stdout, /GUGO_UNICODE:中文🙂/u)
})

test('Windows logical session persists a Unicode cwd', windowsOnly, async () => {
  const directory = path.join(workspace, '中文目录-🙂')
  fs.mkdirSync(directory)

  const changed = await run('unicode-cwd', 'cd /d "中文目录-🙂"')
  const observed = await run('unicode-cwd', 'cd')

  assert.equal(changed.code, 0, JSON.stringify(changed))
  assert.equal(canonical(changed.currentCwd), canonical(directory))
  assert.equal(observed.code, 0, JSON.stringify(observed))
  assert.equal(canonical(observed.currentCwd), canonical(directory))
  assert.match(observed.stdout, /中文目录-🙂/u)
})

test('Windows ERRORLEVEL environment spoof cannot forge the real exit code', windowsOnly, async () => {
  const result = await run(
    'errorlevel-spoof',
    'set ERRORLEVEL=999\r\ncmd.exe /d /c exit 7',
  )
  assert.equal(result.code, 7, JSON.stringify(result))
})

test('Windows logical session normalizes signed -1 to the unsigned process exit code', windowsOnly, async () => {
  const result = await run(
    'unsigned-exit-code',
    'cmd.exe /d /c exit /b -1',
  )

  assert.equal(result.code, 0xFFFFFFFF, JSON.stringify(result))
  assert.notEqual(result.sessionCrashed, true, JSON.stringify(result))
})

test('Windows setlocal with delayed expansion disabled still returns a trusted exit receipt', windowsOnly, async () => {
  const result = await run(
    'setlocal-exit-receipt',
    [
      'setlocal DisableDelayedExpansion',
      'echo GUGO_SETLOCAL_BANG:before!literal!after',
      'exit /b 7',
    ].join('\r\n'),
  )

  assert.equal(result.timedOut, false, JSON.stringify(result))
  assert.equal(result.code, 7, JSON.stringify(result))
  assert.notEqual(result.sessionCrashed, true, JSON.stringify(result))
  assert.match(result.stdout, /GUGO_SETLOCAL_BANG:before!literal!after/u)
})

test('Windows missing shell executable reports startup failure instead of an invalid receipt', windowsOnly, async () => {
  const originalComspec = process.env.COMSPEC
  try {
    process.env.COMSPEC = path.join(
      workspace,
      `gugo-missing-shell-${process.pid}-${Date.now()}.exe`,
    )
    const result = await run('missing-shell-executable', 'echo MUST_NOT_RUN')

    assert.equal(result.code, null)
    assert.equal(result.sessionCrashed, true)
    assert.equal(result.processStartFailed, true)
    assert.match(result.processStartError, /ENOENT/iu)
    assert.equal(result.processIsolationFailed, false)
    assert.match(result.error, /(?:启动失败|ENOENT)/iu)
    assert.doesNotMatch(result.error, /回执无效/iu)
    assert.match(result.stderr, /ENOENT/iu)
  } finally {
    if (originalComspec === undefined) delete process.env.COMSPEC
    else process.env.COMSPEC = originalComspec
  }
})

test('Windows logical session preserves literal exclamation-mark expressions', windowsOnly, async () => {
  const result = await run(
    'literal-exclamation-output',
    [
      'set "GUGO_BANG_EXPANSION_PROBE="',
      'echo GUGO_LITERAL_BANG:before!GUGO_BANG_EXPANSION_PROBE!after',
    ].join('\r\n'),
  )

  assert.equal(result.timedOut, false, JSON.stringify(result))
  assert.equal(result.code, 0, JSON.stringify(result))
  assert.notEqual(result.sessionCrashed, true, JSON.stringify(result))
  assert.match(
    result.stdout,
    /GUGO_LITERAL_BANG:before!GUGO_BANG_EXPANSION_PROBE!after/u,
  )
  assert.doesNotMatch(result.stdout, /GUGO_LITERAL_BANG:beforeafter/u)
})

test('Windows CD environment spoof cannot replace the committed cwd', windowsOnly, async () => {
  const stable = path.join(workspace, 'stable-cd')
  fs.mkdirSync(stable)
  const forged = path.join(path.dirname(workspace), 'gugo-forged-cd')

  const initialized = await run('cd-spoof', 'cd /d "stable-cd"')
  const spoofed = await run('cd-spoof', `set "CD=${forged}"`)
  const observed = await run('cd-spoof', 'cd')

  assert.equal(initialized.code, 0, JSON.stringify(initialized))
  assert.equal(spoofed.code, 0, JSON.stringify(spoofed))
  assert.equal(observed.code, 0, JSON.stringify(observed))
  assert.equal(canonical(observed.currentCwd), canonical(stable))
  assert.doesNotMatch(observed.stdout, /gugo-forged-cd/iu)
})

test('Windows fixed legacy prompt text is preserved as ordinary stdout', windowsOnly, async () => {
  const result = await run(
    'prompt-output',
    'echo __GUGO_PROMPT__\r\necho BEFORE__GUGO_PROMPT__AFTER',
  )
  assert.equal(result.code, 0, JSON.stringify(result))
  assert.match(result.stdout, /__GUGO_PROMPT__/u)
  assert.match(result.stdout, /BEFORE__GUGO_PROMPT__AFTER/u)
})

test('Windows ephemeral env is case-insensitive and does not leak', windowsOnly, async () => {
  const readEnv = `node -e "process.stdout.write(process.env.GUGO_EPHEMERAL_SECURITY||'MISSING')"`
  const initialized = await run(
    'ephemeral-env',
    'set "GUGO_EPHEMERAL_SECURITY=persistent"',
  )
  const temporary = await run('ephemeral-env', readEnv, {
    beforeExecute: async () => ({
      ephemeralEnv: { gugo_ephemeral_security: 'temporary' },
    }),
  })
  const restored = await run('ephemeral-env', readEnv)

  assert.equal(initialized.code, 0, JSON.stringify(initialized))
  assert.equal(temporary.code, 0, JSON.stringify(temporary))
  assert.match(temporary.stdout, /temporary/u)
  assert.equal(restored.code, 0, JSON.stringify(restored))
  assert.match(restored.stdout, /persistent/u)
  assert.doesNotMatch(restored.stdout, /temporary/u)
})

test('Windows starts every logical-session request on code page 65001', windowsOnly, async () => {
  const initial = await run('code-page', 'chcp')
  const changed = await run('code-page', 'chcp 437 > nul')
  const reset = await run('code-page', 'chcp')

  assert.equal(initial.code, 0, JSON.stringify(initial))
  assert.match(initial.stdout, /65001/u)
  assert.equal(changed.code, 0, JSON.stringify(changed))
  assert.equal(reset.code, 0, JSON.stringify(reset))
  assert.match(reset.stdout, /65001/u)
})

test('Windows timeout rolls back cwd and environment to the last committed snapshot', windowsOnly, async () => {
  const stable = path.join(workspace, 'timeout-stable')
  fs.mkdirSync(stable)
  fs.mkdirSync(path.join(workspace, 'timeout-mutated'))
  const initialized = await run(
    'timeout-rollback',
    'cd /d "timeout-stable"\r\nset "GUGO_STABLE_STATE=committed-timeout"',
  )
  assert.equal(initialized.code, 0, JSON.stringify(initialized))

  const timedOut = await run(
    'timeout-rollback',
    'cd /d "..\\timeout-mutated"\r\nset "GUGO_STABLE_STATE=uncommitted-timeout"\r\nnode -e "setTimeout(()=>{},10000)"',
    { timeout: 250 },
  )
  const observed = await observeState('timeout-rollback', stable, 'committed-timeout')

  assert.equal(timedOut.timedOut, true, JSON.stringify(timedOut))
  assert.doesNotMatch(observed.stdout, /uncommitted-timeout/u)
})

test('Windows abort rolls back cwd and environment to the last committed snapshot', windowsOnly, async () => {
  const stable = path.join(workspace, 'abort-stable')
  fs.mkdirSync(stable)
  fs.mkdirSync(path.join(workspace, 'abort-mutated'))
  const initialized = await run(
    'abort-rollback',
    'cd /d "abort-stable"\r\nset "GUGO_STABLE_STATE=committed-abort"',
  )
  assert.equal(initialized.code, 0, JSON.stringify(initialized))

  const controller = new AbortController()
  const pending = run(
    'abort-rollback',
    'cd /d "..\\abort-mutated"\r\nset "GUGO_STABLE_STATE=uncommitted-abort"\r\nnode -e "setTimeout(()=>{},10000)"',
    { signal: controller.signal },
  )
  setTimeout(() => controller.abort(), 250)
  const aborted = await pending
  const observed = await observeState('abort-rollback', stable, 'committed-abort')

  assert.equal(aborted.aborted, true, JSON.stringify(aborted))
  assert.doesNotMatch(observed.stdout, /uncommitted-abort/u)
})

test('Windows exit and exit /b leave the last committed snapshot recoverable', windowsOnly, async () => {
  for (const [suffix, exitCommand] of [['exit', 'exit 23'], ['exit-b', 'exit /b 19']]) {
    const userId = `missing-frame-${suffix}`
    const directoryName = `exit-stable-${suffix}`
    const stable = path.join(workspace, directoryName)
    fs.mkdirSync(stable)
    const initialized = await run(
      userId,
      `cd /d "${directoryName}"\r\nset "GUGO_STABLE_STATE=committed-${suffix}"`,
    )
    assert.equal(initialized.code, 0, JSON.stringify(initialized))

    await run(userId, exitCommand)
    await observeState(userId, stable, `committed-${suffix}`)
  }
})

test('Windows rejects a junction cwd escape without committing it', windowsOnly, async (t) => {
  const stable = path.join(workspace, 'junction-stable')
  const junction = path.join(workspace, 'junction-outside')
  fs.mkdirSync(stable)
  junctionOutside = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-junction-outside-'))
  try {
    fs.symlinkSync(junctionOutside, junction, 'junction')
  } catch (error) {
    if (['EPERM', 'EACCES', 'UNKNOWN'].includes(error?.code)) {
      t.skip(`当前 Windows 环境无法创建 junction: ${error.code}`)
      return
    }
    throw error
  }

  const initialized = await run(
    'junction-boundary',
    'cd /d "junction-stable"\r\nset "GUGO_STABLE_STATE=committed-junction"',
  )
  assert.equal(initialized.code, 0, JSON.stringify(initialized))

  await run(
    'junction-boundary',
    'cd /d "..\\junction-outside"\r\nset "GUGO_STABLE_STATE=uncommitted-junction"',
  )
  const observed = await observeState(
    'junction-boundary',
    stable,
    'committed-junction',
  )
  assert.doesNotMatch(observed.stdout, /uncommitted-junction/u)
})
