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

export function handled(promise) {
  // Runtime event producers are allowed to ignore onEvent's return value. Keep
  // the promise awaitable without turning a broken pipe into an unhandled
  // rejection before finish()/flush() observes the same writer failure.
  promise.catch(() => {})
  return promise
}

export function createSerializedWriter(stream, streamName) {
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
