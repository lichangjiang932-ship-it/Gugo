const RUN_OUTPUT_FORMATS = new Set(['jsonl', 'text'])

const TEXT_TERMINAL_DIAGNOSTICS = Object.freeze({
  'turn.failed': 'Failed',
  'turn.blocked': 'Blocked',
  'turn.cancelled': 'Cancelled',
  'turn.paused': 'Paused',
  'turn.interrupted': 'Interrupted',
})

export class CliOutputError extends Error {
  constructor(code, message, exitCode = 2) {
    super(message)
    this.name = 'CliOutputError'
    this.code = code
    this.exitCode = exitCode
  }
}

function streamFailure(streamName, kind, cause = null) {
  const causeCode = String(cause?.code || '').trim()
  const closed = kind === 'closed'
  const error = new CliOutputError(
    closed ? 'CLI_OUTPUT_STREAM_CLOSED' : 'CLI_OUTPUT_WRITE_FAILED',
    closed
      ? `${streamName} closed before CLI output completed`
      : `${streamName} write failed${causeCode ? ` (${causeCode})` : ''}`,
    1,
  )
  error.stream = streamName
  if (causeCode) error.causeCode = causeCode
  if (cause) error.cause = cause
  return error
}

function handled(promise) {
  // Runtime event producers are allowed to ignore onEvent's return value. Keep
  // the promise awaitable without turning a broken pipe into an unhandled
  // rejection before finish()/flush() observes the same writer failure.
  promise.catch(() => {})
  return promise
}

function createSerializedWriter(stream, streamName) {
  if (!stream || typeof stream.write !== 'function'
    || typeof stream.on !== 'function'
    || typeof stream.removeListener !== 'function') {
    throw new CliOutputError(
      'CLI_OUTPUT_STREAM_INVALID',
      `${streamName} must be a writable stream`,
    )
  }

  let tail = Promise.resolve()
  let failure = null
  let rejectActiveWrite = null

  const rememberFailure = (kind, cause = null) => {
    if (!failure) failure = streamFailure(streamName, kind, cause)
    rejectActiveWrite?.(failure)
    return failure
  }
  const onError = (error) => rememberFailure('error', error)
  const onClose = () => rememberFailure('closed')
  stream.on('error', onError)
  stream.on('close', onClose)

  const assertWritable = () => {
    if (failure) throw failure
    if (stream.destroyed || stream.closed || stream.writableEnded) {
      throw rememberFailure('closed')
    }
  }

  const writeOne = (chunk) => new Promise((resolve, reject) => {
    let callbackCompleted = false
    let drainCompleted = false
    let writeReturned = false
    let needsDrain = true
    let settled = false

    const cleanup = () => {
      stream.removeListener('drain', onDrain)
      if (rejectActiveWrite === rejectForFailure) rejectActiveWrite = null
    }
    const settle = (error = null) => {
      if (settled) return
      if (!error && (!writeReturned || !callbackCompleted || (needsDrain && !drainCompleted))) {
        return
      }
      settled = true
      cleanup()
      if (error) reject(error)
      else resolve()
    }
    const rejectForFailure = (error) => settle(error)
    const onDrain = () => {
      drainCompleted = true
      settle()
    }
    const onWritten = (error) => {
      if (error) {
        settle(rememberFailure('error', error))
        return
      }
      callbackCompleted = true
      settle()
    }

    // Register before write(): custom Writable implementations may complete or
    // signal failure synchronously.
    rejectActiveWrite = rejectForFailure
    stream.once('drain', onDrain)
    try {
      const accepted = stream.write(chunk, onWritten)
      writeReturned = true
      needsDrain = accepted === false
      if (!needsDrain) {
        drainCompleted = true
        stream.removeListener('drain', onDrain)
      }
      settle()
    } catch (error) {
      writeReturned = true
      settle(rememberFailure('error', error))
    }
  })

  const write = (chunk) => {
    const operation = tail.then(async () => {
      assertWritable()
      await writeOne(chunk)
      assertWritable()
    })
    tail = operation.catch(() => {})
    return handled(operation)
  }

  const flush = () => {
    const barrier = tail.then(() => assertWritable())
    return handled(barrier)
  }

  return Object.freeze({ write, flush })
}

export function normalizeRunOutputFormat(value = 'jsonl') {
  const format = String(value ?? 'jsonl').trim().toLowerCase() || 'jsonl'
  if (!RUN_OUTPUT_FORMATS.has(format)) {
    throw new CliOutputError(
      'CLI_OUTPUT_INVALID',
      'output format must be one of jsonl, text',
    )
  }
  return format
}

function line(value) {
  const text = String(value ?? '')
  if (!text.trim()) return null
  return /\r?\n$/u.test(text) ? text : `${text}\n`
}

