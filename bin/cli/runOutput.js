import { createSerializedWriter, handled } from './runOutputStream.js'
import {
  completedEventSucceeded,
  createRunTerminalObserver,
  formatProgressEvent,
  formatRunError,
  line,
  isFinalRunTerminal,
  normalizeRunOutputFormat,
  runResultSucceeded,
  runOutcomeConflictError,
  runResultIdentityConflict,
  runTerminalsConflict,
  terminalDescriptor,
  terminalDiagnostic,
} from './runDiagnostics.js'

export { CliOutputError } from './runOutputStream.js'
export { formatProgressEvent, formatRunError, normalizeRunOutputFormat } from './runDiagnostics.js'
export function formatRunEvent(event, { format = 'jsonl' } = {}) {
  const resolvedFormat = normalizeRunOutputFormat(format)
  if (resolvedFormat === 'jsonl') {
    return Object.freeze({ stdout: `${JSON.stringify(event)}\n`, stderr: null })
  }
  if (completedEventSucceeded(event)) {
    return Object.freeze({ stdout: line(event?.payload?.text), stderr: null })
  }
  const diagnostic = terminalDiagnostic(event)
  if (!diagnostic) return Object.freeze({ stdout: null, stderr: null })
  // Text mode treats stdout as a successful-result channel. Partial model
  // output remains available in JSONL but must not look like a completed
  // answer to shell pipelines when the durable terminal state is non-success.
  return Object.freeze({ stdout: null, stderr: diagnostic })
}

function createLiveTextOutput(writer) {
  let text = ''
  let openLine = false
  const breakLine = async () => {
    if (openLine) await writer.write('\n')
    openLine = false
  }
  return {
    breakLine,
    async delta(event) {
      if (event?.type !== 'assistant.delta' || typeof event.payload?.text !== 'string' || !event.payload.text) return
      if (!text) await writer.write('[assistant provisional]\n')
      await writer.write(event.payload.text)
      text += event.payload.text
      openLine = !event.payload.text.endsWith('\n')
    },
    async finish(finalText, completed) {
      if (!text) return finalText
      let replacement = null
      if (completed && finalText?.startsWith(text)) {
        const suffix = finalText.slice(text.length)
        if (suffix) {
          await writer.write(suffix)
          openLine = !suffix.endsWith('\n')
        }
        await breakLine()
        await writer.write('[assistant confirmed]\n')
      } else {
        await breakLine()
        await writer.write(completed
          ? '[assistant final; replaces provisional text]\n'
          : '[assistant not confirmed]\n')
        replacement = finalText
      }
      text = ''
      return replacement
    },
  }
}

