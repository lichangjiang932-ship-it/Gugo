import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  createDesktopTerminalHost,
  resolveDefaultShell,
  resolveWindowsPty,
  TERMINAL_DATA_CHANNEL,
  TERMINAL_EXIT_CHANNEL,
  TERMINAL_MAX_COLS,
  TERMINAL_MIN_COLS,
} from '../desktop/terminalHost.js'

const ORIGIN = 'http://127.0.0.1:3210'

const SHELL_PID = 4242

function createFakePty() {
  const listeners = { data: [], exit: [] }
  return {
    pid: SHELL_PID,
    killed: 0,
    resized: [],
    written: [],
    kill() { this.killed += 1 },
    onData(callback) { listeners.data.push(callback) },
    onExit(callback) { listeners.exit.push(callback) },
    resize(cols, rows) { this.resized.push([cols, rows]) },
    write(data) { this.written.push(data) },
    emitData(chunk) { for (const listener of listeners.data) listener(chunk) },
    emitExit(payload) { for (const listener of listeners.exit) listener(payload) },
  }
}

function createHarness({ platform = 'win32' } = {}) {
  const handlers = new Map()
  const sent = []
  const closed = []
  // One pty per session, the way node-pty works: sharing one would broadcast each
  // session's output to the other.
  const ptys = []
  const spawnOptions = []
  const treeKills = []
  const env = { COMSPEC: 'C:\\Windows\\system32\\cmd.exe', USERPROFILE: 'C:\\Users\\tester' }
  const window = {
    isDestroyed: () => false,
    once(name, callback) { if (name === 'closed') closed.push(callback) },
    webContents: { send(channel, payload) { sent.push({ channel, payload }) } },
  }
  const host = createDesktopTerminalHost({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    getApplicationOrigin: () => ORIGIN,
    getMainWindow: () => window,
    spawnPty: (_file, _args, options) => {
      const pty = createFakePty()
      ptys.push(pty)
      spawnOptions.push(options)
      return pty
    },
    spawnTreeKill: (pid) => {
      const failure = treeKills.failure
      treeKills.push(pid)
      if (failure) throw failure
      return { once: (name, handler) => { if (failure) handler() } }
    },
    env,
    platform,
  })
  host.register()

  const trustedEvent = { senderFrame: { url: `${ORIGIN}/chat` }, sender: window.webContents }
  const invoke = (channel, payload, event = trustedEvent) => handlers.get(channel)(event, payload)
  return { closed, env, host, invoke, ptys, sent, spawnOptions, treeKills, window }
}

test('the shell to open is the one the platform actually has', () => {
  assert.deepEqual(
    resolveDefaultShell({ env: { COMSPEC: 'C:\\Windows\\system32\\cmd.exe' }, platform: 'win32' }),
    { file: 'C:\\Windows\\system32\\cmd.exe', args: [] },
  )
  assert.deepEqual(resolveDefaultShell({ env: {}, platform: 'win32' }), { file: 'cmd.exe', args: [] })
  // A login shell, so the reader's profile (PATH, aliases) is what they get.
  assert.deepEqual(resolveDefaultShell({ env: { SHELL: '/usr/bin/zsh' }, platform: 'linux' }), {
    file: '/usr/bin/zsh',
    args: ['-l'],
  })
})

test('windowsPty is reported only where ConPTY is the thing being talked to', () => {
  assert.equal(resolveWindowsPty({ platform: 'linux', release: '6.8.0' }), undefined)
  assert.deepEqual(
    resolveWindowsPty({ platform: 'win32', release: '10.0.26200' }),
    { backend: 'conpty', buildNumber: 26200 },
  )
  // A release string without a build number must not become NaN in the options.
  assert.equal(resolveWindowsPty({ platform: 'win32', release: 'weird' }), undefined)
})

