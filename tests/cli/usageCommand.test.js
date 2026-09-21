import assert from 'node:assert/strict'
import test from 'node:test'

import { parseSinceMs, parseUsageArgs, renderUsageCsv, renderUsageText } from '../../bin/cli/usageCommand.js'
import { summarizeUsageEvents } from '../../server/services/localUsageReportService.js'
import { USAGE_REPORT_LIMITS } from '../../shared/usageReportLimits.js'

function phase(modelName, usage, sessionId = 's1') {
  return { type: 'model.phase', sessionId, payload: { phase: 'completed', modelName, usage } }
}

function terminal(type, turnModelUsage, sessionId = 's1') {
  return { type, sessionId, payload: { turnModelUsage } }
}

test('the aggregate sums turn totals and names how stopped turns ended', () => {
  const report = summarizeUsageEvents([
    phase('model-a', { promptTokens: 100, completionTokens: 10, cacheHitTokens: 60, cacheMissTokens: 40 }),
    terminal('turn.completed', { promptTokens: 100, completionTokens: 10, cacheHitTokens: 60, cacheMissTokens: 40 }),
    phase('model-a', { promptTokens: 50, completionTokens: 5, cacheHitTokens: 20, cacheMissTokens: 30 }, 's2'),
    terminal('turn.paused', { promptTokens: 50, completionTokens: 5, cacheHitTokens: 20, cacheMissTokens: 30 }, 's2'),
    terminal('turn.blocked', null, 's3'),
  ])

  assert.deepEqual(report.turns, {
    total: 3,
    completed: 1,
    stopped: 2,
    byType: { 'turn.completed': 1, 'turn.paused': 1, 'turn.blocked': 1 },
  })
  assert.equal(report.totals.promptTokens, 150)
  assert.equal(report.totals.completionTokens, 15)
  assert.equal(report.totals.totalTokens, 165)
  assert.equal(report.cacheHitRatePercent, 53.33)
  assert.equal(report.perModelPhases, 2)
  assert.deepEqual(report.byModel.map((entry) => entry.key), ['model-a'])
  assert.equal(report.bySession.length, 3)
})

test('a stopped turn that spent tokens still counts, so the breakdown never exceeds the total', () => {
  // Regression: only completed/failed terminals were counted, so a paused turn
  // contributed its model phases but no turn total and the per-model sum came
  // out larger than the aggregate.
  const events = [
    phase('model-a', { promptTokens: 10, completionTokens: 1 }),
    terminal('turn.paused', { promptTokens: 10, completionTokens: 1 }),
  ]
  const report = summarizeUsageEvents(events)
  assert.equal(report.turns.stopped, 1)
  const modelSum = report.byModel.reduce((sum, entry) => sum + entry.totalTokens, 0)
  assert.equal(modelSum, report.totals.totalTokens)
  assert.equal(modelSum, report.phaseTotals.totalTokens)
})

test('the text report says which way the two totals disagree', () => {
  const compacted = summarizeUsageEvents([terminal('turn.completed', { promptTokens: 500, completionTokens: 0 })])
  assert.match(renderUsageText(compacted), /smaller than the turn totals/u)

  const phasesOnly = summarizeUsageEvents([phase('model-a', { promptTokens: 500, completionTokens: 0 })])
  assert.match(renderUsageText(phasesOnly), /larger than the turn totals/u)

  const agreeing = summarizeUsageEvents([
    phase('model-a', { promptTokens: 5, completionTokens: 5 }),
    terminal('turn.completed', { promptTokens: 5, completionTokens: 5 }),
  ])
  const text = renderUsageText(agreeing)
  assert.doesNotMatch(text, /turn totals are authoritative/iu)
  assert.match(text, /turns=1 completed=1 stopped=0/u)
})

test('an unnamed model and an unreported cache rate stay explicit', () => {
  const report = summarizeUsageEvents([phase('', { promptTokens: 3, completionTokens: 1 })])
  assert.equal(report.byModel[0].key, '(unknown model)')
  assert.equal(report.byModel[0].cacheHitRatePercent, null)
  assert.match(renderUsageText(report), /cacheHitRate=not reported/u)
})

