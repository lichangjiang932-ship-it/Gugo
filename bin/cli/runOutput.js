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

function uniqueTextValues(...sources) {
  return [...new Set(sources
    .flatMap((source) => Array.isArray(source) ? source : (typeof source === 'string' ? [source] : []))
    .map((value) => String(value || '').trim())
    .filter(Boolean))]
}

function localFileLabels(...sources) {
  return [...new Set(sources
    .flatMap((source) => Array.isArray(source) ? source : [])
    .map((file) => typeof file === 'string'
      ? file.trim()
      : String(file?.path || file?.filename || file?.id || '').trim())
    .filter(Boolean))]
}

const COMPLETED_VERIFICATION_CHECK_STATUSES = new Set([
  'pass',
  'passed',
  'success',
  'succeeded',
  'complete',
  'completed',
  'ok',
])

function taskVerificationCheckIssue(check) {
  if (!check || typeof check !== 'object' || Array.isArray(check)) return ''
  const status = String(check.status || 'failed').trim().toLowerCase()
  if (COMPLETED_VERIFICATION_CHECK_STATUSES.has(status)) return ''
  const kind = String(check.kind || 'check').trim()
  const code = String(check.code || '').trim()
  const command = String(check.commandScope || '').trim()
  const cwd = String(check.cwd || '').trim()
  const diagnostic = String(check.diagnostic || '').trim()
  const targets = uniqueTextValues(check.mutationTargets)
  const identity = `${status} ${kind}${code ? ` [${code}]` : ''}`
  const scope = [command ? `command=${command}` : '', cwd ? `cwd=${cwd}` : '']
    .filter(Boolean)
    .join(', ')
  return `${identity}${scope ? ` (${scope})` : ''}`
    + `${diagnostic ? `: ${diagnostic}` : ''}`
    + `${targets.length > 0 ? `; targets=${targets.join(', ')}` : ''}`
}

