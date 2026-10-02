import { useEffect, useRef, useState } from 'react'
import { RotateCcw } from 'lucide-react'
import { getDesktopTerminalHost } from '../../../lib/desktopTerminalClient.js'
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

/**
 * A real shell, in the desktop app.
 *
 * The deliberate difference from the command console it replaces: output goes
 * straight into xterm rather than through React state, so a command that prints
 * for an hour cannot grow the app's memory — xterm keeps the scrollback, bounded,
 * where the OS already put it.
 *
 * The session outlives this tab. Switching to the browser and back must not kill a
 * running build, so nothing here tears down on `active` — only on unmount, which is
 * when the panel itself is gone. It starts lazily on first activation for the same
 * reason: opening the workbench is not a request for a shell.
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
  const [attempt, setAttempt] = useState(0)
  const [status, setStatus] = useState({ phase: 'idle', shell: '', exitCode: null })

  useEffect(() => {
    if (!active) return undefined
    const host = getDesktopTerminalHost()
    const surface = surfaceRef.current
    if (!host || !surface) return undefined
    // Already running: this activation only has to re-measure a surface that was
    // hidden, since a hidden element reports no size to fit against.
    if (runtimeRef.current) {
      runtimeRef.current.refit()
      return undefined
    }

    let disposed = false
    let runtime = null
    const pending = []

    const applySize = () => {
      const terminal = runtime?.terminal
      if (!terminal) return
      try {
        runtime.fit.fit()
      } catch {
        // A zero-size surface cannot be measured; the observer will call again.
      }
      host.resize(runtime.id, terminal.cols, terminal.rows)
    }

    const endSession = (exitCode) => {
      if (runtime) runtime.id = ''
      setStatus((current) => ({ ...current, phase: 'exited', exitCode }))
    }

    const flush = () => {
      for (const entry of pending.splice(0)) {
        if (entry.id !== runtime?.id) continue
        if (entry.kind === 'data') runtime.terminal.write(entry.chunk)
        else endSession(entry.exitCode)
      }
    }

    const boot = async () => {
      // Subscribed before the shell exists, so the first thing it prints cannot
      // fall into the gap between `start` and the terminal that displays it.
      const stopData = host.onData((payload) => {
        const id = String(payload?.id || '')
        const chunk = String(payload?.chunk ?? '')
        if (!chunk) return
        if (!runtime?.id) pending.push({ kind: 'data', id, chunk })
        else if (id === runtime.id) runtime.terminal.write(chunk)
      })
      const stopExit = host.onExit((payload) => {
        const id = String(payload?.id || '')
        const exitCode = payload?.exitCode ?? null
        if (!runtime?.id) pending.push({ kind: 'exit', id, exitCode })
        else if (id === runtime.id) endSession(exitCode)
      })

      // Opening where the reader's project is, when the panel knows one: a shell
      // that starts in the home directory is a shell they have to cd out of.
      const started = await host.start(cwd ? { cwd } : {})
      if (disposed) {
        stopData()
        stopExit()
        if (started?.ok) host.kill(started.id)
        return
      }

      const { Terminal, FitAddon } = await loadRuntime()
      if (disposed) {
        stopData()
        stopExit()
        host.kill(started.id)
        return
      }

      const terminal = new Terminal({
        cursorBlink: true,
        convertEol: false,
        scrollback: 5000,
        theme: terminalThemeForElement(sectionRef.current),
        windowsPty: started.windowsPty,
        ...terminalTypographyForElement(surface),
      })
      const fit = new FitAddon()
      terminal.loadAddon(fit)
      terminal.open(surface)
      runtime = { terminal, fit, id: String(started.id || ''), refit: applySize }
      runtimeRef.current = runtime
      const disposeTerminal = () => {
        stopData()
        stopExit()
        terminal.dispose()
      }
      runtime.dispose = disposeTerminal

      flush()
      applySize()

      terminal.onData((data) => host.write(runtime.id, data))
      if (typeof ResizeObserver === 'function') {
        const observer = new ResizeObserver(() => applySize())
        observer.observe(surface)
        runtime.observer = observer
      }
      // Buffered output may already have reported an exit (a shell that dies on
      // startup); that verdict is the newer one.
      setStatus((current) => (current.phase === 'exited'
        ? current
        : { phase: 'running', shell: String(started.shell || ''), exitCode: null }))
    }

    void boot().catch(() => {
      if (disposed) return
      runtimeRef.current = null
      setStatus((current) => ({ ...current, phase: 'failed', exitCode: null }))
    })

    return () => { disposed = true }
    // `cwd` is a dependency for correctness even though a running shell is never
    // restarted: the effect's first branch returns early when a session exists, so
    // a changed project only decides where the *next* shell starts.
  }, [active, attempt, cwd, loadRuntime])

  // Only unmounting ends the shell: `active` is about visibility, not lifetime.
  useEffect(() => () => {
    const runtime = runtimeRef.current
    runtimeRef.current = null
    if (!runtime) return
    runtime.observer?.disconnect()
    runtime.dispose?.()
    getDesktopTerminalHost()?.kill(runtime.id)
  }, [])

  const restart = () => {
    const runtime = runtimeRef.current
    runtimeRef.current = null
    if (runtime) {
      runtime.observer?.disconnect()
      runtime.dispose?.()
      getDesktopTerminalHost()?.kill(runtime.id)
    }
    setStatus({ phase: 'starting', shell: '', exitCode: null })
    setAttempt((value) => value + 1)
  }

  return (
    <section
      ref={sectionRef}
      className={`workbench-terminal-surface min-h-0 flex-1 flex-col bg-ink text-paper ${active ? 'flex' : 'hidden'}`}
      data-testid="workbench-pty-panel"
      data-phase={status.phase}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-paper/10 px-2 py-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-paper/65" title={status.shell}>
          {status.shell ? basename(status.shell) : t('workbench.terminalDesktop')}
        </span>
        <button
          type="button"
          onClick={restart}
          aria-label={t('workbench.terminalRestart')}
          title={t('workbench.terminalRestart')}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-paper/65 hover:bg-paper/10 hover:text-paper"
        >
          <RotateCcw className="h-3.5 w-3.5" />
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
        className="min-h-0 flex-1 overflow-hidden p-1.5 font-mono text-xs"
        data-testid="workbench-pty-surface"
      />
    </section>
  )
}