test('a session is started for the trusted frame only, sized within limits', () => {
  const { invoke, ptys } = createHarness()
  const started = invoke('desktop:terminal-start', { cols: 5000, rows: 1 })

  assert.equal(started.ok, true)
  assert.equal(started.id, 'terminal-1')
  assert.equal(started.shell, 'C:\\Windows\\system32\\cmd.exe')
  // Compared against the resolver's own answer for this host's platform: the
  // build number comes from the machine actually running the test, so a literal
  // would only pass on the maintainer's Windows box.
  assert.deepEqual(started.windowsPty, resolveWindowsPty({ platform: 'win32' }))
  assert.equal(started.cols, TERMINAL_MAX_COLS)
  assert.equal(started.rows, 5)
  assert.equal(ptys[0].killed, 0)

  const untrusted = createHarness()
  assert.throws(
    () => untrusted.invoke('desktop:terminal-start', {}, { senderFrame: { url: 'https://evil.example/' }, sender: {} }),
    /untrusted desktop IPC sender/,
  )
  // A sender that is trusted but is not the main window is refused too.
  const foreign = {}
  assert.throws(
    () => untrusted.invoke('desktop:terminal-start', {}, { senderFrame: { url: `${ORIGIN}/chat` }, sender: foreign }),
    /only available to the main window/,
  )
  assert.equal(untrusted.ptys.length, 0)
})

test('output, keystrokes and resizes are routed by session id', () => {
  const { invoke, ptys, sent } = createHarness()
  const first = invoke('desktop:terminal-start', {})
  const second = invoke('desktop:terminal-start', {})

  ptys[0].emitData('banner\r\n')
  assert.deepEqual(sent, [{ channel: TERMINAL_DATA_CHANNEL, payload: { id: first.id, chunk: 'banner\r\n' } }])

  assert.deepEqual(invoke('desktop:terminal-write', { id: second.id, data: 'dir\n' }), { ok: true })
  assert.deepEqual(ptys[1].written, ['dir\n'])

  assert.deepEqual(invoke('desktop:terminal-resize', { id: first.id, cols: 120, rows: 40 }), {
    ok: true,
    cols: 120,
    rows: 40,
  })
  // An absurd size falls back to the session's current one rather than throwing.
  assert.deepEqual(invoke('desktop:terminal-resize', { id: first.id, cols: 0, rows: Number.NaN }), {
    ok: true,
    cols: 120,
    rows: 40,
  })
  assert.deepEqual(ptys[0].resized, [[120, 40], [120, 40]])

  assert.deepEqual(invoke('desktop:terminal-resize', { id: 'terminal-404', cols: 80, rows: 24 }), {
    ok: false,
    reason: 'session',
  })
  assert.equal(TERMINAL_MIN_COLS < 120, true)
})

test('a shell is reported as exited exactly once, whichever end killed it', () => {
  const { closed, invoke, ptys, sent } = createHarness()
  const started = invoke('desktop:terminal-start', {})

  ptys[0].emitExit({ exitCode: 0 })
  ptys[0].emitExit({ exitCode: 0 })
  assert.deepEqual(sent.filter(({ channel }) => channel === TERMINAL_EXIT_CHANNEL), [{
    channel: TERMINAL_EXIT_CHANNEL,
    payload: { id: started.id, exitCode: 0, signal: null },
  }])
  // The session is gone, so a second write is refused rather than written nowhere.
  assert.equal(invoke('desktop:terminal-write', { id: started.id, data: 'x' }).ok, false)

  // Killed from the panel: the exit still has to reach the panel, or it shows a
  // prompt for a shell that no longer exists.
  const killed = createHarness()
  const killedSession = killed.invoke('desktop:terminal-start', {})
  assert.deepEqual(killed.invoke('desktop:terminal-kill', { id: killedSession.id }), { ok: true })
  assert.equal(killed.ptys[0].killed, 1)
  killed.ptys[0].emitExit({ exitCode: 130, signal: 15 })
  assert.deepEqual(killed.sent.filter(({ channel }) => channel === TERMINAL_EXIT_CHANNEL)[0].payload, {
    id: killedSession.id,
    exitCode: 130,
    signal: 15,
  })

  // A window that closes takes its shells with it.
  closed[0]()
  assert.equal(invoke('desktop:terminal-kill', { id: started.id }).ok, false)
})