function taskVerificationIssues(...sources) {
  const issues = []
  for (const source of sources) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue
    issues.push(...uniqueTextValues(source.issues, source.missingRequirements))
    const reason = String(source.reason || source.summary || '').trim()
    if (reason) issues.push(reason)
    if (Array.isArray(source.checks)) {
      issues.push(...source.checks.map(taskVerificationCheckIssue).filter(Boolean))
    }
  }
  return [...new Set(issues)]
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
      || nested.reason
      || payload.message
      || payload.reason
      || clarificationMessage
      || payload.text
      || '',
  ).trim()
  const incompleteReason = String(
    nested.incompleteReason || payload.incompleteReason || '',
  ).trim()
  const missingRequirements = uniqueTextValues(
    nested.missingRequirements,
    payload.missingRequirements,
  )
  const artifactIds = uniqueTextValues(
    nested.artifactIds,
    nested.deliveryArtifactIds,
    payload.artifactIds,
    payload.deliveryArtifactIds,
  )
  const verifiedFiles = localFileLabels(
    nested.verifiedLocalFiles,
    payload.verifiedLocalFiles,
  )
  const retainedFiles = localFileLabels(
    nested.retainedLocalFiles,
    payload.retainedLocalFiles,
  )
  const verificationIssues = taskVerificationIssues(
    nested.taskVerification,
    payload.taskVerification,
  )
  const retryable = typeof nested.retryable === 'boolean'
    ? nested.retryable
    : payload.retryable === true
  const manualRetryable = typeof nested.manualRetryable === 'boolean'
    ? nested.manualRetryable
    : payload.manualRetryable === true
  const details = [`${label}${code ? ` [${code}]` : ''}`]
  const reason = incompleteReason || message
  if (reason) details.push(`Reason: ${reason}`)
  if (incompleteReason && message && message !== incompleteReason) {
    details.push(`Detail: ${message}`)
  }
  if (missingRequirements.length > 0) {
    details.push(`Missing: ${missingRequirements.join(', ')}`)
  }
  if (artifactIds.length > 0) details.push(`Saved artifacts: ${artifactIds.join(', ')}`)
  if (verifiedFiles.length > 0) details.push(`Verified files: ${verifiedFiles.join(', ')}`)
  if (retainedFiles.length > 0) details.push(`Saved files awaiting verification: ${retainedFiles.join(', ')}`)
  if (verificationIssues.length > 0) details.push(`Verification: ${verificationIssues.join('; ')}`)
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
  const recovery = error?.recovery && typeof error.recovery === 'object' ? error.recovery : {}
  const serverFailure = error?.serverFailure && typeof error.serverFailure === 'object'
    ? error.serverFailure
    : {}
  const recoveryFailure = recovery.error && typeof recovery.error === 'object' ? recovery.error : {}
  const code = String(
    error?.code || serverFailure.code || recoveryFailure.code || recovery.errorCode || 'CLI_RUN_FAILED',
  ).trim() || 'CLI_RUN_FAILED'
  const message = String(
    error?.message || serverFailure.message || recoveryFailure.message
      || recovery.errorMessage || error?.reason || recovery.reason || error || 'run failed',
  ).trim()
  const causeMessage = [
    serverFailure.message,
    recoveryFailure.message,
    recovery.errorMessage,
  ].map((value) => String(value || '').trim()).find((value) => value && value !== message) || ''
  const action = String(
    error?.action || serverFailure.action || recoveryFailure.action || recovery.action || '',
  ).trim()
  const reason = String(
    error?.reason || serverFailure.reason || recoveryFailure.reason || recovery.reason || '',
  ).trim()
  const incompleteReason = String(
    error?.incompleteReason || serverFailure.incompleteReason
      || recoveryFailure.incompleteReason || recovery.incompleteReason || '',
  ).trim()
  const missingRequirements = uniqueTextValues(
    error?.missingRequirements,
    serverFailure.missingRequirements,
    recoveryFailure.missingRequirements,
    recovery.missingRequirements,
  )
  const artifactIds = uniqueTextValues(
    error?.artifactIds,
    error?.deliveryArtifactIds,
    serverFailure.artifactIds,
    serverFailure.deliveryArtifactIds,
    recoveryFailure.artifactIds,
    recoveryFailure.deliveryArtifactIds,
    recovery.artifactIds,
    recovery.deliveryArtifactIds,
  )
  const verifiedFiles = localFileLabels(
    error?.verifiedLocalFiles,
    serverFailure.verifiedLocalFiles,
    recoveryFailure.verifiedLocalFiles,
    recovery.verifiedLocalFiles,
  )
  const retainedFiles = localFileLabels(
    error?.retainedLocalFiles,
    serverFailure.retainedLocalFiles,
    recoveryFailure.retainedLocalFiles,
    recovery.retainedLocalFiles,
  )
  const verificationIssues = taskVerificationIssues(
    error?.taskVerification,
    serverFailure.taskVerification,
    recoveryFailure.taskVerification,
    recovery.taskVerification,
  )
  const taskVerification = [
    error?.taskVerification,
    serverFailure.taskVerification,
    recoveryFailure.taskVerification,
    recovery.taskVerification,
  ].find((value) => value && typeof value === 'object' && !Array.isArray(value)) || null
  const retryable = typeof error?.retryable === 'boolean'
    ? error.retryable
    : typeof serverFailure.retryable === 'boolean'
      ? serverFailure.retryable
      : typeof recoveryFailure.retryable === 'boolean'
        ? recoveryFailure.retryable
        : typeof recovery.retryable === 'boolean' ? recovery.retryable : null
  const manualRetryable = typeof error?.manualRetryable === 'boolean'
    ? error.manualRetryable
    : typeof serverFailure.manualRetryable === 'boolean'
      ? serverFailure.manualRetryable
      : typeof recoveryFailure.manualRetryable === 'boolean'
        ? recoveryFailure.manualRetryable
        : typeof recovery.manualRetryable === 'boolean' ? recovery.manualRetryable : null
  const details = [`Error [${code}]: ${message}`]
  if (causeMessage) details.push(`Detail: ${causeMessage}`)
  const explicitReason = incompleteReason || reason
  if (explicitReason && explicitReason !== message) details.push(`Reason: ${explicitReason}`)
  if (missingRequirements.length > 0) details.push(`Missing: ${missingRequirements.join(', ')}`)
  if (artifactIds.length > 0) details.push(`Saved artifacts: ${artifactIds.join(', ')}`)
  if (verifiedFiles.length > 0) details.push(`Verified files: ${verifiedFiles.join(', ')}`)
  if (retainedFiles.length > 0) details.push(`Saved files awaiting verification: ${retainedFiles.join(', ')}`)
  if (verificationIssues.length > 0) details.push(`Verification: ${verificationIssues.join('; ')}`)
  if (retryable) details.push('Next: retry this turn from its durable checkpoint.')
  else if (manualRetryable) details.push('Next: verify the recorded outcome, then retry explicitly.')
  else if (missingRequirements.length > 0) details.push('Next: satisfy the missing requirements and run again.')
  const diagnostic = line(details.join('\n'))
  if (resolvedFormat === 'text') {
    return Object.freeze({ stdout: null, stderr: diagnostic })
  }
  const event = {
    type: 'cli.error',
    error: {
      code,
      message,
      ...(causeMessage ? { causeMessage } : {}),
      ...(action ? { action } : {}),
      ...(reason && reason !== message ? { reason } : {}),
      ...(incompleteReason ? { incompleteReason } : {}),
      ...(missingRequirements.length > 0 ? { missingRequirements } : {}),
      ...(artifactIds.length > 0 ? { artifactIds } : {}),
      ...(verifiedFiles.length > 0 ? { verifiedLocalFiles: verifiedFiles } : {}),
      ...(retainedFiles.length > 0 ? { retainedLocalFiles: retainedFiles } : {}),
      ...(taskVerification ? { taskVerification } : {}),
      ...(verificationIssues.length > 0 ? { verificationIssues } : {}),
      ...(typeof retryable === 'boolean' ? { retryable } : {}),
      ...(typeof manualRetryable === 'boolean' ? { manualRetryable } : {}),
    },
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