function terminalDiagnostic(event) {
  const label = TEXT_TERMINAL_DIAGNOSTICS[event?.type]
  if (!label) return null
  const payload = event?.payload && typeof event.payload === 'object' ? event.payload : {}
  const nested = payload.error && typeof payload.error === 'object' ? payload.error : {}
  // `payload.error` is the canonical failure object. Top-level fields only
  // remain for replay compatibility and may contain an older generic value.
  const code = String(nested.code || payload.code || '').trim()
  const clarification = payload.clarification
  const clarificationMessage = typeof clarification === 'string'
    ? clarification
    : clarification?.question || clarification?.message
  const message = String(
    nested.message
      || payload.message
      || payload.reason
      || clarificationMessage
      || '',
  ).trim()
  const incompleteReason = String(
    nested.incompleteReason || payload.incompleteReason || '',
  ).trim()
  const nestedMissingRequirements = Array.isArray(nested.missingRequirements)
    ? nested.missingRequirements
    : []
  const payloadMissingRequirements = Array.isArray(payload.missingRequirements)
    ? payload.missingRequirements
    : []
  const missingRequirements = [...new Set((nestedMissingRequirements.length > 0
    ? nestedMissingRequirements
    : payloadMissingRequirements)
    .map((value) => String(value || '').trim())
    .filter(Boolean))]
  const artifactIds = [...new Set((Array.isArray(payload.artifactIds)
    && payload.artifactIds.length > 0
    ? payload.artifactIds
    : Array.isArray(nested.artifactIds) ? nested.artifactIds : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean))]
  const verifiedFiles = (Array.isArray(payload.verifiedLocalFiles)
    && payload.verifiedLocalFiles.length > 0
    ? payload.verifiedLocalFiles
    : Array.isArray(nested.verifiedLocalFiles) ? nested.verifiedLocalFiles : [])
    .map((file) => String(file?.filename || file?.path || '').trim())
    .filter(Boolean)
  const retainedFiles = (Array.isArray(payload.retainedLocalFiles)
    && payload.retainedLocalFiles.length > 0
    ? payload.retainedLocalFiles
    : Array.isArray(nested.retainedLocalFiles) ? nested.retainedLocalFiles : [])
    .map((file) => String(file?.filename || file?.path || '').trim())
    .filter(Boolean)
  const retryable = typeof nested.retryable === 'boolean'
    ? nested.retryable
    : payload.retryable === true
  const manualRetryable = typeof nested.manualRetryable === 'boolean'
    ? nested.manualRetryable
    : payload.manualRetryable === true
  const details = [`${label}${code ? ` [${code}]` : ''}`]
  const reason = incompleteReason || message
  if (reason) details.push(`Reason: ${reason}`)
  if (missingRequirements.length > 0) {
    details.push(`Missing: ${missingRequirements.join(', ')}`)
  }
  if (artifactIds.length > 0) details.push(`Saved artifacts: ${artifactIds.join(', ')}`)
  if (verifiedFiles.length > 0) details.push(`Verified files: ${verifiedFiles.join(', ')}`)
  if (retainedFiles.length > 0) details.push(`Saved files awaiting verification: ${retainedFiles.join(', ')}`)
  if (retryable) details.push('Next: retry this turn from its durable checkpoint.')
  else if (manualRetryable) details.push('Next: verify the recorded outcome, then retry explicitly.')
  else if (missingRequirements.length > 0) details.push('Next: satisfy the missing requirements and run again.')
  return line(details.join('\n'))
}

export function formatRunEvent(event, { format = 'jsonl' } = {}) {
  const resolvedFormat = normalizeRunOutputFormat(format)
  if (resolvedFormat === 'jsonl') {
    return Object.freeze({ stdout: `${JSON.stringify(event)}\n`, stderr: null })
  }
  if (event?.type === 'turn.completed') {
    return Object.freeze({ stdout: line(event?.payload?.text), stderr: null })
  }
  const diagnostic = terminalDiagnostic(event)
  if (!diagnostic) return Object.freeze({ stdout: null, stderr: null })
  // Text mode treats stdout as a successful-result channel. Partial model
  // output remains available in JSONL but must not look like a completed
  // answer to shell pipelines when the durable terminal state is non-success.
  return Object.freeze({ stdout: null, stderr: diagnostic })
}

export function formatRunError(error, { format = 'jsonl' } = {}) {
  const resolvedFormat = normalizeRunOutputFormat(format)
  const code = String(error?.code || 'CLI_RUN_FAILED').trim() || 'CLI_RUN_FAILED'
  const message = String(error?.message || error || 'run failed').trim()
  const action = String(error?.action || '').trim()
  const diagnostic = line(`Error [${code}]: ${message}`)
  if (resolvedFormat === 'text') {
    return Object.freeze({ stdout: null, stderr: diagnostic })
  }
  const event = {
    type: 'cli.error',
    error: { code, message, ...(action ? { action } : {}) },
  }
  return Object.freeze({ stdout: `${JSON.stringify(event)}\n`, stderr: diagnostic })
}

export function createRunOutputFormatter({
  format = 'jsonl',
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const resolvedFormat = normalizeRunOutputFormat(format)
  const stdoutWriter = createSerializedWriter(stdout, 'stdout')
  const stderrWriter = createSerializedWriter(stderr, 'stderr')
  let pendingCompletedText = null
  let pendingTerminalDiagnostic = null
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
    return enqueue(async () => {
      if (resolvedFormat === 'text' && event?.type === 'turn.completed') {
        pendingCompletedText = output.stdout
        pendingTerminalDiagnostic = null
        return output
      }
      if (resolvedFormat === 'text' && TEXT_TERMINAL_DIAGNOSTICS[event?.type]) {
        pendingCompletedText = output.stdout
        pendingTerminalDiagnostic = output.stderr
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
    const completed = result?.status === 'completed' && result?.exitCode === 0
    const committedText = completed ? pendingCompletedText : null
    const committedDiagnostic = completed ? null : pendingTerminalDiagnostic
    pendingCompletedText = null
    pendingTerminalDiagnostic = null
    const output = Object.freeze({ stdout: committedText, stderr: committedDiagnostic })
    await writeOutput(output)
    await flushWriters()
    return output
  })
  const flush = () => enqueue(flushWriters)
  return Object.freeze({
    format: resolvedFormat,
    writeEvent,
    writeError,
    finish,
    flush,
    onEvent: writeEvent,
  })
}
