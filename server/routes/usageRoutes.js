/**
 * HTTP surface for the persisted usage report the CLI renders with `gugo usage`.
 *
 * The panel and the command must not disagree, so both call `readUsageReport`:
 * here it reads the live runtime database, while the CLI wraps the same call in
 * the read-only trace reader.
 */
import { authenticateRequest } from '../middleware.js'
import { sendJson } from '../utils.js'
import { parseLocalDateTime } from '../../shared/localDateTime.js'
import { readUsageReport } from '../services/localUsageReportService.js'
import { USAGE_REPORT_LIMITS } from '../../shared/usageReportLimits.js'

const { DEFAULT_EVENTS, MAX_EVENTS } = USAGE_REPORT_LIMITS

/** The endpoint and the CLI share one default, so neither can contradict the other. */
export function resolveUsageEventLimit(raw) {
  // A missing parameter must take the default: `Number(null)` is 0, which would
  // clamp to a single event and silently report a fraction of the usage.
  const text = String(raw ?? '').trim()
  if (!text) return DEFAULT_EVENTS
  const parsed = Number(text)
  if (!Number.isFinite(parsed)) return DEFAULT_EVENTS
  return Math.min(Math.max(Math.floor(parsed), 1), MAX_EVENTS)
}

export async function handleUsageRequest(req, res) {
  const userId = authenticateRequest(req)
  if (!userId) return sendJson(res, 401, { ok: false, error: '请先登录' })
  const url = new URL(req.url, 'http://localhost')
  if (url.pathname !== '/api/usage/report') {
    return sendJson(res, 404, { ok: false, error: '未知端点' })
  }
  if (req.method !== 'GET') {
    return sendJson(res, 405, { ok: false, error: '仅支持 GET' })
  }

  const rawSince = String(url.searchParams.get('since') || '').trim()
  let since = null
  if (rawSince) {
    const parsed = parseLocalDateTime(rawSince, { allowEpochMs: true })
    if (!parsed.ok) {
      // Refuse rather than silently reading a different window than requested.
      return sendJson(res, 400, {
        ok: false,
        code: 'USAGE_SINCE_INVALID',
        error: 'since 需要 yyyy-mm-dd 或 yyyy-mm-ddTHH:mm（本地时间），或正的 epoch 毫秒',
      })
    }
    since = parsed.ms
  }

  try {
    const report = readUsageReport({
      userId,
      sessionId: String(url.searchParams.get('sessionId') || '').trim(),
      since,
      limit: resolveUsageEventLimit(url.searchParams.get('limit')),
    })
    return sendJson(res, 200, { ok: true, report })
  } catch (error) {
    return sendJson(res, error?.statusCode || 500, {
      ok: false,
      code: error?.code || 'USAGE_REPORT_FAILED',
      error: error?.message || 'usage report failed',
    })
  }
}
