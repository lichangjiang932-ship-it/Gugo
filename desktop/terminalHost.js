import { spawn } from 'node:child_process'
import { statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { release as osRelease } from 'node:os'

import { isTrustedNavigation } from './security.js'

/**
 * A real terminal, in the main process.
 *
 * `node-pty` is required lazily so this module can be loaded (and tested) outside
 * Electron, and `spawnPty` is injectable for the same reason — the tests drive the
 * whole session lifecycle without a window.
 *
 * Why the main process and not the local server: an interactive shell is a
 * stronger capability than any single tool call, because it is a session the user
 * keeps using rather than one command the host can inspect and bound. Keeping it
 * behind the desktop bridge means it exists only in the desktop app, only for the
 * trusted app frame, and never as an HTTP endpoint any page could reach. The web
 * build keeps the command console it already had.
 */
let ptyPackage = null
function loadPtyPackage() {
  if (!ptyPackage) ptyPackage = createRequire(import.meta.url)('node-pty')
  return ptyPackage
}

export const TERMINAL_DATA_CHANNEL = 'desktop:terminal-data'
export const TERMINAL_EXIT_CHANNEL = 'desktop:terminal-exit'
export const TERMINAL_DEFAULT_COLS = 100
export const TERMINAL_DEFAULT_ROWS = 30
export const TERMINAL_MIN_COLS = 20
export const TERMINAL_MAX_COLS = 500
export const TERMINAL_MIN_ROWS = 5
export const TERMINAL_MAX_ROWS = 200

export function resolveDefaultShell({ env = process.env, platform = process.platform } = {}) {
  if (platform === 'win32') return { file: env.COMSPEC || 'cmd.exe', args: [] }
  return { file: env.SHELL || '/bin/bash', args: ['-l'] }
}

/**
 * What the reader needs to know about ConPTY, told to the reader.
 *
 * ConPTY does not pull scrolled-away rows back when the viewport grows: without
 * this, widening the panel leaves blank rows where output used to be. xterm has a
 * workaround, but it only applies it when it is told which pty it is talking to,
 * and it applies it only for the ConPTY builds that fixed the underlying bug.
 */
export function resolveWindowsPty({ platform = process.platform, release = osRelease() } = {}) {
  if (platform !== 'win32') return undefined
  const buildNumber = Number(String(release).split('.')[2])
  if (!Number.isFinite(buildNumber)) return undefined
  return { backend: 'conpty', buildNumber }
}

function clampDimension(value, min, max, fallback) {
  const size = Math.trunc(Number(value))
  if (!Number.isFinite(size) || size <= 0) return fallback
  return Math.min(Math.max(size, min), max)
}

function defaultSpawnPty(file, args, options) {
  return loadPtyPackage().spawn(file, args, options)
}

/**
 * Where a new shell starts.
 *
 * The panel asks for the project the reader is working in, so the terminal opens
 * where their code is instead of in their home directory. The request is honoured
 * only when it names a directory that exists — a stale path from a deleted
 * project must not stop the terminal from opening — and only the app frame can
 * make it.
 */
function resolveSessionCwd(requested, fallback) {
  // A directory is a string or it is nothing: coercing an object here would mean
  // `String({})` decided where a shell opens.
  const candidate = typeof requested === 'string' ? requested.trim() : ''
  if (!candidate) return fallback
  try {
    return statSync(candidate).isDirectory() ? candidate : fallback
  } catch {
    return fallback
  }
}

function defaultSpawnTreeKill(pid) {
  return spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
    windowsHide: true,
    stdio: 'ignore',
  })
}

