import { useEffect, useRef, useState } from 'react'
import { Plus, RotateCcw, Trash2 } from 'lucide-react'
import { getDesktopTerminalHost } from '../../../lib/desktopTerminalClient.js'
import {
  ensureTerminalSession,
  getTerminalSession,
  killTerminalSession,
  resizeTerminalSession,
  subscribeTerminalSession,
  terminalSessionKey,
  writeTerminalSession,
} from '../../../lib/desktopTerminalSessions.js'
import { terminalThemeForElement, terminalTypographyForElement } from '../../../lib/ptyTerminalTheme.js'

/**
 * Loaded when the tab is first opened, not on import: xterm is a large module, and
 * a reader who never opens the tab should not pay for it. Injectable so the
 * session's lifecycle can be tested without a renderer that needs a canvas.
 */
async function loadXtermRuntime() {
  const [core, fitAddon] = await Promise.all([
    import('@xterm/xterm'),
    import('@xterm/addon-fit'),
    // With the module, not before it: its stylesheet is only needed by a reader
    // who opens this tab.
    import('@xterm/xterm/css/xterm.css'),
  ])
  return { Terminal: core.Terminal, FitAddon: fitAddon.FitAddon }
}

function basename(file) {
  return String(file || '').split(/[\\/]/).filter(Boolean).pop() || String(file || '')
}

function isMacPlatform() {
  return globalThis.window?.gugoDesktop?.platform === 'darwin'
}

async function writeClipboardText(text) {
  if (!text) return false
  try {
    if (globalThis.navigator?.clipboard?.writeText) {
      await globalThis.navigator.clipboard.writeText(text)
      return true
    }
  } catch { /* fall through to the desktop bridge */ }
  try {
    const write = globalThis.window?.gugoDesktop?.writeClipboardText
    if (typeof write === 'function') {
      await write(text)
      return true
    }
  } catch { /* no clipboard available */ }
  return false
}

async function readClipboardText() {
  try {
    const text = await globalThis.navigator?.clipboard?.readText?.() || ''
    if (text) return text
  } catch { /* fall through to the desktop bridge */ }
  try {
    const read = globalThis.window?.gugoDesktop?.readClipboardText
    if (typeof read === 'function') {
      const result = await read()
      if (typeof result === 'string') return result
      if (typeof result?.text === 'string') return result.text
    }
  } catch { /* no clipboard available */ }
  return ''
}

/**
 * A real shell, in the desktop app.
 *
 * The deliberate difference from the command console it replaces: output goes
 * straight into xterm rather than through React state, so a command that prints
 * for an hour cannot grow the app's memory — xterm keeps the scrollback, bounded,
 * where the OS already put it.
 *
 * The session outlives this panel. Closing the workbench, switching tabs or
 * changing routes detaches the xterm; it does not kill the shell. The module
 * session manager keeps the pty's output so the next mount can replay what it
 * missed. Only "Restart", "New" or "End" end a shell.
 */
