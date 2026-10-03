import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildTurnTraceSpans,
  spanIdFor,
  toOtlpJson,
  traceIdForTurn,
} from '../server/services/turnTraceSpans.js'

function event(sequence, type, payload = {}, createdAt = 1_000 + sequence) {
  return { id: `e${sequence}`, sessionId: 's1', turnId: 't1', sequence, type, payload, createdAt }
}

test('span ids are deterministic and OTel-shaped', () => {
  assert.match(traceIdForTurn('t1'), /^[a-f0-9]{32}$/u)
  assert.equal(traceIdForTurn('t1'), traceIdForTurn('t1'))
  assert.notEqual(traceIdForTurn('t1'), traceIdForTurn('t2'))
  assert.match(spanIdFor('x'), /^[a-f0-9]{16}$/u)
})

test('buildTurnTraceSpans derives a parent/child tree from correlation ids', () => {
  const { traceId, spans } = buildTurnTraceSpans({
    turnId: 't1',
    sessionId: 's1',
    events: [
      event(0, 'turn.started', { approvalMode: 'plan' }, 1_000),
      event(1, 'model.phase', { phase: 'started', iteration: 0, modelName: 'm1' }, 1_010),
      event(2, 'model.phase', { phase: 'completed', iteration: 0, modelName: 'm1', usage: { promptTokens: 10, cacheHitTokens: 8 } }, 1_050),
      event(3, 'tool.started', { name: 'read_file', toolCallId: 'c1' }, 1_060),
      event(4, 'tool.completed', { name: 'read_file', toolCallId: 'c1', error: null, artifactId: 'a1' }, 1_070),
      event(5, 'approval.required', { approvalId: 'ap1', toolName: 'bash_exec' }, 1_080),
      event(6, 'approval.resolved', { approvalId: 'ap1', proceed: false }, 1_090),
      event(7, 'turn.completed', { text: 'ok' }, 1_100),
    ],
  })

  const byName = Object.fromEntries(spans.map((span) => [span.name, span]))
  const root = byName.turn
  assert.equal(root.parentSpanId, null)
  assert.equal(root.status.code, 'OK')
  assert.equal(root.startTimeMs, 1_000)
  assert.equal(root.endTimeMs, 1_100)
  assert.equal(root.attributes.sessionId, 's1')

  const model = byName['model.iteration.0']
  assert.equal(model.parentSpanId, root.spanId)
  assert.equal(model.status.code, 'OK')
  assert.equal(model.startTimeMs, 1_010)
  assert.equal(model.endTimeMs, 1_050)
  assert.equal(model.attributes.modelName, 'm1')
  assert.equal(model.attributes.promptTokens, 10)
  assert.equal(model.attributes.cacheHitTokens, 8)

  const tool = byName['tool.read_file']
  assert.equal(tool.parentSpanId, root.spanId)
  assert.equal(tool.status.code, 'OK')
  assert.equal(tool.attributes.toolCallId, 'c1')
  assert.equal(tool.attributes.artifactId, 'a1')

  const approval = byName['approval.bash_exec']
  assert.equal(approval.status.code, 'ERROR')
  assert.equal(approval.attributes.proceed, false)

  assert.equal(traceId, root.traceId)
})

test('incomplete and failed spans are reported without inventing a terminal phase', () => {
  const { spans } = buildTurnTraceSpans({
    turnId: 't1',
    events: [
      event(0, 'turn.started', {}, 1_000),
      event(1, 'tool.started', { name: 'read_file', toolCallId: 'c1' }, 1_010),
      event(2, 'model.phase', { phase: 'failed', iteration: 0, error: 'boom' }, 1_020),
    ],
  })
  const tool = spans.find((span) => span.name === 'tool.read_file')
  assert.equal(tool.status.code, 'UNSET')
  assert.equal(tool.endTimeMs, 1_020, 'an open span ends at the last event')
  const model = spans.find((span) => span.name.startsWith('model.'))
  assert.equal(model.status.code, 'ERROR')
  assert.equal(model.status.message, 'boom')
  const root = spans.find((span) => span.name === 'turn')
  assert.equal(root.status.code, 'UNSET')
})

