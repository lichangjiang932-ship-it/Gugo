import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Writable } from 'node:stream'
import test from 'node:test'

import {
  createRunOutputFormatter,
  formatRunEvent,
  formatRunError,
  normalizeRunOutputFormat,
} from '../bin/cli/runOutput.js'

function capture() {
  const chunks = []
  return {
    chunks,
    stream: new Writable({
      write(chunk, _encoding, done) {
        chunks.push(String(chunk))
        done()
      },
    }),
  }
}

function controlledBackpressureStream() {
  const stream = new EventEmitter()
  const chunks = []
  const callbacks = []
  stream.destroyed = false
  stream.closed = false
  stream.writableEnded = false
  stream.write = (chunk, callback) => {
    chunks.push(String(chunk))
    callbacks.push(callback)
    return false
  }
  return {
    chunks,
    stream,
    release() {
      const callback = callbacks.shift()
      assert.equal(typeof callback, 'function')
      callback()
      stream.emit('drain')
    },
  }
}

function waitForTurn() {
  return new Promise((resolve) => setImmediate(resolve))
}

test('run output defaults to JSONL and preserves each event', async () => {
  const stdout = capture()
  const stderr = capture()
  const formatter = createRunOutputFormatter({ stdout: stdout.stream, stderr: stderr.stream })
  const events = [
    { type: 'turn.started', turnId: 'turn-1', payload: { content: 'hello' } },
    { type: 'turn.completed', turnId: 'turn-1', payload: { text: 'done' } },
  ]

  await Promise.all(events.map((event) => formatter.onEvent(event)))

  assert.equal(formatter.format, 'jsonl')
  assert.equal(stdout.chunks.join(''), events.map((event) => `${JSON.stringify(event)}\n`).join(''))
  assert.equal(stderr.chunks.join(''), '')
})

test('text output writes only completed text to stdout', async () => {
  const stdout = capture()
  const stderr = capture()
  const formatter = createRunOutputFormatter({
    format: 'text',
    stdout: stdout.stream,
    stderr: stderr.stream,
  })

  await formatter.writeEvent({ type: 'turn.started', payload: { content: 'hidden prompt' } })
  await formatter.writeEvent({ type: 'model.phase', payload: { phase: 'connecting' } })
  await formatter.writeEvent({ type: 'turn.completed', payload: { text: 'readable result' } })

  assert.equal(stdout.chunks.join(''), '')
  await formatter.finish({ status: 'completed', exitCode: 0 })
  assert.equal(stdout.chunks.join(''), 'readable result\n')
  assert.equal(stderr.chunks.join(''), '')
})

test('text terminal failures stay out of stdout and use stderr diagnostics', () => {
  for (const [event, diagnostic] of [
    [{ type: 'turn.failed', payload: { code: 'MODEL_FAILED', message: 'model unavailable' } }, 'Failed [MODEL_FAILED]: model unavailable\n'],
    [{ type: 'turn.blocked', payload: { code: 'APPROVAL_REQUIRED', message: 'approval required' } }, 'Blocked [APPROVAL_REQUIRED]: approval required\n'],
    [{ type: 'turn.cancelled', payload: { code: 'TURN_CANCELLED' } }, 'Cancelled [TURN_CANCELLED]\n'],
    [{ type: 'turn.cancelled', payload: { reason: 'Cancelled by user' } }, 'Cancelled: Cancelled by user\n'],
    [{ type: 'turn.paused', payload: { clarification: { question: 'Choose a directory' } } }, 'Paused: Choose a directory\n'],
    [{ type: 'turn.paused', payload: { clarification: 'Confirm the operation' } }, 'Paused: Confirm the operation\n'],
    [{ type: 'turn.interrupted', payload: { code: 'MODEL_503', message: 'upstream unavailable' } }, 'Interrupted [MODEL_503]: upstream unavailable\n'],
  ]) {
    const output = formatRunEvent(event, { format: 'text' })
    assert.equal(output.stdout, null)
    assert.equal(output.stderr, diagnostic)
  }
})