export default function PtyTerminalPanel({
  active = true,
  cwd = '',
  loadRuntime = loadXtermRuntime,
  t,
}) {
  const sectionRef = useRef(null)
  const surfaceRef = useRef(null)
  const runtimeRef = useRef(null)
  const menuRef = useRef(null)
  const restartCwdRef = useRef(null)
  const stoppedRef = useRef(false)
  const [attempt, setAttempt] = useState(0)
  const [killArmed, setKillArmed] = useState(false)
  const [menu, setMenu] = useState(null)
  const [status, setStatus] = useState({ phase: 'idle', shell: '', cwd: '', exitCode: null })

  useEffect(() => {
    if (!killArmed) return undefined
    const timer = setTimeout(() => setKillArmed(false), 4000)
    return () => clearTimeout(timer)
  }, [killArmed])

  useEffect(() => {
    if (!menu) return undefined
    const closeOnPointer = (event) => {
      if (!menuRef.current?.contains(event.target)) setMenu(null)
    }
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') { event.preventDefault(); setMenu(null) }
    }
    window.addEventListener('pointerdown', closeOnPointer)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('pointerdown', closeOnPointer)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [menu])

  const applySize = () => {
    const runtime = runtimeRef.current
    const terminal = runtime?.terminal
    if (!terminal) return
    try {
      runtime.fit.fit()
    } catch {
      // A zero-size surface cannot be measured; the observer will call again.
    }
    resizeTerminalSession(runtime.key, terminal.cols, terminal.rows)
  }

  const disposeTerminal = () => {
    const runtime = runtimeRef.current
    runtimeRef.current = null
    if (!runtime) return null
    runtime.observer?.disconnect()
    runtime.detach?.()
    runtime.terminal.dispose?.()
    return runtime
  }

  const copySelection = async () => {
    const terminal = runtimeRef.current?.terminal
    const text = terminal?.getSelection?.() || ''
    return writeClipboardText(text)
  }

  const pasteClipboard = async () => {
    const runtime = runtimeRef.current
    if (!runtime || runtime.terminal.options.disableStdin) return false
    const text = await readClipboardText()
    if (!text) return false
    return writeTerminalSession(runtime.key, text)
  }

  useEffect(() => {
    if (!active || stoppedRef.current) return undefined
    const host = getDesktopTerminalHost()
    const surface = surfaceRef.current
    if (!host || !surface) return undefined
    // Already running: this activation only has to re-measure a surface that was
    // hidden, since a hidden element reports no size to fit against.
    if (runtimeRef.current) {
      runtimeRef.current.refit()
      runtimeRef.current.terminal.focus?.()
      return undefined
    }

    let disposed = false
    const bootCwd = restartCwdRef.current ?? cwd
    restartCwdRef.current = null
    const key = terminalSessionKey(bootCwd)

    const endSession = ({ exitCode }) => {
      const current = runtimeRef.current
      if (current) current.terminal.options.disableStdin = true
      setStatus((previous) => ({ ...previous, phase: 'exited', exitCode: exitCode ?? null }))
    }

    const boot = async () => {
      const session = await ensureTerminalSession({ key, cwd: bootCwd, host })
      if (disposed || stoppedRef.current) return
      const { Terminal, FitAddon } = await loadRuntime()
      if (disposed || stoppedRef.current) return

      const terminal = new Terminal({
        cursorBlink: true,
        convertEol: false,
        scrollback: 5000,
        theme: terminalThemeForElement(sectionRef.current),
        windowsPty: session.windowsPty,
        ...terminalTypographyForElement(surface),
      })
      const fit = new FitAddon()
      terminal.loadAddon(fit)
      terminal.open(surface)
      const runtime = {
        key,
        id: session.id,
        terminal,
        fit,
        sessionCwd: session.cwd,
        refit: applySize,
      }
      runtimeRef.current = runtime

      const subscription = subscribeTerminalSession(key, {
        onData: (chunk) => terminal.write(chunk),
        onExit: endSession,
      })
      if (!subscription) {
        runtimeRef.current = null
        terminal.dispose()
        setStatus((previous) => ({ ...previous, phase: 'failed', exitCode: null }))
        return
      }
      runtime.detach = subscription.detach
      if (subscription.replay) terminal.write(subscription.replay)
      if (subscription.exited) {
        terminal.options.disableStdin = true
        setStatus({ phase: 'exited', shell: subscription.shell, cwd: subscription.cwd, exitCode: subscription.exitCode })
      } else {
        setStatus({ phase: 'running', shell: subscription.shell, cwd: subscription.cwd, exitCode: null })
      }

      terminal.onData((data) => {
        if (terminal.options.disableStdin) return
        writeTerminalSession(key, data)
      })
      terminal.attachCustomKeyEventHandler?.((event) => {
        if (event.type !== 'keydown' || event.altKey) return true
        const keyName = String(event.key || '').toLowerCase()
        const mac = isMacPlatform()
        const copyCombo = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && event.shiftKey
        const pasteCombo = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && event.shiftKey
        if (copyCombo && keyName === 'c') {
          event.preventDefault()
          void copySelection()
          return false
        }
        if (pasteCombo && keyName === 'v') {
          event.preventDefault()
          void pasteClipboard()
          return false
        }
        return true
      })

      applySize()
      if (typeof ResizeObserver === 'function') {
        const observer = new ResizeObserver(() => applySize())
        observer.observe(surface)
        runtime.observer = observer
      }
      if (active) terminal.focus?.()
    }

    void boot().catch(() => {
      if (disposed || stoppedRef.current) return
      runtimeRef.current = null
      setStatus((previous) => ({ ...previous, phase: 'failed', exitCode: null }))
    })

    return () => { disposed = true }
    // A running shell is never restarted by `cwd`: a changed project only decides
    // where the next shell starts, through New or Restart.
  }, [active, attempt, cwd, loadRuntime])

  // Leaving the panel detaches; it does not end the shell.
  useEffect(() => () => {
    disposeTerminal()
  }, [])

  const restart = () => {
    const runtime = runtimeRef.current
    const fallback = getTerminalSession(cwd)
    const session = runtime ? getTerminalSession(runtime.key) : fallback
    const targetCwd = runtime?.sessionCwd || session?.cwd || cwd
    const targetKey = terminalSessionKey(targetCwd)
    disposeTerminal()
    killTerminalSession(targetKey)
    stoppedRef.current = false
    restartCwdRef.current = targetCwd
    setKillArmed(false)
    setMenu(null)
    setStatus({ phase: 'starting', shell: '', cwd: targetCwd, exitCode: null })
    setAttempt((value) => value + 1)
  }

  const newShell = () => {
    const targetKey = terminalSessionKey(cwd)
    disposeTerminal()
    // A new shell in another project must not silently end the old one. Only the
    // same project slot is replaced, because one panel cannot show two shells.
    if (getTerminalSession(targetKey)) killTerminalSession(targetKey)
    stoppedRef.current = false
    restartCwdRef.current = cwd
    setKillArmed(false)
    setMenu(null)
    setStatus({ phase: 'starting', shell: '', cwd, exitCode: null })
    setAttempt((value) => value + 1)
  }

  const endShell = () => {
    if (!killArmed) {
      setKillArmed(true)
      return
    }
    const runtime = runtimeRef.current
    const key = runtime?.key || terminalSessionKey(cwd)
    disposeTerminal()
    killTerminalSession(key)
    stoppedRef.current = true
    setKillArmed(false)
    setMenu(null)
    setStatus((previous) => ({ ...previous, phase: 'exited', exitCode: null }))
  }

  const chooseMenuAction = (action) => {
    setMenu(null)
    const terminal = runtimeRef.current?.terminal
    if (action === 'copy') void copySelection()
    else if (action === 'paste') void pasteClipboard()
    else if (action === 'selectAll') terminal?.selectAll?.()
    else if (action === 'clear') terminal?.clear?.()
  }

  const canEnd = ['running', 'starting', 'exited'].includes(status.phase)
  const cwdLabel = status.cwd
    ? `${t('workbench.terminalCwd')} · ${status.cwd}`
    : status.shell ? basename(status.shell) : t('workbench.terminalDesktop')

  return (
    <section
      ref={sectionRef}
      className={`workbench-terminal-surface relative min-h-0 flex-1 flex-col bg-ink text-paper ${active ? 'flex' : 'hidden'}`}
      data-testid="workbench-pty-panel"
      data-phase={status.phase}
    >
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-paper/10 px-2.5">
        <span className="shrink-0 text-xs font-medium text-paper">{t('workbench.terminal')}</span>
        <span
          data-testid="workbench-pty-cwd"
          className="min-w-0 flex-1 truncate font-mono text-xs text-paper/55"
          title={status.cwd || status.shell}
        >
          {cwdLabel}
        </span>
        <button
          type="button"
          data-testid="workbench-pty-new"
          onClick={newShell}
          aria-label={t('workbench.terminalNew')}
          title={t('workbench.terminalNew')}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-control text-paper/65 hover:bg-paper/10 hover:text-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/40 disabled:opacity-30"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          data-testid="workbench-pty-restart"
          onClick={restart}
          aria-label={t('workbench.terminalRestart')}
          title={t('workbench.terminalRestart')}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-control text-paper/65 hover:bg-paper/10 hover:text-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/40"
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          data-testid="workbench-pty-kill"
          onClick={endShell}
          disabled={!canEnd}
          aria-label={killArmed ? t('workbench.terminalKillConfirm') : t('workbench.terminalKill')}
          title={killArmed ? t('workbench.terminalKillConfirm') : t('workbench.terminalKill')}
          data-armed={killArmed || undefined}
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-control focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/40 disabled:opacity-30 ${killArmed ? 'bg-danger/20 text-danger' : 'text-paper/65 hover:bg-paper/10 hover:text-paper'}`}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      {(status.phase === 'failed' || status.phase === 'exited') && (
        <p role="status" data-testid="workbench-pty-notice" className="border-b border-paper/10 px-2 py-1 text-xs text-paper/70">
          {status.phase === 'failed'
            ? t('workbench.terminalStartFailed')
            : t('workbench.terminalExited', { code: status.exitCode === null ? '?' : status.exitCode })}
        </p>
      )}
      <div
        ref={surfaceRef}
        aria-label={t('workbench.terminal')}
        onPointerDown={() => runtimeRef.current?.terminal.focus?.()}
        onContextMenu={(event) => {
          event.preventDefault()
          const rect = sectionRef.current?.getBoundingClientRect?.()
          setMenu({
            x: Math.max(4, event.clientX - (rect?.left || 0)),
            y: Math.max(4, event.clientY - (rect?.top || 0)),
          })
        }}
        className="min-h-0 flex-1 overflow-hidden p-1.5 font-mono text-xs"
        data-testid="workbench-pty-surface"
      />
      {menu && (
        <div
          ref={menuRef}
          role="menu"
          data-testid="workbench-pty-menu"
          style={{ left: menu.x, top: menu.y }}
          className="absolute z-20 min-w-[9rem] rounded-card border border-paper/15 bg-ink px-1 py-1 text-xs text-paper shadow-lg"
        >
          {[
            ['copy', t('workbench.terminalCopy')],
            ['paste', t('workbench.terminalPaste')],
            ['selectAll', t('workbench.terminalSelectAll')],
            ['clear', t('workbench.terminalClear')],
          ].map(([action, label]) => (
            <button
              key={action}
              type="button"
              role="menuitem"
              data-testid={`workbench-pty-menu-${action}`}
              onClick={() => chooseMenuAction(action)}
              className="block w-full rounded-control px-2 py-1 text-left hover:bg-paper/10"
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </section>
  )
}
