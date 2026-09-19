import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { createWindowsTreeKillWorkerManager } from '../../server/utils/windowsTreeKillRuntime.js'

// Readiness only: no user command, model, database or existing user profile.
// Match the CLI artifact fixture's deliberately sparse Windows environment.
function isolatedEnvironment(root) {
  const env = {}
  for (const name of ['SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'SYSTEMDRIVE', 'LANG', 'LC_ALL', 'PATH']) {
    const key = Object.keys(process.env).find((candidate) => candidate.toLowerCase() === name.toLowerCase())
    if (key) env[name] = process.env[key]
  }
  const temp = join(root, 'temp')
  const profile = join(root, 'profile')
  mkdirSync(temp)
  mkdirSync(profile)
  return {
    ...env,
    PATH: [dirname(process.execPath), env.PATH || ''].join(delimiter),
    TEMP: temp, TMP: temp, TMPDIR: temp,
    HOME: profile, USERPROFILE: profile,
    APPDATA: join(profile, 'roaming'), LOCALAPPDATA: join(profile, 'local'),
  }
}

async function diagnoseWorker(attempt) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'gugo-worker-diagnostic-'))
  const env = isolatedEnvironment(root)
  let closed = Promise.resolve()
  let workerChild
  const manager = createWindowsTreeKillWorkerManager({
    spawnProcess: (executable, args, options) => {
      const child = spawn(executable, args, { ...options, env, cwd: root })
      workerChild = child
      // Register before readiness; only this diagnostic's own child is stopped.
      closed = once(child, 'close').catch(() => {})
      return child
    },
  })
  let result
  try {
    await manager.ready({ timeoutMs: 35_000 })
    result = { attempt, ready: true, startup: manager.startupDiagnostics() }
  } catch (error) {
    result = { attempt, ready: false, code: error.code, startup: manager.startupDiagnostics() }
    process.exitCode = 1
  } finally {
    manager.shutdown()
    workerChild?.ref()
    await closed
    rmSync(root, { recursive: true, force: true })
  }
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

if (process.platform !== 'win32') {
  process.stderr.write('Windows worker diagnostics require Windows; no worker was started.\n')
  process.exitCode = 2
} else {
  process.stdout.write(`${JSON.stringify({ platform: process.platform, node: process.version, trials: 3 })}\n`)
  // Three independent cold workers, not success-until-green retries. Any failure
  // keeps the exit code nonzero; the original 30s worker deadline is unchanged.
  for (let attempt = 1; attempt <= 3; attempt += 1) await diagnoseWorker(attempt)
}
