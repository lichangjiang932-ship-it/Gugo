import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { resolveExecutable, spawnPlan } from '../server/services/previewServerStore.js'

/**
 * The spawn plan is where a configured command becomes a process. It is asserted
 * here, on whatever platform CI runs, because the Windows branch is the one that
 * cannot be exercised by running it on Linux — and it is the branch that decides
 * whether `npm` is found at all.
 */

const fakePath = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-preview-spawn-'))
fs.writeFileSync(path.join(fakePath, 'npm.cmd'), '@echo off\n', 'utf8')
// A file with no extension, first on PATH: on Windows that is not a program, so
// it must not win over the shim beside it.
fs.writeFileSync(path.join(fakePath, 'npm'), 'not a program', 'utf8')
fs.writeFileSync(path.join(fakePath, 'tool.exe'), 'binary', 'utf8')

test.after(() => fs.rmSync(fakePath, { recursive: true, force: true }))

test('a bare name resolves against PATH, preferring real executable extensions', () => {
  const env = { ...process.env, PATH: fakePath }
  assert.equal(resolveExecutable('npm', { platform: 'win32', env }), path.join(fakePath, 'npm.cmd'))
  assert.equal(resolveExecutable('tool', { platform: 'win32', env }), path.join(fakePath, 'tool.exe'))
  // Somewhere else on PATH: the unresolved name is handed to the OS, which
  // produces the platform's own error rather than one invented here.
  assert.equal(resolveExecutable('definitely-not-installed', { platform: 'win32', env }), 'definitely-not-installed')
  // A path the config spelled out is used as written.
  assert.equal(resolveExecutable('./tools/dev', { platform: 'win32', env }), './tools/dev')
  // Other platforms spawn the name directly and let the OS resolve it.
  assert.equal(resolveExecutable('npm', { platform: 'linux', env }), 'npm')
})

test('a Windows shim is run by cmd.exe with every argument quoted', () => {
  const env = { ...process.env, PATH: fakePath, COMSPEC: 'C:\\WINDOWS\\system32\\cmd.exe' }
  const plan = spawnPlan('npm', ['run', 'dev', '--', '--port', '3000'], { platform: 'win32', env })
  assert.equal(plan.command, 'C:\\WINDOWS\\system32\\cmd.exe')
  assert.equal(plan.shell, false)
  // Verbatim, or Node re-quotes the command into one token cmd cannot find.
  assert.equal(plan.verbatim, true)
  assert.deepEqual(plan.args.slice(0, 3), ['/d', '/s', '/c'])
  // The whole command is wrapped once more for `/s`, and every argument is
  // quoted individually: nothing in the config reaches the shell unquoted.
  assert.equal(plan.args[3], `""${path.join(fakePath, 'npm.cmd')}" "run" "dev" "--" "--port" "3000""`)
})

test('a real executable is spawned directly, without a shell', () => {
  const env = { ...process.env, PATH: fakePath, COMSPEC: 'cmd.exe' }
  const plan = spawnPlan('tool', ['--serve'], { platform: 'win32', env })
  assert.equal(plan.command, path.join(fakePath, 'tool.exe'))
  assert.deepEqual(plan.args, ['--serve'])
  assert.equal(plan.shell, false)
  assert.equal(plan.verbatim, false)
  // POSIX keeps the command as configured.
  const posix = spawnPlan('npm', ['run', 'dev'], { platform: 'linux', env })
  assert.equal(posix.command, 'npm')
  assert.deepEqual(posix.args, ['run', 'dev'])
})
