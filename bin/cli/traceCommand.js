import { CliUsageError } from './errors.js'
import { formatProgressEvent } from './runDiagnostics.js'
import { commandOptionValue, commandPositiveInteger } from './commandPreflight.js'

const EXPORTS = new Set(['text', 'json', 'otel'])
const VALUE_FLAGS = new Map([
  ['--session-id', 'sessionId'],
  ['--limit', 'limit'],
  ['--export', 'export'],
])
const BOOLEAN_FLAGS = new Map([['--json', 'json']])
export const TRACE_BOOLEAN_FLAGS = Object.freeze([...BOOLEAN_FLAGS.keys()])

/** Parse `gugo trace <turnId> [--session-id <id>] [--limit <n>] [--export text|json|otel] [--json]`. */
export function parseTraceArgs(argv = [], { help = false } = {}) {
  const options = { turnId: '', sessionId: '', limit: 2_000, export: 'text', json: false }
  const positional = []
  const seen = new Set()
  for (let index = 0; index < argv.length; index += 1) {
    const raw = String(argv[index])
    if (!raw.startsWith('--')) {
      positional.push(raw)
      continue
    }
    const equalAt = raw.indexOf('=')
    const key = raw.slice(0, equalAt >= 0 ? equalAt : undefined)
    if (seen.has(key)) throw new CliUsageError('CLI_OPTION_DUPLICATE', `${key} may only be specified once`)
    seen.add(key)
    if (BOOLEAN_FLAGS.has(key)) {
      if (equalAt >= 0) throw new CliUsageError('CLI_OPTION_VALUE_REQUIRED', `${key} does not take a value`)
      options[BOOLEAN_FLAGS.get(key)] = true
      continue
    }
    if (!VALUE_FLAGS.has(key)) throw new CliUsageError('CLI_OPTION_UNKNOWN', `unknown option for trace: ${key}`)
    const value = equalAt >= 0 ? raw.slice(equalAt + 1) : argv[++index]
    const normalized = commandOptionValue(value, key).trim()
    options[VALUE_FLAGS.get(key)] = normalized
  }
  if (positional.length > 1) throw new CliUsageError('CLI_ARGUMENT_UNEXPECTED', 'trace accepts a single turn id')
  options.turnId = String(positional[0] || '').trim()
  if (!options.turnId && !help) throw new CliUsageError('CLI_TURN_ID_REQUIRED', 'trace requires a turn id')
  commandPositiveInteger(options.limit, { flag: '--limit', code: 'CLI_TRACE_LIMIT_INVALID', max: 10_000 })
  options.export = String(options.export || 'text').toLowerCase()
  if (!EXPORTS.has(options.export)) {
    throw new CliUsageError('CLI_TRACE_EXPORT_INVALID', 'export must be one of text, json, otel')
  }
  if (options.json && seen.has('--export') && options.export !== 'json') {
    throw new CliUsageError('CLI_TRACE_EXPORT_CONFLICT', '--json cannot be combined with a different --export format')
  }
  if (options.json) options.export = 'json'
  return options
}

function renderAggregates(aggregates) {
  const usage = aggregates.usage || {}
  return [
    `modelPhases=${aggregates.modelPhases}`,
    `toolCalls=${aggregates.toolCalls}`,
    `toolFailures=${aggregates.toolFailures}`,
    `approvals=${aggregates.approvalsRequired}/${aggregates.approvalsDenied}denied`,
    `checkpoints=${aggregates.checkpoints}`,
    `promptTokens=${usage.promptTokens}`,
    `cached=${usage.cacheHitTokens}`,
    `completionTokens=${usage.completionTokens}`,
  ].join(' ')
}

function spanLine(span, depth) {
  const duration = Math.max(0, Number(span.endTimeMs) - Number(span.startTimeMs))
  const status = span.status?.code || 'UNSET'
  const detail = [
    `status=${status}`,
    `${duration}ms`,
    ...Object.entries(span.attributes || {})
      .filter(([key]) => !['sessionId', 'turnId', 'eventCount'].includes(key))
      .map(([key, value]) => `${key}=${value}`),
  ].join(' ')
  return `${'  '.repeat(depth)}${span.name} (${detail})\n`
}

