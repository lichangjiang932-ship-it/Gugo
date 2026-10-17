import { getDesktopTerminalHost } from './desktopTerminalClient.js'

/**
 * Renderer-side lifetime for desktop shells.
 *
 * The panel is allowed to disappear — a tab switch, a closed workbench, a route
 * change — without ending a command the reader started. The pty belongs to the
 * main process, so this module only remembers which shell belongs to which
 * project, keeps a bounded replay buffer for the next xterm, and fans output out
 * to whichever panel is attached now.
 */
const REPLAY_CHAR_LIMIT = 200_000

const sessions = new Map()
// The host may print before the start IPC reply names the session. Hold those
// chunks by id and hand them over when the session learns its id.
const pendingById = new Map()
const PENDING_ID_LIMIT = 64
const PENDING_CHUNK_LIMIT = 200
let activeHost = null
let subscription = null

function rememberPending(id, entry) {
  if (!id) return
  if (!pendingById.has(id) && pendingById.size >= PENDING_ID_LIMIT) {
    pendingById.delete(pendingById.keys().next().value)
  }
  const entries = pendingById.get(id) || []
  entries.push(entry)
  if (entries.length > PENDING_CHUNK_LIMIT) entries.shift()
  pendingById.set(id, entries)
}

function findSessionById(id) {
  return [...sessions.values()].find((entry) => entry.id === id && entry.id)
}

function markExited(session, exitCode, signal) {
  if (session.exited) return
  session.exited = true
  session.exitCode = exitCode ?? null
  session.exitSignal = signal ?? null
  for (const listener of session.listeners) listener.onExit?.({ exitCode: session.exitCode, signal: session.exitSignal })
}

export function terminalSessionKey(cwd = '') {
  return String(cwd || '').trim() || '__default__'
}

function appendReplay(session, chunk) {
  const next = session.buffer + chunk
  if (next.length <= REPLAY_CHAR_LIMIT) {
    session.buffer = next
    return
  }
  const cut = next.length - REPLAY_CHAR_LIMIT
  const newline = next.indexOf('\n', cut)
  session.buffer = newline === -1 ? next.slice(cut) : next.slice(newline + 1)
}

function ensureSubscription(host) {
  if (!host) return
  if (subscription && activeHost === host) return
  subscription?.dispose()
  const stopData = host.onData((payload) => {
    const id = String(payload?.id || '')
    const chunk = String(payload?.chunk ?? '')
    if (!id || !chunk) return
    const session = findSessionById(id)
    if (!session) { rememberPending(id, { kind: 'data', chunk }); return }
    if (session.exited) return
    appendReplay(session, chunk)
    for (const listener of session.listeners) listener.onData?.(chunk)
  })
  const stopExit = host.onExit((payload) => {
    const id = String(payload?.id || '')
    const session = findSessionById(id)
    if (!session) { rememberPending(id, { kind: 'exit', payload }); return }
    markExited(session, payload?.exitCode, payload?.signal)
  })
  subscription = { host, dispose: () => { stopData(); stopExit() } }
  activeHost = host
}

export function getTerminalSession(key) {
  return sessions.get(terminalSessionKey(key)) || null
}

export async function ensureTerminalSession({ key, cwd = '', host = getDesktopTerminalHost(), cols = 100, rows = 30 } = {}) {
  if (!host) throw new Error('desktop terminal unavailable')
  ensureSubscription(host)
  const sessionKey = key || terminalSessionKey(cwd)
  let session = sessions.get(sessionKey)
  if (!session) {
    session = {
      key: sessionKey,
      id: '',
      cwd: String(cwd || ''),
      shell: '',
      windowsPty: undefined,
      buffer: '',
      exited: false,
      exitCode: null,
      exitSignal: null,
      listeners: new Set(),
      host,
      starting: null,
    }
    sessions.set(sessionKey, session)
    session.starting = Promise.resolve()
      .then(() => host.start(cwd ? { cwd } : {}))
      .then((started) => {
        if (!started?.ok) throw new Error(started?.reason || 'terminal start failed')
        if (sessions.get(sessionKey) !== session) {
          void host.kill(started.id)
          throw new Error('terminal session cancelled')
        }
        session.id = String(started.id || '')
        session.shell = String(started.shell || '')
        session.cwd = String(started.cwd || cwd || '')
        session.windowsPty = started.windowsPty
        session.cols = Number(started.cols) || cols
        session.rows = Number(started.rows) || rows
        const queued = pendingById.get(session.id)
        if (queued) {
          pendingById.delete(session.id)
          for (const entry of queued) {
            if (entry.kind === 'exit') markExited(session, entry.payload?.exitCode, entry.payload?.signal)
            else if (!session.exited) {
              appendReplay(session, entry.chunk)
              for (const listener of session.listeners) listener.onData?.(entry.chunk)
            }
          }
        }
        return session
      })
      .catch((error) => {
        sessions.delete(sessionKey)
        throw error
      })
  }
  return session.starting
}

export function subscribeTerminalSession(key, { onData, onExit } = {}) {
  const session = sessions.get(terminalSessionKey(key))
  if (!session) return null
  const listener = { onData, onExit }
  session.listeners.add(listener)
  return {
    id: session.id,
    cwd: session.cwd,
    shell: session.shell,
    windowsPty: session.windowsPty,
    replay: session.buffer,
    exited: session.exited,
    exitCode: session.exitCode,
    detach: () => { session.listeners.delete(listener) },
  }
}

export function writeTerminalSession(key, data) {
  const session = sessions.get(terminalSessionKey(key))
  if (!session?.id || session.exited) return false
  void session.host.write(session.id, String(data ?? ''))
  return true
}

export function resizeTerminalSession(key, cols, rows) {
  const session = sessions.get(terminalSessionKey(key))
  if (!session?.id || session.exited) return false
  void session.host.resize(session.id, cols, rows)
  return true
}

export function killTerminalSession(key) {
  const session = sessions.get(terminalSessionKey(key))
  if (!session) return false
  sessions.delete(session.key)
  session.listeners.clear()
  if (session.id) void session.host.kill(session.id)
  return true
}

export function resetTerminalSessions() {
  subscription?.dispose()
  subscription = null
  activeHost = null
  sessions.clear()
  pendingById.clear()
}