test('a truncated window is reported rather than silently mis-totalling', () => {
  const report = summarizeUsageEvents([phase('model-a', { promptTokens: 1, completionTokens: 1 })], { truncated: true })
  assert.equal(report.window.truncated, true)
  assert.match(renderUsageText(report), /capped at the --limit/u)
})

test('csv export carries the same figures as the text report', () => {
  const report = summarizeUsageEvents([
    phase('model-a', { promptTokens: 10, completionTokens: 2, cacheHitTokens: 5, cacheMissTokens: 5 }),
    terminal('turn.completed', { promptTokens: 10, completionTokens: 2, cacheHitTokens: 5, cacheMissTokens: 5 }),
  ])
  const rows = renderUsageCsv(report).trim().split('\n')
  assert.equal(rows[0], 'scope,key,turns,modelPhases,promptTokens,completionTokens,totalTokens,cacheHitRatePercent')
  assert.equal(rows[1], 'total,,1,1,10,2,12,50')
  assert.equal(rows[2], 'model,model-a,,1,10,2,12,50')
  assert.equal(rows[3].startsWith('session,'), true)
})

test('usage arguments accept both flag shapes and reject bad input with a usage code', () => {
  assert.deepEqual(parseUsageArgs([]), {
    sessionId: '', limit: USAGE_REPORT_LIMITS.DEFAULT_EVENTS, export: 'text', json: false, since: null,
  })
  assert.equal(parseUsageArgs(['--session-id', 'abc']).sessionId, 'abc')
  assert.equal(parseUsageArgs(['--session-id=abc']).sessionId, 'abc')
  assert.equal(parseUsageArgs(['--json']).export, 'json')
  assert.equal(parseUsageArgs(['--export', 'CSV']).export, 'csv')

  const invalid = [
    [[], 'CLI_USAGE_LIMIT_INVALID', ['--limit', 'abc']],
    [[], 'CLI_USAGE_EXPORT_INVALID', ['--export', 'yaml']],
    [[], 'CLI_OPTION_UNKNOWN', ['--nope']],
    [[], 'CLI_ARGUMENT_UNEXPECTED', ['extra']],
    [[], 'CLI_OPTION_DUPLICATE', ['--limit', '1', '--limit', '2']],
    [[], 'CLI_USAGE_EXPORT_CONFLICT', ['--json', '--export', 'csv']],
    [[], 'CLI_USAGE_SINCE_INVALID', ['--since', 'yesterday']],
    [[], 'CLI_USAGE_SINCE_INVALID', ['--since', '0']],
  ]
  for (const [, code, argv] of invalid) {
    assert.throws(() => parseUsageArgs(argv), (error) => error?.code === code, argv.join(' '))
  }
  // `--help` must not turn a bad date into a parse failure while still rejecting
  // genuinely unknown options.
  assert.doesNotThrow(() => parseUsageArgs(['--since', 'later'], { help: true }))
})

test('the CLI reads the same default event window as the endpoint, and --limit is the only override', () => {
  // Regression: the CLI defaulted to 50 000 while the panel defaulted to 20 000,
  // so a heavy range could read as complete on one surface and truncated on the
  // other. Both now take the single shared value.
  assert.equal(parseUsageArgs([]).limit, USAGE_REPORT_LIMITS.DEFAULT_EVENTS)
  assert.equal(USAGE_REPORT_LIMITS.DEFAULT_EVENTS, 20_000, 'the shared default is the panel-facing bound')
  assert.equal(parseUsageArgs(['--limit', '500']).limit, 500)
  assert.throws(() => parseUsageArgs(['--limit', '100001']), (error) => error?.code === 'CLI_USAGE_LIMIT_INVALID')
})

test('a date filter is parsed as local time and as raw epoch millis', () => {
  assert.equal(parseSinceMs(''), null)
  assert.equal(parseSinceMs('1758400000000'), 1758400000000)
  const local = parseSinceMs('2026-09-21')
  assert.equal(new Date(local).getHours(), 0)
  assert.equal(new Date(local).getMinutes(), 0)
  assert.equal(parseSinceMs('2026-09-21T18:30') - local, (18 * 60 + 30) * 60_000)
  assert.throws(() => parseSinceMs('2026-13-45'), (error) => error?.code === 'CLI_USAGE_SINCE_INVALID')
})