function renderText(trace, stdout) {
  const coverage = trace.truncated === true || trace.coverage === 'partial' ? 'partial'
    : trace.coverage === 'complete' ? 'complete' : 'unknown'
  stdout.write(`turn ${trace.turnId} session ${trace.sessionId} trace ${trace.traceId}\n`)
  stdout.write(`events=${trace.events.length} spans=${trace.spans.length} coverage=${coverage} ${renderAggregates(trace.aggregates)}\n`)
  if (coverage === 'partial') {
    stdout.write('Partial trace: spans and totals cover only the returned events. Increase --limit (maximum 10000), or use the authenticated service/SDK to inspect remaining history.\n')
  }
  const root = trace.spans.find((span) => !span.parentSpanId)
  if (root) stdout.write(spanLine(root, 0))
  for (const span of trace.spans) {
    if (!span.parentSpanId) continue
    stdout.write(spanLine(span, 1))
  }
  stdout.write('events:\n')
  for (const event of trace.events) {
    const summary = formatProgressEvent(event) || event.type
    stdout.write(`#${String(event.sequence).padStart(4, '0')} ${event.type.padEnd(20)} ${summary}\n`)
  }
}

/** Render a read-only local Turn trace (text, JSON, or OTLP/JSON spans). */
const TRACE_BLOCKING_HELP = Object.freeze({
  TURN_ID_REQUIRED: 'pass a turn id: gugo trace <turnId>',
  TURN_NOT_FOUND: 'no turn events for that id. Check the id (e.g. `gugo session show <sessionId>`), or pass --session-id when the turn exists in a known session.',
  AUTH_REQUIRED: 'use this deployment\'s authenticated service or SDK. A remote gugo login token does not authorize reading a local trace database.',
  TRACE_DATABASE_NOT_INITIALIZED: 'initialize the local runtime through normal application startup, then retry. Trace does not create databases or migrate data.',
  TRACE_LOCAL_IDENTITY_NOT_INITIALIZED: 'initialize the local identity through normal application startup, then retry. Trace does not create accounts or login sessions.',
  TRACE_MIGRATION_REQUIRED: 'use normal application startup to apply supported database migrations, then retry. Trace never migrates or repairs data.',
  TRACE_ACTIVE_WAL_UNAVAILABLE: 'use the running authenticated service/SDK, or normally stop the runtime and retry. Trace does not checkpoint or remove active WAL/SHM files.',
  TRACE_SQLITE_RECOVERY_REQUIRED: 'check database recovery with the normal runtime. Trace does not recover the database or remove its rollback journal.',
  TRACE_RECOVERY_REQUIRED: 'complete the pending runtime configuration transaction through normal recovery, then retry. Trace does not modify pending recovery state.',
  TRACE_DATABASE_CHANGED: 'the database changed during inspection; retry when it is stable or use the authenticated service/SDK.',
  TRACE_READONLY_IMAGE_LIMIT: 'the read-only snapshot exceeds this Node runtime\'s size limit. Use a supported newer Node.js version or the authenticated service/SDK.',
  TRACE_SCHEMA_VERSION_INVALID: 'check the application/database version and backup; the stored schema version is invalid. Trace does not repair data.',
  TRACE_SCHEMA_VERSION_UNSUPPORTED: 'use an application version compatible with this database. Trace does not downgrade or migrate data.',
  RUNTIME_CONFIG_FILE_INVALID: 'correct the runtime configuration and retry. Trace has not initialized storage or changed the configuration.',
})

function describeTraceFailure(blocking) {
  const code = String(blocking?.code || 'TRACE_FAILED')
  const help = TRACE_BLOCKING_HELP[code]
  if (help) return `${code}: ${help}`
  if (code.startsWith('TRACE_')) return `${code}: check the configured data path and normal runtime state; read-only trace does not initialize, migrate, or repair data.`
  return `${code} (${blocking?.action || 'retry'})`
}

export async function cmdTrace(argv, { stdout = process.stdout, cwd = process.cwd(), env = process.env } = {}) {
  const options = parseTraceArgs(argv)
  const { readLocalTurnTrace } = await import('../../server/services/localTurnTraceService.js')
  const trace = await readLocalTurnTrace({
    cwd, env,
    turnId: options.turnId,
    sessionId: options.sessionId,
    limit: Number(options.limit) || 2_000,
  })
  if (options.export === 'json' || options.export === 'otel') {
    if (!trace.ok) {
      stdout.write(`${JSON.stringify({ ok: false, turnId: trace.turnId, blocking: trace.blocking }, null, 2)}\n`)
      return 1
    }
    if (options.export === 'otel') {
      const { toOtlpJson } = await import('../../server/services/turnTraceSpans.js')
      stdout.write(`${JSON.stringify(toOtlpJson({ traceId: trace.traceId, spans: trace.spans }), null, 2)}\n`)
      return 0
    }
    stdout.write(`${JSON.stringify(trace, null, 2)}\n`)
    return 0
  }
  if (!trace.ok) {
    stdout.write(`trace unavailable — ${describeTraceFailure(trace.blocking)}\n`)
    return 1
  }
  renderText(trace, stdout)
  return 0
}