export function createRunOutputFormatter({
  format = 'jsonl',
  progress = false,
  liveText = false,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const resolvedFormat = normalizeRunOutputFormat(format)
  const stdoutWriter = createSerializedWriter(stdout, 'stdout')
  const stderrWriter = createSerializedWriter(stderr, 'stderr')
  const live = liveText && resolvedFormat === 'text' ? createLiveTextOutput(stdoutWriter) : null
  let pendingCompletedText = null
  let pendingTerminalDiagnostic = null
  let observedTurnTerminal = null
  const terminalObserver = createRunTerminalObserver()
  let finalized = false
  let operationTail = Promise.resolve()

  const enqueue = (operation) => {
    const result = operationTail.then(operation)
    operationTail = result.catch(() => {})
    return handled(result)
  }
  const writeOutput = async (output) => {
    let firstFailure = null
    if (output.stdout) {
      try {
        await stdoutWriter.write(output.stdout)
      } catch (error) {
        firstFailure = error
      }
    }
    if (output.stderr) {
      try {
        await stderrWriter.write(output.stderr)
      } catch (error) {
        firstFailure ||= error
      }
    }
    if (firstFailure) throw firstFailure
  }
  const flushWriters = async () => {
    const results = await Promise.allSettled([
      stdoutWriter.flush(),
      stderrWriter.flush(),
    ])
    const rejected = results.find((result) => result.status === 'rejected')
    if (rejected) throw rejected.reason
  }
  const writeEvent = (event) => {
    const output = formatRunEvent(event, { format: resolvedFormat })
    const progressLine = progress ? formatProgressEvent(event) : null
    return enqueue(async () => {
      if (live && finalized) return output
      if (progressLine) {
        await live?.breakLine()
        await stderrWriter.write(`[gugo] ${progressLine}\n`)
      }
      await live?.delta(event)
      if (terminalObserver.observe(event)) {
        pendingCompletedText = null
        pendingTerminalDiagnostic = null
      }
      observedTurnTerminal = terminalObserver.terminal
      if (resolvedFormat === 'text' && (completedEventSucceeded(event) || terminalDescriptor(event))) {
        // The pending projection must follow the same accepted Turn outcome as
        // the observer. A late nonfinal event cannot erase its answer/failure;
        // an explicit attempt reset above releases both pieces of state.
        if (!event?.type?.startsWith?.('turn.') || observedTurnTerminal === event) {
          pendingCompletedText = output.stdout
          pendingTerminalDiagnostic = output.stderr
        }
        return output
      }
      await writeOutput(output)
      return output
    })
  }
  const writeError = (error) => {
    const output = formatRunError(error, { format: resolvedFormat })
    return enqueue(async () => {
      pendingCompletedText = null
      pendingTerminalDiagnostic = null
      finalized = true
      await live?.finish(null, false)
      await writeOutput(output)
      return output
    })
  }
  const finish = (result) => enqueue(async () => {
    if (finalized) {
      await flushWriters()
      return Object.freeze({ stdout: null, stderr: null })
    }
    finalized = true
    const returnedTerminal = result?.lastEvent
    // Recovery may return its persisted terminal without replaying a callback.
    // Publish that exact event once; never fabricate a terminal from status alone.
    if (returnedTerminal && (!observedTurnTerminal || (!isFinalRunTerminal(observedTurnTerminal)
      && observedTurnTerminal.type !== returnedTerminal.type))
      && (returnedTerminal.type === 'turn.completed' || terminalDescriptor(returnedTerminal))) {
      terminalObserver.observe(returnedTerminal)
      observedTurnTerminal = terminalObserver.terminal
      const returnedOutput = formatRunEvent(returnedTerminal, { format: resolvedFormat })
      if (resolvedFormat === 'text') {
        pendingCompletedText = returnedOutput.stdout
        pendingTerminalDiagnostic = returnedOutput.stderr
      } else await writeOutput(returnedOutput)
    }
    const conflict = terminalObserver.conflict || runTerminalsConflict(result?.lastEvent, observedTurnTerminal)
      || runResultIdentityConflict(result, result?.lastEvent) || runResultIdentityConflict(result, observedTurnTerminal)
    const conflictOutput = conflict ? formatRunError(runOutcomeConflictError(observedTurnTerminal), { format: resolvedFormat }) : null
    const completed = !conflict && runResultSucceeded(result, observedTurnTerminal)
    let committedText = completed ? pendingCompletedText : null
    if (live) committedText = await live.finish(committedText, completed)
    const committedDiagnostic = completed ? null : pendingTerminalDiagnostic
    pendingCompletedText = null
    pendingTerminalDiagnostic = null
    const output = Object.freeze({ stdout: conflictOutput?.stdout ?? committedText, stderr: conflictOutput?.stderr ?? committedDiagnostic })
    await writeOutput(output)
    await flushWriters()
    return output
  })
  const flush = () => enqueue(flushWriters)
  const dispose = () => enqueue(async () => {
    try {
      if (!finalized) {
        finalized = true
        await live?.finish(null, false)
      }
    } finally {
      await Promise.all([stdoutWriter.dispose(), stderrWriter.dispose()])
    }
  })
  const resolveExitCode = (result) => {
    const declared = Number.isInteger(result?.exitCode) ? result.exitCode : null
    if (terminalObserver.conflict || !runResultSucceeded(result, observedTurnTerminal)) {
      return declared !== null && declared !== 0 ? declared : 1
    }
    return declared ?? 0
  }
  return Object.freeze({
    format: resolvedFormat,
    writeEvent,
    writeError,
    finish,
    flush,
    dispose,
    resolveExitCode,
    onEvent: writeEvent,
  })
}