test('text failure sequences never leak partial progress or partial text to stdout', async () => {
  for (const terminalEvent of [
    { type: 'turn.failed', payload: { code: 'MODEL_FAILED', message: 'failed', partialText: 'secret partial' } },
    { type: 'turn.blocked', payload: { code: 'TURN_BLOCKED', message: 'blocked', partialText: 'secret partial' } },
    { type: 'turn.cancelled', payload: { reason: 'cancelled', partialText: 'secret partial' } },
    { type: 'turn.paused', payload: { clarification: 'input required', partialText: 'secret partial' } },
    { type: 'turn.interrupted', payload: { code: 'MODEL_INTERRUPTED', message: 'interrupted', partialText: 'secret partial' } },
  ]) {
    const stdout = capture()
    const stderr = capture()
    const formatter = createRunOutputFormatter({
      format: 'text',
      stdout: stdout.stream,
      stderr: stderr.stream,
    })
    await formatter.onEvent({ type: 'turn.started', payload: { content: 'private prompt' } })
    await formatter.onEvent({ type: 'model.delta', payload: { text: 'streamed partial' } })
    await formatter.onEvent({ type: 'turn.checkpoint', payload: { partialText: 'checkpoint partial' } })
    await formatter.onEvent(terminalEvent)
    await formatter.finish({ status: terminalEvent.type.slice('turn.'.length), exitCode: 1 })

    assert.equal(stdout.chunks.join(''), '')
    assert.ok(stderr.chunks.join('').length > 0)
  }
})

test('text CLI errors stay on stderr while JSONL keeps the stable error event', () => {
  const error = Object.assign(new Error('model is not configured'), {
    code: 'MODEL_CONFIG_MISSING',
    action: 'configure_model',
  })
  assert.deepEqual(formatRunError(error, { format: 'text' }), {
    stdout: null,
    stderr: 'Error [MODEL_CONFIG_MISSING]: model is not configured\n',
  })
  assert.deepEqual(JSON.parse(formatRunError(error).stdout.trim()), {
    type: 'cli.error',
    error: {
      code: 'MODEL_CONFIG_MISSING',
      message: 'model is not configured',
      action: 'configure_model',
    },
  })
})

test('text output discards a completed event when host shutdown later fails', async () => {
  const stdout = capture()
  const stderr = capture()
  const formatter = createRunOutputFormatter({
    format: 'text',
    stdout: stdout.stream,
    stderr: stderr.stream,
  })
  await formatter.onEvent({ type: 'turn.completed', payload: { text: 'must not commit' } })
  await formatter.writeError(Object.assign(new Error('lifecycle shutdown failed'), {
    code: 'HEADLESS_RUNTIME_SHUTDOWN_FAILED',
  }))
  await formatter.finish({ status: 'completed', exitCode: 0 })

  assert.equal(stdout.chunks.join(''), '')
  assert.equal(
    stderr.chunks.join(''),
    'Error [HEADLESS_RUNTIME_SHUTDOWN_FAILED]: lifecycle shutdown failed\n',
  )
})

test('unknown run output format fails with a stable usage error', () => {
  assert.throws(
    () => normalizeRunOutputFormat('yaml'),
    (error) => error?.code === 'CLI_OUTPUT_INVALID' && error?.exitCode === 2,
  )
})

test('formatter serializes writes and waits for drain after backpressure', async () => {
  const stdout = controlledBackpressureStream()
  const stderr = capture()
  const formatter = createRunOutputFormatter({
    stdout: stdout.stream,
    stderr: stderr.stream,
  })
  const firstEvent = { type: 'turn.started', sequence: 1 }
  const secondEvent = { type: 'turn.completed', sequence: 2, payload: { text: 'done' } }

  const first = formatter.onEvent(firstEvent)
  const second = formatter.onEvent(secondEvent)
  const flushed = formatter.flush()
  await waitForTurn()

  assert.deepEqual(stdout.chunks, [`${JSON.stringify(firstEvent)}\n`])
  stdout.release()
  await first
  await waitForTurn()

  assert.deepEqual(stdout.chunks, [
    `${JSON.stringify(firstEvent)}\n`,
    `${JSON.stringify(secondEvent)}\n`,
  ])
  stdout.release()
  await Promise.all([second, flushed])
})

