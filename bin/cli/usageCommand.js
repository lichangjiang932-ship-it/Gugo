import { CliUsageError } from './errors.js'
import { commandOptionValue, commandPositiveInteger } from './commandPreflight.js'
import { formatLocalDateTime, parseLocalDateTime } from '../../shared/localDateTime.js'
import { USAGE_REPORT_LIMITS } from '../../shared/usageReportLimits.js'

const EXPORTS = new Set(['text', 'json', 'csv'])
const VALUE_FLAGS = new Map([
  ['--session-id', 'sessionId'],
  ['--limit', 'limit'],
  ['--export', 'export'],
  ['--since', 'since'],
])
const BOOLEAN_FLAGS = new Map([['--json', 'json']])
export const USAGE_BOOLEAN_FLAGS = Object.freeze([...BOOLEAN_FLAGS.keys()])

const USAGE_FAILURE_HELP = Object.freeze({
  TRACE_DATABASE_NOT_INITIALIZED: 'initialize the local runtime through normal application startup, then retry. Usage reporting does not create databases.',
  TRACE_LOCAL_IDENTITY_NOT_INITIALIZED: 'initialize the local identity through normal application startup, then retry. Usage reporting does not create accounts.',
  TRACE_MIGRATION_REQUIRED: 'use normal application startup to apply supported database migrations, then retry. Usage reporting never migrates data.',
  TRACE_SCHEMA_VERSION_UNSUPPORTED: 'use an application version compatible with this database. Usage reporting does not downgrade data.',
  TRACE_DATABASE_CHANGED: 'the database changed during inspection; retry when it is stable or use the authenticated service/SDK.',
  TRACE_ACTIVE_WAL_UNAVAILABLE: 'use the running authenticated service/SDK, or normally stop the runtime and retry. Usage reporting never checkpoints or removes active WAL/SHM files.',
  AUTH_REQUIRED: 'use this deployment\'s authenticated service or SDK. A remote token does not authorize reading a local database.',
})

/** Parse a calendar date or `yyyy-mm-ddThh:mm` in local time into epoch millis. */
export function parseSinceMs(value) {
  const text = String(value || '').trim()
  if (!text) return null
  // The calendar round-trip lives in shared/localDateTime.js so this filter and
  // the Git history filter cannot drift apart.
  const parsed = parseLocalDateTime(text, { allowEpochMs: true })
  if (!parsed.ok) {
    throw new CliUsageError(
      'CLI_USAGE_SINCE_INVALID',
      '--since must be a positive epoch millisecond value or a real local yyyy-mm-dd[Thh:mm] date',
    )
  }
  return parsed.ms
}

/** Parse `gugo usage [--session-id <id>] [--since <date|ms>] [--limit <n>] [--export text|json|csv] [--json]`. */
export function parseUsageArgs(argv = [], { help = false } = {}) {
  const options = { sessionId: '', limit: USAGE_REPORT_LIMITS.DEFAULT_EVENTS, export: 'text', json: false, since: null }
  const seen = new Set()
  for (let index = 0; index < argv.length; index += 1) {
    const raw = String(argv[index])
    if (!raw.startsWith('--')) throw new CliUsageError('CLI_ARGUMENT_UNEXPECTED', `usage takes no positional argument: ${raw}`)
    const equalAt = raw.indexOf('=')
    const key = raw.slice(0, equalAt >= 0 ? equalAt : undefined)
    if (seen.has(key)) throw new CliUsageError('CLI_OPTION_DUPLICATE', `${key} may only be specified once`)
    seen.add(key)
    if (BOOLEAN_FLAGS.has(key)) {
      if (equalAt >= 0) throw new CliUsageError('CLI_OPTION_VALUE_REQUIRED', `${key} does not take a value`)
      options[BOOLEAN_FLAGS.get(key)] = true
      continue
    }
    if (!VALUE_FLAGS.has(key)) throw new CliUsageError('CLI_OPTION_UNKNOWN', `unknown option for usage: ${key}`)
    const value = equalAt >= 0 ? raw.slice(equalAt + 1) : argv[++index]
    options[VALUE_FLAGS.get(key)] = commandOptionValue(value, key).trim()
  }
  // Assign the coerced value: the validator returns a number, and discarding it
  // left `--limit 500` as the string '500' while the default is a number. The cap
  // is the shared one, not a second copy of it.
  options.limit = commandPositiveInteger(options.limit, {
    flag: '--limit',
    code: 'CLI_USAGE_LIMIT_INVALID',
    max: USAGE_REPORT_LIMITS.MAX_EVENTS,
  })
  options.export = String(options.export || 'text').toLowerCase()
  if (!EXPORTS.has(options.export)) {
    throw new CliUsageError('CLI_USAGE_EXPORT_INVALID', 'export must be one of text, json, csv')
  }
  if (options.json && seen.has('--export') && options.export !== 'json') {
    throw new CliUsageError('CLI_USAGE_EXPORT_CONFLICT', '--json cannot be combined with a different --export format')
  }
  if (options.json) options.export = 'json'
  if (options.since != null && options.since !== '' && !help) options.sinceMs = parseSinceMs(options.since)
  return options
}

function formatCount(value) {
  return String(Number(value) || 0)
}