test('a shell starts in the project the panel asked for, when that project still exists', () => {
  const { env, invoke, spawnOptions } = createHarness()
  const project = mkdtempSync(path.join(tmpdir(), 'gugo-terminal-cwd-'))
  invoke('desktop:terminal-start', { cwd: project })
  assert.equal(spawnOptions[0].cwd, project)

  // A stale path (deleted project, renamed folder) must not stop the terminal
  // from opening; the reader gets the default directory instead.
  const missing = path.join(tmpdir(), 'gugo-terminal-cwd-does-not-exist')
  invoke('desktop:terminal-start', { cwd: missing })
  assert.notEqual(spawnOptions[1].cwd, missing)
  assert.equal(spawnOptions[1].cwd, env.USERPROFILE)

  // A file is not a directory.
  const file = path.join(project, 'notes.txt')
  writeFileSync(file, 'hello')
  invoke('desktop:terminal-start', { cwd: file })
  assert.notEqual(spawnOptions[2].cwd, file)

  // Nothing asked for, or a non-string, falls back without throwing.
  invoke('desktop:terminal-start', {})
  invoke('desktop:terminal-start', { cwd: { toString: () => project } })
  assert.equal(spawnOptions[3].cwd, spawnOptions[1].cwd)
  assert.equal(spawnOptions[4].cwd, spawnOptions[1].cwd)
})

test('ending a shell takes its process tree with it, and releases the pty either way', () => {
  // Windows: a build started in the shell must not outlive the panel that started
  // it as an orphan holding file locks.
  const windows = createHarness({ platform: 'win32' })
  const first = windows.invoke('desktop:terminal-start', {})
  windows.invoke('desktop:terminal-start', {})
  assert.deepEqual(windows.invoke('desktop:terminal-kill', { id: first.id }), { ok: true })
  assert.deepEqual(windows.treeKills, [SHELL_PID], 'the shell pid is what the tree kill targets')
  assert.deepEqual(windows.ptys.map((pty) => pty.killed), [1, 0], 'and the pty itself is released')

  // Elsewhere `pty.kill()` already ends the group; there is no taskkill to run.
  const linux = createHarness({ platform: 'linux' })
  const session = linux.invoke('desktop:terminal-start', {})
  linux.invoke('desktop:terminal-kill', { id: session.id })
  assert.deepEqual(linux.treeKills, [])
  assert.equal(linux.ptys[0].killed, 1)

  // A shell whose pid is unknown cannot be tree-killed; it must still be released
  // rather than left behind.
  const pidless = createHarness()
  const pidlessPty = { kill() { this.killed = (this.killed || 0) + 1 } }
  pidless.host.sessions.set('terminal-x', { id: 'terminal-x', pty: pidlessPty })
  assert.deepEqual(pidless.invoke('desktop:terminal-kill', { id: 'terminal-x' }), { ok: true })
  assert.deepEqual(pidless.treeKills, [])
  assert.equal(pidlessPty.killed, 1)

  // taskkill missing or refusing to start must not strand the session.
  const failing = createHarness()
  failing.treeKills.failure = new Error('taskkill is not on PATH')
  const failingSession = failing.invoke('desktop:terminal-start', {})
  assert.deepEqual(failing.invoke('desktop:terminal-kill', { id: failingSession.id }), { ok: true })
  assert.equal(failing.ptys[0].killed, 1, 'the pty is released even when the tree kill throws')
  assert.equal(failing.host.sessions.size, 0)
})

test('quitting releases every shell, and does so without throwing twice', () => {
  const { host, invoke, ptys, sent, treeKills } = createHarness()
  invoke('desktop:terminal-start', {})
  invoke('desktop:terminal-start', {})
  assert.equal(host.sessions.size, 2)

  host.disposeAll()
  host.disposeAll()
  assert.equal(host.sessions.size, 0)
  assert.deepEqual(ptys.map((pty) => pty.killed), [1, 1])
  assert.deepEqual(treeKills, [SHELL_PID, SHELL_PID], 'each shell is tree-killed once')
  assert.deepEqual(sent.filter(({ channel }) => channel === TERMINAL_DATA_CHANNEL), [])
})