export function createDesktopTerminalHost({
  ipcMain,
  getApplicationOrigin,
  getMainWindow,
  spawnPty = defaultSpawnPty,
  spawnTreeKill = defaultSpawnTreeKill,
  env = process.env,
  platform = process.platform,
  cwd = () => env.USERPROFILE || env.HOME || process.cwd(),
} = {}) {
  const sessions = new Map()
  let nextId = 0

  function assertTrusted(event) {
    const sourceUrl = event.senderFrame?.url || event.sender?.getURL?.() || ''
    const origin = getApplicationOrigin?.() || ''
    if (!origin || !isTrustedNavigation(sourceUrl, origin)) {
      throw new Error('untrusted desktop IPC sender')
    }
    const window = getMainWindow?.()
    if (!window || window.isDestroyed?.() || event.sender !== window.webContents) {
      throw new Error('the terminal is only available to the main window')
    }
    return window
  }

  function send(channel, payload) {
    const window = getMainWindow?.()
    if (!window || window.isDestroyed?.()) return
    window.webContents.send(channel, payload)
  }

  /**
   * End a shell — and everything it started.
   *
   * On Windows `pty.kill()` closes the ConPTY but does not guarantee the shell's
   * descendants end with it: a build the reader started (node → esbuild,
   * compilers) survives as an orphan holding file locks the next command wants.
   * The rest of this repo already treats the whole process tree as the unit to
   * kill (DEBT-EXEC-002), so the terminal does too. The pty is released either
   * way: its ConPTY socket and agent are ours, and killing the shell does not
   * free them.
   */
  function endShell(pty) {
    const pid = pty?.pid
    if (platform === 'win32' && Number.isInteger(pid) && pid > 0) {
      try {
        const child = spawnTreeKill(pid)
        // A missing taskkill reports asynchronously; without a listener that is
        // an unhandled error in the main process.
        if (typeof child?.once === 'function') child.once('error', () => {})
      } catch {
        // No tree kill available; releasing the pty below still ends the shell.
      }
    }
    try {
      pty?.kill()
    } catch {
      // The shell may already be gone; the entry is what mattered.
    }
  }

  function disposeSession(id) {
    const session = sessions.get(id)
    if (!session) return false
    sessions.delete(id)
    endShell(session.pty)
    return true
  }

  function disposeAll() {
    for (const id of [...sessions.keys()]) disposeSession(id)
  }

  function register() {
    ipcMain.handle('desktop:terminal-start', (event, options = {}) => {
      const window = assertTrusted(event)
      const cols = clampDimension(options?.cols, TERMINAL_MIN_COLS, TERMINAL_MAX_COLS, TERMINAL_DEFAULT_COLS)
      const rows = clampDimension(options?.rows, TERMINAL_MIN_ROWS, TERMINAL_MAX_ROWS, TERMINAL_DEFAULT_ROWS)
      const shell = resolveDefaultShell({ env, platform })
      const id = `terminal-${nextId += 1}`

      const session = { id, cols, rows, pty: null, reported: false }
      const pty = spawnPty(shell.file, shell.args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: resolveSessionCwd(options?.cwd, cwd()),
        env: platform === 'win32' ? env : { TERM: 'xterm-256color', ...env },
        // ConPTY or winpty is left to node-pty: it already picks whichever the OS
        // supports, and pinning one would break the other.
      })
      session.pty = pty
      sessions.set(id, session)

      // Output is forwarded and forgotten: the reader's own scrollback is where it
      // belongs, and a second copy here would be an unbounded buffer growing once
      // per keystroke of a long-running command.
      pty.onData((chunk) => send(TERMINAL_DATA_CHANNEL, { id, chunk: String(chunk ?? '') }))
      const onExit = ({ exitCode, signal } = {}) => {
        // Reported once, whichever ended it: the shell exiting on its own, or the
        // panel killing it. An entry removed by the kill path must not swallow the
        // event, or the panel is left showing a prompt for a shell that is gone.
        if (session.reported) return
        session.reported = true
        sessions.delete(id)
        send(TERMINAL_EXIT_CHANNEL, { id, exitCode: exitCode ?? null, signal: signal ?? null })
      }
      pty.onExit(onExit)
      // A window that goes away must not leave an orphaned shell behind.
      window.once('closed', () => disposeSession(id))

      return {
        ok: true,
        id,
        cols,
        rows,
        shell: shell.file,
        windowsPty: resolveWindowsPty({ platform }),
      }
    })

    ipcMain.handle('desktop:terminal-write', (event, payload = {}) => {
      assertTrusted(event)
      const session = sessions.get(String(payload?.id || ''))
      if (!session) return { ok: false, reason: 'session' }
      session.pty.write(String(payload?.data ?? ''))
      return { ok: true }
    })

    ipcMain.handle('desktop:terminal-resize', (event, payload = {}) => {
      assertTrusted(event)
      const session = sessions.get(String(payload?.id || ''))
      if (!session) return { ok: false, reason: 'session' }
      const cols = clampDimension(payload?.cols, TERMINAL_MIN_COLS, TERMINAL_MAX_COLS, session.cols)
      const rows = clampDimension(payload?.rows, TERMINAL_MIN_ROWS, TERMINAL_MAX_ROWS, session.rows)
      session.cols = cols
      session.rows = rows
      session.pty.resize(cols, rows)
      return { ok: true, cols, rows }
    })

    ipcMain.handle('desktop:terminal-kill', (event, payload = {}) => {
      assertTrusted(event)
      return { ok: disposeSession(String(payload?.id || '')) }
    })
  }

  return { disposeAll, register, sessions }
}
