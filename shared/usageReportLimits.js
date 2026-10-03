/**
 * Event-window bounds for the persisted usage report.
 *
 * These live in `shared/` because three surfaces need the same numbers without
 * needing each other: the aggregator, the HTTP route, and the CLI. The CLI must
 * not reach into `server/services/` for this — that would pull the database and
 * migration module graph into a command whose whole point is to read the
 * runtime without initializing it.
 *
 * `DEFAULT_EVENTS` is deliberately single-valued. A CLI run and a panel load over
 * the same range must reach the same completeness verdict; when each surface
 * kept its own default, a heavy range could read as truncated in the panel and
 * complete in the CLI. Both still state truncation honestly, and a caller who
 * wants more raises it explicitly (`--limit`, or the endpoint's `limit`).
 */
export const USAGE_REPORT_LIMITS = Object.freeze({
  DEFAULT_EVENTS: 20_000,
  MAX_EVENTS: 100_000,
  MAX_MODELS: 32,
  MAX_SESSIONS: 32,
})