test('toOtlpJson emits OTLP-shaped spans with nanosecond timestamps', () => {
  const { traceId, spans } = buildTurnTraceSpans({
    turnId: 't1',
    events: [event(0, 'turn.started', {}, 1_000), event(1, 'turn.failed', { code: 'TURN_FAILED' }, 1_100)],
  })
  const otlp = toOtlpJson({ traceId, spans })
  assert.equal(otlp.resourceSpans.length, 1)
  assert.equal(otlp.resourceSpans[0].resource.attributes[0].value.stringValue, 'gugo')
  const otlpSpans = otlp.resourceSpans[0].scopeSpans[0].spans
  assert.equal(otlpSpans.length, spans.length)
  const root = otlpSpans.find((span) => span.name === 'turn')
  assert.match(root.traceId, /^[a-f0-9]{32}$/u)
  assert.match(root.spanId, /^[a-f0-9]{16}$/u)
  assert.equal(root.startTimeUnixNano, '1000000000')
  assert.equal(root.endTimeUnixNano, '1100000000')
  assert.equal(root.status.code, 2)
  assert.ok(root.attributes.some((entry) => entry.key === 'turnId'))
  // No non-OTLP helper keys leak into the export.
  assert.deepEqual(Object.keys(otlp).sort(), ['resourceSpans'])
})

test('the turn log context uses the same trace id the span export emits', async () => {
  const fs = await import('node:fs/promises')
  const engineSource = await fs.readFile(
    new URL('../server/services/TurnEngine.js', import.meta.url), 'utf8',
  )
  // Regression: the turn async context used a random `newTraceId()`, so the id
  // in logs never matched the trace id in `gugo trace --export otel`, and a
  // single turn had two unrelated ids. Both must be the deterministic one.
  assert.doesNotMatch(engineSource, /traceId: newTraceId\(\)/u)
  assert.match(engineSource, /traceIdForTurn/u)
  assert.match(engineSource, /traceId: resolveTraceId\(resolvedTurnId\)/u)

  // And the exported trace id is exactly what that resolver returns.
  const spans = buildTurnTraceSpans({
    turnId: 't1',
    events: [event(0, 'turn.started'), event(1, 'turn.completed', { text: 'ok' })],
  })
  assert.equal(spans.traceId, traceIdForTurn('t1'))
})

test('a truncated event log never looks like a completed turn', () => {
  // Sweep every event boundary. Resume/replay reads a persisted prefix of the
  // turn, so each prefix must project to a coherent, non-certifying trace.
  const full = [
    event(0, 'turn.started'),
    event(1, 'model.phase', { phase: 'completed', iteration: 0, usage: { promptTokens: 5 } }),
    event(2, 'tool.call', { toolCallId: 'c1', name: 'write_file', args: { path: 'a.txt' } }),
    event(3, 'tool.started', { toolCallId: 'c1', name: 'write_file' }),
    event(4, 'tool.completed', { toolCallId: 'c1', name: 'write_file', result: { ok: true } }),
    event(5, 'turn.completed', { text: 'done' }),
  ]
  for (let boundary = 0; boundary <= full.length; boundary += 1) {    const prefix = full.slice(0, boundary)
    const spans = buildTurnTraceSpans({ turnId: 't1', sessionId: 's1', events: prefix })
    const roots = spans.spans.filter((span) => span.parentSpanId === null)
    assert.equal(roots.length, 1, `boundary ${boundary}: exactly one root span`)
    assert.equal(roots[0].spanId, spans.rootSpanId)
    assert.equal(roots[0].attributes.eventCount, boundary)
    assert.ok(
      spans.spans.every((span) => span.traceId === spans.traceId),
      `boundary ${boundary}: every span shares the trace id`,
    )
    for (const span of spans.spans) {
      assert.ok(span.spanId, `boundary ${boundary}: every span has an id`)
    }
    assert.equal(
      new Set(spans.spans.map((span) => span.spanId)).size, spans.spans.length,
      `boundary ${boundary}: span ids are unique within the trace`,
    )
    const terminator = prefix.at(-1)?.type
    const certified = terminator === 'turn.completed' && roots[0].status.code === 'OK'
    if (!certified) {
      assert.notEqual(
        roots[0].status.code, 'OK',
        `boundary ${boundary}: an unfinished turn must not be reported as OK`,
      )
    }
  }
  // Only the final boundary carries the success status.
  const complete = buildTurnTraceSpans({ turnId: 't1', sessionId: 's1', events: full })
  assert.equal(complete.spans[0].status.code, 'OK')
  // A truncated log still emits the timeline it did observe.
  const partial = buildTurnTraceSpans({ turnId: 't1', sessionId: 's1', events: full.slice(0, 5) })
  assert.ok(partial.spans.length > 1, 'observed work is still exported when the log stops early')
})