export function renderUsageText(report, { since = null } = {}) {
  const window = report.window || {}
  const totals = report.totals || {}
  const lines = []
  const scope = [
    window.sessionId ? `session=${window.sessionId}` : 'all sessions',
    since ? `since=${formatLocalDateTime(since)} (local)` : 'all time',
  ].join(' ')
  lines.push(`usage (${scope})`)
  const stoppedTypes = Object.entries(report.turns?.byType || {})
    .filter(([type]) => type !== 'turn.completed')
    .map(([type, count]) => `${type.replace(/^turn\./u, '')}=${formatCount(count)}`)
  lines.push([
    `turns=${formatCount(report.turns?.total)}`,
    `completed=${formatCount(report.turns?.completed)}`,
    `stopped=${formatCount(report.turns?.stopped)}`,
    `modelPhases=${formatCount(report.perModelPhases)}`,
  ].join(' ') + (stoppedTypes.length ? ` (${stoppedTypes.join(' ')})` : ''))
  lines.push(`promptTokens=${formatCount(totals.promptTokens)} completionTokens=${formatCount(totals.completionTokens)} totalTokens=${formatCount(totals.totalTokens)}`)
  lines.push(report.cacheHitRatePercent == null
    ? 'cacheHitRate=not reported'
    : `cacheHitRate=${report.cacheHitRatePercent}%`)
  if (report.byModel?.length) {
    lines.push('by model:')
    for (const entry of report.byModel) {
      lines.push(`  ${entry.key} phases=${formatCount(entry.modelPhases)} promptTokens=${formatCount(entry.usage.promptTokens)} completionTokens=${formatCount(entry.usage.completionTokens)} cacheHitRate=${entry.cacheHitRatePercent == null ? 'not reported' : `${entry.cacheHitRatePercent}%`}`)
    }
  }
  if (report.bySession?.length) {
    lines.push('by session:')
    for (const entry of report.bySession) {
      lines.push(`  ${entry.key} turns=${formatCount(entry.turns)} modelPhases=${formatCount(entry.modelPhases)} totalTokens=${formatCount(entry.totalTokens)}`)
    }
  }
  if (window.truncated) {
    lines.push(`note: the event window is capped at the --limit of ${formatCount(window.eventCount)}; raise --limit or narrow --since for a complete total.`)
  }
  // The two figures disagree for opposite reasons, so name which way.
  const phaseTotals = Number(report.phaseTotals?.totalTokens) || 0
  const turnTotals = Number(totals.totalTokens) || 0
  if (phaseTotals < turnTotals) {
    lines.push('note: the breakdown covers only surviving model phases, so it is smaller than the turn totals. Turn totals are authoritative.')
  } else if (phaseTotals > turnTotals) {
    lines.push('note: some turns stopped without persisting cumulative usage, so the breakdown is larger than the turn totals. Turn totals are authoritative.')
  }
  return `${lines.join('\n')}\n`
}

const CSV_COLUMNS = Object.freeze([
  'scope', 'key', 'turns', 'modelPhases', 'promptTokens', 'completionTokens', 'totalTokens', 'cacheHitRatePercent',
])

function csvCell(value) {
  const text = value == null ? '' : String(value)
  return /[",\r\n]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text
}

export function renderUsageCsv(report) {
  const rows = [CSV_COLUMNS.join(',')]
  const totals = report.totals || {}
  rows.push([
    'total', '', report.turns?.total ?? 0, report.perModelPhases ?? 0,
    totals.promptTokens ?? 0, totals.completionTokens ?? 0, totals.totalTokens ?? 0,
    report.cacheHitRatePercent ?? '',
  ].map(csvCell).join(','))
  for (const entry of report.byModel || []) {
    rows.push([
      'model', entry.key, '', entry.modelPhases ?? 0,
      entry.usage?.promptTokens ?? 0, entry.usage?.completionTokens ?? 0, entry.totalTokens ?? 0,
      entry.cacheHitRatePercent ?? '',
    ].map(csvCell).join(','))
  }
  for (const entry of report.bySession || []) {
    rows.push([
      'session', entry.key, entry.turns ?? 0, entry.modelPhases ?? 0,
      entry.usage?.promptTokens ?? 0, entry.usage?.completionTokens ?? 0, entry.totalTokens ?? 0,
      entry.cacheHitRatePercent ?? '',
    ].map(csvCell).join(','))
  }
  return `${rows.join('\n')}\n`
}

/** `gugo usage` — report persisted token usage without running a turn. */
export async function cmdUsage(argv = [], { cwd = process.cwd(), env = process.env, stdout = process.stdout } = {}) {
  const options = parseUsageArgs(argv)
  const { readLocalUsageReport } = await import('../../server/services/localUsageReportService.js')
  const { localTraceReadFailure } = await import('../../server/services/localTurnTraceReader.js')
  try {
    const report = await readLocalUsageReport({
      cwd, env, sessionId: options.sessionId, since: options.sinceMs ?? null, limit: options.limit,
    })
    if (options.export === 'json') {
      stdout.write(`${JSON.stringify(report, null, 2)}\n`)
      return 0
    }
    if (options.export === 'csv') {
      stdout.write(renderUsageCsv(report))
      return 0
    }
    stdout.write(renderUsageText(report, { since: options.sinceMs ?? null }))
    return 0
  } catch (error) {
    // An unavailable runtime is an operational failure, not a usage mistake, so
    // it reports like `gugo trace` does: code plus the specific remedy, exit 1.
    const failure = localTraceReadFailure(error)
    const help = USAGE_FAILURE_HELP[failure.code]
    stdout.write(`usage unavailable — ${failure.code}${help ? `: ${help}` : ''}\n`)
    return 1
  }
}
