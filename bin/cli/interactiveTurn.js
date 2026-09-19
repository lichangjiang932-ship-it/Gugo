import { createRunInteractionPorts } from './runInteractionPorts.js'
import { createRunTerminalObserver, formatProgressEvent } from './runDiagnostics.js'
import { CliError } from './errors.js'
import { resolveRunDeadlineOutcome } from './runDeadline.js'

function write(stream, text) {
  try { stream.write(text + '\n') } catch { /* Closed terminal. */ }
}

function discardBufferedInput(stdin) {
  if (typeof stdin.read !== 'function') return
  let chunk = stdin.read()
  while (chunk !== null) chunk = stdin.read()
}

function startTurnTimeout({ timeoutMs, controller, signal, stderr }) {
  if (!(timeoutMs > 0)) return { error: null, clear() {} }
  const error = new CliError('CLI_RUN_TIMEOUT', `run timed out after ${timeoutMs}ms`, 124)
  const timer = setTimeout(() => {
    // The first cancellation owns the reason, including an external shutdown.
    if (signal.aborted) return
    write(stderr, `\n[turn timeout requested after ${timeoutMs}ms; waiting for runtime cleanup]`)
    controller.abort(error)
  }, timeoutMs)
  return { error, clear: () => clearTimeout(timer) }
}

async function reportTurnTimeout(output, stderr, error) {
  await output.writeError(error)
  write(stderr, '[turn timed out]')
  return null
}

export async function runInteractiveTurn({
  parsed, state, runtime, stdin, stdout, stderr, env, signal, reader, setController, timeoutMs = 0,
}) {
  const controller = new AbortController()
  const attachmentRequests = state.attachments.take()
  setController(controller)
  const runtimeSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
  const timeout = startTurnTimeout({ timeoutMs, controller, signal: runtimeSignal, stderr })
  // The same interaction ports `gugo run` uses: approval, directory
  // authorization and unknown-side-effect recovery. Without them the runtime's
  // fail-closed default denies every approval-requiring tool in chat.
  const interactionPorts = createRunInteractionPorts({
    stdin, diagnostics: stderr, signal: runtimeSignal,
  })
  // Release stdin for the whole turn: approval and recovery prompts create
  // their own interface, and two readers on one stdin drop each other's lines.
  let output
  const terminalObserver = createRunTerminalObserver()
  try {
    reader.suspend()
    if (runtimeSignal.aborted) throw runtimeSignal.reason
    const formatter = await import('./runOutput.js')
    output = formatter.createRunOutputFormatter({
      format: 'text', progress: true, liveText: true, stdout, stderr,
    })
    const guardedPorts = Object.fromEntries(Object.entries(interactionPorts).map(([name, ask]) => [name, async (...args) => {
      discardBufferedInput(stdin)
      try { return await ask(...args) } finally { discardBufferedInput(stdin) }
    }]))
    const startedAt = Date.now()
    let usage = null
    if (runtimeSignal.aborted) throw runtimeSignal.reason
    let result = await runtime({
      prompt: parsed.prompt,
      ...(attachmentRequests.length ? { attachmentRequests } : {}),
      model: state.model,
      modelProviderId: state.modelProviderId,
      mode: state.mode,
      modeExplicit: state.modeExplicit,
      cwd: state.cwd,
      workspaceExplicit: true,
      sessionWorkspaceExplicit: state.cwdExplicit === true,
      sessionId: state.sessionId,
      token: '',
      interactive: true,
      signal: runtimeSignal,
      env,
      onEvent: (event) => {
        terminalObserver.observe(event)
        if (event?.type === 'model.phase' && event?.payload?.phase === 'completed') {
          usage = formatProgressEvent(event)
        }
        return output.onEvent(event)
      },
      onToken: () => {},
      onDiagnostic: (message) => stderr.write(`${message}\n`),
      ...guardedPorts,
    })
    timeout.clear()
    if (timeout.error && runtimeSignal.reason === timeout.error) {
      const outcome = resolveRunDeadlineOutcome({ result, timeoutError: timeout.error,
        observedTerminal: terminalObserver.terminal, terminalConflict: terminalObserver.conflict })
      if (Object.hasOwn(outcome, 'error')) {
        if (outcome.error === timeout.error) {
          if (result?.sessionId) state.sessionId = String(result.sessionId)
          return await reportTurnTimeout(output, stderr, timeout.error)
        }
        throw outcome.error
      }
      result = outcome.result
      write(stderr, '[deadline elapsed; preserving the turn outcome]')
    }
    if (result?.sessionId) state.sessionId = String(result.sessionId)
    await output.finish(result)
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1)
    write(stderr, `\n[turn ${result?.status || 'unknown'} in ${seconds}s${usage ? ` — ${usage}` : ''}]`)
    return result
  } catch (error) {
    timeout.clear()
    if (runtimeSignal.aborted) {
      // Only the exact local cancellation reason proves cooperative abort here.
      // Do not unwrap causes or classify arbitrary AbortErrors as cancellation:
      // persistence/shutdown failures must reach the CLI's fatal error handler.
      if (controller.signal.aborted && error === controller.signal.reason
        && runtimeSignal.reason === controller.signal.reason) {
        if (error === timeout.error) {
          const outcome = resolveRunDeadlineOutcome({ error, didThrow: true, timeoutError: timeout.error,
            observedTerminal: terminalObserver.terminal, terminalConflict: terminalObserver.conflict })
          if (Object.hasOwn(outcome, 'error')) {
            if (outcome.error === error) return await reportTurnTimeout(output, stderr, error)
            throw outcome.error
          }
          await output.finish(outcome.result)
          if (outcome.result.sessionId) state.sessionId = String(outcome.result.sessionId)
          write(stderr, `[deadline elapsed; preserving the turn outcome: ${outcome.result.status}]`)
          return outcome.result
        }
        write(stderr, '[turn cancelled]')
        return null
      }
      throw error
    }
    if (!output) throw error
    await output.writeError(error)
    write(stderr, `[turn failed: ${error?.message || error}]`)
    return null
  } finally {
    timeout.clear()
    setController(null)
    await output?.dispose()
  }
}
