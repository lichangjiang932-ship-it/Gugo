import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Writable } from 'node:stream'
import test from 'node:test'

import { createSerializedWriter } from '../bin/cli/runOutputStream.js'
import {
  createRunOutputFormatter,
  formatProgressEvent,
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

for (const [channel, format, liveText] of [['text', 'text', false], ['chat', 'text', true], ['jsonl', 'jsonl', false]]) {
  for (const status of ['completed', 'failed']) {
    for (const phase of ['waiting', 'awaiting_approval', 'paused', 'blocked']) {
      test(`${channel} keeps ${status} projection when a later ${phase} event is not a new attempt`, async () => {
        const stdout = capture()
        const stderr = capture()
        const formatter = createRunOutputFormatter({ format, liveText, stdout: stdout.stream, stderr: stderr.stream })
        const lastEvent = status === 'completed'
          ? { type: 'turn.completed', payload: { text: 'confirmed answer' } }
          : { type: 'turn.failed', payload: { code: 'SPECIFIC_FAILURE' } }
        const lateEvent = { type: `turn.${phase}`, payload: { code: 'LATE_NONFINAL_STATE' } }
        const result = { status, exitCode: status === 'completed' ? 0 : 1, lastEvent }
        try {
          if (liveText) await formatter.onEvent({ type: 'assistant.delta', payload: { text: 'confirmed ' } })
          await formatter.onEvent(lastEvent)
          await formatter.onEvent(lateEvent)
          await formatter.finish(result)
          assert.equal(formatter.resolveExitCode(result), result.exitCode)
          if (format === 'jsonl') {
            assert.deepEqual(stdout.chunks.join('').trim().split('\n').map((line) => JSON.parse(line)), [lastEvent, lateEvent])
          } else if (status === 'completed') {
            assert.match(stdout.chunks.join(''), /confirmed answer/u)
            assert.equal((stdout.chunks.join('').match(/confirmed answer/gu) || []).length, 1)
            if (liveText) assert.match(stdout.chunks.join(''), /\[assistant confirmed\]/u)
            assert.equal(stderr.chunks.join(''), '')
          } else {
            assert.match(stderr.chunks.join(''), /SPECIFIC_FAILURE/u)
            assert.doesNotMatch(stderr.chunks.join(''), /LATE_NONFINAL_STATE/u)
            if (liveText) assert.match(stdout.chunks.join(''), /\[assistant not confirmed\]/u)
            else assert.equal(stdout.chunks.join(''), '')
          }
        } finally { await formatter.dispose() }
      })
    }
  }

  test(`${channel} resets both final evidence and its pending projection at an explicit new attempt`, async () => {
    const stdout = capture()
    const stderr = capture()
    const formatter = createRunOutputFormatter({ format, liveText, stdout: stdout.stream, stderr: stderr.stream })
    const lastEvent = { type: 'turn.completed', payload: { text: 'new attempt answer' } }
    try {
      await formatter.onEvent({ type: 'turn.completed', payload: { text: 'old attempt answer' } })
      await formatter.onEvent({ type: 'turn.blocked', payload: { code: 'OLD_NONFINAL' } })
      await formatter.onEvent({ type: 'turn.attempt', payload: { resetStreaming: true } })
      await formatter.onEvent({ type: 'turn.awaiting_approval', payload: { code: 'NEW_NONFINAL' } })
      await formatter.onEvent(lastEvent)
      await formatter.finish({ status: 'completed', exitCode: 0, lastEvent })
      assert.equal(formatter.resolveExitCode({ status: 'completed', exitCode: 0, lastEvent }), 0)
      if (format === 'text') assert.equal(stdout.chunks.join(''), 'new attempt answer\n')
      else assert.deepEqual(JSON.parse(stdout.chunks.at(-1)), lastEvent)
      assert.doesNotMatch(stderr.chunks.join(''), /CLI_RUN_OUTCOME_CONFLICT|NONFINAL/u)
    } finally { await formatter.dispose() }
  })
}

for (const format of ['text', 'jsonl']) {
  test(`${format} formatter rejects conflicting final observations while retaining legacy status-only compatibility`, async () => {
    const stdout = capture()
    const stderr = capture()
    const formatter = createRunOutputFormatter({ format, stdout: stdout.stream, stderr: stderr.stream })
    const lastEvent = { type: 'turn.completed', payload: { text: 'conflicting answer' } }
    try {
      await formatter.onEvent({ type: 'turn.failed', payload: { code: 'TURN_PERSISTENCE_FAILED' } })
      await formatter.onEvent(lastEvent)
      await formatter.finish({ status: 'completed', exitCode: 0, lastEvent })
      assert.equal(formatter.resolveExitCode({ status: 'completed', exitCode: 0, lastEvent }), 1)
      assert.match(stderr.chunks.join(''), /CLI_RUN_OUTCOME_CONFLICT.*TURN_PERSISTENCE_FAILED/u)
      if (format === 'text') assert.equal(stdout.chunks.join(''), '')
      else assert.equal(JSON.parse(stdout.chunks.at(-1)).error.code, 'CLI_RUN_OUTCOME_CONFLICT')
    } finally { await formatter.dispose() }
    const legacy = createRunOutputFormatter({ format, stdout: stdout.stream, stderr: stderr.stream })
    try { assert.equal(legacy.resolveExitCode({ status: 'completed', exitCode: 0 }), 0) }
    finally { await legacy.dispose() }
  })

  test(`${format} formatter resets final evidence only at an explicit replay attempt boundary`, async () => {
    const stdout = capture()
    const stderr = capture()
    const formatter = createRunOutputFormatter({ format, stdout: stdout.stream, stderr: stderr.stream })
    const lastEvent = { type: 'turn.completed', payload: { text: 'recovered answer' } }
    try {
      await formatter.onEvent({ type: 'turn.failed', payload: { code: 'TURN_FAILED' } })
      await formatter.onEvent({ type: 'turn.attempt', payload: { resetStreaming: true } })
      await formatter.onEvent({ type: 'turn.interrupted', payload: {} })
      await formatter.onEvent(lastEvent)
      await formatter.finish({ status: 'completed', exitCode: 0, lastEvent })
      assert.equal(formatter.resolveExitCode({ status: 'completed', exitCode: 0, lastEvent }), 0)
      assert.doesNotMatch(stderr.chunks.join(''), /CLI_RUN_OUTCOME_CONFLICT/u)
      if (format === 'text') assert.equal(stdout.chunks.join(''), 'recovered answer\n')
    } finally { await formatter.dispose() }
  })
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

test('formatProgressEvent renders only factual turn activity', () => {
  assert.equal(formatProgressEvent({ type: 'turn.started', payload: {} }), 'turn started')
  assert.equal(formatProgressEvent({ type: 'model.phase', payload: { phase: 'thinking' } }), 'model thinking')
  assert.equal(
    formatProgressEvent({ type: 'model.phase', payload: { phase: 'completed', usage: { promptTokens: 1200, cacheHitTokens: 900, completionTokens: 40 } } }),
    'model completed (prompt 1200, cached 900, completion 40)',
  )
  assert.equal(formatProgressEvent({ type: 'model.phase', payload: { phase: 'completed', usage: null } }), 'model completed')
  assert.equal(formatProgressEvent({ type: 'tool.started', payload: { name: 'read_file' } }), 'tool read_file started')
  assert.equal(formatProgressEvent({ type: 'tool.completed', payload: { name: 'read_file', error: null } }), 'tool read_file finished')
  assert.equal(formatProgressEvent({ type: 'tool.completed', payload: { name: 'bash_exec', error: { code: 'X' } } }), 'tool bash_exec failed')
  assert.equal(formatProgressEvent({ type: 'turn.progress', payload: { completed: 2, total: 5 } }), 'progress 2/5')
  assert.equal(formatProgressEvent({ type: 'approval.required', payload: { toolName: 'bash_exec' } }), 'approval required: bash_exec')
  assert.equal(formatProgressEvent({ type: 'approval.resolved', payload: { proceed: false } }), 'approval denied')
  // Terminal events are explained by the terminal diagnostic, not duplicated here.
  assert.equal(formatProgressEvent({ type: 'turn.completed', payload: { text: 'done' } }), null)
  assert.equal(formatProgressEvent({ type: 'failed', jobId: 'job-1', payload: {} }), null)
  assert.equal(formatProgressEvent({ type: 'turn.checkpoint', payload: {} }), null)
})

test('progress writes factual stderr lines and keeps stdout pure JSONL', async () => {
  const stdout = capture()
  const stderr = capture()
  const formatter = createRunOutputFormatter({
    format: 'jsonl', progress: true, stdout: stdout.stream, stderr: stderr.stream,
  })
  for (const event of [
    { type: 'turn.started', turnId: 'turn-1', payload: {} },
    { type: 'tool.started', turnId: 'turn-1', payload: { name: 'read_file' } },
    { type: 'tool.completed', turnId: 'turn-1', payload: { name: 'read_file', error: null } },
    { type: 'approval.required', turnId: 'turn-1', payload: { toolName: 'bash_exec' } },
  ]) {
    await formatter.onEvent(event)
  }
  await formatter.flush()

  const progress = stderr.chunks.join('')
  assert.match(progress, /\[gugo\] turn started/u)
  assert.match(progress, /\[gugo\] tool read_file started/u)
  assert.match(progress, /\[gugo\] tool read_file finished/u)
  assert.match(progress, /\[gugo\] approval required: bash_exec/u)
  // Every stdout line must still be a complete, parseable event.
  const lines = stdout.chunks.join('').split('\n').filter(Boolean)
  assert.equal(lines.length, 4)
  for (const line of lines) assert.equal(typeof JSON.parse(line).type, 'string')
})

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

test('chat live text is provisional until finish and does not duplicate the successful answer', async () => {
  const stdout = capture()
  const stderr = capture()
  const formatter = createRunOutputFormatter({ format: 'text', liveText: true, stdout: stdout.stream, stderr: stderr.stream })
  try {
    await formatter.onEvent({ type: 'assistant.delta', payload: { text: 'Hello' } })
    assert.match(stdout.chunks.join(''), /\[assistant provisional\]\nHello$/u)
    await formatter.onEvent({ type: 'reasoning.delta', payload: { text: 'private reasoning' } })
    await formatter.onEvent({ type: 'assistant.delta', payload: { text: ' world' } })
    await formatter.onEvent({ type: 'turn.completed', payload: { text: 'Hello world!' } })
    assert.doesNotMatch(stdout.chunks.join(''), /confirmed|private reasoning/u)
    await formatter.finish({ status: 'completed', exitCode: 0 })
    await formatter.finish({ status: 'completed', exitCode: 0 })
    assert.equal(stdout.chunks.join(''), '[assistant provisional]\nHello world!\n[assistant confirmed]\n')
  } finally { await formatter.dispose() }
})

test('chat provisional text stays explicitly unconfirmed on failed, cancelled and shutdown outcomes', async () => {
  for (const status of ['failed', 'cancelled', 'shutdown']) {
    const stdout = capture()
    const stderr = capture()
    const formatter = createRunOutputFormatter({ format: 'text', liveText: true, stdout: stdout.stream, stderr: stderr.stream })
    try {
      await formatter.onEvent({ type: 'assistant.delta', payload: { text: 'partial answer' } })
      await formatter.onEvent({ type: 'turn.completed', payload: { text: 'partial answer plus final' } })
      if (status === 'shutdown') await formatter.writeError(new Error('shutdown failed'))
      else await formatter.finish({ status, exitCode: 1 })
      assert.equal(stdout.chunks.join(''), '[assistant provisional]\npartial answer\n[assistant not confirmed]\n')
      assert.doesNotMatch(stdout.chunks.join(''), /plus final|assistant confirmed/u)
    } finally { await formatter.dispose() }
  }
})

test('chat final replacement is labelled when the host revises provisional text', async () => {
  const stdout = capture()
  const formatter = createRunOutputFormatter({ format: 'text', liveText: true, stdout: stdout.stream, stderr: capture().stream })
  try {
    await formatter.onEvent({ type: 'assistant.delta', payload: { text: 'draft answer' } })
    await formatter.onEvent({ type: 'turn.completed', payload: { text: 'corrected answer' } })
    await formatter.finish({ status: 'completed', exitCode: 0 })
    assert.equal(stdout.chunks.join(''), '[assistant provisional]\ndraft answer\n[assistant final; replaces provisional text]\ncorrected answer\n')
  } finally { await formatter.dispose() }
})

test('run text ignores assistant deltas and remains final-success-only', async () => {
  for (const status of ['completed', 'failed', 'cancelled']) {
    const stdout = capture()
    const formatter = createRunOutputFormatter({ format: 'text', stdout: stdout.stream, stderr: capture().stream })
    try {
      await formatter.onEvent({ type: 'assistant.delta', payload: { text: 'not final' } })
      await formatter.onEvent({ type: 'turn.completed', payload: { text: 'final answer' } })
      assert.equal(stdout.chunks.join(''), '')
      await formatter.finish({ status, exitCode: status === 'completed' ? 0 : 1 })
      assert.equal(stdout.chunks.join(''), status === 'completed' ? 'final answer\n' : '')
    } finally { await formatter.dispose() }
  }
})

test('text terminal failures stay out of stdout and use stderr diagnostics', () => {
  for (const [event, diagnostic] of [
    [
      { type: 'turn.failed', payload: { code: 'MODEL_FAILED', message: 'model unavailable' } },
      'Failed [MODEL_FAILED]\nReason: model unavailable\nNext: inspect the stable code and terminal record before retrying.\n',
    ],
    [
      { type: 'turn.blocked', payload: { code: 'APPROVAL_REQUIRED', message: 'approval required' } },
      'Blocked [APPROVAL_REQUIRED]\nReason: approval required\nNext: inspect the stable code and terminal record before retrying.\n',
    ],
    [
      { type: 'turn.cancelled', payload: { code: 'TURN_CANCELLED' } },
      'Cancelled [TURN_CANCELLED]\nReason: terminal_reason_not_recorded\nNext: inspect the stable code and terminal record before retrying.\n',
    ],
    [
      { type: 'turn.cancelled', payload: { reason: 'Cancelled by user' } },
      'Cancelled [TURN_CANCELLED]\nReason: Cancelled by user\nNext: inspect the stable code and terminal record before retrying.\n',
    ],
    [
      { type: 'turn.paused', payload: { clarification: { question: 'Choose a directory' } } },
      'Paused [TURN_PAUSED]\nReason: Choose a directory\nNext: inspect the stable code and terminal record before retrying.\n',
    ],
    [
      { type: 'turn.paused', payload: { clarification: 'Confirm the operation' } },
      'Paused [TURN_PAUSED]\nReason: Confirm the operation\nNext: inspect the stable code and terminal record before retrying.\n',
    ],
    [
      { type: 'turn.interrupted', payload: { code: 'MODEL_503', message: 'upstream unavailable' } },
      'Interrupted [MODEL_503]\nReason: upstream unavailable\nNext: inspect the stable code and terminal record before retrying.\n',
    ],
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
    stderr: 'Error [MODEL_CONFIG_MISSING]: model is not configured\nNext: configure_model\n',
  })
  assert.deepEqual(JSON.parse(formatRunError(error).stdout.trim()), {
    type: 'cli.error',
    error: {
      code: 'MODEL_CONFIG_MISSING',
      message: 'model is not configured',
      action: 'configure_model',
      nextAction: 'configure_model',
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

test('writer disposal waits for in-flight output and removes only owned listeners', async () => {
  const output = controlledBackpressureStream()
  const externalError = () => {}
  const externalClose = () => {}
  output.stream.on('error', externalError)
  output.stream.on('close', externalClose)
  const writer = createSerializedWriter(output.stream, 'test')
  const pending = writer.write('queued')
  await waitForTurn()
  let disposed = false
  const disposal = writer.dispose().then(() => { disposed = true })
  await waitForTurn()
  assert.equal(disposed, false)
  await assert.rejects(writer.write('late'), { code: 'CLI_OUTPUT_WRITER_DISPOSED' })
  output.release()
  await Promise.all([pending, disposal, writer.dispose()])
  assert.deepEqual(output.chunks, ['queued'])
  assert.deepEqual(output.stream.listeners('error'), [externalError])
  assert.deepEqual(output.stream.listeners('close'), [externalClose])
  assert.equal(output.stream.listenerCount('drain'), 0)
})

test('writer disposal settles after EPIPE without suppressing the original write error', async () => {
  const output = controlledBackpressureStream()
  const writer = createSerializedWriter(output.stream, 'test')
  const pending = writer.write('queued')
  await waitForTurn()
  const disposal = writer.dispose()
  output.stream.emit('error', Object.assign(new Error('broken pipe'), { code: 'EPIPE' }))
  await assert.rejects(pending, { code: 'CLI_OUTPUT_WRITE_FAILED', causeCode: 'EPIPE' })
  await disposal
  assert.equal(output.stream.listenerCount('error'), 0)
  assert.equal(output.stream.listenerCount('close'), 0)
  assert.equal(output.stream.listenerCount('drain'), 0)
})

test('repeated formatter disposal does not accumulate shared stream listeners', async () => {
  const output = capture()
  for (let index = 0; index < 12; index += 1) {
    const formatter = createRunOutputFormatter({ stdout: output.stream, stderr: output.stream })
    await formatter.onEvent({ type: 'turn.started', sequence: index })
    await formatter.dispose()
    await formatter.dispose()
    assert.equal(output.stream.listenerCount('error'), 0)
    assert.equal(output.stream.listenerCount('close'), 0)
  }
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

test('terminal diagnostics surface exhausted completion policies', () => {
  const policies = [{ id: 'mutation_verification', attempts: 2, limit: 2, exhausted: true }]
  const rendered = formatRunEvent({
    type: 'turn.failed',
    payload: { code: 'TURN_INCOMPLETE', incompleteReason: 'post_mutation_verification_missing', completionPolicies: policies },
  }, { format: 'text' })
  assert.equal(rendered.stdout, null)
  assert.match(rendered.stderr, /Completion policies: mutation_verification 2\/2 \(exhausted\)/u)

  const error = Object.assign(new Error('incomplete'), {
    code: 'TURN_INCOMPLETE',
    completionPolicies: policies,
  })
  const jsonl = formatRunError(error, { format: 'jsonl' })
  assert.match(jsonl.stdout, /"completionPolicies"/u)
  assert.match(jsonl.stderr, /Completion policies: mutation_verification 2\/2 \(exhausted\)/u)
  const event = JSON.parse(jsonl.stdout.trim())
  assert.deepEqual(event.error.completionPolicies, policies)
})