test('finish waits for queued events even when the producer ignores onEvent promises', async () => {
  const stdout = controlledBackpressureStream()
  const stderr = capture()
  const formatter = createRunOutputFormatter({
    stdout: stdout.stream,
    stderr: stderr.stream,
  })
  const event = { type: 'turn.completed', sequence: 1, payload: { text: 'done' } }

  formatter.onEvent(event)
  const finished = formatter.finish({ status: 'completed', exitCode: 0 })
  let didFinish = false
  finished.then(() => { didFinish = true })
  await waitForTurn()

  assert.equal(didFinish, false)
  assert.deepEqual(stdout.chunks, [`${JSON.stringify(event)}\n`])
  stdout.release()
  assert.deepEqual(await finished, { stdout: null, stderr: null })
  assert.equal(didFinish, true)
})

test('formatter turns EPIPE into an awaitable stable write failure', async () => {
  const stdout = controlledBackpressureStream()
  const stderr = capture()
  const formatter = createRunOutputFormatter({
    stdout: stdout.stream,
    stderr: stderr.stream,
  })
  const pending = formatter.onEvent({ type: 'turn.started', sequence: 1 })
  await waitForTurn()
  stdout.stream.emit('error', Object.assign(new Error('broken pipe'), { code: 'EPIPE' }))

  await assert.rejects(pending, (error) => (
    error?.code === 'CLI_OUTPUT_WRITE_FAILED'
    && error?.causeCode === 'EPIPE'
    && error?.stream === 'stdout'
    && error?.exitCode === 1
  ))
  await assert.rejects(
    formatter.flush(),
    (error) => error?.code === 'CLI_OUTPUT_WRITE_FAILED' && error?.causeCode === 'EPIPE',
  )
})

test('formatter normalizes a synchronous EPIPE thrown by write', async () => {
  const stdout = new EventEmitter()
  stdout.destroyed = false
  stdout.closed = false
  stdout.writableEnded = false
  stdout.write = () => {
    throw Object.assign(new Error('broken pipe'), { code: 'EPIPE' })
  }
  const formatter = createRunOutputFormatter({ stdout, stderr: capture().stream })

  await assert.rejects(
    formatter.onEvent({ type: 'turn.started', sequence: 1 }),
    (error) => (
      error?.code === 'CLI_OUTPUT_WRITE_FAILED'
      && error?.causeCode === 'EPIPE'
      && error?.stream === 'stdout'
    ),
  )
  await assert.rejects(
    formatter.finish({ status: 'completed', exitCode: 0 }),
    (error) => error?.code === 'CLI_OUTPUT_WRITE_FAILED',
  )
})

test('formatter rejects a stream that was already closed before its first write', async () => {
  const stdout = new EventEmitter()
  let writes = 0
  stdout.destroyed = false
  stdout.closed = true
  stdout.writableEnded = false
  stdout.write = () => {
    writes += 1
    return true
  }
  const formatter = createRunOutputFormatter({ stdout, stderr: capture().stream })

  await assert.rejects(
    formatter.onEvent({ type: 'turn.started', sequence: 1 }),
    (error) => error?.code === 'CLI_OUTPUT_STREAM_CLOSED' && error?.stream === 'stdout',
  )
  assert.equal(writes, 0)
})

test('formatter reports a stream close while a write is pending', async () => {
  const stdout = controlledBackpressureStream()
  const stderr = capture()
  const formatter = createRunOutputFormatter({
    stdout: stdout.stream,
    stderr: stderr.stream,
  })
  const pending = formatter.onEvent({ type: 'turn.started', sequence: 1 })
  await waitForTurn()
  stdout.stream.closed = true
  stdout.stream.emit('close')

  await assert.rejects(pending, (error) => (
    error?.code === 'CLI_OUTPUT_STREAM_CLOSED'
    && error?.stream === 'stdout'
    && error?.exitCode === 1
  ))
  await assert.rejects(
    formatter.finish({ status: 'completed', exitCode: 0 }),
    (error) => error?.code === 'CLI_OUTPUT_STREAM_CLOSED',
  )
})
